import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  inventoryGeneratedSyntheaCorpus,
  scanSyntheaStaticInventory,
} from '../src/application/scenario-data/synthea-dependency-inventory.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { force: true, recursive: true })
  )))
})

async function writeModule(
  directory: string,
  relativePath: string,
  value: unknown,
): Promise<void> {
  const path = join(directory, `${relativePath}.json`)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(value)}\n`, 'utf8')
}

describe('Synthea dependency inventory', () => {
  it('recursively inventories concepts from selected modules and their submodules', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-synthea-modules-'))
    temporaryDirectories.push(directory)
    await writeModule(directory, 'hypertension', {
      name: 'Hypertension',
      states: {
        Diagnose: {
          codes: [{ code: '59621000', display: 'Essential hypertension', system: 'SNOMED-CT' }],
          direct_transition: 'Medication',
          type: 'ConditionOnset',
        },
        Medication: {
          direct_transition: 'Terminal',
          submodule: 'medications/hypertension_medication',
          type: 'CallSubmodule',
        },
      },
    })
    await writeModule(directory, 'medications/hypertension_medication', {
      name: 'hypertension_medication',
      states: {
        Amlodipine: {
          codes: [{ code: '308136', display: 'amLODIPine 2.5 MG Oral Tablet', system: 'RxNorm' }],
          direct_transition: 'Monitoring',
          type: 'MedicationOrder',
        },
        Monitoring: {
          direct_transition: 'Terminal',
          submodule: 'monitoring/blood_pressure',
          type: 'CallSubmodule',
        },
      },
    })
    await writeModule(directory, 'monitoring/blood_pressure', {
      name: 'blood_pressure',
      states: {
        Systolic: {
          codes: [{ code: '8480-6', display: 'Systolic blood pressure', system: 'LOINC' }],
          direct_transition: 'Terminal',
          type: 'Observation',
        },
      },
    })

    const inventory = await scanSyntheaStaticInventory({
      moduleDirectory: directory,
      roots: { hypertension: ['hypertension'] },
      syntheaCommit: 'd9d07a6eef91ee5144293b42ab64224d84d124f8',
    })

    expect(inventory.modules).toEqual([
      'hypertension',
      'medications/hypertension_medication',
      'monitoring/blood_pressure',
    ])
    expect(inventory.concepts).toEqual([
      expect.objectContaining({ code: '8480-6', occurrences: 1, system: 'LOINC' }),
      expect.objectContaining({ code: '308136', occurrences: 1, system: 'RxNorm' }),
      expect.objectContaining({ code: '59621000', occurrences: 1, system: 'SNOMED-CT' }),
    ])
    expect(inventory.roots).toEqual({ hypertension: ['hypertension'] })
    expect(inventory.rootClosures).toEqual({
      hypertension: [
        'hypertension',
        'medications/hypertension_medication',
        'monitoring/blood_pressure',
      ],
    })
  })

  it('counts concepts and resource types in a fixed generated corpus', () => {
    const corpus = {
      bundles: [{
        entry: [{
          resource: {
            code: {
              coding: [{
                code: '8480-6',
                display: 'Systolic blood pressure',
                system: 'http://loinc.org',
              }],
            },
            id: 'systolic-1',
            resourceType: 'Observation',
            status: 'final',
            valueQuantity: {
              code: 'mm[Hg]',
              system: 'http://unitsofmeasure.org',
              unit: 'mmHg',
              value: 162,
            },
          },
        }],
        resourceType: 'Bundle',
        type: 'collection',
      }, {
        entry: [{
          resource: {
            code: {
              coding: [{
                code: '8480-6',
                display: 'Systolic blood pressure',
                system: 'http://loinc.org',
              }],
            },
            id: 'systolic-2',
            resourceType: 'Observation',
            status: 'final',
            valueQuantity: {
              code: 'mm[Hg]',
              system: 'http://unitsofmeasure.org',
              unit: 'mmHg',
              value: 158,
            },
          },
        }, {
          resource: {
            clinicalStatus: { coding: [{ code: 'active' }] },
            code: {
              coding: [{
                code: '59621000',
                display: 'Essential hypertension',
                system: 'http://snomed.info/sct',
              }],
            },
            id: 'hypertension-2',
            resourceType: 'Condition',
          },
        }],
        resourceType: 'Bundle',
        type: 'collection',
      }],
      metadata: {
        clinicalSeed: 7331,
        configHash: '81c9b79f5426b85244f42275f98d2f9e161a4c502980d9cde8d027cdda6ef103',
        localization: {
          dependencies: [{
            canonicalSha256: 'a'.repeat(64),
            datasetId: 'geography-cn',
            releaseId: 'geography-cn@test.r1',
            sqliteSha256: 'b'.repeat(64),
          }, {
            canonicalSha256: 'c'.repeat(64),
            datasetId: 'names-cn',
            releaseId: 'names-cn@test.r1',
            sqliteSha256: 'd'.repeat(64),
          }, {
            canonicalSha256: 'e'.repeat(64),
            datasetId: 'population-cn',
            releaseId: 'population-cn@test.r1',
            sqliteSha256: 'f'.repeat(64),
          }],
          identityAlgorithm: 'synthetic-identity-v1',
          profileContentHash: '1'.repeat(64),
          profileId: 'synthea-cn@test.r1',
          syntheaCommit: 'd9d07a6eef91ee5144293b42ab64224d84d124f8',
        },
        modules: ['hypertension'],
        populationSeed: 4242,
        syntheaCommit: 'd9d07a6eef91ee5144293b42ab64224d84d124f8',
        timeRange: { end: '2026-08-01', start: '1986-08-01' },
        timeZone: 'Asia/Shanghai',
      },
    }

    const inventory = inventoryGeneratedSyntheaCorpus(corpus)
    expect(inventory).toMatchObject({
      concepts: [
        { code: '8480-6', display: 'Systolic blood pressure', occurrences: 2, system: 'http://loinc.org' },
        { code: '59621000', display: 'Essential hypertension', occurrences: 1, system: 'http://snomed.info/sct' },
      ],
      patientCount: 2,
      resourceTypes: [
        { occurrences: 1, resourceType: 'Condition' },
        { occurrences: 2, resourceType: 'Observation' },
      ],
      reproduction: corpus.metadata,
      units: [{
        code: 'mm[Hg]',
        display: 'mmHg',
        occurrences: 2,
        system: 'http://unitsofmeasure.org',
      }],
    })
    expect(inventory.reproduction.localization).toMatchObject({
      profileId: 'synthea-cn@test.r1',
    })
  })
})
