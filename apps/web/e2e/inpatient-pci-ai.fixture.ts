import { selectWorkspaceMode } from './inpatient-ui.ts'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import type { Page } from '@playwright/test'
import { z } from 'zod'
import { inpatientDetailSchema, inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullClinicalResponseSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientPciDataResponseSchema, pciCaseSourceResponseSchema, startSyntheticInpatientCaseResponseSchema } from '@clinmesh/contracts/inpatient-pci-data'
import { inpatientMaterialEstimateCandidateSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { inpatientCostsSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { createPciPaymentDrgFixture, preparePciPaymentDrgFixture, parsePciResponse, type PciPaymentDrgFixture } from '../../server/tests/fixtures/pci-payment-drg.ts'
import { OpenAIChatCompletionsClient } from '../../server/src/infrastructure/ai/openai-chat-completions.ts'
import { GuidelineCorpus } from '../../server/src/infrastructure/sqlite/guideline-corpus.ts'
import type { GuidelineDocument } from '../../server/src/application/guideline-corpus.ts'
import { expect, test as base } from './fixtures.ts'

// 2021 原件的字面摘录；保留提取换行与断词。来源、哈希和物理页固定在下方测试包装中。
export const pciAiQuotes = [
  ['COR LOE Recommendation\n1 A\n1. In patients undergoing PCI, DES should be\nused in preference to BMS to prevent reste-\nnosis, MI, or acute stent thrombosis.1-4'],
  ['COR LOE Recommendations\n2a B-R\n1. In patients undergoing coronary stent implan-\ntation, IVUS can be useful for procedural\nguidance, particularly in cases of left main or\ncomplex coronary artery stenting, to reduce\nischemic events.1-10\n2a B-R\n2. In patients undergoing coronary stent implan-\ntation, OCT is a reasonable alternative to IVUS\nfor procedural guidance, except in ostial left\nmain disease.11-13'],
  ['Once the reference segments are selected, quantitative and\nqualitative assessment similar to the stenosis should be\nperformed in both proximal and distal reference, including\nlumen, EEM, and plaque measurements.',
    'Length measurements by IVUS can be performed using\nmotorized transducer pullback system (number of sec-\nonds × pullback speed). Alternatively, longitudinal imaging\ncan be used. In case with manual pullback without motor-\nized transducer pullback system, length cannot be meas-\nured. This approach can be used to determine the length of\na lesion, stenosis, calcium, or any other longitudinal feature.'],
] as const
export const pciAiParagraphs = pciAiQuotes.map(quotes => quotes.join('\n\n'))
export function pciAiGuidelineDocuments(): GuidelineDocument[] {
  return [
    { id: 'coronary-10-2021', hash: '9843131ad84f9a261ceb8857025e656a067496472edabfb6bd2b6297f2c5ff0e', title: '血运重建指南核对引文（合成验收包装）', pages: [35, 36], texts: pciAiParagraphs.slice(0, 2) },
    { id: 'coronary-15-2021', hash: 'c2018438f6bfe9abf39cdfa813f6a6312de858bb6047ce18d9a01bff222ae9ad', title: 'CVIT测量共识核对引文（合成验收包装）', pages: [6], texts: pciAiParagraphs.slice(2) },
  ].map(item => ({ source: { id: item.id, title: item.title, publisher: '合成验收机构', documentType: 'guideline', version: '2021',
    url: `https://example.test/${item.id}`, sha256: item.hash, format: 'pdf', scope: '仅用于合成浏览器验收；引文为已核对2021版原件的有限字面摘录，测试包装元数据不代表实际发布来源或原文许可。', status: 'active', license: { id: 'CC0', url: 'https://example.test/license', usage: 'open' }, topics: [] },
    passages: item.pages.map((page, index) => ({ locator: `PDF 物理第 ${page} 页`, text: item.texts[index]! })) }))
}
const issueSchema = z.object({ key: z.string(), evidence: z.array(z.string()) })
const payloadSchema = z.object({
  guidelines: z.array(z.object({ id: z.string(), text: z.string() })).optional(), missing: z.array(z.string()).optional(),
  estimate: z.object({ request: z.object({ id: z.string(), plannedProcedure: z.object({ coding: z.object({ code: z.string() }) }) }), candidates: z.array(inpatientMaterialEstimateCandidateSchema) }).optional(),
  remaining: z.array(z.object({ materialId: z.string(), quantity: z.number() })).optional(),
  costs: inpatientCostsSchema.optional(),
  recordChecks: z.object({ issues: z.array(issueSchema), costs: inpatientCostsSchema.nullable() }).optional(),
})

export async function createPciAiBrowserApp(webRoot?: string, options: { guidelines?: GuidelineDocument[]; unknownGuideline?: boolean } = {}) {
  const prepared = await preparePciPaymentDrgFixture()
  const writer = new GuidelineCorpus({ databasePath: join(prepared.directory, 'guidelines.sqlite') })
  writer.importDocuments(options.guidelines ?? pciAiGuidelineDocuments())
  const calls: Array<{ kind: 'guideline' | 'material' | 'explanation'; phase: 'angiography' | 'pci' | 'record-explanation'; feature: string }> = []
  prepared.options.guidelineDatabasePath = join(prepared.directory, 'guidelines.sqlite')
  prepared.options.consultationModel = 'synthetic-pci-ai-browser'
  prepared.options.autoDispatchIntervalMs = 250
  prepared.options.chatCompletionsProvider = new OpenAIChatCompletionsClient({ apiKey: 'synthetic-only', baseUrl: 'https://synthetic.invalid/v1',
    fetch: async (_url, init) => {
      const body = z.object({ response_format: z.object({ json_schema: z.object({ name: z.string() }) }), messages: z.array(z.object({ role: z.string(), content: z.string() })) }).parse(JSON.parse(String(init?.body)))
      const feature = body.response_format.json_schema.name
      if (!['inpatient_drg_recommendation', 'inpatient_drg_verification'].includes(feature)) throw new Error(`Uncontrolled feature ${feature}`)
      const payload = payloadSchema.parse(JSON.parse(body.messages.find(message => message.role === 'user')!.content))
      const generation = feature === 'inpatient_drg_recommendation'
      const kind = payload.guidelines ? 'guideline' : payload.recordChecks ? 'explanation' : 'material'
      calls.push({ kind, phase: kind === 'explanation' ? 'record-explanation' : payload.estimate?.request.plannedProcedure.coding.code.startsWith('88.') ? 'angiography' : 'pci', feature })
      if (kind === 'guideline' && generation && options.unknownGuideline) throw new Error('Synthetic guideline response lost after dispatch')
      let result: unknown
      if (payload.guidelines) {
        const texts = ['对接受PCI的患者，DES相对BMS的类别推荐用于预防再狭窄、心肌梗死或急性支架血栓，仍须核对本次患者的适用条件。', '对冠脉支架置入患者，IVUS可以用于操作指导，尤其左主干或复杂支架置入；OCT是合理的替代方式，但须保留左主干开口病变例外，并非所有PCI必须检查。', '选定参考段后，应核对近远端参考段、管腔、EEM和斑块。IVUS测长可用电动回撤或纵向成像；手动回撤缺少电动回撤系统时不能据此测长。']
        result = { conclusions: ['stent-category', 'imaging-guidance', 'measurement-requirements'].map((kind, index) => generation
          ? { kind, applicability: 'conditional', text: texts[index]!, citations: pciAiQuotes[index]!.map(quote => ({ evidenceId: payload.guidelines![index]!.id, quote })) }
          : { kind, supported: true, populationPreserved: true, conditionsPreserved: true, strengthPreserved: true, noInventedMeasurements: true, noProductOrQuantity: true, reason: '合成独立核验已核对同一原文与条件' }) }
      } else {
        const costs = payload.recordChecks?.costs ?? payload.costs
        const costExplanation = costs ? `预计住院总费用为${(costs.components.projectedTotalFen / 100).toFixed(2)}元；费用位置不改变必要治疗与耗材选择。` : null
        if (payload.recordChecks) result = generation ? { costExplanation, observations: payload.recordChecks.issues.map(issue => ({ key: issue.key, explanation: '请回到原记录核实，本说明不改变诊断、主操作或费用。', evidenceIds: issue.evidence })) }
          : { costExplanationSupported: true, observations: payload.recordChecks.issues.map(issue => ({ key: issue.key, supported: true, reason: '已核对当前正式来源' })) }
        else {
          const candidates = (payload.estimate?.candidates ?? []).filter(item => item.eligibility === 'valid' && item.expectedQuantity !== null)
          result = generation ? { costExplanation, items: candidates.map(item => ({ materialId: item.materialId, catalogVersion: item.catalogVersion, quantity: payload.remaining?.find(value => value.materialId === item.materialId)?.quantity ?? item.expectedQuantity!, reason: '已按当前合成适用范围和独立数量依据准备，等待医生统一审阅。', evidenceIds: [item.evidence.id] })) }
            : { costExplanationSupported: true, items: candidates.map(item => ({ materialId: item.materialId, applicable: true, compatible: true, quantitySupported: true, evidenceSupported: true, reason: '已独立核对传入候选与数量来源' })) }
        }
      }
      return Response.json({ id: `synthetic-pci-ai-${calls.length}`, model: 'synthetic-pci-ai-browser', choices: [{ message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })
    } })
  let fixture: PciPaymentDrgFixture | undefined
  let closing = false
  const inFlight = new Set<Promise<Response>>()
  const server = serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    if (!fixture || closing) return new Response('Unavailable', { status: 503 })
    const response = Promise.resolve(fixture.runtime.app.fetch(request))
    inFlight.add(response)
    try { return await response } finally { inFlight.delete(response) }
  } })
  const close = async () => {
    closing = true
    let settled: PromiseSettledResult<Response>[] = []
    try { await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); if ('closeAllConnections' in server) server.closeAllConnections() }) }
    finally {
      settled = await Promise.allSettled(inFlight)
      try { if (fixture) await fixture.close(); else await rm(prepared.directory, { recursive: true, force: true }) } finally { writer.close() }
    }
    const rejected = settled.filter(result => result.status === 'rejected')
    if (rejected.length > 0) throw new AggregateError(rejected.map(result => result.reason), 'PCI fixture requests failed during shutdown')
  }
  try {
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing PCI AI fixture address')
    const origin = `http://127.0.0.1:${address.port}`
    Object.assign(prepared.options, { authBaseUrl: origin, ...(webRoot ? { webRoot } : {}), trustedOrigins: ['http://localhost', origin] })
    fixture = await createPciPaymentDrgFixture(prepared)
    return { origin, password: prepared.password, fixture, calls, writer, close }
  } catch (error) { await close(); throw error }
}
export type PciAiBrowserApp = Awaited<ReturnType<typeof createPciAiBrowserApp>>
export const test = base.extend<{ pciAiApp: PciAiBrowserApp; pciAiNoSourcesApp: PciAiBrowserApp; pciAiUnknownGuidelineApp: PciAiBrowserApp }>({ pciAiApp: async ({ webRoot }, use) => {
  const app = await createPciAiBrowserApp(webRoot)
  try { await use(app) } finally { await app.close() }
}, pciAiNoSourcesApp: async ({ webRoot }, use) => {
  const app = await createPciAiBrowserApp(webRoot, { guidelines: [] })
  try { await use(app) } finally { await app.close() }
}, pciAiUnknownGuidelineApp: async ({ webRoot }, use) => {
  const app = await createPciAiBrowserApp(webRoot, { unknownGuideline: true })
  try { await use(app) } finally { await app.close() }
} })
export { expect }

export async function preparePciAiPatient(app: PciAiBrowserApp) {
  const f = app.fixture, epoch = 'epoch-1'
  const data = (await parsePciResponse(inpatientPciDataResponseSchema, await f.request('admin', '/api/his/v1/inpatient/pci-data/prepare', { expectedEpoch: epoch }))).data
  const { case: source } = (await parsePciResponse(pciCaseSourceResponseSchema, await f.request('admin', '/api/sim/v1/synthetic-cases/pci/prepare', { expectedEpoch: epoch }))).data
  const started = (await parsePciResponse(startSyntheticInpatientCaseResponseSchema, await f.runtime.app.request(`/api/his/v1/synthetic-cases/${source.caseId}/actions/start-inpatient-visit`, {
    method: 'POST', headers: { cookie: await f.login('registrar'), origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ activeBriefRevision: source.activeBriefRevision, expectedCaseRevision: source.revision, expectedEpoch: epoch, wardId: 'ward-general' }) }))).data
  const path = `/api/his/v1/inpatient/admissions/${started.admissionId}`
  const registered = await f.read('registrar', path, inpatientDetailSchema)
  const admission = (await parsePciResponse(inpatientCommandResponseSchema, await f.request('ward-nurse', `${path}/receive`, { encounterVersion: registered.admission.versionId, bedId: 'bed-general-1' }))).data.admission
  await parsePciResponse(inpatientFullClinicalResponseSchema, await f.request('inpatient-doctor', `${path}/diagnoses/confirm`, { encounterVersion: admission.versionId, expectedRevision: 0,
    entries: [{ catalogItemId: data.package.diagnosis.id, role: 'primary', admissionCondition: '1', note: '本院确认合成冠心病' }] }))
  return { path, admissionId: admission.id, patientName: admission.patientName }
}

export async function openPciAiPatient(page: Page, app: PciAiBrowserApp, role: string, name: string) {
  expect((await page.request.post(`${app.origin}/api/auth/sign-in/email`, { headers: { origin: app.origin }, data: { email: `${role}@demo.clinmesh.local`, password: app.password } })).status()).toBe(200)
  await page.goto(`${app.origin}/${role === 'cashier' ? 'billing' : 'inpatient'}`)
  if (role === 'cashier') await selectWorkspaceMode(page, '住院')
  await page.getByRole('button', { name: role === 'cashier' ? `查看${name}` : new RegExp(name), exact: role === 'cashier' }).click()
}
