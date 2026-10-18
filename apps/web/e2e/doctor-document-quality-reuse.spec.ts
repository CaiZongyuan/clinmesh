import { z } from 'zod'
import { checkClinicalDocumentQualityRequestSchema, clinicalDocumentQualityControlStateSchema } from '@clinmesh/contracts/his'
import { sourceArtifactHash } from '../../server/src/application/scenario-data/provider.ts'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { expect, test } from './fixtures.ts'

for (const status of ['ready', 'pending', 'failed'] as const) test(`reuses one ${status} document-quality task and model call across real patient navigation`, async ({ page, webRoot }) => {
  let calls = 0
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const server = await startBrowserServer(webRoot, {
    dshModelBridge: { origin: 'http://127.0.0.1:1', secret: 'synthetic-quality-reuse-secret-at-least-32-characters', timeoutMs: 2000, maxResponseBytes: 8192 },
    patientPersonaModel: 'synthetic-persona', autoDispatchIntervalMs: 30,
    syntheaProvider: new class extends StubSyntheaProvider {
      generated = 0
      override async generate() {
        const corpus = await super.generate()
        return { ...corpus, sources: corpus.sources.map(source => {
          const raw = z.object({ entry: z.array(z.object({ resource: z.record(z.string(), z.unknown()) }).passthrough()) }).passthrough().parse(source.raw)
          raw.entry.find(entry => entry.resource.resourceType === 'Patient')!.resource.name = [{ text: `合成质控患者${++this.generated}` }]
          return { ...source, raw, hash: sourceArtifactHash(raw) }
        }) }
      }
    }(),
    qualityCompletions: async () => {
      calls += 1
      if (status === 'pending') await held
      return { content: status === 'failed' ? '{invalid-json' : JSON.stringify({ issues: [], agentFactChecks: [] }), model: 'synthetic' }
    },
    chatCompletionsProvider: { async completeJson(input) {
      if (input.schemaName === 'patient_persona') return { content: JSON.stringify(persona), model: 'synthetic' }
      if (input.schemaName === 'patient_dialogue_reply') return { content: JSON.stringify({ reply: '合成患者回答。' }), model: 'synthetic' }
      if (input.schemaName === 'consultation_history_increment') return { content: JSON.stringify({ additions: [] }), model: 'synthetic' }
      throw new Error('Unexpected synthetic model schema')
    } },
  })
  try {
    const first = await startConsultationCase(server.runtime, server.password, server.origin)
    const second = await startConsultationCase(server.runtime, server.password, server.origin)
    let clientId: string | undefined
    page.on('request', request => {
      if (new URL(request.url()).pathname === `/api/his/v1/doctor/cases/${first.outpatientCaseId}/document-quality-control/actions/check`) {
        clientId = checkClinicalDocumentQualityRequestSchema.parse(request.postDataJSON()).input.clientId
      }
    })
    const taskCount = () => z.object({ count: z.number() }).parse(server.runtime.database.driver.prepare(
      "SELECT count(*) AS count FROM outbox_event WHERE kind = 'clinical-document.check-quality' AND json_extract(payload_json, '$.caseId') = ?").get(first.outpatientCaseId)).count
    const read = async () => clinicalDocumentQualityControlStateSchema.parse(await (await page.request.get(
      `${server.origin}/api/his/v1/doctor/cases/${first.outpatientCaseId}/document-quality-control${clientId === undefined ? '' : `?clientId=${encodeURIComponent(clientId)}`}`)).json())
    const select = (caseId: string) => page.locator(`[data-agent-selection="${caseId}"]`).click()
    await page.goto(`${server.origin}/consultation`)
    await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
    await page.getByLabel('账户密码').fill(server.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByRole('tab', { name: '待诊', exact: true }).click()
    await select(first.outpatientCaseId)
    await page.getByRole('button', { name: '开始首诊', exact: true }).click()
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await expect.poll(() => calls).toBe(1)
    await expect.poll(async () => (await read()).status).toBe(status)
    const generation = (await read()).generation
    await page.getByRole('tab', { name: '待诊', exact: true }).click()
    await select(second.outpatientCaseId)
    await expect(page.getByRole('button', { name: '开始首诊', exact: true })).toBeVisible()
    await page.getByRole('tab', { name: '在诊', exact: true }).click()
    await select(first.outpatientCaseId)
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await page.getByRole('button', { name: '依据与说明', exact: true }).click()
    const explanation = page.getByRole('dialog', { name: '依据与说明', exact: true })
    await expect(explanation.locator('[data-document-quality-status]')).toHaveAttribute('data-document-quality-status', status)
    if (status === 'failed') await expect(explanation).toContainText('返回内容格式不正确，本次病历检查未完成，可重试。')
    // The returning candidate has a 500 ms debounce; observe its full window before counting work.
    await page.waitForTimeout(650)
    expect(taskCount()).toBe(1)
    expect(calls).toBe(1)
    expect((await read()).generation).toBe(generation)
    if (status === 'pending') {
      release()
      await expect.poll(async () => (await read()).status).toBe('ready')
      expect(calls).toBe(1)
    }
  } finally { release(); await server.close() }
})
