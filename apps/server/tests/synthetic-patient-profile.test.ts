import {
  scenarioGenerationRequestSchema,
  syntheaCnLocalizationProvenanceSchema,
} from '@clinmesh/contracts/scenario'
import { describe, expect, it } from 'vitest'
import { canonicalJsonHash } from '../src/application/scenario-data/canonical-json.ts'
import type { SourcePatientArtifact } from '../src/application/scenario-data/provider.ts'
import { createSyntheticPatientProfiles } from '../src/application/scenario-data/synthetic-patient-profile.ts'

const profileContentHash = 'd8a4ef19561434cb66c8a391aebfcf6a4dc5f14baf4d4171eac3b8c340b5dd12'
const localization = syntheaCnLocalizationProvenanceSchema.parse({
  clinicalDisplay: {
    catalogSha256: 'd7a25fc414d4008cf59145fd8fc3448556635dd2d5ab8e1e7974bc236f825811',
    language: 'zh-CN',
    projectionId: 'synthea-zh-cn@2026-08-30.r1',
    recordCount: 2180,
    reviewMode: 'experimental-preview',
  },
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
  moduleMode: 'filter',
  modules: ['fever'],
  name: '确定性患者',
  population: { age: { maximum: 50, minimum: 30 }, count: 1, gender: 'any' },
  providerId: 'synthea',
  seeds: { clinical: 7331, population: 4242 },
  timeRange: { end: '2026-08-01', start: '2016-08-01' },
  timeZone: 'Asia/Shanghai',
})

function sourceArtifact(raw: ReturnType<typeof sourceBundle>, patientId = 'patient-cn') {
  return {
    format: 'fhir-r4-bundle' as const,
    hash: canonicalJsonHash(raw),
    patientId,
    raw,
  }
}

function sourceBundle(patientId = 'patient-cn') {
  return {
    entry: [{
      fullUrl: `urn:uuid:${patientId}`,
      resource: {
        birthDate: '1980-01-01',
        gender: 'female',
        id: patientId,
        name: [{ text: '合成患者 source' }],
        resourceType: 'Patient',
      },
    }],
    resourceType: 'Bundle' as const,
    type: 'collection' as const,
  }
}

function profiles(
  batchId: string,
  sources: readonly SourcePatientArtifact[] = [sourceArtifact(sourceBundle())],
) {
  return createSyntheticPatientProfiles({
    batchId,
    batchName: request.name,
    createdAt: '2026-08-27T09:00:00+08:00',
    request,
    sources,
    workspaceId: 'workspace-demo',
  })
}

describe('Synthetic Patient Profile compilation', () => {
  it('keeps identity deterministic across batches and rejects duplicate artifacts', async () => {
    const source = sourceArtifact(sourceBundle())
    const first = profiles('batch-1', [source])
    const second = profiles('batch-2', [source])

    expect(second[0]).toMatchObject({
      demographics: { birthDate: '1980-01-01', gender: 'female' },
      identity: first[0]?.identity,
      profileId: first[0]?.profileId,
      source: {
        batchId: 'batch-2',
        format: 'fhir-r4-bundle',
        generation: {
          moduleMode: 'filter',
          modules: ['fever'],
          ordinal: 0,
          seeds: request.seeds,
          timeRange: request.timeRange,
          timeZone: 'Asia/Shanghai',
        },
        providerId: 'synthea',
        raw: source.raw,
      },
    })
    expect(second[0]?.identity).toMatchObject({
      address: expect.stringMatching(/^虚构测试地址 /),
      displayName: expect.stringMatching(/^合成患者 /),
      insuranceDisplay: '合成医疗保障',
      nationalId: expect.stringMatching(/^990000/),
      phone: expect.stringMatching(/^100\d{8}$/),
    })
    expect(() => profiles('batch-invalid', [source, source]))
      .toThrow('one unique source artifact')
  })

  it('uses a localized Patient identity only when provenance and the Bundle tag agree', async () => {
    const sourcePatient = sourceBundle().entry[0]!.resource
    const patientId = 'synthea-patient-patient-cn'
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
            value: 'CNH4E13CCB7CC71',
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
            value: 'cnh4e13ccb7cc71@example.test',
          }],
        },
      }],
      meta: {
        tag: [{
          code: localization.profileId,
          display: localization.profileContentHash,
          system: 'urn:cn-health-data:synthea-profile',
        }, {
          code: localization.clinicalDisplay.projectionId,
          display: localization.clinicalDisplay.catalogSha256,
          system: 'urn:cn-health-data:synthea-translation',
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

    const profile = profiles('batch-localized', [source])[0]!

    expect(profile).toMatchObject({
      identity: {
        address: '陕西省渭南市合成路178号',
        displayName: '杨秀珍',
        email: 'cnh4e13ccb7cc71@example.test',
        mrn: 'CNH4E13CCB7CC71',
        nationalId: '990000198001010637',
        phone: '10093284819',
      },
      demographics: { birthDate: '1980-01-01', gender: 'female' },
      source: { localization },
    })

    const wrongTag = {
      ...raw,
      meta: {
        ...raw.meta,
        tag: [{ ...raw.meta.tag[0]!, display: 'f'.repeat(64) }],
      },
    }
    expect(() => profiles('batch-wrong-tag', [{ ...source, raw: wrongTag }]))
      .toThrow('localization provenance')

    const withoutProvenance = profiles('batch-without-provenance', [{
      format: source.format,
      hash: source.hash,
      patientId: source.patientId,
      raw: source.raw,
    }])[0]!
    expect(withoutProvenance.identity).toMatchObject({
      displayName: '杨秀珍',
      phone: expect.stringMatching(/^100\d{8}$/),
    })
  })
})
