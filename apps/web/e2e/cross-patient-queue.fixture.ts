import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Page } from '@playwright/test'
import { commandResponseSchema } from '@clinmesh/contracts/his'
import {
  patientPersonaRevisionSchema, scenarioGenerationJobSchema, syntheticCaseInstanceSchema,
  syntheticPatientProfileDetailSchema, syntheticPatientProfileListSchema,
} from '@clinmesh/contracts/scenario'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { sourceArtifactHash } from '../../server/src/application/scenario-data/provider.ts'
import { expect, test as base } from './fixtures.ts'
import { drgBrowserApi } from './inpatient-drg.fixture.ts'

const sourceBundle = z.object({ entry: z.array(z.object({ resource: z.object({
  resourceType: z.string(), name: z.array(z.object({ text: z.string() }).passthrough()).optional(),
}).passthrough() }).passthrough()) }).passthrough()

/** 每次只有一个合成 source，保留 FHIR 引用，同时使 profile/case/hash 各自独立。 */
class QueueSyntheaProvider extends StubSyntheaProvider {
  private generation = 0
  override async generate() {
    const corpus = await super.generate()
    for (const source of corpus.sources) {
      const raw = sourceBundle.parse(source.raw)
      const patient = raw.entry.find(entry => entry.resource.resourceType === 'Patient')
      if (!patient) throw new Error('Missing synthetic Patient')
      patient.resource.name = [{ text: `合成连续就诊${++this.generation}` }]
      source.raw = raw
      source.hash = sourceArtifactHash(raw)
    }
    return corpus
  }
}

export const libraryTest = base.extend({ browserApp: async ({ webRoot }, use) => {
  const app = await startBrowserServer(webRoot, { syntheaProvider: new QueueSyntheaProvider() })
  try { await use(app) } finally { await app.close() }
} })

export async function observeQueuePage(page: Page) {
  const media: string[] = [], errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route(/\/(?:imaging-studies|imaging-assets|pathology-assets)\/|\/(?:blocks|tiles)\//, async route => {
    media.push(new URL(route.request().url()).pathname)
    await route.abort('blockedbyclient')
  })
  return { media, errors, assertClean() { expect(media).toEqual([]); expect(errors).toEqual([]) } }
}

export async function preparePatientLibraryQueue(page: Pick<Page, 'request'>, app: Awaited<ReturnType<typeof startBrowserServer>>) {
  const api = drgBrowserApi(page, app)
  await api.login('admin')
  const write = (path: string, data: unknown, method: 'POST' | 'PUT' = 'POST') => page.request.fetch(app.origin + path, {
    method, headers: { origin: app.origin, 'idempotency-key': randomUUID() }, data,
  })
  for (let index = 0; index < 3; index++) {
    const response = await write('/api/sim/v1/scenario-generation-jobs', {
      name: `合成连续就诊批次${index + 1}`, population: { age: { maximum: 65, minimum: 18 }, count: 1, gender: 'any' },
      providerId: 'synthea', seeds: { clinical: 7331 + index, population: 4242 + index },
      timeRange: { end: '2026-08-01', start: '2020-01-01' }, timeZone: 'Asia/Shanghai',
    })
    expect(response.status()).toBe(200)
    const queued = commandResponseSchema(scenarioGenerationJobSchema).parse(await response.json()).data
    const processed = await app.runtime.scenarioData.processNextGenerationJob()
    expect(processed?.jobId).toBe(queued.jobId)
    const job = scenarioGenerationJobSchema.parse(await (await api.get(`/api/sim/v1/scenario-generation-jobs/${queued.jobId}`)).json())
    expect(job.status).toBe('succeeded')
    expect(job.profileIds).toHaveLength(1)
    expect(job.caseIds).toHaveLength(1)
    const path = `/api/sim/v1/synthetic-cases/${job.caseIds[0]!}`
    const initial = syntheticCaseInstanceSchema.parse(await (await api.get(path)).json())
    expect(initial.status).toBe('brief-pending')
    const saved = commandResponseSchema(patientPersonaRevisionSchema).parse(await (await write(path + '/patient-persona-revisions', { input: { content: persona } })).json()).data
    const current = syntheticCaseInstanceSchema.parse(await (await api.get(path)).json())
    const selected = commandResponseSchema(syntheticCaseInstanceSchema).parse(await (await write(path + '/patient-persona-revisions/active', {
      personaRevision: saved.revision, expectedCaseRevision: current.revision,
    }, 'PUT')).json()).data
    expect(selected.status).toBe('brief-ready')
    expect(selected.activeBriefRevision).toBe(saved.revision)
  }
  const list = syntheticPatientProfileListSchema.parse(await (await api.get('/api/sim/v1/synthetic-patients?page=1&pageSize=20')).json())
  expect(list.total).toBe(3)
  expect(new Set(list.items.map(item => item.profileId)).size).toBe(3)
  const details = []
  for (const item of list.items) {
    expect(item.activeVisit).toBe(false)
    const detail = syntheticPatientProfileDetailSchema.parse(await (await api.get(`/api/sim/v1/synthetic-patients/${item.profileId}`)).json())
    expect(detail.case?.status).toBe('brief-ready')
    expect(detail.case?.activeBriefRevision).not.toBeNull()
    const current = syntheticCaseInstanceSchema.parse(await (await api.get(`/api/sim/v1/synthetic-cases/${detail.case!.caseId}`)).json())
    expect(current.status).toBe('brief-ready')
    expect(current.activeBriefRevision).toBe(detail.case!.activeBriefRevision)
    details.push(detail)
  }
  expect(new Set(details.map(detail => detail.source.hash)).size).toBe(3)
  expect(new Set(details.map(detail => detail.case!.caseId)).size).toBe(3)
  return { api, ordered: list.items, details }
}
