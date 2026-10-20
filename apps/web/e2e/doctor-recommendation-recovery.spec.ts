import { z } from 'zod'
import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { doctorRecommendationKindSchema, doctorRecommendationStateSchema, type DoctorRecommendationKind } from '@clinmesh/contracts/doctor-recommendations'
import { ChatCompletionsError } from '../../server/src/infrastructure/ai/openai-chat-completions.ts'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { recommendationFixture } from './doctor-recommendations-fixture.ts'
import { expect, test } from './fixtures.ts'

async function startApp(webRoot: string, initialMode: 'empty' | 'unknown') {
  let mode: 'empty' | 'unknown' | 'exhausted' | 'success' = initialMode
  const calls: Array<{ stage: string; kind: string }> = []
  const app = await startBrowserServer(webRoot, {
    patientPersonaModel: 'synthetic-persona', syntheaProvider: new StubSyntheaProvider(), autoDispatchIntervalMs: 30,
    chatCompletionsProvider: { completeJson: async input => {
      if (input.schemaName === 'patient_persona') return { model: input.model, content: JSON.stringify(persona) }
      const { kind } = z.object({ kind: doctorRecommendationKindSchema }).parse(input.userPayload)
      calls.push({ stage: input.schemaName, kind })
      if (kind === 'diagnosis' && input.schemaName === 'doctor_recommendation_verification') {
        if (mode === 'unknown') throw new ChatCompletionsError('AI_TIMEOUT', 'Synthetic unknown response')
        if (mode === 'exhausted') throw new ChatCompletionsError('AI_REQUEST_FAILED', 'Synthetic complete technical failure', { httpStatus: 503 })
      }
      const result = mode === 'empty' || kind !== 'diagnosis'
        ? { items: [], considerations: [], missingInformation: [] } : recommendationFixture(input)
      return { model: input.model, content: JSON.stringify(result) }
    } },
  })
  return { ...app, calls, setMode: (next: typeof mode) => { mode = next } }
}

test('saving identical text preserves all five automatic preparations and their generations', async ({ page, webRoot }) => {
  const app = await startApp(webRoot, 'empty')
  try {
    const started = await startConsultationCase(app.runtime, app.password, app.origin)
    await page.goto(`${app.origin}/consultation`)
    await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
    await page.getByLabel('账户密码').fill(app.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByRole('tab', { name: '待诊', exact: true }).click()
    await page.locator(`[data-agent-selection="${started.outpatientCaseId}"]`).click()
    await page.getByRole('button', { name: '开始首诊', exact: true }).click()
    const read = async (kind: DoctorRecommendationKind) => doctorRecommendationStateSchema.parse(await (await page.request.get(
      `${app.origin}/api/his/v1/doctor/cases/${started.outpatientCaseId}/recommendations/${kind}`)).json())
    const readAll = () => Promise.all(doctorRecommendationKindSchema.options.map(read))
    await expect.poll(async () => (await readAll()).map(state => state.status)).toEqual(Array(5).fill('missing-evidence'))
    expect(app.calls).toHaveLength(5)
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await page.getByLabel('现病史', { exact: true }).fill('合成记录：站起时头晕。')
    const save = page.getByRole('button', { name: '保存病历草稿', exact: true })
    const detail = async () => doctorCaseDetailSchema.parse(await (await page.request.get(
      `${app.origin}/api/his/v1/doctor/cases/${started.outpatientCaseId}`)).json())
    await save.click()
    await expect.poll(async () => (await readAll()).map(state => [state.generation, state.status, state.stale]))
      .toEqual(Array.from({ length: 5 }, () => [2, 'missing-evidence', false]))
    expect(app.calls).toHaveLength(10)
    const before = await detail()
    const previous = await readAll()
    const saved = page.waitForResponse(response => response.request().method() === 'PUT'
      && new URL(response.url()).pathname.endsWith('/clinical-document/draft') && response.status() === 200)
    await save.click()
    await saved
    await expect.poll(async () => (await detail()).clinicalDocument?.draft?.version).toBe(before.clinicalDocument!.draft!.version + 1)
    // Public reads and the visible preparation panel settle after the source version changed.
    await page.getByRole('tab', { name: '诊断', exact: true }).click()
    await expect(page.getByRole('region', { name: '待确认诊断', exact: true }).getByRole('button', { name: '刷新', exact: true })).toBeEnabled()
    const after = await readAll()
    expect(after.map(state => [state.generation, state.inputFingerprint, state.stale]))
      .toEqual(previous.map(state => [state.generation, state.inputFingerprint, false]))
    expect(app.calls).toHaveLength(10)
  } finally { await app.close() }
})

test('continues only unknown verification, exposes exhaustion, and explicitly regenerates with new quota', async ({ page, webRoot }) => {
  const app = await startApp(webRoot, 'unknown')
  try {
    const started = await startConsultationCase(app.runtime, app.password, app.origin)
    await page.goto(`${app.origin}/consultation`)
    await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
    await page.getByLabel('账户密码').fill(app.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByRole('tab', { name: '待诊', exact: true }).click()
    await page.locator(`[data-agent-selection="${started.outpatientCaseId}"]`).click()
    await page.getByRole('button', { name: '开始首诊', exact: true }).click()
    await page.getByRole('tab', { name: '诊断', exact: true }).click()
    const panel = page.getByRole('region', { name: '待确认诊断', exact: true })
    const read = async () => doctorRecommendationStateSchema.parse(await (await page.request.get(
      `${app.origin}/api/his/v1/doctor/cases/${started.outpatientCaseId}/recommendations/diagnosis`)).json())
    const diagnosisCalls = () => app.calls.filter(call => call.kind === 'diagnosis').map(call => call.stage)
    await expect(panel.getByText(/上次请求结果未知/)).toBeVisible()
    expect((await read()).items).toEqual([])
    expect(diagnosisCalls()).toEqual(['doctor_recommendations', 'doctor_recommendation_verification'])
    app.setMode('success')
    await panel.getByRole('button', { name: '继续原任务', exact: true }).click()
    await expect(panel.getByRole('button', { name: /^确认选中诊断/ })).toBeEnabled()
    expect(await read()).toMatchObject({ generation: 1, status: 'ready', recovery: { requestCount: 3 } })
    expect(diagnosisCalls()).toEqual(['doctor_recommendations', 'doctor_recommendation_verification', 'doctor_recommendation_verification'])
    app.setMode('exhausted')
    await panel.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(panel.getByText(/本次任务的请求次数已用完/)).toBeVisible()
    expect(await read()).toMatchObject({ generation: 2, status: 'failed', recovery: { requestCount: 4, status: 'exhausted' } })
    await expect(panel.getByRole('button', { name: '继续原任务', exact: true })).toHaveCount(0)
    await expect(panel.getByRole('button', { name: /^确认选中诊断/ })).toBeDisabled()
    app.setMode('success')
    await panel.getByRole('button', { name: '重新生成', exact: true }).click()
    await expect(panel.getByRole('button', { name: /^确认选中诊断/ })).toBeEnabled()
    expect(await read()).toMatchObject({ generation: 3, status: 'ready', recovery: { requestCount: 2, extraRequestCount: 0 } })
    const detail = doctorCaseDetailSchema.parse(await (await page.request.get(`${app.origin}/api/his/v1/doctor/cases/${started.outpatientCaseId}`)).json())
    expect(detail.diagnosis?.confirmation).toBeUndefined()
  } finally { await app.close() }
})
