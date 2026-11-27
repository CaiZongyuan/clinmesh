import { v7 } from 'uuid';
import { z } from 'zod';
import { activeEncounter, pricedServices, requestStages, requireOrderPrerequisites, sameQuote } from '../../diagnostic-workflow';
import { checkVersion, CoreError, type CommandContext } from '../../platform';
import type { StoreReader, StoreScope } from '../../store';
import { issueReceipt, quote, type LabBillingPort, type Quote } from './contracts';
import { labOrders } from './reports';

export const legacyProcedure = z.strictObject({ packId: z.string().min(1), packVersion: z.string().min(1), codeSystem: z.url(), code: z.string().min(1) });
type LegacyProcedures = readonly z.infer<typeof legacyProcedure>[];

export function clinicalServices(reader: StoreReader, at: StoreScope, legacy: LegacyProcedures) {
  return pricedServices(reader, at).flatMap(({ definition, quote, packId }) => {
    const kind = definition.kind;
    if ((kind !== 'lab' && kind !== 'examination') || definition.requiresProcedure) return [];
    if (kind === 'examination' && definition.requiresProcedure === undefined && legacy.some(item =>
      item.packId === packId && item.packVersion === quote.catalogVersion && item.codeSystem === definition.codeSystem && item.code === definition.code)) return [];
    return [{ definition, kind, quote }];
  });
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

export function issueOrders(context: CommandContext, items: Quote[], legacy: LegacyProcedures, billing?: LabBillingPort) {
  const { tx, at, targetId, expectedVersion, virtualAt, recordedAt } = context;
  const encounter = activeEncounter(context, targetId, true);
  const draft = savedDraft(tx, at, targetId);
  checkVersion(draft.version, expectedVersion);
  requireOrderPrerequisites(context);
  const services = clinicalServices(tx, at, legacy);
  const orders = labOrders(tx, at, targetId);
  const issued = new Set<string>();
  const results: z.infer<typeof issueReceipt>['results'] = [];
  for (const item of items) {
    const { serviceId, ...price } = item;
    const service = services.find(service => service.quote.serviceId === serviceId);
    if (!service || !sameQuote(service.quote, item) || !sameQuote(draft.items.find(draftItem => draftItem.serviceId === serviceId), item)) {
      results.push({ serviceId, error: 'CATALOG_CONFLICT' }); continue;
    }
    const prior = orders.filter(order => order.catalog_item_id === serviceId);
    const stages = requestStages(tx, at, encounter, prior);
    if (!stages) {
      results.push({ serviceId, error: 'ACTIVE_ORDER_EXISTS' }); continue;
    }
    const orderId = v7();
    tx.insert(at, 'clinical_orders', { id: orderId, encounter_id: targetId, catalog_item_id: serviceId, kind: service.kind, status: 'issued', version: 1, virtual_at: virtualAt, recorded_at: recordedAt });
    tx.insert(at, 'lab_requests', { id: v7(), order_id: orderId, stages });
    if (context.actor.enabledModules.includes('mod-billing')) billing?.freezeCharge(tx, at, { ...price, orderId, encounterId: targetId, catalogItemId: serviceId, quantity: 1, virtualAt, recordedAt });
    issued.add(serviceId);
    results.push({ serviceId, orderId });
  }
  const version = issued.size ? replaceDraft(context, draft.items.filter(item => !issued.has(item.serviceId))).version : expectedVersion;
  return { version, results };
}
