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
    const consultationCase = await startConsultationCase(browserApp.runtime, browserApp.password, browserApp.origin,
      { chiefComplaint: '发热、咽痛伴肌痛两天', temperatureC: 38.5 })
    // 临时合成目录提供两个合法剂量，让真实编辑入口能产生未保存改动。
    const configured = browserApp.runtime.database.driver.prepare(`UPDATE outpatient_catalog SET version=version+1,
      config_json=json_set(config_json,'$.allowedDoseTexts',json_array('0.5 g','1 g'))
      WHERE item_id='medication-acetaminophen'`).run()
    expect(configured.changes).toBe(1)
    await use(consultationCase)
  },
})
export { expect }
