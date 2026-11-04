import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { afterEach, expect, it } from 'vitest'
import { inpatientDrgRecordChecksSchema } from '@clinmesh/contracts/inpatient-drg-review'
import { inpatientDrgExplanationSchema, inpatientDrgExplanationResponseSchema } from '@clinmesh/contracts/inpatient-drg-explanation'
import { inpatientDrgFollowupSchema } from '@clinmesh/contracts/inpatient-drg-followup'
import { inpatientDrgAgentSchema } from '@clinmesh/contracts/inpatient-drg-agent'
import { inpatientSurgeryResponseSchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientPciSelectionResponseSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientRecordSchema, inpatientRecordResponseSchema } from '@clinmesh/contracts/inpatient-record'
import { inpatientDischargeResponseSchema, inpatientSettlementPreviewSchema, inpatientSettlementResponseSchema } from '@clinmesh/contracts/inpatient-discharge'
import { inpatientFullClinicalSchema, inpatientChargesSchema } from '@clinmesh/contracts/inpatient-clinical'
import { modelUsageListSchema } from '@clinmesh/contracts/model-usage'
import { z } from 'zod'
import { OpenAIChatCompletionsClient } from '../src/infrastructure/ai/openai-chat-completions.ts'
import { ModelUsageControlError } from '../src/application/model-usage-control.ts'
import { canonicalJsonHash } from '../src/application/scenario-data/canonical-json.ts'
import { createPciPaymentDrgFixture, preparePciPaymentDrgFixture, parsePciResponse } from './fixtures/pci-payment-drg.ts'
import { cancelAutomaticMaterialEstimate, pciAgentParameters } from './fixtures/inpatient-drg-agent.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup(respond?: (schema: string, payload: unknown) => unknown | Promise<unknown>, pci = false) {
  const prepared = await preparePciPaymentDrgFixture()
  cleanups.push(() => rm(prepared.directory, { recursive: true, force: true }))
  const calls: Array<{ schema: string; payload: unknown }> = []
  prepared.options.consultationModel = 'synthetic-check-explanation'
  prepared.options.chatCompletionsProvider = new OpenAIChatCompletionsClient({ apiKey: 'synthetic-only', baseUrl: 'https://synthetic.invalid/v1',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      const schema = body.response_format?.json_schema?.name ?? calls.at(-1)?.schema ?? 'inpatient_drg_recommendation'
      const payload = JSON.parse(body.messages[1].content)
      calls.push({ schema, payload })
      const issues = z.object({ recordChecks: z.object({ issues: z.array(z.object({ key: z.string(), evidence: z.array(z.string()) })) }) }).parse(payload).recordChecks.issues
      const result = respond ? await respond(schema, payload) : { observations: issues.map(issue => schema === 'inpatient_drg_recommendation'
        ? { key: issue.key, explanation: '合成核对说明，请返回原记录核实', evidenceIds: issue.evidence }
        : { key: issue.key, supported: true, reason: '合成核验来源完整' }) }
      return Response.json({ id: randomUUID(), model: 'synthetic-check-explanation', choices: [{ message: { content: JSON.stringify(result) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })
    } })
  const fixture = await createPciPaymentDrgFixture(prepared)
  cleanups.push(() => fixture.runtime.close())
  const pciStay = pci ? await fixture.preparePciAdmission() : null
  if (pciStay) await cancelAutomaticMaterialEstimate(fixture, pciStay)
  const stay = pciStay ?? await fixture.admitSyntheticCase(['I10.x09'], 'bed-general-1')
  return { fixture, stay, pciStay, calls,
    checks: () => fixture.read('inpatient-doctor', `${stay.path}/drg/record-checks`, inpatientDrgRecordChecksSchema),
    explanation: () => fixture.read('inpatient-doctor', `${stay.path}/drg/record-checks/explanation`, inpatientDrgExplanationSchema),
  }
}

function observations(payload: unknown, verification = false) {
  const { issues } = z.object({ recordChecks: z.object({ issues: z.array(z.object({ key: z.string(), evidence: z.array(z.string()) })) }) }).parse(payload).recordChecks
  return issues.map(issue => verification ? { key: issue.key, supported: true, reason: '合成来源核验' }
    : { key: issue.key, explanation: '合成原记录依据解释', evidenceIds: issue.evidence })
}

it('无跟进的护士可读术中及术后用量，医生按需解释并复用同依据的实际计量结果', async () => {
  let costExplanation = '本台已登记导丝费用200元，住院预计费用3065.98元。'
  const s = await setup((schema, payload) => ({ observations: observations(payload, schema === 'inpatient_drg_verification'),
    ...(schema === 'inpatient_drg_recommendation' ? { costExplanation } : { costExplanationSupported: true }) }), true)
  const stay = s.pciStay!
  await parsePciResponse(inpatientPciSelectionResponseSchema, await s.fixture.request('inpatient-doctor', `${stay.path}/pci-selection/confirm`, {
    expectedVersion: 0, parameters: { ...pciAgentParameters, requestId: stay.requestId },
  }))
  const { materials: _materials, ...input } = await s.fixture.pciExecutionInput(stay)
  let surgery = (await parsePciResponse(inpatientSurgeryResponseSchema, await s.fixture.request('inpatient-doctor', `${stay.path}/surgeries/start`, input))).data
  const reservation = stay.reservations.find(item => item.materialId === 'hospital-material-pci-guidewire')!
  surgery = (await parsePciResponse(inpatientSurgeryResponseSchema, await s.fixture.request('inpatient-doctor', `${stay.path}/surgeries/record-material`, {
    requestId: stay.requestId, expectedRequestVersion: surgery.requests.find(item => item.id === stay.requestId)!.version,
    executionId: surgery.inProgress[0]!.id, note: '术者逐笔记录实际使用，护士查看相同正式事实', material: { materialId: reservation.materialId,
      catalogVersion: 1, quantity: 1, reservationId: reservation.id, expectedReservationVersion: reservation.version },
  }))).data
  await s.fixture.runtime.dispatchPending()
  expect(s.calls).toEqual([])
  const board = await s.fixture.read('ward-nurse', `${stay.path}/drg/agent`, inpatientDrgAgentSchema)
  expect(board).toMatchObject({ taskId: null, status: 'inactive', costs: { components: { formalChargesFen: 20000, projectedTotalFen: 306598 } },
    usage: expect.arrayContaining([expect.objectContaining({ materialId: 'hospital-material-pci-guidewire', actualQuantity: 1, remainingQuantity: 0 })]) })
  const checks = await s.checks()
  await parsePciResponse(inpatientDrgExplanationResponseSchema, await s.fixture.request('inpatient-doctor', `${stay.path}/drg/record-checks/explain`, {
    expectedVersion: 0, expectedFingerprint: checks.fingerprint,
  }))
  await s.fixture.runtime.dispatchPending()
  const explained = await s.explanation()
  expect(explained).toMatchObject({ status: 'succeeded', result: { costExplanation } })
  await parsePciResponse(inpatientDrgExplanationResponseSchema, await s.fixture.request('inpatient-doctor', `${stay.path}/drg/record-checks/explain`, {
    expectedVersion: explained.version, expectedFingerprint: checks.fingerprint,
  }))
  await s.fixture.runtime.dispatchPending()
  expect(s.calls).toHaveLength(2)
  const usage = await s.fixture.read('inpatient-doctor', `/api/model-usage/requests?caseId=${stay.admissionId}&taskId=${explained.taskId}`, modelUsageListSchema)
  expect(usage.items).toHaveLength(2)
  expect(usage.items.every(item => item.context.trigger === 'manual')).toBe(true)
  const executionId = surgery.inProgress[0]!.id
  surgery = (await parsePciResponse(inpatientSurgeryResponseSchema, await s.fixture.request('inpatient-doctor', `${stay.path}/surgeries/record-material`, {
    requestId: stay.requestId, expectedRequestVersion: surgery.requests.find(item => item.id === stay.requestId)!.version,
    executionId, note: '术者核实额外一根导丝的实际使用', material: { materialId: reservation.materialId, catalogVersion: 1, quantity: 1 },
  }))).data
  await parsePciResponse(inpatientSurgeryResponseSchema, await s.fixture.request('inpatient-doctor', `${stay.path}/surgeries/complete`, {
    requestId: stay.requestId, expectedRequestVersion: surgery.requests.find(item => item.id === stay.requestId)!.version,
    executionId, note: '完成手术后继续按正式耗材记录解释费用',
  }))
  const postoperative = await s.checks()
  expect(postoperative.usage).toContainEqual(expect.objectContaining({ executionId, materialId: reservation.materialId,
    plannedQuantity: 1, actualQuantity: 2, usedFen: 40000, excessQuantity: 1, additionalFen: 20000 }))
  expect((await s.fixture.read('ward-nurse', `${stay.path}/drg/agent`, inpatientDrgAgentSchema)).usage).toEqual(postoperative.usage)
  expect(s.calls).toHaveLength(2)
  costExplanation = '本台已用导丝费用400元，其中超计划200元。'
  await parsePciResponse(inpatientDrgExplanationResponseSchema, await s.fixture.request('inpatient-doctor', `${stay.path}/drg/record-checks/explain`, {
    expectedVersion: explained.version, expectedFingerprint: postoperative.fingerprint,
  }))
  await s.fixture.runtime.dispatchPending()
  expect(await s.explanation()).toMatchObject({ status: 'succeeded', result: { costExplanation } })
  expect(s.calls).toHaveLength(4)
})

it('未开启跟进时读取核对不派发；按需解释复用结果并从首次调用计量，正式记录不变', async () => {
  const s = await setup(), checks = await s.checks()
  expect(checks.issues).toContainEqual(expect.objectContaining({ kind: 'grouping-incomplete' }))
  expect(await s.explanation()).toMatchObject({ status: 'idle', version: 0, taskId: null, result: null })
  await s.fixture.runtime.dispatchPending()
  expect(s.calls).toHaveLength(0)
  const before = {
    record: await s.fixture.read('inpatient-doctor', `${s.stay.path}/record`, inpatientRecordSchema),
    clinical: await s.fixture.read('inpatient-doctor', `${s.stay.path}/clinical`, inpatientFullClinicalSchema),
    charges: await s.fixture.read('cashier', `${s.stay.path}/charges`, inpatientChargesSchema),
  }
  const requested = await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/record-checks/explain`, {
    expectedVersion: 0, expectedFingerprint: checks.fingerprint,
  })
  expect(requested.status).toBe(200)
  expect(inpatientDrgExplanationResponseSchema.parse(await requested.json()).data.status).toBe('queued')
  await s.fixture.runtime.dispatchPending()
  const completed = await s.explanation()
  expect(completed.status).toBe('succeeded')
  expect(completed.result?.observations.map(item => item.key)).toEqual(checks.issues.map(item => item.key))
  expect(s.calls.map(item => item.schema)).toEqual(['inpatient_drg_recommendation', 'inpatient_drg_verification'])
  expect(Object.keys(s.calls[0]!.payload as object)).toEqual(['recordChecks'])
  expect(s.calls[0]!.payload).not.toHaveProperty('recordChecks.simulation')
  expect(JSON.stringify(s.calls)).not.toMatch(/CaseTruth|caseTruth|hidden/)
  expect(await s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/followup`, inpatientDrgFollowupSchema)).toMatchObject({ task: null })
  const repeated = await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/record-checks/explain`, {
    expectedVersion: completed.version, expectedFingerprint: checks.fingerprint,
  })
  expect(repeated.status).toBe(200)
  await s.fixture.runtime.dispatchPending()
  expect(s.calls).toHaveLength(2)
  const usage = await s.fixture.read('inpatient-doctor', `/api/model-usage/requests?caseId=${s.stay.admissionId}&taskId=${completed.taskId}`, modelUsageListSchema)
  expect(usage.items).toHaveLength(2)
  expect(usage.items.every(item => item.context.trigger === 'manual')).toBe(true)
  expect(await s.fixture.read('inpatient-doctor', `${s.stay.path}/record`, inpatientRecordSchema)).toEqual(before.record)
  expect(await s.fixture.read('inpatient-doctor', `${s.stay.path}/clinical`, inpatientFullClinicalSchema)).toEqual(before.clinical)
  expect(await s.fixture.read('cashier', `${s.stay.path}/charges`, inpatientChargesSchema)).toEqual(before.charges)
  await s.fixture.restart()
  expect((await s.explanation()).result).toEqual(completed.result)
  await s.fixture.runtime.dispatchPending()
  expect(s.calls).toHaveLength(2)
})

async function reviseDiagnosis(s: Awaited<ReturnType<typeof setup>>) {
  const clinical = await s.fixture.read('inpatient-doctor', `${s.stay.path}/clinical`, inpatientFullClinicalSchema)
  const response = await s.fixture.request('inpatient-doctor', `${s.stay.path}/diagnoses/confirm`, {
    encounterVersion: clinical.encounterVersion, expectedRevision: clinical.diagnosis.revision,
    entries: clinical.diagnosis.entries.map(entry => ({ catalogItemId: entry.coding.id,
      role: entry.role, admissionCondition: entry.admissionCondition, note: '医生重新核实当前正式依据' })),
  })
  expect(response.status).toBe(200)
}

it('原模型尝试未知时保留原状态，依据变化和重启均不绕过原尝试重新派发', async () => {
  const s = await setup(async () => { throw new Error('Synthetic response lost after dispatch') }), checks = await s.checks()
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/record-checks/explain`, {
    expectedVersion: 0, expectedFingerprint: checks.fingerprint,
  })).status).toBe(200)
  await s.fixture.runtime.dispatchPending()
  expect(await s.explanation()).toMatchObject({ status: 'unknown', failureCode: 'MODEL_OUTCOME_UNKNOWN', result: null })
  const dispatched = s.calls.length
  await reviseDiagnosis(s)
  const changed = await s.checks(), state = await s.explanation()
  expect(changed.fingerprint).not.toBe(checks.fingerprint)
  expect(state.status).toBe('unknown')
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/record-checks/explain`, {
    expectedVersion: state.version, expectedFingerprint: changed.fingerprint,
  })).status).toBe(409)
  await s.fixture.restart(); await s.fixture.runtime.dispatchPending()
  expect((await s.explanation()).status).toBe('unknown')
  expect(s.calls).toHaveLength(dispatched)
})

it('核验期间正式依据变化使晚到解释失效；新解释需显式展开，其他岗位只读', async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const s = await setup(async (schema, payload) => {
    if (schema === 'inpatient_drg_verification') await held
    return { observations: observations(payload, schema === 'inpatient_drg_verification') }
  }), checks = await s.checks()
  expect((await s.fixture.request('ward-nurse', `${s.stay.path}/drg/record-checks/explain`, {
    expectedVersion: 0, expectedFingerprint: checks.fingerprint,
  })).status).toBe(403)
  expect((await s.fixture.read('medical-records', `${s.stay.path}/drg/record-checks/explanation`, inpatientDrgExplanationSchema)).status).toBe('idle')
  expect(s.calls).toHaveLength(0)
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/record-checks/explain`, {
    expectedVersion: 0, expectedFingerprint: checks.fingerprint,
  })).status).toBe(200)
  const dispatch = s.fixture.runtime.dispatchPending()
  try {
    await expect.poll(() => s.calls.length).toBe(2)
    await reviseDiagnosis(s)
  } finally { release(); await dispatch }
  const stale = await s.explanation()
  expect(stale).toMatchObject({ status: 'stale', result: null })
  expect(stale.fingerprint).not.toBe(checks.fingerprint)
  await s.fixture.runtime.dispatchPending()
  expect(s.calls).toHaveLength(2)
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/record-checks/explain`, {
    expectedVersion: stale.version, expectedFingerprint: stale.fingerprint,
  })).status).toBe(200)
  await s.fixture.runtime.dispatchPending()
  expect(await s.explanation()).toMatchObject({ status: 'succeeded', result: { fingerprint: stale.fingerprint } })
  expect(s.calls).toHaveLength(4)
})

it('AI 引用无关来源时拒绝发布解释，规则结果仍可读且刷新不自行重发', async () => {
  const s = await setup((_schema, payload) => ({ observations: observations(payload).map(item => ({
    ...item, evidenceIds: ['Procedure/unrelated-synthetic-source'],
  })) })), checks = await s.checks()
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/record-checks/explain`, {
    expectedVersion: 0, expectedFingerprint: checks.fingerprint,
  })).status).toBe(200)
  await s.fixture.runtime.dispatchPending()
  expect(await s.explanation()).toMatchObject({ status: 'failed', result: null })
  expect((await s.checks()).issues).toEqual(checks.issues)
  const dispatched = s.calls.length
  expect(dispatched).toBe(2)
  await s.explanation(); await s.fixture.runtime.dispatchPending()
  expect(s.calls).toHaveLength(dispatched)
})

it.each(['核验不支持', '生成格式预算耗尽', '核验格式预算耗尽'])('%s 后显式重新请求会产生新解释，重放及重启保留原用量且不重复派发', async failure => {
  let accept = false
  const s = await setup((schema, payload) => {
    const verification = schema === 'inpatient_drg_verification'
    if (!accept && failure === '生成格式预算耗尽' && !verification) return {
      observations: observations(payload).map(item => ({ ...item, evidenceIds: ['Procedure/unrelated-synthetic-source'] })),
    }
    if (!accept && failure === '核验格式预算耗尽' && verification) return { observations: [] }
    return { observations: observations(payload, verification)
      .map(item => !accept && failure === '核验不支持' && verification ? { ...item, supported: false } : item) }
  })
  const checks = await s.checks()
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/record-checks/explain`, {
    expectedVersion: 0, expectedFingerprint: checks.fingerprint,
  })).status).toBe(200)
  await s.fixture.runtime.dispatchPending()
  const failed = await s.explanation()
  expect(failed.status).toBe('failed')
  const dispatched = failure === '核验格式预算耗尽' ? 3 : 2
  expect(s.calls).toHaveLength(dispatched)
  accept = true
  const key = randomUUID(), input = { expectedVersion: failed.version, expectedFingerprint: checks.fingerprint }
  const retried = await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/record-checks/explain`, input, key)
  expect(retried.status).toBe(200)
  const receipt = inpatientDrgExplanationResponseSchema.parse(await retried.json())
  expect(receipt.data).toMatchObject({ taskId: failed.taskId, version: 2, status: 'queued' })
  await s.fixture.runtime.dispatchPending()
  expect(await s.explanation()).toMatchObject({ status: 'succeeded', version: 2, result: { fingerprint: checks.fingerprint } })
  expect(s.calls).toHaveLength(dispatched + 2)
  const replayed = await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/record-checks/explain`, input, key)
  expect(inpatientDrgExplanationResponseSchema.parse(await replayed.json())).toEqual(receipt)
  await s.fixture.restart(); await s.fixture.runtime.dispatchPending()
  expect((await s.explanation()).status).toBe('succeeded')
  expect(s.calls).toHaveLength(dispatched + 2)
  const usage = await s.fixture.read('inpatient-doctor', `/api/model-usage/requests?caseId=${s.stay.admissionId}&taskId=${failed.taskId}`, modelUsageListSchema)
  expect(usage.items).toHaveLength(dispatched + 2)
})

it.each(['旧版', '新版'])('%s 持久解释在核验派发受阻后重启，复用原生成步骤并保留累计用量', async format => {
  const s = await setup(), checks = await s.checks()
  let blocked = true
  const provider = s.fixture.options.chatCompletionsProvider!, complete = provider.completeJson.bind(provider)
  provider.completeJson = input => {
    if (blocked && input.schemaName === 'inpatient_drg_verification')
      throw new ModelUsageControlError('MODEL_METERING_UNAVAILABLE', 'workspace')
    return complete(input)
  }
  const requested = await parsePciResponse(inpatientDrgExplanationResponseSchema,
    await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/record-checks/explain`, {
      expectedVersion: 0, expectedFingerprint: checks.fingerprint,
    }))
  if (format === '旧版') {
    // 固定升级前协议：无归档投影、无执行版本；公开诊断版本参与原依据身份。
    const clinical = await s.fixture.read('inpatient-doctor', `${s.stay.path}/clinical`, inpatientFullClinicalSchema)
    const { fingerprint: _fingerprint, frozenGrouping: _frozenGrouping, ...legacyChecks } = checks
    const legacyFingerprint = canonicalJsonHash({ workspaceId: 'workspace-demo', epoch: 'epoch-1',
      diagnosisRevision: clinical.diagnosis.revision, ...legacyChecks,
      simulation: checks.simulation ? { ...checks.simulation, evaluatedAt: undefined } : null })
    s.fixture.runtime.database.driver.prepare(`UPDATE inpatient_drg_explanation SET basis_fingerprint=?
      WHERE task_id=?`).run(legacyFingerprint, requested.data.taskId)
    s.fixture.runtime.database.driver.prepare(`UPDATE inpatient_drg_agent_analysis SET basis_fingerprint=?,
      input_json=json_remove(json_set(input_json,'$.recordChecks.fingerprint',?), '$.attemptVersion', '$.recordChecks.frozenGrouping')
      WHERE workspace_id='workspace-demo' AND epoch='epoch-1' AND task_id=?`).run(legacyFingerprint, legacyFingerprint, requested.data.taskId)
    expect(await s.explanation()).toMatchObject({ status: 'queued', fingerprint: legacyFingerprint })
  }
  await s.fixture.runtime.dispatchPending()
  expect(await s.explanation()).toMatchObject({ status: 'blocked', version: 1 })
  expect(s.calls).toHaveLength(1)
  expect(s.calls[0]!.payload).not.toHaveProperty('recordChecks.frozenGrouping')
  const usagePath = `/api/model-usage/requests?caseId=${s.stay.admissionId}&taskId=${requested.data.taskId}`
  const before = await s.fixture.read('inpatient-doctor', usagePath, modelUsageListSchema)
  expect(before.items.map(item => item.context.stage)).toEqual([format === '旧版' ? 'record-check-generation' : 'record-check-1-generation'])
  blocked = false
  await s.fixture.restart(); await s.fixture.runtime.dispatchPending()
  expect(await s.explanation()).toMatchObject({ status: 'succeeded', version: 1, taskId: requested.data.taskId })
  expect(s.calls.map(item => item.schema)).toEqual(['inpatient_drg_recommendation', 'inpatient_drg_verification'])
  const usage = await s.fixture.read('inpatient-doctor', usagePath, modelUsageListSchema)
  expect(usage.items).toHaveLength(2)
  expect(usage.items).toContainEqual(before.items[0])
})

it.each(['queued', 'succeeded'] as const)('已有 %s 解释的病例归档后可只读核查原请求，不再派发模型', async status => {
  const s = await setup(), checks = await s.checks()
  const requested = await parsePciResponse(inpatientDrgExplanationResponseSchema,
    await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/record-checks/explain`, {
      expectedVersion: 0, expectedFingerprint: checks.fingerprint,
    }))
  if (status === 'succeeded') await s.fixture.runtime.dispatchPending()
  expect((await s.explanation()).status).toBe(status)
  const dispatched = s.calls.length
  await s.fixture.depart(s.stay)
  const preview = await s.fixture.read('cashier', `${s.stay.path}/discharge/preview`, inpatientSettlementPreviewSchema)
  const settled = await parsePciResponse(inpatientSettlementResponseSchema, await s.fixture.request('cashier', `${s.stay.path}/discharge/settle`, {
    encounterVersion: preview.encounterVersion, fingerprint: preview.fingerprint,
    expectedChargesFen: preview.chargesFen, expectedBalanceFen: preview.balanceFen,
  }))
  await parsePciResponse(inpatientDischargeResponseSchema, await s.fixture.request('ward-nurse', `${s.stay.path}/discharge/clear`, {
    encounterVersion: settled.data.encounterVersion, reason: '合成核对归档清床',
  }))
  const record = await s.fixture.read('inpatient-doctor', `${s.stay.path}/record`, inpatientRecordSchema)
  const submitted = await parsePciResponse(inpatientRecordResponseSchema, await s.fixture.request('inpatient-doctor', `${s.stay.path}/record/submit`, {
    expectedRevision: 0, expectedSourcesHash: record.sourcesHash, mainProcedureExecutionId: null,
  }))
  const approved = await parsePciResponse(inpatientRecordResponseSchema, await s.fixture.request('medical-records', `${s.stay.path}/record/review`, {
    expectedRevision: submitted.data.revision!.revision, expectedSourcesHash: submitted.data.sourcesHash, outcome: 'approved',
  }))
  await parsePciResponse(inpatientRecordResponseSchema, await s.fixture.request('medical-records', `${s.stay.path}/record/archive`, {
    expectedRevision: approved.data.revision!.revision, expectedSourcesHash: approved.data.sourcesHash,
  }))
  const frozen = await s.fixture.read('medical-records', `${s.stay.path}/drg/record-checks/explanation`, inpatientDrgExplanationSchema)
  expect(frozen).toMatchObject({ status: 'frozen', taskId: requested.data.taskId, version: requested.data.version, result: null })
  const denied = await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/record-checks/explain`, {
    expectedVersion: frozen.version, expectedFingerprint: frozen.fingerprint,
  })
  expect(denied.status).toBe(409)
  expect(await denied.json()).toMatchObject({ error: { code: 'INPATIENT_RECORD_ARCHIVED' } })
  await s.fixture.runtime.dispatchPending(); await s.fixture.restart(); await s.fixture.runtime.dispatchPending()
  expect(await s.explanation()).toMatchObject({ status: 'frozen', taskId: requested.data.taskId })
  const usage = await s.fixture.read('medical-records', `/api/model-usage/requests?caseId=${s.stay.admissionId}&taskId=${frozen.taskId}`, modelUsageListSchema)
  expect(usage.items).toHaveLength(dispatched)
  expect(s.calls).toHaveLength(dispatched)
})
