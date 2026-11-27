import { z } from 'zod';
import { catalogSchema, manifestSchema } from '../../data-pack';
import { requireEncounter } from '../../patient-visit';
import { CoreError, type CommandContext } from '../../platform';
import type { EntityRow, StoreReader, StoreScope, StoreTx } from '../../store';

export const quote = z.strictObject({ serviceId: z.uuidv7(), catalogVersion: z.string().min(1), unitPriceMinor: z.int().nonnegative(), currencyCode: z.string().regex(/^[A-Z]{3}$/), currencyExponent: z.int().min(0).max(9) });
export type Quote = z.infer<typeof quote>;
type ChargeSource = Omit<Quote, 'serviceId'> & { catalogItemId: string; encounterId: string; orderId: string; quantity: number; virtualAt: string; recordedAt: string };
export interface DiagnosticBillingPort {
  freezeCharge(tx: StoreTx, at: StoreScope, row: ChargeSource): string | null;
  readOrderFunds(reader: StoreReader, at: StoreScope, orderId: string): { released: boolean; locked: boolean };
}

export function pricedServices(reader: StoreReader, at: StoreScope) {
  const installation = reader.list(at, 'data_pack_installations')[0]!;
  return reader.list(at, 'catalog_items', { kind: 'services', installation_id: installation.id }).flatMap(row => {
    if (row.amount_minor === null || row.currency_code === null || row.currency_exponent === null) return [];
    const definition = catalogSchema.shape.services.element.parse(row.definition);
    return [{ definition, packId: installation.pack_id, quote: { serviceId: row.id, catalogVersion: installation.pack_version, unitPriceMinor: row.amount_minor, currencyCode: row.currency_code, currencyExponent: row.currency_exponent } }];
  });
}

export function activeEncounter(context: CommandContext, encounterId: string, responsible: boolean) {
  const encounter = requireEncounter(context.tx, context.at, encounterId);
  if (encounter.status !== 'active') throw new CoreError(409, 'ENCOUNTER_COMPLETED');
  if (responsible && encounter.active_practitioner_role !== context.actor.role.id) throw new CoreError(403, 'RESPONSIBLE_ROLE_REQUIRED');
  return encounter;
}

export function requireOrderPrerequisites({ tx, at, targetId }: CommandContext) {
  const policies = manifestSchema.shape.policies.parse(tx.list(at, 'data_pack_installations')[0]!.manifest.policies);
  if (policies.requireSignedNoteBeforeOrder && !tx.list(at, 'clinical_record_revisions', { encounter_id: targetId }).length) throw new CoreError(409, 'CLINICAL_DOCUMENT_UNSIGNED');
  if (policies.requireDiagnosisBeforeOrder && !tx.list(at, 'diagnosis_revisions', { encounter_id: targetId }).length) throw new CoreError(409, 'DIAGNOSIS_UNCONFIRMED');
}

export function sameQuote(first: Quote | undefined, other: Quote) {
  return first && first.serviceId === other.serviceId && first.catalogVersion === other.catalogVersion && first.unitPriceMinor === other.unitPriceMinor && first.currencyCode === other.currencyCode && first.currencyExponent === other.currencyExponent;
}

export function requestStages(reader: StoreReader, at: StoreScope, encounter: EntityRow<'encounters'>, prior: EntityRow<'clinical_orders'>[]) {
  const reviewed = prior.filter(order => reader.list(at, 'diagnostic_reports', { order_id: order.id }).some(report => reader.list(at, 'report_acknowledgements', { report_id: report.id }).length));
  if (prior.some(order => !['cancelled', 'generation-failed'].includes(order.status) && !reviewed.includes(order))) return null;
  const stages: EntityRow<'lab_requests'>['stages'] = [];
  if (reader.list(at, 'encounters', { source_case_id: encounter.source_case_id, status: 'completed' }).length) stages.push('follow-up');
  if (reviewed.length) stages.push('repeat');
  if (encounter.encounter_class === 'inpatient') stages.push('inpatient');
  stages.push('initial');
  return stages;
}
