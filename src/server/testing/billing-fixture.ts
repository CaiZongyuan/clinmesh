import { v7 } from 'uuid';
import { z } from 'zod';
import { BUILTIN_DATA_PACKS } from '../builtin-data-packs';
import { installHospitalDataPack } from '../../packages/data-pack';
import { OperationCatalog, type Credential } from '../../packages/platform';
import type { StorePort } from '../../packages/store';
import { createBillingModule, type BillingOptions } from '../../packages/mod-billing';

export async function billingFixture(store: StorePort, facility: 'general' | 'cardiology' | 'yen' | 'free' | 'disabled' = 'general', inpatient = false, options: BillingOptions = {}) {
  const pack = structuredClone(BUILTIN_DATA_PACKS[facility === 'cardiology' ? 'cn-cardiology' : 'global-general']);
  if (facility === 'yen') pack.manifest.currency = { code: 'JPY', symbol: '¥', minorUnitExponent: 0 };
  if (facility === 'free') pack.manifest.policies.outpatientInvestigationBillingPolicy = 'free';
  if (facility === 'disabled') pack.manifest.enabledModules = pack.manifest.enabledModules.filter(name => name !== 'mod-billing');
  const instant = '2026-11-26T12:00:00.000Z';
  const encounterId = v7(), patientId = v7(), admissionId = v7(), visitorId = v7();
  const billing = createBillingModule(options);
  const at = await store.withTransaction(tx => {
    const at = installHospitalDataPack(tx, { workspaceId: v7(), virtualTime: instant, recordedAt: instant, expectedEpoch: null }, pack);
    const role = pack.organization.practitionerRoles.find(role => role.capabilities.includes('settle'))!;
    tx.insert(at, 'visitor_sessions', { id: visitorId, practitioner_role: role.id, version: 1, expires_at: '2099-01-01T00:00:00Z', revoked: false });
    tx.insert(at, 'patients', { id: patientId, display_name: 'Synthetic account', birth_date: null, version: 1 });
    tx.insert(at, 'encounters', { id: encounterId, patient_id: patientId, source_case_id: tx.list(at, 'clinical_cases')[0]!.id, encounter_class: inpatient ? 'inpatient' : 'outpatient', status: 'active', active_practitioner_role: role.id, version: 1, recorded_at: instant, virtual_at: instant });
    if (inpatient) tx.insert(at, 'inpatient_admissions', { id: admissionId, encounter_id: encounterId, ward: 'ward', status: 'admitted', version: 1, recorded_at: instant, virtual_at: instant });
    return at;
  });
  const credential: Credential = { ticket: { kind: 'visitor', id: visitorId, workspaceId: at.workspaceId, expiresAt: '2099-01-01T00:00:00Z' } };
  const catalog = new OperationCatalog();
  catalog.contribute(billing.id, billing.registerOperations);
  const call = (name: string, fields: Record<string, unknown> = {}, expectedVersion = 0, key = v7() as string) => catalog.require(name).invoke({ store, credential, targetId: encounterId, body: async () => ({ ...fields, expectedVersion, idempotencyKey: key, epoch: at.epoch }) });
  const order = (code?: string, quantity = 1) => store.withTransaction(tx => {
    const item = tx.list(at, 'catalog_items', code ? { code } : { kind: 'services' })[0]!;
    const orderId = v7();
    tx.insert(at, 'clinical_orders', { id: orderId, encounter_id: encounterId, catalog_item_id: item.id, kind: item.kind === 'medications' ? 'medication' : 'lab', status: 'signed', version: 1, recorded_at: instant, virtual_at: instant });
    const source = { encounterId, orderId, catalogItemId: item.id, catalogVersion: pack.manifest.version, quantity, unitPriceMinor: item.amount_minor!, currencyCode: item.currency_code!, currencyExponent: item.currency_exponent!, virtualAt: instant, recordedAt: instant };
    return { chargeId: billing.freezeCharge(tx, at, source), orderId, amount: item.amount_minor! * quantity, source };
  });
  const read = () => store.read(reader => billing.readAccount(reader, at, encounterId));
  const command = async (name: string, fields: Record<string, unknown> = {}) => z.record(z.string(), z.json()).parse(await call(name, fields, (await read()).version));
  return { at, pack, encounterId, admissionId, patientId, billing, catalog, order, call, command, read, credential, instant, store };
}
