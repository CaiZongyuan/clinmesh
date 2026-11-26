import { v5, v7 } from 'uuid';
import { z } from 'zod';
import type { StoreReader, StoreScope, StoreTx } from '../../store';
import { parseHospitalDataPack } from './compiler';
import { DataPackError } from './errors';
import { catalogKinds } from './references';
import { catalog, demographics, manifest, organization, priorHistory, triageVitals, type HospitalDataPack } from './schema';

const installation = z.strictObject({
  workspaceId: z.uuidv7(), expectedEpoch: z.uuidv7().nullable(), virtualTime: z.iso.datetime(), recordedAt: z.iso.datetime().optional(),
});
type Installation = z.infer<typeof installation>;

function persistPack(tx: StoreTx, at: StoreScope, pack: HospitalDataPack, recordedAt: string) {
  const installationId = v7();
  const { packId, version, currency } = pack.manifest;
  tx.insert(at, 'data_pack_installations', {
    id: installationId, pack_id: packId, pack_version: version, manifest: pack.manifest,
    organization: pack.organization, knowledge: pack.knowledge ?? {}, recorded_at: recordedAt,
  });
  for (const kind of catalogKinds) {
    for (const item of pack.catalog[kind]) {
      const price = 'unitPriceMinor' in item ? item.unitPriceMinor : null;
      tx.insert(at, 'catalog_items', {
        id: v7(), installation_id: installationId, kind, code_system: item.codeSystem, code: item.code,
        definition: item, amount_minor: price, currency_code: price === null ? null : currency.code,
        currency_exponent: price === null ? null : currency.minorUnitExponent,
      });
    }
  }
  for (const patient of pack.cases) {
    const caseId = v5(JSON.stringify([packId, version, patient.caseId, patient.version]), v5.URL);
    tx.insert(at, 'clinical_cases', {
      id: caseId, installation_id: installationId, case_key: patient.caseId, case_version: patient.version,
      encounter_class: patient.encounterClass, demographics: patient.demographics, prior_history: patient.priorHistory, triage_vitals: patient.triageVitals,
    });
    tx.insert(at, 'case_personas', { id: v7(), case_id: caseId, persona: patient.patientPersona });
    tx.writePrivateCaseTruth(at, { id: v7(), case_id: caseId, truth: { ...patient.caseTruth, tags: patient.tags } });
  }
}

export function installHospitalDataPack(tx: StoreTx, input: Installation, raw: unknown): StoreScope {
  const { workspaceId, expectedEpoch, virtualTime, recordedAt = new Date().toISOString() } = installation.parse(input);
  const pack = parseHospitalDataPack(raw);
  const active = tx.listEpochs(workspaceId).find(item => item.status === 'active');
  if ((active?.epoch ?? null) !== expectedEpoch) throw new DataPackError('EPOCH_CONFLICT', 'expectedEpoch');
  if (!tx.getWorkspace(workspaceId)) tx.createWorkspace({ id: workspaceId, recorded_at: recordedAt });
  if (active) tx.updateEpoch({ workspaceId, epoch: active.epoch }, active.clock_revision, { status: 'closed' });
  const at = { workspaceId, epoch: v7() };
  tx.createEpoch(at, { status: 'active', virtual_time: virtualTime, clock_revision: 0 });
  persistPack(tx, at, pack, recordedAt);
  return at;
}

export function readHospitalDataPack(reader: StoreReader, at: StoreScope) {
  const [installed] = reader.list(at, 'data_pack_installations');
  if (!installed) return undefined;
  const rows = reader.list(at, 'catalog_items', { installation_id: installed.id });
  return {
    manifest: manifest.parse(installed.manifest),
    organization: organization.parse(installed.organization),
    catalog: catalog.parse(Object.fromEntries(catalogKinds.map(kind => [kind, rows.filter(row => row.kind === kind).map(row => row.definition)]))),
    cases: reader.list(at, 'clinical_cases', { installation_id: installed.id }).map(patient => ({
      id: patient.id, encounterClass: patient.encounter_class, demographics: demographics.parse(patient.demographics),
      priorHistory: priorHistory.parse(patient.prior_history), triageVitals: triageVitals.parse(patient.triage_vitals),
    })),
  };
}
