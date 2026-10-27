import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { applyMigrations, openClinMeshDatabase } from '../src/infrastructure/sqlite/database.ts'
import { FhirRepository } from '../src/infrastructure/sqlite/fhir-repository.ts'
import { WorkspaceRepository } from '../src/infrastructure/sqlite/workspace-repository.ts'
import { readInpatientBirthWeight } from '../src/application/inpatient-birth-weight.ts'

it('从同一患者正式出生体重Observation投影克数和版本，缺失/冲突明确未知', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drg-birth-weight-'))
  const database = openClinMeshDatabase({ databasePath: join(directory, 'facts.sqlite'), busyTimeoutMs: 5_000 })
  try {
    applyMigrations(database)
    const context = { workspaceId: 'weight-workspace', epoch: 'weight-epoch' }
    new WorkspaceRepository(database).install({ ...context, scenarioId: 'synthetic-weight', scenarioRunId: 'weight-run', workspaceName: '合成体重' })
    const fhir = new FhirRepository(database)
    fhir.create(context, { resourceType: 'Patient', id: 'synthetic-baby' })
    fhir.create(context, { resourceType: 'Patient', id: 'other-baby' })
    const observation = (id: string, value: number, code = '8339-4', patient = 'synthetic-baby', unit = 'kg') => ({
      resourceType: 'Observation', id, status: 'final', subject: { reference: `Patient/${patient}` },
      code: { coding: [{ system: 'http://loinc.org', code }] },
      valueQuantity: { value, system: 'http://unitsofmeasure.org', code: unit },
    })
    expect(readInpatientBirthWeight(fhir, context, 'synthetic-baby').snapshot).toBeUndefined()
    fhir.create(context, observation('current-weight', 4.2, '29463-7'))
    fhir.create(context, observation('other-birth-weight', 2.5, '8339-4', 'other-baby'))
    const source = fhir.create(context, observation('birth-weight', 3.2))
    expect(readInpatientBirthWeight(fhir, context, 'synthetic-baby').snapshot).toEqual({
      grams: 3200, observations: [{ id: source.id, version: source.meta!.versionId }],
    })
    fhir.create(context, observation('conflicting-weight', 2800, '8339-4', 'synthetic-baby', 'g'))
    expect(readInpatientBirthWeight(fhir, context, 'synthetic-baby').snapshot).toMatchObject({ grams: null })
  } finally { database.close(); await rm(directory, { recursive: true, force: true }) }
})

it.each(['<', '<=', '>', '>='])('出生体重比较符 %s 保持未知，不能把范围边界投影为精确克数', async comparator => {
  const directory = await mkdtemp(join(tmpdir(), 'drg-birth-weight-range-'))
  const database = openClinMeshDatabase({ databasePath: join(directory, 'facts.sqlite'), busyTimeoutMs: 5_000 })
  try {
    applyMigrations(database)
    const context = { workspaceId: 'weight-workspace', epoch: 'weight-epoch' }
    new WorkspaceRepository(database).install({ ...context, scenarioId: 'synthetic-weight', scenarioRunId: 'weight-run', workspaceName: '合成范围体重' })
    const fhir = new FhirRepository(database)
    fhir.create(context, { resourceType: 'Patient', id: 'synthetic-baby' })
    const source = fhir.create(context, {
      resourceType: 'Observation', id: 'range-birth-weight', status: 'final', subject: { reference: 'Patient/synthetic-baby' },
      code: { coding: [{ system: 'http://loinc.org', code: '8339-4' }] },
      valueQuantity: { value: 1, comparator, system: 'http://unitsofmeasure.org', code: 'kg' },
    })
    expect(readInpatientBirthWeight(fhir, context, 'synthetic-baby').snapshot).toEqual({
      grams: null, observations: [{ id: source.id, version: source.meta!.versionId }],
    })
    fhir.create(context, {
      resourceType: 'Observation', id: 'exact-birth-weight', status: 'final', subject: { reference: 'Patient/synthetic-baby' },
      code: { coding: [{ system: 'http://loinc.org', code: '8339-4' }] },
      valueQuantity: { value: 1000, system: 'http://unitsofmeasure.org', code: 'g' },
    })
    expect(readInpatientBirthWeight(fhir, context, 'synthetic-baby').snapshot).toMatchObject({ grams: null })
  } finally { database.close(); await rm(directory, { recursive: true, force: true }) }
})
