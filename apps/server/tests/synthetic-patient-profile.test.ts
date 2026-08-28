import { scenarioGenerationRequestSchema, type ScenarioDataset } from '@clinmesh/contracts/scenario'
import { describe, expect, it } from 'vitest'
import { canonicalJsonHash } from '../src/application/scenario-data/canonical-json.ts'
import { createSyntheticPatientProfiles } from '../src/application/scenario-data/synthetic-patient-profile.ts'
import { BuiltInScenarioGenerationProvider } from '../src/infrastructure/scenario-generation/builtin-provider.ts'

const request = scenarioGenerationRequestSchema.parse({
  modules: ['fever'],
  name: '确定性患者',
  population: { age: { maximum: 50, minimum: 30 }, count: 1, gender: 'any' },
  providerId: 'builtin',
  seeds: { clinical: 7331, population: 4242 },
  timeRange: { end: '2026-08-01', start: '2016-08-01' },
  timeZone: 'Asia/Shanghai',
})

describe('Synthetic Patient Profile compilation', () => {
  it('keeps identity deterministic across batches and rejects duplicate artifacts', async () => {
    const corpus = await new BuiltInScenarioGenerationProvider().generate(request)
    const dataset = (datasetId: string): ScenarioDataset => ({
      content: corpus.content,
      contentHash: canonicalJsonHash(corpus.content),
      createdAt: '2026-08-27T09:00:00+08:00',
      datasetId,
      diagnostics: [],
      name: request.name,
      providerId: request.providerId,
      updatedAt: '2026-08-27T09:00:00+08:00',
      version: 1,
      workspaceId: 'workspace-demo',
    })
    const first = createSyntheticPatientProfiles({ dataset: dataset('batch-1'), sources: corpus.sources })
    const second = createSyntheticPatientProfiles({ dataset: dataset('batch-2'), sources: corpus.sources })

    expect(second[0]).toMatchObject({
      identity: first[0]?.identity,
      profileId: first[0]?.profileId,
      source: {
        mappingProvenance: {
          compiler: { id: 'builtin-case-truth', version: '2' },
          packages: [{
            contentHash: '5e9b7faabae742a83d527d0756b9d8bff73dc0ac8a9968e68da06f01652efb87',
            mappingSetId: 'clinmesh-synthea-nhsa-diagnosis',
            version: '2026-08-28',
          }, {
            contentHash: '49091e048017024da99a59e3cd5af625fcca6540525bd2655d1989c8898ee89d',
            mappingSetId: 'clinmesh-rxnorm-drug-concepts',
            version: '2026-08-28',
          }],
        },
        mappingVersion: 'builtin-case-truth-v2',
      },
    })
    expect(() => createSyntheticPatientProfiles({
      dataset: dataset('batch-invalid'),
      sources: [...corpus.sources, ...corpus.sources],
    })).toThrow('exactly one source artifact')

    const mismatchedTarget = dataset('batch-mismatched-target')
    mismatchedTarget.content = {
      ...mismatchedTarget.content,
      catalog: {
        ...mismatchedTarget.content.catalog,
        diagnoses: mismatchedTarget.content.catalog.diagnoses.map(diagnosis => (
          diagnosis.code === 'R50.9' ? { ...diagnosis, id: 'diagnosis-wrong-fever' } : diagnosis
        )),
      },
    }
    expect(() => createSyntheticPatientProfiles({
      dataset: mismatchedTarget,
      sources: corpus.sources,
    })).toThrow('Diagnosis mapping target diagnosis-fever is unavailable')
  })
})
