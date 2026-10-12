import { z } from 'zod'
import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { ChatCompletionsError } from '../../server/src/infrastructure/ai/openai-chat-completions.ts'
import { journeyReplies, runRecordingJourney, type JourneyStage } from './consultation-recording-journey.ts'
import { expect, test } from './fixtures.ts'

test('combines source review, manual edits, undo, pause, retry and signing in one consultation', async ({ page, webRoot }) => {
  let stage: JourneyStage = 'initial'
  let fail = false
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let extracting = false
  let settled = false
  const server = await startBrowserServer(webRoot, {
    dshModelBridge: { origin: 'http://127.0.0.1:1', secret: 'synthetic-bridge-secret-at-least-32-characters', timeoutMs: 2000, maxResponseBytes: 8192 },
    syntheaProvider: new StubSyntheaProvider(), autoDispatchIntervalMs: 50,
    chatCompletionsProvider: { async completeJson(input) {
      if (input.schemaName === 'patient_persona') return { content: JSON.stringify(persona), model: 'synthetic' }
      if (input.schemaName === 'patient_dialogue_reply') return { content: JSON.stringify({ reply: journeyReplies[stage] }), model: 'synthetic' }
      if (fail) throw new ChatCompletionsError('AI_TIMEOUT', 'Synthetic timeout')
      const payload = z.object({ turns: z.array(z.object({ id: z.string(), messageText: z.string() })),
        history: z.array(z.object({ id: z.string() })) }).parse(input.userPayload)
      const turn = payload.turns.at(-1)!
      if (stage === 'late') { extracting = true; await held }
      const quotes = stage === 'initial' ? ['头晕一周了。', '站起来时更明显。'] : [turn.messageText]
      const result = { content: JSON.stringify({ additions: quotes.map(quote => ({ field: 'historyOfPresentIllness',
        sourceTurnId: turn.id, quote, relation: stage === 'correction' ? 'correction' : 'addition',
        ...(stage === 'correction' ? { targetAdditionId: payload.history[0]!.id } : {}),
      })) }), model: 'synthetic' }
      settled = true
      return result
    } },
  })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    const started = await startConsultationCase(server.runtime, server.password, server.origin)
    await page.goto(`${server.origin}/consultation`)
    await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
    await page.getByLabel('账户密码').fill(server.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByRole('tab', { name: '待诊', exact: true }).click()
    await page.getByText('张琴', { exact: true }).first().click()
    await page.getByRole('button', { name: '开始首诊', exact: true }).click()
    const result = await runRecordingJourney({ page,
      read: async () => doctorCaseDetailSchema.parse(await (await page.request.get(
        `${server.origin}/api/his/v1/doctor/cases/${started.outpatientCaseId}`)).json()),
      stage: async (next, shouldFail = false) => { stage = next; fail = shouldFail; settled = false },
      waitForExtraction: async () => { await expect.poll(() => extracting).toBe(true) },
      releaseExtraction: async () => { release() },
      settleExtraction: async () => {
        await expect.poll(() => settled).toBe(true)
        await expect.poll(() => server.runtime.database.driver.prepare(
          "SELECT count(*) AS count FROM outbox_event WHERE status = 'claimed'",
        ).get()).toEqual({ count: 0 })
      },
    })
    expect(result).toEqual({ processedCount: 6, signedCount: 1 })
    expect(errors).toEqual([])
  } finally { release(); await server.close() }
})
