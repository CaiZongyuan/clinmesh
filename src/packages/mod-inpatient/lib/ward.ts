import { v7 } from 'uuid';
import { z } from 'zod';
import { organizationSchema } from '../../data-pack';
import type { ClinicalBillingPort } from '../../mod-billing';
import { requireEncounter } from '../../patient-visit';
import { checkVersion, CoreError, type CommandContext } from '../../platform';
import type { EntityRow, StoreReader, StoreScope, StoreTx } from '../../store';

export const id = z.uuidv7();
export const text = z.string().trim().min(1).max(1000);
export const receipt = z.object({ version: z.int().positive() });
export const wardsBase = '/api/his/ward';
export const access = (...capabilities: string[]) => ({ capabilities, visitorOnly: true });
export const route = (name: string, ...capabilities: string[]) => ({ name: `ward.${name}`, path: `${wardsBase}/:id/${name}`, method: 'POST' as const, access: access(...capabilities) });
export const times = (ctx: Pick<CommandContext, 'virtualAt' | 'recordedAt'>) => ({ virtual_at: ctx.virtualAt, recorded_at: ctx.recordedAt });
export function conflict(code: string): never { throw new CoreError(409, code); }
export type Admission = EntityRow<'inpatient_admissions'>;
export interface WardBilling extends ClinicalBillingPort {
  freezeMaterialUse(tx: StoreTx, at: StoreScope, useId: string): string | null;
  reverseMaterialUse(tx: StoreTx, at: StoreScope, useId: string, quantity: number, reason: string, virtualAt: string, recordedAt: string): void;
  readAdmissionFunds(reader: StoreReader, at: StoreScope, encounterId: string): { outstandingMinor: number | null; canClearBed: boolean; locked: boolean };
}
export function organization(reader: StoreReader, at: StoreScope) { return organizationSchema.parse(reader.list(at, 'data_pack_installations')[0]!.organization); }
export function wardDepartment(reader: StoreReader, at: StoreScope, ward: string) {
  return organization(reader, at).wards.find(item => item.id === ward)?.departmentId ?? conflict('WARD_NOT_IN_PACK');
}
export function clinician(reader: StoreReader, at: StoreScope, ward: string) {
  const org = organization(reader, at);
  const department = wardDepartment(reader, at, ward);
  const roles = new Set(org.practitionerRoles.filter(role => role.capabilities.includes('admit')).map(role => role.id));
  return org.practitioners.find(person => person.departmentId === department && roles.has(person.roleId))?.roleId ?? conflict('RESPONSIBLE_ROLE_UNAVAILABLE');
}
export function roleOnWard(ctx: CommandContext, ward: string) {
  const department = wardDepartment(ctx.tx, ctx.at, ward);
  if (!organization(ctx.tx, ctx.at).practitioners.some(person => person.departmentId === department && person.roleId === ctx.actor.role.id)) throw new CoreError(403, 'WARD_ROLE_REQUIRED');
}
export function requireAdmission(reader: StoreReader, at: StoreScope, encounterId: string) {
  const [admission] = reader.list(at, 'inpatient_admissions', { encounter_id: encounterId });
  if (!admission) throw new CoreError(404, 'ADMISSION_NOT_FOUND');
  return admission;
}
export function mutateAdmission(ctx: CommandContext, statuses: readonly string[], role: 'doctor' | 'nurse' | 'other' = 'other') {
  const admission = requireAdmission(ctx.tx, ctx.at, ctx.targetId);
  if (ctx.tx.list(ctx.at, 'medical_record_archives', { admission_id: admission.id }).length) conflict('CHART_ARCHIVED');
  checkVersion(admission.version, ctx.expectedVersion);
  if (!statuses.includes(admission.status)) conflict('ADMISSION_STATE_CONFLICT');
  if (role === 'doctor' && requireEncounter(ctx.tx, ctx.at, ctx.targetId).active_practitioner_role !== ctx.actor.role.id) throw new CoreError(403, 'RESPONSIBLE_ROLE_REQUIRED');
  if (role === 'nurse') roleOnWard(ctx, admission.ward);
  return admission;
}
export function advance(ctx: CommandContext, admission: Admission, status = admission.status, ward = admission.ward) {
  ctx.tx.update(ctx.at, 'inpatient_admissions', admission.id, admission.version, { status, ward });
  return { version: admission.version + 1 };
}
export function occupancy(reader: StoreReader, at: StoreScope, admission: Admission) { return reader.list(at, 'bed_occupancies', { admission_id: admission.id, released_at: null })[0]; }
export function openOrder(tx: StoreTx, at: StoreScope, encounterId: string, itemId: string, kind: EntityRow<'clinical_orders'>['kind'], status: string, when: ReturnType<typeof times>) {
  const order = { id: v7(), encounter_id: encounterId, catalog_item_id: itemId, kind, status, version: 1, ...when };
  tx.insert(at, 'clinical_orders', order);
  return order;
}
export function chargeOrder(billing: ClinicalBillingPort | undefined, tx: StoreTx, at: StoreScope, order: EntityRow<'clinical_orders'>, quantity: number, department: string) {
  if (!billing) return;
  const item = tx.get(at, 'catalog_items', order.catalog_item_id)!;
  billing.freezeCharge(tx, at, { orderId: order.id, encounterId: order.encounter_id, catalogItemId: item.id, catalogVersion: tx.get(at, 'data_pack_installations', item.installation_id)!.pack_version,
    unitPriceMinor: item.amount_minor!, currencyCode: item.currency_code!, currencyExponent: item.currency_exponent!, quantity, department, virtualAt: order.virtual_at, recordedAt: order.recorded_at });
}
type GateIntent = { kind: 'medication'; encounterId: string; lines: readonly { codeSystem: string; code: string; dose: number; timesPerDay: number }[]; activeMedicationIds: readonly string[] } |
  { kind: 'pci'; encounterId: string; ffr?: number } | { kind: 'discharge'; encounterId: string; completedPci: boolean; activeMedicationIds: readonly string[] };
export function quality(context: CommandContext & { checkClinicalQuality?(intent: GateIntent, override: unknown): void }, intent: GateIntent, override: unknown) { context.checkClinicalQuality?.(intent, override); }
