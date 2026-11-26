import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 } from 'uuid';
import { expect, it } from 'vitest';
import { BUILTIN_DATA_PACKS } from '../../../server/builtin-data-packs';
import { createNodeSqliteStore } from '../../store';
import { installHospitalDataPack, readHospitalDataPack } from '../index';

const workspaceId = '0192eaf2-cb03-7000-8000-000000000588';
const virtualTime = '2026-08-24T00:00:00Z';
const initial = { workspaceId, virtualTime, expectedEpoch: null };

it('switches institutions atomically and reopens frozen catalog, currency and clinical facts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'clinmesh-packs-'));
  const dbPath = join(directory, 'workspace.sqlite');
  const store = createNodeSqliteStore({ dbPath });
  try {
    const first = await store.withTransaction(tx => installHospitalDataPack(tx, initial, BUILTIN_DATA_PACKS['global-general']));
    const before = await store.read(reader => readHospitalDataPack(reader, first));
    expect(before?.manifest.currency).toMatchObject({ code: 'USD', minorUnitExponent: 2 });
    expect(before?.organization.practitionerRoles.map(role => role.id)).toContain('family-clinician');
    expect(before?.manifest.clinicalRecordTemplate).toHaveLength(6);
    expect(before?.catalog.services.find(item => item.code === 'ecg12')).toMatchObject({ unit: 'tracing', unitPriceMinor: 2850 });
    expect(before?.cases).toHaveLength(4);
    const patient = before!.cases[0]!;
    expect(Object.keys(patient).sort()).toEqual(['demographics', 'encounterClass', 'id', 'priorHistory', 'triageVitals']);
    const encounterId = v7();
    await store.withTransaction(tx => {
      const patientId = v7();
      tx.insert(first, 'patients', { id: patientId, display_name: patient.demographics.name, birth_date: patient.demographics.birthDate, version: 1 });
      tx.insert(first, 'encounters', { id: encounterId, patient_id: patientId, source_case_id: patient.id, encounter_class: patient.encounterClass, status: 'active', active_practitioner_role: 'family-clinician', version: 1, recorded_at: virtualTime, virtual_at: virtualTime });
      tx.insert(first, 'charge_items', { id: v7(), encounter_id: encounterId, order_id: null, description: 'ECG', amount_minor: 2850, currency_code: 'USD', currency_exponent: 2, recorded_at: virtualTime, virtual_at: virtualTime });
    });
    const second = await store.withTransaction(tx => installHospitalDataPack(tx, { ...initial, expectedEpoch: first.epoch }, BUILTIN_DATA_PACKS['cn-cardiology']));
    const active = await store.read(reader => readHospitalDataPack(reader, second));
    expect(active?.manifest.currency.code).toBe('CNY');
    expect(active?.manifest.clinicalRecordTemplate.map(field => field.id)).toContain('admission');
    expect(active?.organization.practitionerRoles.map(role => role.id)).not.toContain('family-clinician');
    expect(active?.catalog.services.some(item => item.code === 'ecg12')).toBe(false);
    expect(active?.catalog.medications).toHaveLength(22);
    const knownBaselines = active!.cases.map(patient => patient.priorHistory.observations[0]!.value).sort((first, second) => Number(first) - Number(second));
    expect(knownBaselines).toEqual([70, 102, 172]);
    expect(await store.read(reader => reader.list(second, 'encounters'))).toEqual([]);
    await expect(store.withTransaction(tx => installHospitalDataPack(tx, { ...initial, expectedEpoch: first.epoch }, BUILTIN_DATA_PACKS['global-general']))).rejects.toMatchObject({ code: 'EPOCH_CONFLICT' });
    const zeroDecimal = structuredClone(BUILTIN_DATA_PACKS['global-general']);
    zeroDecimal.manifest.currency = { code: 'JPY', symbol: '¥', minorUnitExponent: 0 };
    zeroDecimal.catalog.services.find(item => item.code === 'ecg12')!.unitPriceMinor = 900;
    const third = await store.withTransaction(tx => installHospitalDataPack(tx, { ...initial, expectedEpoch: second.epoch }, zeroDecimal));
    await store.close();
    const reopened = createNodeSqliteStore({ dbPath });
    try {
      await reopened.read(reader => {
        expect(reader.getEpoch(first)?.status).toBe('closed');
        expect(reader.getEpoch(third)?.status).toBe('active');
        expect(readHospitalDataPack(reader, first)).toEqual(before);
        expect(readHospitalDataPack(reader, second)).toEqual(active);
        expect(reader.list(third, 'catalog_items', { code: 'ecg12' })[0]).toMatchObject({ amount_minor: 900, currency_code: 'JPY', currency_exponent: 0 });
        expect(reader.list(first, 'charge_items')[0]).toMatchObject({ amount_minor: 2850, currency_code: 'USD', currency_exponent: 2 });
        expect(() => reader.readPrivateCaseTruth(first, { purpose: 'completed-debrief', encounterId })).toThrow();
        expect(reader.readPrivateCaseTruth(first, { purpose: 'simulation', encounterId })?.truth).toHaveProperty('primaryDiagnosis');
      });
    } finally { await reopened.close(); }
  } finally {
    await store.close();
    for (const file of readdirSync(directory)) unlinkSync(join(directory, file));
    rmdirSync(directory);
  }
});

it('rolls an entire pack switch back when the enclosing Command fails', async () => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    const first = await store.withTransaction(tx => installHospitalDataPack(tx, initial, BUILTIN_DATA_PACKS['global-general']));
    const before = await store.exportLogicalSnapshot(workspaceId);
    await expect(store.withTransaction(tx => {
      installHospitalDataPack(tx, { ...initial, expectedEpoch: first.epoch }, BUILTIN_DATA_PACKS['cn-cardiology']);
      throw new Error('Command rolled back');
    })).rejects.toThrow('Command rolled back');
    expect(await store.exportLogicalSnapshot(workspaceId)).toEqual(before);
  } finally { await store.close(); }
});
