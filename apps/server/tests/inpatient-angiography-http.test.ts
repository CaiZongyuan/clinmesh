import { afterEach, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { inpatientAngiographyReportsSchema } from '@clinmesh/contracts/inpatient-angiography'
import { inpatientPciSelectionSchema, inpatientPciSelectionResponseSchema, type InpatientPciSelectionParameters } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientDrgAgentSchema } from '@clinmesh/contracts/inpatient-drg-agent'
import { inpatientMaterialEstimatesSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { inpatientMaterialEstimateResponseSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { inpatientMaterialReservationListSchema, inpatientDrgSimulationSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { randomUUID } from 'node:crypto'
import { inpatientSurgeryResponseSchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { pciAgentParameters } from './fixtures/inpatient-drg-agent.ts'
import { z } from 'zod'
import { fhirResourceSchema } from '@clinmesh/contracts/fhir'
import { OpenAIChatCompletionsClient } from '../src/infrastructure/ai/openai-chat-completions.ts'
import { createPciPaymentDrgFixture, preparePciPaymentDrgFixture } from './fixtures/pci-payment-drg.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup(estimate = false) {
  const prepared = await preparePciPaymentDrgFixture()
  const calls: string[] = []
  const payloads: unknown[] = []
  if (estimate) {
    prepared.options.consultationModel = 'synthetic-angiography-estimate'
    prepared.options.chatCompletionsProvider = new OpenAIChatCompletionsClient({ apiKey: 'synthetic-only', baseUrl: 'https://synthetic.invalid/v1',
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)), feature = body.response_format.json_schema.name
        const input = JSON.parse(body.messages[1].content)
        calls.push(feature)
        payloads.push(input)
        const items = input.remaining.filter((item: { quantity: number }) => item.quantity > 0)
          .map((item: { materialId: string; quantity: number }) => feature === 'inpatient_drg_recommendation'
            ? { materialId: item.materialId, catalogVersion: 1, quantity: item.quantity, reason: '核对合成方案',
              evidenceIds: [item.materialId === 'hospital-material-catheter' ? 'angiography-one-catheter' : `pci-evidence-${item.materialId.replace('hospital-material-pci-', '')}`] }
            : { materialId: item.materialId, applicable: true, compatible: true, quantitySupported: true, evidenceSupported: true, reason: '独立核验合成方案' })
        const result = feature === 'inpatient_drg_recommendation'
          ? { items, costExplanation: '费用说明仅对应生成时的规则费用块。' } : { items, costExplanationSupported: true }
        return Response.json({ id: `synthetic-${calls.length}`, model: 'synthetic-angiography-estimate', choices: [{ message: { content: JSON.stringify(result) } }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })
      } })
  }
  cleanups.push(() => rm(prepared.directory, { recursive: true, force: true }))
  const fixture = await createPciPaymentDrgFixture(prepared)
  cleanups.push(() => fixture.runtime.close())
  const stay = await fixture.preparePciAdmission([])
  return { fixture, prepared, stay, calls, payloads }
}

it('造影完成后持久任务生成关联本院操作的正式报告，刷新和重启不重复且不请求模型', async () => {
  const s = await setup()
  const execution = await s.fixture.executeAngiography(s.stay)
  const path = `${s.stay.path}/angiography-reports`
  const pending = await s.fixture.request('inpatient-doctor', path)
  expect(pending.status).toBe(200)
  expect(await s.fixture.runtime.dispatcher.dispatchOnce({ kinds: ['inpatient.angiography.report'] })).toMatchObject({ status: 'completed' })
  const result = await s.fixture.read('inpatient-doctor', path, inpatientAngiographyReportsSchema)
  expect(result.reports).toHaveLength(1)
  expect(result.reports[0]).toMatchObject({ procedureId: execution.id, version: 1, status: 'final', targetSite: 'LAD 中段',
    measurements: [{ kind: 'lesion-length', value: 12, unit: 'mm', method: '定量冠脉造影（合成）' },
      { kind: 'proximal-reference-diameter', value: 3, unit: 'mm' }, { kind: 'distal-reference-diameter', value: 3, unit: 'mm' }] })
  expect(result.reports[0]!.measurements.every(item => item.source.reference === `DiagnosticReport/${result.reports[0]!.id}` && item.source.version === '1')).toBe(true)
  expect(JSON.stringify(result)).not.toMatch(/sourceCaseId|Case Truth|hiddenResources|case_truth|pci-patient/)
  expect(s.prepared.modelCalls).toBe(0)
  await s.fixture.restart()
  await s.fixture.runtime.dispatcher.dispatchOnce({ kinds: ['inpatient.angiography.report'] })
  expect(await s.fixture.read('inpatient-doctor', path, inpatientAngiographyReportsSchema)).toEqual(result)
  expect((await s.fixture.request('cashier', path)).status).toBe(403)
})

it('报告草稿足以自动起草PCI耗材清单，医生不必先确认选型', async () => {
  const s = await setup(true)
  await s.fixture.executeAngiography(s.stay)
  await s.fixture.runtime.dispatchPending()
  const selection = await s.fixture.read('inpatient-doctor', `${s.stay.path}/pci-selection`, inpatientPciSelectionSchema)
  expect(selection.confirmation).toBeNull()
  const estimate = (await s.fixture.read('inpatient-doctor', `${s.stay.path}/material-estimates`, inpatientMaterialEstimatesSchema))
    .estimates.find(item => item.requestId === s.stay.requestId)!
  expect(estimate).toMatchObject({ status: 'succeeded', missing: [], draft: { edited: false, confirmedRevision: null } })
  expect(estimate.draft!.items.map(item => item.materialId).sort()).toEqual([
    'hospital-material-pci-balloon', 'hospital-material-pci-guidewire', 'hospital-material-pci-guiding-catheter', 'hospital-material-pci-stent',
  ])
  expect(JSON.stringify(s.payloads)).not.toMatch(/case_truth|hiddenResources|pci-angiography-|urn:uuid:pci/)
})

it('一次确认原子确认选型、清单和预留，快照失败全回滚，同键恢复不重复且不使自身依据过期', async () => {
  const s = await setup(true)
  await s.fixture.executeAngiography(s.stay)
  await s.fixture.runtime.dispatchPending()
  const read = () => s.fixture.read('inpatient-doctor', `${s.stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)
  const state = (await read()).estimates.find(item => item.requestId === s.stay.requestId)!
  const reservations = await s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)
  const input = { requestId: state.requestId, expectedVersion: state.version, expectedDraftRevision: state.draft!.revision,
    expectedBasisFingerprint: state.basisFingerprint, expectedRequestVersion: state.requestVersion,
    encounterVersion: reservations.encounterVersion, expectedReservationFingerprint: reservations.reservationSets.find(item => item.requestId === state.requestId)!.fingerprint,
    reason: '医生一次核对参数、清单及预留' }
  const key = randomUUID(), path = `${s.stay.path}/material-estimates/confirm`
  s.fixture.runtime.database.driver.exec(`CREATE TRIGGER reject_synthetic_plan BEFORE INSERT ON inpatient_material_plan_confirmation
    BEGIN SELECT RAISE(ABORT,'synthetic plan snapshot failure'); END`)
  expect((await s.fixture.request('inpatient-doctor', path, input, key)).status).toBe(500)
  expect((await s.fixture.read('inpatient-doctor', `${s.stay.path}/pci-selection`, inpatientPciSelectionSchema)).confirmation).toBeNull()
  expect((await s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)).reservations).toEqual([])
  s.fixture.runtime.database.driver.exec('DROP TRIGGER reject_synthetic_plan')
  const response = await s.fixture.request('inpatient-doctor', path, input, key)
  expect(response.status, await response.clone().text()).toBe(200)
  const confirmed = inpatientMaterialEstimateResponseSchema.parse(await response.json())
  const selection = await s.fixture.read('inpatient-doctor', `${s.stay.path}/pci-selection`, inpatientPciSelectionSchema)
  expect(selection.confirmation).toMatchObject({ version: 1, parameters: { requestId: s.stay.requestId, targetSite: 'LAD 中段',
    approvedMaterialIds: state.draft!.items.map(item => item.materialId) } })
  expect(confirmed.data.planBasis).toMatchObject({ status: 'confirmed', history: [{ sources: { selectionConfirmationId: selection.confirmation!.id, selectionVersion: 1 } }] })
  expect((await read()).estimates.find(item => item.requestId === state.requestId)).toMatchObject({ status: 'succeeded',
    basisFingerprint: state.basisFingerprint, draft: { confirmedRevision: 1, reservationIds: expect.any(Array) } })
  expect(inpatientMaterialEstimateResponseSchema.parse(await (await s.fixture.request('inpatient-doctor', path, input, key)).json())).toEqual(confirmed)
  expect((await s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)).reservations).toHaveLength(4)
})

it('报告预计手工删项即时重算费用，一次确认与实际预留一致且不重跑模型', async () => {
  const s = await setup(true)
  await s.fixture.executeAngiography(s.stay)
  await s.fixture.runtime.dispatchPending()
  const read = async () => (await s.fixture.read('inpatient-doctor', `${s.stay.path}/material-estimates`, inpatientMaterialEstimatesSchema))
    .estimates.find(item => item.requestId === s.stay.requestId)!
  const initial = await read(), callsBefore = s.calls.length
  expect(initial.draft!.items).toHaveLength(4)
  expect(initial.costs?.components.remainingMaterialsFen).toBe(126598)
  expect(initial.analysis?.costExplanation).toBe('费用说明仅对应生成时的规则费用块。')
  const guidewire = initial.draft!.items.find(item => item.materialId === 'hospital-material-pci-guidewire')!
  const savedResponse = await s.fixture.request('inpatient-doctor', `${s.stay.path}/material-estimates/save`, {
    requestId: initial.requestId, expectedVersion: initial.version, expectedDraftRevision: initial.draft!.revision,
    expectedBasisFingerprint: initial.basisFingerprint, analysisId: initial.analysis!.id, items: [guidewire], note: '医生仅保留本次已核对的一根导丝',
  })
  expect(savedResponse.status, await savedResponse.clone().text()).toBe(200)
  const saved = inpatientMaterialEstimateResponseSchema.parse(await savedResponse.json()).data
  expect(saved.costs?.components.remainingMaterialsFen).toBe(20000)
  expect(saved).toMatchObject({ status: 'blocked', draft: { items: [guidewire], analysisId: null, basisFingerprint: saved.basisFingerprint } })
  expect(saved.basisFingerprint).not.toBe(initial.basisFingerprint)
  expect(saved.analysis?.basisFingerprint).not.toBe(saved.basisFingerprint)
  expect(saved.candidates.filter(item => item.eligibility === 'valid')).toHaveLength(4)
  const before = await s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)
  const confirmedResponse = await s.fixture.request('inpatient-doctor', `${s.stay.path}/material-estimates/confirm`, {
    requestId: saved.requestId, expectedVersion: saved.version, expectedDraftRevision: saved.draft!.revision,
    expectedBasisFingerprint: saved.basisFingerprint, expectedRequestVersion: saved.requestVersion,
    encounterVersion: before.encounterVersion, expectedReservationFingerprint: before.reservationSets.find(item => item.requestId === saved.requestId)!.fingerprint,
    reason: '医生一次确认当前一项人工稿及相应预留',
  })
  expect(confirmedResponse.status, await confirmedResponse.clone().text()).toBe(200)
  const confirmed = inpatientMaterialEstimateResponseSchema.parse(await confirmedResponse.json()).data
  const current = await read()
  expect(current.basisFingerprint).toBe(saved.basisFingerprint)
  expect(current.draft).toMatchObject({ confirmedRevision: saved.draft!.revision, items: [guidewire] })
  expect(confirmed.planBasis?.history[0]!.items).toHaveLength(1)
  const reservations = await s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)
  const active = reservations.reservations.filter(item => item.requestId === saved.requestId && item.status === 'reserved')
  expect(active).toMatchObject([{ materialId: guidewire.materialId, quantity: 1, priceFen: 20000 }])
  const simulate = async () => {
    const response = await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/simulation`, {})
    expect(response.status).toBe(200)
    return inpatientDrgSimulationSchema.parse(await response.json())
  }
  const simulation = await simulate()
  expect(current.costs?.components.remainingMaterialsFen).toBe(20000)
  expect(current.costs?.components.projectedTotalFen).toBe(simulation.coverage.estimatedTotalFen)
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/reservations/${active[0]!.id}/release`, {
    encounterVersion: reservations.encounterVersion, reason: '后续正式释放不应继续计入旧已确认稿的预计金额',
  })).status).toBe(200)
  const released = await read(), afterRelease = await simulate()
  expect(released.costs?.components.remainingMaterialsFen).toBe(0)
  expect(released.costs?.components.projectedTotalFen).toBe(afterRelease.coverage.estimatedTotalFen)
  expect(current.costs!.components.projectedTotalFen - released.costs!.components.projectedTotalFen).toBe(20000)
  await s.fixture.runtime.dispatchPending()
  expect(s.calls).toHaveLength(callsBefore)
})

it('报告晚于PCI计划到达时带入逐字段相等且绑定报告版本的选型草稿，无需先确认选型', async () => {
  const s = await setup()
  await s.fixture.executeAngiography(s.stay)
  await s.fixture.runtime.dispatcher.dispatchOnce({ kinds: ['inpatient.angiography.report'] })
  const report = (await s.fixture.read('inpatient-doctor', `${s.stay.path}/angiography-reports`, inpatientAngiographyReportsSchema)).reports[0]!
  const selection = await s.fixture.read('inpatient-doctor', `${s.stay.path}/pci-selection`, inpatientPciSelectionSchema)
  expect(selection).toMatchObject({ confirmation: null, drafts: [{ requestId: s.stay.requestId, version: 1,
    reportId: report.id, reportVersion: report.version, edited: false, parameters: { targetSite: report.targetSite, measurements: report.measurements } }] })
  expect(selection.candidates.every(candidate => candidate.eligibility === 'valid' && candidate.expectedQuantity === 1)).toBe(true)
})

it('医生编辑草稿后新报告不覆盖人工值，旧版本保存返回冲突', async () => {
  const s = await setup()
  await s.fixture.executeAngiography(s.stay)
  await s.fixture.runtime.dispatcher.dispatchOnce({ kinds: ['inpatient.angiography.report'] })
  const original = (await s.fixture.read('inpatient-doctor', `${s.stay.path}/pci-selection`, inpatientPciSelectionSchema)).drafts![0]!
  const input = { requestId: original.requestId, expectedDraftVersion: original.version,
    parameters: { ...original.parameters, measurements: original.parameters.measurements.map(item => item.kind === 'lesion-length' ? { ...item, value: 13 } : item) } }
  const saved = await s.fixture.request('inpatient-doctor', `${s.stay.path}/pci-selection/save`, input)
  expect(saved.status).toBe(200)
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/pci-selection/save`, input)).status).toBe(409)
  const procedure = s.stay.catalog.procedures.find(item => item.coding.code === '88.5500')!
  const encounterVersion = (await s.fixture.read('inpatient-doctor', s.stay.path, inpatientDetailSchema)).admission.versionId
  const planned = inpatientSurgeryResponseSchema.parse(await (await s.fixture.request('inpatient-doctor', `${s.stay.path}/surgeries/request`, {
    encounterVersion, procedureId: procedure.id, catalogVersion: 1, plannedFor: '2026-08-24T15:00:00+08:00', reason: '复查合成造影，保留人工草稿',
  })).json()).data.requests.at(-1)!
  const executionInput = await s.fixture.pciExecutionInput({ ...s.stay, procedure, requestId: planned.id, reservations: [] })
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/surgeries/execute`, executionInput)).status).toBe(200)
  await s.fixture.runtime.dispatcher.dispatchOnce({ kinds: ['inpatient.angiography.report'] })
  const draft = (await s.fixture.read('inpatient-doctor', `${s.stay.path}/pci-selection`, inpatientPciSelectionSchema)).drafts![0]!
  expect(draft).toMatchObject({ version: 2, edited: true, reportId: original.reportId,
    parameters: { measurements: [expect.objectContaining({ kind: 'lesion-length', value: 13,
      source: expect.objectContaining({ note: expect.stringContaining('人工修订') }) }), ...original.parameters.measurements.slice(1)] } })
  expect(draft.parameters.measurements[0]!.source.reference).not.toBe(original.parameters.measurements[0]!.source.reference)
  expect((await s.fixture.read('inpatient-doctor', `${s.stay.path}/angiography-reports`, inpatientAngiographyReportsSchema)).reports).toHaveLength(2)
})

it('手改测量经保存回读及一次确认均标为人工修订，原报告保留原值且客户端不能冒用来源', async () => {
  const s = await setup(true)
  await s.fixture.executeAngiography(s.stay)
  await s.fixture.runtime.dispatchPending()
  const original = (await s.fixture.read('inpatient-doctor', `${s.stay.path}/pci-selection`, inpatientPciSelectionSchema)).drafts![0]!
  const changed = original.parameters.measurements.map(item => item.kind === 'lesion-length' ? { ...item, value: 13 }
    : { ...item, source: { reference: 'DiagnosticReport/forged', version: '999', note: '客户端伪造来源', synthetic: false } })
  const saved = await s.fixture.request('inpatient-doctor', `${s.stay.path}/pci-selection/save`, {
    requestId: original.requestId, expectedDraftVersion: original.version, parameters: { ...original.parameters, measurements: changed },
  })
  expect(saved.status).toBe(200)
  const draft = (await s.fixture.read('inpatient-doctor', `${s.stay.path}/pci-selection`, inpatientPciSelectionSchema)).drafts![0]!
  expect(draft).toMatchObject({ reportId: original.reportId, reportVersion: original.reportVersion })
  expect(draft.parameters.measurements[0]).toMatchObject({ value: 13, source: { note: expect.stringContaining('人工修订') } })
  expect(draft.parameters.measurements[0]!.source.reference).not.toBe(`DiagnosticReport/${original.reportId}`)
  expect(draft.parameters.measurements.slice(1)).toEqual(original.parameters.measurements.slice(1))
  const current = (await s.fixture.read('inpatient-doctor', `${s.stay.path}/material-estimates`, inpatientMaterialEstimatesSchema))
    .estimates.find(item => item.requestId === original.requestId)!
  const materialDraft = await s.fixture.request('inpatient-doctor', `${s.stay.path}/material-estimates/save`, {
    requestId: current.requestId, expectedVersion: current.version, expectedDraftRevision: current.draft!.revision,
    expectedBasisFingerprint: current.basisFingerprint, analysisId: null, items: current.draft!.items, note: '医生已重新核对人工修订参数和原清单',
  })
  expect(materialDraft.status).toBe(200)
  const ready = inpatientMaterialEstimateResponseSchema.parse(await materialDraft.json()).data
  const reservations = await s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)
  const confirmed = await s.fixture.request('inpatient-doctor', `${s.stay.path}/material-estimates/confirm`, {
    requestId: ready.requestId, expectedVersion: ready.version, expectedDraftRevision: ready.draft!.revision,
    expectedBasisFingerprint: ready.basisFingerprint, expectedRequestVersion: ready.requestVersion, encounterVersion: reservations.encounterVersion,
    expectedReservationFingerprint: reservations.reservationSets.find(item => item.requestId === ready.requestId)!.fingerprint,
    reason: '医生确认人工修订参数与整批清单',
  })
  expect(confirmed.status, await confirmed.clone().text()).toBe(200)
  const selection = await s.fixture.read('inpatient-doctor', `${s.stay.path}/pci-selection`, inpatientPciSelectionSchema)
  expect(selection.confirmation!.parameters.measurements[0]).toMatchObject({ value: 13, source: { note: expect.stringContaining('人工修订') } })
  expect(selection.confirmation!.parameters.measurements[0]!.source.reference).not.toBe(`DiagnosticReport/${original.reportId}`)
  expect(selection.confirmation!.parameters.measurements.slice(1)).toEqual(original.parameters.measurements.slice(1))
  const report = (await s.fixture.read('inpatient-doctor', `${s.stay.path}/angiography-reports`, inpatientAngiographyReportsSchema)).reports[0]!
  expect(report.measurements).toEqual(original.parameters.measurements)
  const fhir = await s.fixture.read('inpatient-doctor', `/fhir/R5/DiagnosticReport/${original.reportId}`, fhirResourceSchema)
  expect(fhir.conclusion).toContain('lesion-length：12 mm')
  expect(fhir.conclusion).not.toContain('13 mm')
})

it('测量内容任一字段修订都不能冒用报告来源，原确认入口同样复核来源', async () => {
  const s = await setup()
  await s.fixture.executeAngiography(s.stay)
  await s.fixture.runtime.dispatcher.dispatchOnce({ kinds: ['inpatient.angiography.report'] })
  const original = (await s.fixture.read('inpatient-doctor', `${s.stay.path}/pci-selection`, inpatientPciSelectionSchema)).drafts![0]!
  const changes: Array<Partial<InpatientPciSelectionParameters['measurements'][number]>> = [
    { value: 13 }, { object: 'external-elastic-membrane' }, { site: 'LAD 其他段' }, { unit: 'cm' }, { method: '医生人工复核测量' },
  ]
  let version = original.version
  for (const change of changes) {
    const response = await s.fixture.request('inpatient-doctor', `${s.stay.path}/pci-selection/save`, {
      requestId: original.requestId, expectedDraftVersion: version, parameters: { ...original.parameters,
        measurements: original.parameters.measurements.map(item => item.kind === 'lesion-length' ? { ...item, ...change } : item) },
    })
    expect(response.status).toBe(200)
    const current = (await s.fixture.read('inpatient-doctor', `${s.stay.path}/pci-selection`, inpatientPciSelectionSchema)).drafts![0]!
    version += 1
    expect(current.reportId).toBe(original.reportId)
    expect(current.reportVersion).toBe(original.reportVersion)
    expect(current.parameters.measurements[0]!.source).toMatchObject({ reference: `InpatientPciSelectionDraft/${original.requestId}`,
      version: String(version), note: expect.stringContaining('人工修订') })
    expect(current.parameters.measurements.slice(1)).toEqual(original.parameters.measurements.slice(1))
  }
  const confirmed = await s.fixture.request('inpatient-doctor', `${s.stay.path}/pci-selection/confirm`, {
    expectedVersion: 0, parameters: { ...original.parameters,
      measurements: original.parameters.measurements.map(item => item.kind === 'lesion-length' ? { ...item, value: 14 } : item) },
  })
  expect(confirmed.status).toBe(200)
  const selection = await s.fixture.read('inpatient-doctor', `${s.stay.path}/pci-selection`, inpatientPciSelectionSchema)
  expect(selection.confirmation!.parameters.measurements[0]).toMatchObject({ value: 14, source: { note: expect.stringContaining('人工修订') } })
  expect(selection.confirmation!.parameters.measurements[0]!.source.reference).not.toBe(`DiagnosticReport/${original.reportId}`)
  expect(selection.drafts![0]!.parameters.measurements).toEqual(selection.confirmation!.parameters.measurements)
  expect(selection.confirmation!.parameters.measurements.slice(1)).toEqual(original.parameters.measurements.slice(1))
})

it.each(['missing', 'unit', 'outside'] as const)('造影来源%s时保留真实缺项或范围限制，不用固定底稿补值', async kind => {
  const s = await setup()
  const row = z.object({ hidden_resources_json: z.string() }).parse(s.fixture.runtime.database.driver.prepare(
    'SELECT hidden_resources_json FROM synthetic_case_truth WHERE case_id=?').get(s.stay.sourceCaseId))
  const facts = z.array(z.object({ resource: z.record(z.string(), z.unknown()), sourceReference: z.string() })).parse(JSON.parse(row.hidden_resources_json))
  const next = facts.flatMap(item => {
    const source = String(item.resource.id ?? '')
    if (!source.startsWith('pci-angiography-')) return [item]
    if (kind === 'missing') return []
    if (source === 'pci-angiography-proximal-reference-diameter' && kind === 'unit')
      return [{ ...item, resource: { ...item.resource, valueQuantity: { value: 3 } } }]
    if (source === 'pci-angiography-lesion-length' && kind === 'outside')
      return [{ ...item, resource: { ...item.resource, valueQuantity: { value: 17, unit: 'mm' } } }]
    return [item]
  })
  s.fixture.runtime.database.driver.prepare('UPDATE synthetic_case_truth SET hidden_resources_json=? WHERE case_id=?')
    .run(JSON.stringify(next), s.stay.sourceCaseId)
  await s.fixture.executeAngiography(s.stay)
  await s.fixture.runtime.dispatcher.dispatchOnce({ kinds: ['inpatient.angiography.report'] })
  const report = (await s.fixture.read('inpatient-doctor', `${s.stay.path}/angiography-reports`, inpatientAngiographyReportsSchema)).reports[0]!
  expect(report.status).toBe(kind === 'missing' ? 'unavailable' : kind === 'unit' ? 'partial' : 'final')
  if (kind === 'unit') expect(report.measurements.find(item => item.kind === 'proximal-reference-diameter')).toMatchObject({ value: 3, unit: null })
  const selection = await s.fixture.read('inpatient-doctor', `${s.stay.path}/pci-selection`, inpatientPciSelectionSchema)
  expect(selection.confirmation).toBeNull()
  expect(selection.candidates.every(item => item.eligibility === (kind === 'outside' ? 'inapplicable' : 'incomplete'))).toBe(true)
  const estimate = (await s.fixture.read('inpatient-doctor', `${s.stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates.find(item => item.requestId === s.stay.requestId)!
  expect(estimate.status).toBe('incomplete')
  expect(estimate.draft).toBeNull()
  expect(s.prepared.modelCalls).toBe(0)
})

it('报告晚到保留医生已确认的手填选型，不替换为报告值', async () => {
  const s = await setup()
  const parameters = { ...pciAgentParameters, requestId: s.stay.requestId,
    measurements: pciAgentParameters.measurements.map(item => item.kind === 'lesion-length' ? { ...item, value: 10 } : item) }
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/pci-selection/confirm`, { expectedVersion: 0, parameters })).status).toBe(200)
  await s.fixture.executeAngiography(s.stay)
  await s.fixture.runtime.dispatcher.dispatchOnce({ kinds: ['inpatient.angiography.report'] })
  const selection = await s.fixture.read('inpatient-doctor', `${s.stay.path}/pci-selection`, inpatientPciSelectionSchema)
  expect(selection.confirmation?.parameters).toEqual(parameters)
  expect(selection.drafts).toEqual([])
})

it('医生从原确认入口显式修订参数后，候选采用人工值而非旧报告草稿', async () => {
  const s = await setup()
  await s.fixture.executeAngiography(s.stay)
  await s.fixture.runtime.dispatcher.dispatchOnce({ kinds: ['inpatient.angiography.report'] })
  const draft = (await s.fixture.read('inpatient-doctor', `${s.stay.path}/pci-selection`, inpatientPciSelectionSchema)).drafts![0]!
  const reports = await s.fixture.read('inpatient-doctor', `${s.stay.path}/angiography-reports`, inpatientAngiographyReportsSchema)
  expect(reports.reports).toContainEqual(expect.objectContaining({ id: draft.reportId, version: draft.reportVersion,
    measurements: expect.arrayContaining([expect.objectContaining({ kind: 'lesion-length', value: 12 })]) }))
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/pci-selection/save`, {
    requestId: draft.requestId, expectedDraftVersion: draft.version, parameters: { ...draft.parameters,
      measurements: draft.parameters.measurements.map(item => item.kind === 'lesion-length' ? { ...item, value: 13 } : item) },
  })).status).toBe(200)
  const parameters = { ...pciAgentParameters, requestId: s.stay.requestId,
    measurements: pciAgentParameters.measurements.map(item => item.kind === 'lesion-length' ? { ...item, value: 17 } : item) }
  const response = await s.fixture.request('inpatient-doctor', `${s.stay.path}/pci-selection/confirm`, { expectedVersion: 0, parameters })
  expect(response.status).toBe(200)
  const confirmation = inpatientPciSelectionResponseSchema.parse(await response.json()).data.confirmation!
  expect(confirmation).not.toBeNull()
  const selection = await s.fixture.read('inpatient-doctor', `${s.stay.path}/pci-selection`, inpatientPciSelectionSchema)
  const expectedParameters = { ...parameters, measurements: parameters.measurements.map(measurement => ({ ...measurement,
    source: { reference: `InpatientPciSelection/${confirmation.id}`, version: '1', synthetic: true,
      note: `医生人工修订；原报告 DiagnosticReport/${draft.reportId} v${draft.reportVersion}` },
  })) }
  expect(confirmation.version).toBe(1)
  expect(selection.confirmation).toEqual(confirmation)
  expect(confirmation.parameters).toEqual(expectedParameters)
  expect(selection.history).toEqual([confirmation])
  expect(selection.drafts).toEqual([{ ...draft, version: 3, edited: true,
    parameters: expectedParameters, confirmedSelectionVersion: 1 }])
  expect(await s.fixture.read('inpatient-doctor', `${s.stay.path}/angiography-reports`, inpatientAngiographyReportsSchema)).toEqual(reports)
  expect(selection.candidates.every(item => item.eligibility === 'inapplicable')).toBe(true)
})

it('计划B的编辑草稿不与计划A的默认确认混用，也不污染A预计依据，显式B读取保留其草稿', async () => {
  const s = await setup(true)
  const confirmed = inpatientPciSelectionResponseSchema.parse(await (await s.fixture.request('inpatient-doctor', `${s.stay.path}/pci-selection/confirm`, {
    expectedVersion: 0, parameters: { ...pciAgentParameters, requestId: s.stay.requestId },
  })).json()).data.confirmation!
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/followup/start`, {
    encounterVersion: s.stay.encounterVersion, expectedTaskVersion: 0,
  })).status).toBe(200)
  await s.fixture.runtime.dispatchPending()
  const beforeFollowup = await s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/agent`, inpatientDrgAgentSchema)
  expect(beforeFollowup.status).toBe('succeeded')
  await s.fixture.executeAngiography(s.stay)
  await s.fixture.runtime.dispatchPending()
  const report = (await s.fixture.read('inpatient-doctor', `${s.stay.path}/angiography-reports`, inpatientAngiographyReportsSchema)).reports[0]!
  const encounterVersion = (await s.fixture.read('inpatient-doctor', s.stay.path, inpatientDetailSchema)).admission.versionId
  const planned = inpatientSurgeryResponseSchema.parse(await (await s.fixture.request('inpatient-doctor', `${s.stay.path}/surgeries/request`, {
    encounterVersion, procedureId: s.stay.procedure.id, catalogVersion: s.stay.procedure.version,
    plannedFor: '2026-08-24T15:00:00+08:00', reason: '第二个PCI计划独立准备报告草稿',
  })).json()).data.requests.at(-1)!
  const before = (await s.fixture.read('inpatient-doctor', `${s.stay.path}/material-estimates`, inpatientMaterialEstimatesSchema))
    .estimates.find(item => item.requestId === s.stay.requestId)!
  const followupBeforeEdit = await s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/agent`, inpatientDrgAgentSchema)
  const saved = await s.fixture.request('inpatient-doctor', `${s.stay.path}/pci-selection/save`, {
    requestId: planned.id, expectedDraftVersion: 1, parameters: { ...pciAgentParameters, requestId: planned.id,
      measurements: report.measurements.map(item => item.kind === 'lesion-length' ? { ...item, value: 17 } : item) },
  })
  expect(saved.status).toBe(200)
  const explicitB = inpatientPciSelectionResponseSchema.parse(await saved.json()).data
  const selected = await s.fixture.read('inpatient-doctor', `${s.stay.path}/pci-selection`, inpatientPciSelectionSchema)
  expect(selected.confirmation).toEqual(confirmed)
  expect(selected.candidates.every(item => item.eligibility === 'valid' && item.expectedQuantity === 1)).toBe(true)
  expect(selected.drafts?.map(item => item.requestId)).toEqual([planned.id])
  expect(explicitB.confirmation).toBeNull()
  expect(explicitB.drafts?.map(item => item.requestId)).toEqual([planned.id])
  expect(explicitB.candidates.every(item => item.eligibility === 'inapplicable')).toBe(true)
  expect(explicitB.history).toEqual([confirmed])
  const after = await s.fixture.read('inpatient-doctor', `${s.stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)
  expect(after.estimates.find(item => item.requestId === s.stay.requestId)!.basisFingerprint).toBe(before.basisFingerprint)
  expect(after.estimates.find(item => item.requestId === planned.id)!.candidates.every(item => item.eligibility === 'inapplicable')).toBe(true)
  const followup = await s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/agent`, inpatientDrgAgentSchema)
  expect(followup.basisFingerprint).toBe(followupBeforeEdit.basisFingerprint)
  expect(followup.lastAnalysis?.sources).toMatchObject({ selectionConfirmationId: confirmed.id, selectionVersion: confirmed.version })
  expect(followup.missing.join(' ')).not.toContain('测量不在已核验仿真范围')
  const unboundResponse = await s.fixture.request('inpatient-doctor', `${s.stay.path}/pci-selection/confirm`, {
    expectedVersion: confirmed.version, parameters: pciAgentParameters,
  })
  expect(unboundResponse.status).toBe(200)
  const unbound = await s.fixture.read('inpatient-doctor', `${s.stay.path}/pci-selection`, inpatientPciSelectionSchema)
  expect(unbound.confirmation!.parameters.requestId).toBeUndefined()
  expect(unbound.candidates.every(item => item.eligibility === 'valid' && item.expectedQuantity === 1)).toBe(true)
  expect(unbound.drafts?.map(item => item.requestId)).toEqual([planned.id])
  expect(unbound.history).toContainEqual(confirmed)
})
