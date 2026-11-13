import { afterEach, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { inpatientDrgFollowupSchema, inpatientDrgFollowupResponseSchema } from '@clinmesh/contracts/inpatient-drg-followup'
import { inpatientSurgerySchema, inpatientSurgeryRequestReasonSchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientAngiographyReportsSchema } from '@clinmesh/contracts/inpatient-angiography'
import { modelUsageListSchema } from '@clinmesh/contracts/model-usage'
import { OpenAIChatCompletionsClient } from '../src/infrastructure/ai/openai-chat-completions.ts'
import { createPciPaymentDrgFixture, preparePciPaymentDrgFixture } from './fixtures/pci-payment-drg.ts'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const stateSchema = inpatientSurgeryRequestReasonSchema
const draftText = '已确认冠状动脉粥样硬化性心脏病，冠脉造影显示前降支病变，拟进一步介入治疗。'
async function setup(reasonResponse?: () => unknown | Promise<unknown>) {
  const prepared = await preparePciPaymentDrgFixture()
  cleanups.push(() => rm(prepared.directory, { recursive: true, force: true }))
  const payloads: unknown[] = []
  prepared.options.consultationModel = 'synthetic-request-reason'
  prepared.options.chatCompletionsProvider = new OpenAIChatCompletionsClient({ apiKey: 'synthetic-only', baseUrl: 'https://synthetic.invalid/v1', fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)), payload = JSON.parse(body.messages[1].content)
    if (payload.kind === 'surgery-request-reason') payloads.push(payload)
    const feature = body.response_format?.json_schema?.name ?? body.tools?.[0]?.function?.name
    const candidates = payload.estimate?.candidates ?? payload.selection?.candidates ?? []
    const drafted = payload.kind === 'surgery-request-reason' && reasonResponse ? await reasonResponse() : { reason: draftText }
    if (drafted instanceof Response) return drafted
    const result = payload.kind === 'surgery-request-reason' ? drafted : { items: (payload.remaining ?? []).filter((item: {quantity: number}) => item.quantity > 0).map((item: {materialId: string, quantity: number}) => feature === 'inpatient_drg_recommendation'
      ? { materialId: item.materialId, catalogVersion: 1, quantity: item.quantity, reason: '合成依据', evidenceIds: [candidates.find((c: {materialId: string}) => c.materialId === item.materialId).evidence.id] }
      : { materialId: item.materialId, applicable: true, compatible: true, quantitySupported: true, evidenceSupported: true, reason: '合成核验' }) }
    return Response.json({ id: 'synthetic-request-reason', model: 'synthetic-request-reason', choices: [{ message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } })
  } })
  const fixture = await createPciPaymentDrgFixture(prepared)
  cleanups.push(() => fixture.runtime.close())
  const stay = await fixture.preparePciAdmission([])
  return { fixture, stay, payloads, path: `${stay.path}/surgeries/request-reason` }
}
async function enable(s: Awaited<ReturnType<typeof setup>>) {
  const current = await s.fixture.read('inpatient-doctor', `${s.stay.path}/drg/followup`, inpatientDrgFollowupSchema)
  const response = await s.fixture.request('inpatient-doctor', `${s.stay.path}/drg/followup/start`, { encounterVersion: current.encounterVersion, expectedTaskVersion: current.task?.version ?? 0 })
  expect(response.status).toBe(200)
  return inpatientDrgFollowupResponseSchema.parse(await response.json()).data
}
it('开启助手后只按已确认诊断和最近正式造影起草，草稿不写业务且计入本次住院用量', async () => {
  const s = await setup()
  await s.fixture.executeAngiography(s.stay)
  await s.fixture.runtime.dispatchPending()
  const reports = await s.fixture.read('inpatient-doctor', `${s.stay.path}/angiography-reports`, inpatientAngiographyReportsSchema)
  expect(reports.reports.some(report => report.status === 'final')).toBe(true)
  await enable(s)
  const before = await s.fixture.read('inpatient-doctor', `${s.stay.path}/surgeries`, inpatientSurgerySchema)
  const requested = await s.fixture.request('inpatient-doctor', s.path, {})
  expect(requested.status).toBe(200)
  await s.fixture.runtime.dispatchPending()
  const state = await s.fixture.read('inpatient-doctor', s.path, stateSchema)
  expect(state).toMatchObject({ status: 'succeeded', reason: draftText })
  expect(s.payloads).toHaveLength(1)
  expect(s.payloads[0]).toMatchObject({ kind: 'surgery-request-reason', diagnosis: { entries: [expect.objectContaining({ coding: expect.objectContaining({ code: 'I25.103' }) })] }, report: { status: 'final' } })
  expect(s.payloads[0]).not.toHaveProperty('caseTruth')
  expect(await s.fixture.read('inpatient-doctor', `${s.stay.path}/surgeries`, inpatientSurgerySchema)).toEqual(before)
  const usage = await s.fixture.read('inpatient-doctor', `/api/model-usage/requests?caseId=${s.stay.admissionId}&taskId=${state.taskId}`, modelUsageListSchema)
  expect(usage.items).toHaveLength(1)
  expect(usage.items[0]).toMatchObject({ context: { caseId: s.stay.admissionId, encounterId: s.stay.admissionId, stage: 'request-reason-generation' } })
}, 30_000)
it('助手关闭或缺正式报告时不创建草稿，非医生不能读取或请求', async () => {
 const s=await setup()
 expect((await s.fixture.request('ward-nurse',s.path,{})).status).toBe(403)
 expect((await s.fixture.request('ward-nurse',s.path)).status).toBe(403)
 expect((await s.fixture.read('inpatient-doctor',s.path,stateSchema)).status).toBe('unavailable')
 expect((await s.fixture.request('inpatient-doctor',s.path,{})).status).toBe(200)
 await enable(s)
 expect((await s.fixture.read('inpatient-doctor',s.path,stateSchema)).status).toBe('unavailable')
 await s.fixture.runtime.dispatchPending()
 expect(s.payloads).toEqual([])
},30_000)

it('已入队后关闭助手阻止派发并隐藏草稿', async () => {
 const s=await setup()
 await s.fixture.executeAngiography(s.stay)
 await s.fixture.runtime.dispatchPending()
 await enable(s)
 expect((await s.fixture.request('inpatient-doctor',s.path,{})).status).toBe(200)
 const current=await s.fixture.read('inpatient-doctor',`${s.stay.path}/drg/followup`,inpatientDrgFollowupSchema)
 expect((await s.fixture.request('inpatient-doctor',`${s.stay.path}/drg/followup/stop`,{encounterVersion:current.encounterVersion,expectedTaskVersion:current.task!.version,reason:'医生关闭自动跟进'})).status).toBe(200)
 await s.fixture.runtime.dispatchPending()
 expect(await s.fixture.read('inpatient-doctor',s.path,stateSchema)).toMatchObject({status:'unavailable',reason:null})
 expect(s.payloads).toEqual([])
},30_000)

it('模型拒绝或超长结果不发布理由，重复打开不自动重试失败调用', async () => {
 const s=await setup(()=>({reason:'字'.repeat(2001)}))
 await s.fixture.executeAngiography(s.stay)
 await s.fixture.runtime.dispatchPending()
 await enable(s)
 expect((await s.fixture.request('inpatient-doctor',s.path,{})).status).toBe(200)
 await s.fixture.runtime.dispatchPending()
 expect(await s.fixture.read('inpatient-doctor',s.path,stateSchema)).toMatchObject({status:'failed',reason:null})
 const calls=s.payloads.length
 expect((await s.fixture.request('inpatient-doctor',s.path,{})).status).toBe(200)
 await s.fixture.runtime.dispatchPending()
 expect(s.payloads).toHaveLength(calls)
},30_000)

it('模型返回前关闭助手，迟到草稿不发布', async () => {
 let release!:()=>void, entered!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve}), called=new Promise<void>(resolve=>{entered=resolve})
 const s=await setup(async()=>{entered();await gate;return {reason:draftText}})
 await s.fixture.executeAngiography(s.stay)
 await s.fixture.runtime.dispatchPending()
 await enable(s)
 expect((await s.fixture.request('inpatient-doctor',s.path,{})).status).toBe(200)
 const processing=s.fixture.runtime.dispatchPending()
 try {
  await called
  const current=await s.fixture.read('inpatient-doctor',`${s.stay.path}/drg/followup`,inpatientDrgFollowupSchema)
  expect((await s.fixture.request('inpatient-doctor',`${s.stay.path}/drg/followup/stop`,{encounterVersion:current.encounterVersion,expectedTaskVersion:current.task!.version,reason:'医生关闭自动跟进'})).status).toBe(200)
 } finally {release()}
 await processing
 expect(await s.fixture.read('inpatient-doctor',s.path,stateSchema)).toMatchObject({status:'unavailable',reason:null})
 expect(s.payloads).toHaveLength(1)
},30_000)
