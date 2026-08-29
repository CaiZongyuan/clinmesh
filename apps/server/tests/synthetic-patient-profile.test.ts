import {
  scenarioGenerationRequestSchema,
  syntheaCnLocalizationProvenanceSchema,
  type ScenarioDataset,
} from '@clinmesh/contracts/scenario'
import { describe, expect, it } from 'vitest'
import { canonicalJsonHash } from '../src/application/scenario-data/canonical-json.ts'
import { createSyntheticPatientProfiles } from '../src/application/scenario-data/synthetic-patient-profile.ts'
import { BuiltInScenarioGenerationProvider } from '../src/infrastructure/scenario-generation/builtin-provider.ts'

const profileContentHash = 'd8a4ef19561434cb66c8a391aebfcf6a4dc5f14baf4d4171eac3b8c340b5dd12'
const localization = syntheaCnLocalizationProvenanceSchema.parse({
  dependencies: [{
    canonicalSha256: '3c632be160c5a3d6e3196b8e95a0b33a25e9f35bcee506b25d7305345c50957a',
    datasetId: 'geography-cn',
    releaseId: 'geography-cn@2026-08-29.r1',
    sqliteSha256: '5ca7121046d49a80b0da38e2b3413a1bc1a7b1040382903ba1d516793e5c5bc7',
  }, {
    canonicalSha256: '4f66c18be0ab19e515927953bd741a1476584f2bdac3d8e6d67221232a31468d',
    datasetId: 'names-cn',
    releaseId: 'names-cn@40.37.0.r1',
    sqliteSha256: '20fc1bc0a0c38b7122635d00aecb710a0ecf1892d91d3c3c190cc9213c2bb0ae',
  }, {
    canonicalSha256: '371dde5944505c426a8ad39be21f647921e754366cb410c0529176d2b6ebfb8a',
    datasetId: 'population-cn',
    releaseId: 'population-cn@WPP2024.r1',
    sqliteSha256: '89858f25d5e898df32f896e8f12b7daf2bc569abb55f8bf69b3f21e988a50a05',
  }],
  identityAlgorithm: 'synthetic-identity-v1',
  profileContentHash,
  profileId: 'synthea-cn@2026-08-29.r3',
  syntheaCommit: 'd9d07a6eef91ee5144293b42ab64224d84d124f8',
})

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
            contentHash: '6d2a98850fb9d3cf96be1cd40d9de7058201f9190f10acb77ca838f7e25a100d',
            mappingSetId: 'clinmesh-rxnorm-drug-concepts',
            version: '2026-08-28',
          }],
        },
        mappingVersion: 'builtin-case-truth-v2',
      },
    })
    expect(second[0]?.identity).toMatchObject({
      address: expect.stringMatching(/^虚构测试地址 /),
      displayName: expect.stringMatching(/^合成患者 /),
      insuranceDisplay: '合成医疗保障',
      nationalId: expect.stringMatching(/^990000/),
      phone: expect.stringMatching(/^100\d{8}$/),
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

  it('uses a localized Patient identity only when provenance and the Bundle tag agree', async () => {
    const corpus = await new BuiltInScenarioGenerationProvider().generate(request)
    const sourcePatient = corpus.content.patients[0]!
    const patientId = 'synthea-patient-patient-cn'
    const content = {
      ...corpus.content,
      patients: [{ ...sourcePatient, id: patientId, name: '合成患者 source' }],
    }
    const dataset: ScenarioDataset = {
      content,
      contentHash: canonicalJsonHash(content),
      createdAt: '2026-08-27T09:00:00+08:00',
      datasetId: 'batch-localized',
      diagnostics: [],
      name: '本地化患者',
      providerId: 'synthea',
      updatedAt: '2026-08-27T09:00:00+08:00',
      version: 1,
      workspaceId: 'workspace-demo',
    }
    const raw = {
      entry: [{
        fullUrl: 'urn:uuid:patient-cn',
        resource: {
          address: [{
            city: '渭南市',
            country: 'CN',
            line: ['陕西省渭南市合成路178号'],
            postalCode: '715300',
            state: '陕西省',
            use: 'home',
          }],
          birthDate: sourcePatient.birthDate,
          gender: sourcePatient.gender,
          id: 'patient-cn',
          identifier: [{
            system: 'https://github.com/synthetichealth/synthea',
            value: 'patient-cn',
          }, {
            system: 'urn:cn-health-data:synthetic-person',
            value: 'urn:uuid:13b0d528-f28a-5bef-a5ad-1a3bdb700d9a',
          }, {
            system: 'urn:cn-health-data:synthetic-mrn',
            value: 'CNH030092236323',
          }, {
            extension: [{ url: 'urn:cn-health-data:synthetic', valueBoolean: true }],
            system: 'urn:cn-health-data:simulated-resident-id',
            value: '990000198001010637',
          }],
          name: [{ family: '杨', given: ['秀珍'], text: '杨秀珍', use: 'official' }],
          resourceType: 'Patient',
          telecom: [{ system: 'phone', use: 'home', value: '10093284819' }, {
            system: 'email',
            use: 'home',
            value: 'cnh030092236323@example.test',
          }],
        },
      }],
      meta: {
        tag: [{
          code: localization.profileId,
          display: localization.profileContentHash,
          system: 'urn:cn-health-data:synthea-profile',
        }],
      },
      resourceType: 'Bundle',
      type: 'collection',
    }
    const source = {
      format: 'fhir-r4-bundle' as const,
      hash: canonicalJsonHash(raw),
      localization,
      patientId,
      raw,
    }

    const profile = createSyntheticPatientProfiles({ dataset, sources: [source] })[0]!

    expect(profile).toMatchObject({
      identity: {
        address: '陕西省渭南市合成路178号',
        displayName: '杨秀珍',
        email: 'cnh030092236323@example.test',
        mrn: 'CNH030092236323',
        nationalId: '990000198001010637',
        phone: '10093284819',
      },
      patient: { name: '杨秀珍' },
      source: { localization },
    })

    const wrongTag = {
      ...raw,
      meta: {
        ...raw.meta,
        tag: [{ ...raw.meta.tag[0]!, display: 'f'.repeat(64) }],
      },
    }
    expect(() => createSyntheticPatientProfiles({
      dataset,
      sources: [{ ...source, raw: wrongTag }],
    })).toThrow('localization provenance')

    const withoutProvenance = createSyntheticPatientProfiles({
      dataset,
      sources: [{
        format: source.format,
        hash: source.hash,
        patientId: source.patientId,
        raw: source.raw,
      }],
    })[0]!
    expect(withoutProvenance.identity).toMatchObject({
      displayName: '合成患者 source',
      phone: expect.stringMatching(/^100\d{8}$/),
    })
  })
})
