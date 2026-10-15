import { doctorCaseDetailSchema, clinicalDocumentQualityControlStateSchema } from '@clinmesh/contracts/his'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { expect, test } from './fixtures.ts'
import { documentQualityFixture, qualityPatientReply } from './doctor-document-quality-fixture.ts'
import { runDocumentQualityJourney } from './doctor-document-quality-journey.ts'

test('reviews unsaved document quality, retains evidence and signs without a new gate', async ({ page, webRoot }) => {
  const server = await startBrowserServer(webRoot, {
    dshModelBridge: { origin: 'http://127.0.0.1:1', secret: 'synthetic-quality-bridge-secret-at-least-32-characters', timeoutMs: 2000, maxResponseBytes: 8192 },
    patientPersonaModel: 'synthetic-persona', syntheaProvider: new StubSyntheaProvider(), autoDispatchIntervalMs: 30,
    chatCompletionsProvider: { async completeJson(input) {
      if (input.schemaName === 'patient_persona') return { content: JSON.stringify(persona), model: 'synthetic' }
      if (input.schemaName === 'patient_dialogue_reply') return { content: JSON.stringify({ reply: qualityPatientReply }), model: 'synthetic' }
      if (input.schemaName === 'consultation_history_increment') return { content: JSON.stringify({ additions: [] }), model: 'synthetic' }
      if (['clinical_document_quality', 'clinical_document_quality_verification'].includes(input.schemaName)) {
        return { content: JSON.stringify(documentQualityFixture(input)), model: 'synthetic' }
      }
      throw new Error(`Unexpected synthetic model schema: ${input.schemaName}`)
    } },
  })
  try {
    const started = await startConsultationCase(server.runtime, server.password, server.origin)
    await page.goto(`${server.origin}/consultation`)
    await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
    await page.getByLabel('账户密码').fill(server.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByRole('tab', { name: '待诊', exact: true }).click()
    await page.getByText('张琴', { exact: true }).first().click()
    await page.getByRole('button', { name: '开始首诊', exact: true }).click()
    const read = async () => doctorCaseDetailSchema.parse(await (await page.request.get(
      `${server.origin}/api/his/v1/doctor/cases/${started.outpatientCaseId}`)).json())
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    expect(await runDocumentQualityJourney({ page, read,
      quality: async clientId => {
        const response = await page.request.get(`${server.origin}/api/his/v1/doctor/cases/${started.outpatientCaseId}/document-quality-control${clientId === undefined ? '' : `?clientId=${encodeURIComponent(clientId)}`}`)
        expect(response.status()).toBe(200)
        return clinicalDocumentQualityControlStateSchema.parse(await response.json())
      },
    })).toEqual({ signedCount: 1, reviewedWithReason: true, agentSourceChecked: false })
    expect(errors).toEqual([])
  } finally { await server.close() }
})
