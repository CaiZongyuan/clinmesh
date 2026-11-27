import { v7 } from 'uuid';
import { z } from 'zod';
import { catalogSchema, manifestSchema } from '../../data-pack';
import { requireEncounter } from '../../patient-visit';
import { checkVersion, CoreError, type CommandContext } from '../../platform';
import type { StoreReader, StoreScope } from '../../store';
import { issueReceipt, quote, type LabBillingPort, type Quote } from './contracts';

export const legacyProcedure = z.strictObject({ packId: z.string().min(1), packVersion: z.string().min(1), codeSystem: z.url(), code: z.string().min(1) });
type LegacyProcedures = readonly z.infer<typeof legacyProcedure>[];

export function clinicalServices(reader: StoreReader, at: StoreScope, legacy: LegacyProcedures) {
  const installation = reader.list(at, 'data_pack_installations')[0]!;
  return reader.list(at, 'catalog_items', { kind: 'services', installation_id: installation.id }).flatMap(row => {
    const definition = catalogSchema.shape.services.element.parse(row.definition);
    const kind = definition.kind;
    if ((kind !== 'lab' && kind !== 'examination') || definition.requiresProcedure || row.amount_minor === null || row.currency_code === null || row.currency_exponent === null) return [];
    if (kind === 'examination' && definition.requiresProcedure === undefined && legacy.some(item =>
      item.packId === installation.pack_id && item.packVersion === installation.pack_version && item.codeSystem === row.code_system && item.code === row.code)) return [];
    return [{ definition, kind, quote: { serviceId: row.id, catalogVersion: installation.pack_version, unitPriceMinor: row.amount_minor, currencyCode: row.currency_code, currencyExponent: row.currency_exponent } }];
  });
}

export function activeEncounter(context: CommandContext, encounterId: string, responsible: boolean) {
  const encounter = requireEncounter(context.tx, context.at, encounterId);
  if (encounter.status !== 'active') throw new CoreError(409, 'ENCOUNTER_COMPLETED');
  if (responsible && encounter.active_practitioner_role !== context.actor.role.id) throw new CoreError(403, 'RESPONSIBLE_ROLE_REQUIRED');
  return encounter;
}

export function labOrders(reader: StoreReader, at: StoreScope, encounterId: string) {
  return reader.list(at, 'clinical_orders', { encounter_id: encounterId }).filter(order =>
    (order.kind === 'lab' || order.kind === 'examination') && reader.list(at, 'lab_requests', { order_id: order.id }).length > 0);
}

export function savedDraft(reader: StoreReader, at: StoreScope, encounterId: string) {
  const row = reader.list(at, 'lab_drafts', { encounter_id: encounterId })[0];
  return { version: row?.version ?? 0, items: z.array(quote).parse(row?.items ?? []) };
}

function replaceDraft(context: CommandContext, items: Quote[]) {
  const { tx, at, targetId, expectedVersion } = context;
  const row = tx.list(at, 'lab_drafts', { encounter_id: targetId })[0];
  if (row) tx.update(at, 'lab_drafts', row.id, expectedVersion, { items });
  else tx.insert(at, 'lab_drafts', { id: v7(), encounter_id: targetId, version: 1, items });
  return { version: expectedVersion + 1 };
}

export function saveDraft(context: CommandContext, serviceIds: string[], legacy: LegacyProcedures) {
  const { tx, at, targetId, expectedVersion } = context;
  activeEncounter(context, targetId, true);
  const current = savedDraft(tx, at, targetId);
  checkVersion(current.version, expectedVersion);
  const services = clinicalServices(tx, at, legacy);
  const items = serviceIds.map(id => {
    const service = services.find(item => item.quote.serviceId === id);
    if (!service) throw new CoreError(409, 'CATALOG_CONFLICT');
    return current.items.find(item => item.serviceId === id) ?? service.quote;
  });
  return replaceDraft(context, items);
}

function sameQuote(first: Quote | undefined, other: Quote) {
  return first && first.serviceId === other.serviceId && first.catalogVersion === other.catalogVersion && first.unitPriceMinor === other.unitPriceMinor && first.currencyCode === other.currencyCode && first.currencyExponent === other.currencyExponent;
}

export function issueOrders(context: CommandContext, items: Quote[], legacy: LegacyProcedures, billing?: LabBillingPort) {
  const { tx, at, targetId, expectedVersion, virtualAt, recordedAt } = context;
  const encounter = activeEncounter(context, targetId, true);
  const draft = savedDraft(tx, at, targetId);
  checkVersion(draft.version, expectedVersion);
  const policies = manifestSchema.shape.policies.parse(tx.list(at, 'data_pack_installations')[0]!.manifest.policies);
  if (policies.requireSignedNoteBeforeOrder && !tx.list(at, 'clinical_record_revisions', { encounter_id: targetId }).length) throw new CoreError(409, 'CLINICAL_DOCUMENT_UNSIGNED');
  if (policies.requireDiagnosisBeforeOrder && !tx.list(at, 'diagnosis_revisions', { encounter_id: targetId }).length) throw new CoreError(409, 'DIAGNOSIS_UNCONFIRMED');
  const services = clinicalServices(tx, at, legacy);
  const orders = labOrders(tx, at, targetId);
  context.checkClinicalQuality?.({ kind: 'investigation', encounterId: targetId, catalogItemIds: items.map(item => item.serviceId) });
  const followUp = tx.list(at, 'encounters', { source_case_id: encounter.source_case_id, status: 'completed' }).length > 0;
  const issued = new Set<string>();
  const results: z.infer<typeof issueReceipt>['results'] = [];
  for (const item of items) {
    const { serviceId, ...price } = item;
    const service = services.find(service => service.quote.serviceId === serviceId);
    if (!service || !sameQuote(service.quote, item) || !sameQuote(draft.items.find(draftItem => draftItem.serviceId === serviceId), item)) {
      results.push({ serviceId, error: 'CATALOG_CONFLICT' }); continue;
    }
    const prior = orders.filter(order => order.catalog_item_id === serviceId);
    const reviews = new Set(prior.filter(order => tx.list(at, 'diagnostic_reports', { order_id: order.id }).some(report =>
      tx.list(at, 'report_acknowledgements', { report_id: report.id }).length > 0)).map(order => order.id));
    if (prior.some(order => !['cancelled', 'generation-failed'].includes(order.status) && !reviews.has(order.id))) {
      results.push({ serviceId, error: 'ACTIVE_ORDER_EXISTS' }); continue;
    }
    const orderId = v7();
    tx.insert(at, 'clinical_orders', { id: orderId, encounter_id: targetId, catalog_item_id: serviceId, kind: service.kind, status: 'issued', version: 1, virtual_at: virtualAt, recorded_at: recordedAt });
    const stages: ('follow-up' | 'repeat' | 'inpatient' | 'initial')[] = [];
    if (followUp) stages.push('follow-up');
    if (reviews.size) stages.push('repeat');
    if (encounter.encounter_class === 'inpatient') stages.push('inpatient');
    tx.insert(at, 'lab_requests', { id: v7(), order_id: orderId, stages: [...stages, 'initial'] });
    if (context.actor.enabledModules.includes('mod-billing')) billing?.freezeCharge(tx, at, { ...price, orderId, encounterId: targetId, catalogItemId: serviceId, quantity: 1, virtualAt, recordedAt });
    issued.add(serviceId);
    results.push({ serviceId, orderId });
  }
  const version = issued.size ? replaceDraft(context, draft.items.filter(item => !issued.has(item.serviceId))).version : expectedVersion;
  return { version, results };
}
