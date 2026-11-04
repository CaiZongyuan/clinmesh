import { openWorkspaceTab } from './workspace-tabs.fixture.ts'
import { z } from 'zod'
import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { doctorRecommendationKindSchema, doctorRecommendationStateSchema, type DoctorRecommendationKind } from '@clinmesh/contracts/doctor-recommendations'
import { ChatCompletionsError } from '../../server/src/infrastructure/ai/openai-chat-completions.ts'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, signIn, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { setModelControl } from '../../server/tests/fixtures/model-control.ts'
import { recommendationFixture } from './doctor-recommendations-fixture.ts'
import { expect, test } from './fixtures.ts'

async function startApp(webRoot: string, initialMode: 'empty' | 'unknown') {
  let mode: 'empty' | 'unknown' | 'exhausted' | 'success' = initialMode
  let verificationGate: Promise<void> | undefined
  const calls: Array<{ stage: string; kind: string }> = []
  const app = await startBrowserServer(webRoot, {
    patientPersonaModel: 'synthetic-persona', syntheaProvider: new StubSyntheaProvider(), autoDispatchIntervalMs: 30,
    chatCompletionsProvider: { completeJson: async input => {
      if (input.schemaName === 'patient_persona') return { model: input.model, content: JSON.stringify(persona) }
      const { kind } = z.object({ kind: doctorRecommendationKindSchema }).parse(input.userPayload)
      calls.push({ stage: input.schemaName, kind })
      if (kind === 'diagnosis' && input.schemaName === 'doctor_recommendation_verification') {
        await verificationGate
        if (mode === 'unknown') throw new ChatCompletionsError('AI_TIMEOUT', 'Synthetic unknown response')
        if (mode === 'exhausted') throw new ChatCompletionsError('AI_REQUEST_FAILED', 'Synthetic complete technical failure', { httpStatus: 503 })
      }
      const result = mode === 'empty' || kind !== 'diagnosis'
        ? { items: [], considerations: [], missingInformation: [] } : recommendationFixture(input)
      return { model: input.model, content: JSON.stringify(result) }
    } },
  })
  return { ...app, calls, setMode: (next: typeof mode) => { mode = next },
    setVerificationGate: (gate: Promise<void>) => { verificationGate = gate } }
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
    await expect(page.getByRole('tab', { name: '在诊', exact: true, includeHidden: true })).toHaveAttribute('aria-selected', 'true')
    const read = async (kind: DoctorRecommendationKind) => doctorRecommendationStateSchema.parse(await (await page.request.get(
      `${app.origin}/api/his/v1/doctor/cases/${started.outpatientCaseId}/recommendations/${kind}`)).json())
    const readAll = () => Promise.all(doctorRecommendationKindSchema.options.map(read))
    await expect.poll(async () => (await readAll()).map(state => state.status)).toEqual(Array(5).fill('missing-evidence'))
    expect(app.calls).toHaveLength(5)
    await openWorkspaceTab(page, '病历记录')
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
    await openWorkspaceTab(page, '诊断')
    await expect(page.getByRole('region', { name: '待确认诊断', exact: true }).getByRole('button', { name: '刷新', exact: true })).toBeEnabled()
    const after = await readAll()
    expect(after.map(state => [state.generation, state.inputFingerprint, state.stale]))
      .toEqual(previous.map(state => [state.generation, state.inputFingerprint, false]))
    expect(app.calls).toHaveLength(10)
  } finally { await app.close() }
})

test('continues with automatic retries disabled despite a lost response, then enforces exhaustion and explicit regeneration', async ({ page, webRoot }) => {
  const app = await startApp(webRoot, 'unknown')
  let releaseVerification = () => {}
  const verificationGate = new Promise<void>(resolve => { releaseVerification = resolve })
  try {
    const started = await startConsultationCase(app.runtime, app.password, app.origin)
    await page.goto(`${app.origin}/consultation`)
    await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
    await page.getByLabel('账户密码').fill(app.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByRole('tab', { name: '待诊', exact: true }).click()
    await page.locator(`[data-agent-selection="${started.outpatientCaseId}"]`).click()
    await page.getByRole('button', { name: '开始首诊', exact: true }).click()
    await expect(page.getByRole('tab', { name: '在诊', exact: true, includeHidden: true })).toHaveAttribute('aria-selected', 'true')
    await openWorkspaceTab(page, '诊断')
    const panel = page.getByRole('region', { name: '待确认诊断', exact: true })
    const read = async () => doctorRecommendationStateSchema.parse(await (await page.request.get(
      `${app.origin}/api/his/v1/doctor/cases/${started.outpatientCaseId}/recommendations/diagnosis`)).json())
    const diagnosisCalls = () => app.calls.filter(call => call.kind === 'diagnosis').map(call => call.stage)
    await expect(panel.getByText(/上次请求结果未知/)).toBeVisible()
    expect((await read()).items).toEqual([])
    expect(diagnosisCalls()).toEqual(['doctor_recommendations', 'doctor_recommendation_verification'])
    const admin = await signIn(app.runtime, 'admin@demo.clinmesh.local', app.password, app.origin)
    await setModelControl(app.runtime, admin, { enabled: true, requests: null, automaticRetries: false }, app.origin)
    app.setMode('success')
    app.setVerificationGate(verificationGate)
    let lostResponse = false
    await page.route('**/recommendations/diagnosis/actions/generate', async route => {
      if (route.request().postDataJSON().input.continueGeneration === undefined) return route.continue()
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      expect(doctorRecommendationStateSchema.parse((await response.json()).data)).toMatchObject({ generation: 1, status: 'pending' })
      lostResponse = true
      await route.abort('failed')
    })
    let pendingReads = 0
    const polling = page.waitForResponse(async response => {
      if (response.request().method() !== 'GET' || !new URL(response.url()).pathname.endsWith('/recommendations/diagnosis')) return false
      const state = doctorRecommendationStateSchema.parse(await response.json())
      return state.status === 'pending' && ++pendingReads >= 2
    })
    await panel.getByRole('button', { name: '继续原任务', exact: true }).click()
    await polling
    expect(lostResponse).toBe(true)
    await expect(panel.getByText('正在按最新资料更新，旧自动项目暂不可开具。', { exact: true })).toBeVisible()
    expect(await read()).toMatchObject({ generation: 1, status: 'pending', recovery: { requestCount: 3 } })
    releaseVerification()
    await expect(panel.getByRole('button', { name: /^确认选中诊断/ })).toBeEnabled()
    expect(await read()).toMatchObject({ generation: 1, status: 'ready', recovery: { requestCount: 3 } })
    expect(diagnosisCalls()).toEqual(['doctor_recommendations', 'doctor_recommendation_verification', 'doctor_recommendation_verification'])
    await setModelControl(app.runtime, admin, { enabled: true, requests: null, automaticRetries: true }, app.origin)
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
  } finally { releaseVerification(); await app.close() }
})
