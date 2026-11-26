import { v7 } from 'uuid';
import { z } from 'zod';
import { manifestSchema, medicationSchema, pharmacyRulesSchema, publicCaseSchema, readClinicalCase } from '../../data-pack';
import { editEncounter, requireEncounter } from '../../patient-visit';
import { checkVersion, CoreError, sha256, type CommandContext } from '../../platform';
import { canonicalJson, prescriptionDirectionsSchema, type EntityRow, type StoreReader, type StoreScope, type StoreTx } from '../../store';
import { checkPrescription, pharmacyContextSchema, sameCode, type PrescriptionLine } from './safety';

type ChargeSource = { encounterId: string; orderId: string; catalogItemId: string; catalogVersion: string; quantity: number; unitPriceMinor: number; currencyCode: string; currencyExponent: number; virtualAt: string; recordedAt: string };
export interface PharmacyBillingPort {
  freezeCharge(tx: StoreTx, at: StoreScope, row: ChargeSource): string | null;
  readOrderFunds(reader: StoreReader, at: StoreScope, orderId: string): { state: 'free' | 'unpaid' | 'partial' | 'settled' | 'unknown'; locked: boolean };
}

const storedLine = prescriptionDirectionsSchema.extend({ orderId: z.uuidv7() });
const medicationDecision = z.object({ reason: z.string(), virtualAt: z.iso.datetime() });
const prescription = z.object({ prescriptionId: z.uuidv7(), encounterId: z.uuidv7(), version: z.int(), source: z.enum(['internal', 'external']),
  status: z.enum(['signed', 'withdrawn', 'dispensed']), signedAt: z.iso.datetime(), actor: z.string(), role: z.string(),
  snapshotHash: z.string(), lines: z.array(storedLine), withdrawalReason: z.string().nullable() });
export const prescribingViewSchema = z.object({ catalog: z.array(medicationSchema), context: pharmacyContextSchema,
  prescriptions: z.array(prescription), noMedication: medicationDecision.nullable() });
export const allergiesSchema = publicCaseSchema.shape.priorHistory.shape.allergies;

export function outpatient(reader: StoreReader, at: StoreScope, id: string) {
  const encounter = requireEncounter(reader, at, id);
  if (encounter.encounter_class !== 'outpatient') throw new CoreError(409, 'OUTPATIENT_REQUIRED');
  return encounter;
}

export function allergiesFor(reader: StoreReader, at: StoreScope, encounter: EntityRow<'encounters'>) {
  return readClinicalCase(reader, at, encounter.source_case_id)!.priorHistory.allergies;
}

function noMedication(reader: StoreReader, at: StoreScope, encounterId: string) {
  return reader.list(at, 'no_medication_conclusions', { encounter_id: encounterId })[0];
}

export function readPrescription(reader: StoreReader, at: StoreScope, prescriptionId: string) {
  const rx = reader.get(at, 'prescriptions', prescriptionId);
  const signature = reader.list(at, 'prescription_signatures', { prescription_id: prescriptionId })[0];
  if (!rx || !signature) throw new CoreError(404, 'PRESCRIPTION_NOT_FOUND');
  const withdrawal = reader.list(at, 'prescription_withdrawals', { prescription_id: prescriptionId })[0];
  const rows = reader.list(at, 'prescription_orders', { prescription_id: prescriptionId });
  const lines = rows.map(row => {
    const line = reader.list(at, 'prescription_directions', { order_id: row.order_id })[0];
    return { ...line!.directions, orderId: row.order_id };
  });
  return prescription.parse({ prescriptionId, encounterId: rx.encounter_id, version: rx.version,
    source: signature.source, status: rx.status, signedAt: rx.virtual_at,
    actor: signature.actor, role: signature.practitioner_role, snapshotHash: signature.snapshot_hash, lines, withdrawalReason: withdrawal?.reason ?? null });
}

function history(reader: StoreReader, at: StoreScope, encounterId: string) {
  return reader.list(at, 'prescriptions', { encounter_id: encounterId }).flatMap(rx => reader.list(at, 'prescription_signatures', { prescription_id: rx.id }).length ? [readPrescription(reader, at, rx.id)] : []);
}

export function hasMedicationDecision(reader: StoreReader, at: StoreScope, id: string) {
  return Boolean(noMedication(reader, at, id)) || reader.list(at, 'prescriptions', { encounter_id: id }).some(rx =>
    reader.list(at, 'prescription_signatures', { prescription_id: rx.id }).length && !reader.list(at, 'prescription_withdrawals', { prescription_id: rx.id }).length);
}

export function prescribingView(reader: StoreReader, at: StoreScope, encounterId: string) {
  const encounter = outpatient(reader, at, encounterId);
  const pack = reader.list(at, 'data_pack_installations')[0]!;
  const rules = pack.knowledge.pharmacy ? pharmacyRulesSchema.strip().parse(pack.knowledge.pharmacy) : null;
  const prescriptions = history(reader, at, encounterId);
  const decision = noMedication(reader, at, encounterId);
  const allergy = allergiesFor(reader, at, encounter);
  const confirmed = reader.list(at, 'diagnosis_revisions', { encounter_id: encounterId }).sort((first, second) => second.revision - first.revision)[0];
  const diagnoses = confirmed ? reader.list(at, 'diagnosis_confirmations', { revision_id: confirmed.id }).map(item => ({ codeSystem: item.code_system, code: item.code })) : [];
  const now = Date.parse(reader.getEpoch(at)!.virtual_time);
  const patientPrescriptions = reader.list(at, 'encounters', { patient_id: encounter.patient_id, encounter_class: 'outpatient' })
    .flatMap(visit => visit.id === encounterId ? prescriptions : history(reader, at, visit.id));
  const activeMedications = patientPrescriptions.filter(rx => rx.status !== 'withdrawn').flatMap(rx => rx.lines
    .filter(line => Date.parse(rx.signedAt) + line.days * 86_400_000 > now).map(({ code, codeSystem }) => ({ code, codeSystem })));
  return { catalog: reader.list(at, 'catalog_items', { kind: 'medications' }).map(item => medicationSchema.parse(item.definition)),
    context: { rules, diagnoses, activeMedications, allergies: allergy.status === 'confirmed' ? allergy.items.map(item => item.groupCode) : [] },
    prescriptions, noMedication: decision ? { reason: decision.reason, virtualAt: decision.virtual_at } : null };
}

function editDecision(context: CommandContext) {
  const { tx, at, targetId } = context;
  outpatient(tx, at, targetId);
  const pack = tx.list(at, 'data_pack_installations')[0]!;
  const policies = manifestSchema.shape.policies.parse(pack.manifest.policies);
  const version = editEncounter(context, 'active', () => {
    if (policies.requireSignedNoteBeforeOrder && !tx.list(at, 'clinical_record_revisions', { encounter_id: targetId }).length) throw new CoreError(409, 'CLINICAL_DOCUMENT_UNSIGNED');
    if (policies.requireDiagnosisBeforeOrder && !tx.list(at, 'diagnosis_revisions', { encounter_id: targetId }).length) throw new CoreError(409, 'DIAGNOSIS_UNCONFIRMED');
  });
  return { pack, version };
}

export function recordNoMedication(context: CommandContext, reason: string) {
  const { tx, at, targetId, virtualAt, recordedAt } = context;
  const { version } = editDecision(context);
  if (hasMedicationDecision(tx, at, targetId)) throw new CoreError(409, 'MEDICATION_DECISION_CONFLICT');
  const conclusionId = v7();
  tx.insert(at, 'no_medication_conclusions', { id: conclusionId, encounter_id: targetId, reason, virtual_at: virtualAt, recorded_at: recordedAt });
  return { conclusionId, version };
}

export async function signPrescription(context: CommandContext, lines: PrescriptionLine[], billing?: PharmacyBillingPort) {
  const { tx, at, targetId, actor, virtualAt, recordedAt } = context;
  const { pack, version } = editDecision(context);
  if (noMedication(tx, at, targetId)) throw new CoreError(409, 'MEDICATION_DECISION_CONFLICT');
  const view = prescribingView(tx, at, targetId);
  const [issue] = checkPrescription(view.catalog, lines, view.context);
  if (issue) throw new CoreError(409, issue);
  const items = lines.map(line => {
    const item = view.catalog.find(item => sameCode(item, line))!;
    return { item, snapshot: prescriptionDirectionsSchema.parse({ ...line, display: item.display, doseUnit: item.inpatientDoseBasis.unit }) };
  });
  const source = items[0]!.item.source;
  const prescriptionId = v7();
  const times = { virtual_at: virtualAt, recorded_at: recordedAt };
  const catalogVersion = pack.pack_version;
  const snapshotHash = await sha256(canonicalJson({ packId: pack.pack_id, catalogVersion, source, lines: items.map(entry => entry.snapshot) }));
  tx.insert(at, 'prescriptions', { id: prescriptionId, encounter_id: targetId, status: 'signed', version: 1, ...times });
  tx.insert(at, 'prescription_signatures', { id: v7(), prescription_id: prescriptionId, source, actor: actor.id, practitioner_role: actor.role.id, catalog_version: catalogVersion, snapshot_hash: snapshotHash });
  for (const { item, snapshot } of items) {
    const [catalogItem] = tx.list(at, 'catalog_items', { kind: 'medications', code_system: item.codeSystem, code: item.code });
    const orderId = v7();
    tx.insert(at, 'clinical_orders', { id: orderId, encounter_id: targetId, catalog_item_id: catalogItem!.id, kind: 'medication', status: 'issued', version: 1, ...times });
    tx.insert(at, 'prescription_orders', { id: v7(), prescription_id: prescriptionId, order_id: orderId });
    tx.insert(at, 'prescription_directions', { id: v7(), order_id: orderId, directions: snapshot });
    if (source === 'internal') billing?.freezeCharge(tx, at, { encounterId: targetId, orderId, catalogItemId: catalogItem!.id, catalogVersion,
      quantity: snapshot.quantity, unitPriceMinor: item.unitPriceMinor, currencyCode: catalogItem!.currency_code!, currencyExponent: catalogItem!.currency_exponent!, virtualAt, recordedAt });
  }
  return { version, prescriptionId, snapshotHash };
}

export function requireSigned(rx: ReturnType<typeof readPrescription>, expectedVersion: number) {
  if (rx.status === 'withdrawn') throw new CoreError(409, 'PRESCRIPTION_WITHDRAWN');
  if (rx.status === 'dispensed') throw new CoreError(409, 'PRESCRIPTION_DISPENSED');
  checkVersion(rx.version, expectedVersion);
}

export function withdrawPrescription(context: CommandContext, reason: string, noMedicationReason: string | undefined, billing?: PharmacyBillingPort) {
  const { tx, at, targetId, expectedVersion, actor } = context;
  const rx = readPrescription(tx, at, targetId);
  const encounter = outpatient(tx, at, rx.encounterId);
  if (encounter.active_practitioner_role !== actor.role.id) throw new CoreError(403, 'RESPONSIBLE_ROLE_REQUIRED');
  requireSigned(rx, expectedVersion);
  for (const { orderId } of rx.lines) {
    const funds = rx.source === 'internal' && billing ? billing.readOrderFunds(tx, at, orderId) : undefined;
    if (funds && (funds.locked || funds.state === 'partial' || funds.state === 'unknown')) throw new CoreError(409, 'PRESCRIPTION_FUNDS_LOCKED');
    const order = tx.get(at, 'clinical_orders', orderId)!;
    tx.update(at, 'clinical_orders', orderId, order.version, { status: 'cancelled' });
  }
  const lastDecision = !tx.list(at, 'prescriptions', { encounter_id: encounter.id }).some(other => other.id !== targetId && ['signed', 'dispensed'].includes(other.status));
  if (noMedicationReason && !lastDecision) throw new CoreError(409, 'MEDICATION_DECISION_CONFLICT');
  if (encounter.status === 'completed' && lastDecision && !noMedicationReason) throw new CoreError(409, 'REPLACEMENT_DECISION_REQUIRED');
  tx.insert(at, 'prescription_withdrawals', { id: v7(), prescription_id: targetId, reason, actor: actor.id, practitioner_role: actor.role.id, virtual_at: context.virtualAt, recorded_at: context.recordedAt });
  tx.update(at, 'prescriptions', targetId, expectedVersion, { status: 'withdrawn' });
  tx.update(at, 'encounters', encounter.id, encounter.version, { status: encounter.status });
  if (!noMedicationReason) return { version: expectedVersion + 1, conclusionId: null };
  const conclusionId = v7();
  tx.insert(at, 'no_medication_conclusions', { id: conclusionId, encounter_id: encounter.id, reason: noMedicationReason, virtual_at: context.virtualAt, recorded_at: context.recordedAt });
  return { version: expectedVersion + 1, conclusionId };
}
