import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { test as base, expect } from './fixtures.ts'

export const test = base.extend<{ consultationCase: Awaited<ReturnType<typeof startConsultationCase>> }>({
  browserApp: async ({ webRoot }, use) => {
    const app = await startBrowserServer(webRoot, {
      patientPersonaModel: 'synthetic-persona', syntheaProvider: new StubSyntheaProvider(),
      chatCompletionsProvider: { completeJson: async input => {
        if (input.schemaName !== 'patient_persona') throw new Error(`Unexpected synthetic schema: ${input.schemaName}`)
        return { model: input.model, content: JSON.stringify({ ...persona, chiefComplaint: '发热、咽痛伴肌痛两天',
          symptomExperience: '两天前开始发热、咽痛和肌肉酸痛，未自行服药。', openingStatement: '医生您好，我发烧、喉咙痛两天了。' }) }
      } },
    })
    try { await use(app) } finally { await app.close() }
  },
  consultationCase: async ({ browserApp }, use) => {
    await use(await startConsultationCase(browserApp.runtime, browserApp.password, browserApp.origin,
      { chiefComplaint: '发热、咽痛伴肌痛两天', temperatureC: 38.5 }))
  },
})
export { expect }
