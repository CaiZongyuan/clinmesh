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
            contentHash: 'f57a624291b46caa7cb5d83f7686cb0040a417f8f592119889ea751f4c2a74e1',
            mappingSetId: 'clinmesh-synthea-nhsa-diagnosis',
            version: '2026-08-28',
          }, {
            contentHash: '5bb02fdda48776766d781966e810c1e4870c9ebeb5c7fe8af61910841a5f2451',
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
