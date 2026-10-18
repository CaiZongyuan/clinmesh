import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase } from '../../server/tests/fixtures/consultation.ts'
import { test as base, expect } from './fixtures.ts'
import { createRecommendationGuidelineDatabase, recommendationFixture, RecommendationSyntheaProvider } from './doctor-recommendations-fixture.ts'
import { runRecommendationJourney } from './doctor-recommendations-journey.ts'
import { createInvestigationReferenceDatabase } from './investigation-workspace.fixture.ts'

const test = base.extend<{ recommendationCase: Awaited<ReturnType<typeof startConsultationCase>> }>({
  browserApp: async ({ webRoot }, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-recommendation-e2e-'))
    try {
      const referenceDatabasePath = await createInvestigationReferenceDatabase(directory)
      const app = await startBrowserServer(webRoot, {
        activeReferenceReleaseId: 'investigation-e2e-v1', referenceDatabasePath,
        guidelineDatabasePath: createRecommendationGuidelineDatabase(directory),
        patientPersonaModel: 'synthetic-persona', syntheaProvider: new RecommendationSyntheaProvider(), autoDispatchIntervalMs: 30,
        chatCompletionsProvider: { completeJson: async input => ({ model: input.model,
          content: JSON.stringify(input.schemaName === 'patient_persona' ? persona : recommendationFixture(input)) }) },
      })
      try { await use(app) }
      finally { await app.close() }
    } finally { await rm(directory, { recursive: true, force: true }) }
  },
  recommendationCase: async ({ browserApp }, use) => {
    await use(await startConsultationCase(browserApp.runtime, browserApp.password, browserApp.origin))
  },
})

for (const width of [1280, 390]) test(`prepares in the background and directly confirms or issues selected verified items at ${width}px`, async ({ page, browserApp, recommendationCase }) => {
  const errors: string[] = []
  const preparedKinds = new Set<string>()
  page.on('response', response => {
    const match = /recommendations\/(diagnosis|laboratory|imaging|pathology|prescription)$/.exec(new URL(response.url()).pathname)
    if (response.status() === 200 && match?.[1] !== undefined) preparedKinds.add(match[1])
  })
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width, height: 900 })
  await page.goto(`${browserApp.origin}/consultation`)
  await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('tab', { name: '待诊', exact: true }).click()
  if (width === 390) await page.getByRole('button', { name: '候诊患者', exact: true }).click()
  await page.getByRole('button', { name: /^选择病例 / }).click()
  await page.getByRole('button', { name: '开始首诊', exact: true }).click()
  await expect.poll(() => [...preparedKinds].sort()).toEqual(['diagnosis', 'imaging', 'laboratory', 'pathology', 'prescription'])
  await runRecommendationJourney({ page, read: async () => {
    const response = await page.request.get(`${browserApp.origin}/api/his/v1/doctor/cases/${recommendationCase.outpatientCaseId}`)
    expect(response.status()).toBe(200)
    return doctorCaseDetailSchema.parse(await response.json())
  } })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(errors).toEqual([])
})
