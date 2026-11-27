import { v7 } from 'uuid';
import { z } from 'zod';
import { caseTruthSchema, catalogSchema, wardKnowledgeSchema, type Coding } from '../../data-pack';
import { availableStock, takeStock } from '../../mod-pharmacy';
import { localizedName, type CommandContext } from '../../platform';
import type { EntityRow, StoreReader, StoreScope, StoreTx } from '../../store';
import { itemFor, localDay, policy } from './calendar';
import { conflict, id, openOrder, text, times, type WardBilling } from './ward';

export const material = z.strictObject({ itemId: id, quantity: z.int().min(1).max(1000) });
export const materials = z.array(material).max(20).refine(rows => new Set(rows.map(row => row.itemId)).size === rows.length);
export const notice = z.strictObject({ procedureId: id, type: z.enum(['elective', 'urgent', 'emergency', 'day']), plannedAt: z.iso.datetime(), location: text,
  surgeon: text, assistant: text.optional(), anesthesia: text, reason: text, preopOrderPolicy: z.enum(['continue-active', 'stop-on-completion']), standbyAdHocPci: z.boolean().default(false), materials: materials.default([]) });
export type Stage = EntityRow<'ward_surgery_stages'>;
const codeMatches = (row: EntityRow<'catalog_items'>, code: Coding) => row.code === code.code && row.code_system === code.codeSystem;
export function procedure(reader: StoreReader, at: StoreScope, itemId: string) {
  const item = reader.get(at, 'catalog_items', itemId);
  if (item?.kind !== 'procedures') conflict('PROCEDURE_NOT_IN_CATALOG');
  const binding = policy(reader, at).settings.procedures.find(row => codeMatches(item, row.item));
  return { item, binding, definition: catalogSchema.shape.procedures.element.parse(item.definition) };
}
export function initializeMaterials(tx: StoreTx, at: StoreScope, virtualAt: string, recordedAt: string) {
  const config = wardKnowledgeSchema.optional().parse(tx.list(at, 'data_pack_installations')[0]!.knowledge.inpatient);
  for (const lot of config?.materialStock ?? []) {
    const item = itemFor(tx, at, 'materials', lot.item);
    const lotId = v7();
    tx.insert(at, 'inventory_lots', { id: lotId, catalog_item_id: item.id, unit: z.string().parse(item.definition.unit), lot_number: lot.lotNumber, expiry_date: lot.expiryDate });
    tx.insert(at, 'inventory_movements', { id: v7(), lot_id: lotId, quantity_delta: lot.quantity, reason: 'opening-stock', virtual_at: virtualAt, recorded_at: recordedAt });
  }
}
export function supplyLedger(reader: StoreReader, at: StoreScope, stageId: string) {
  return reader.list(at, 'ward_surgery_supplies', { stage_id: stageId }).map(link => {
    const reservation = reader.get(at, 'material_reservations', link.reservation_id)!;
    const lot = reader.get(at, 'inventory_lots', reservation.lot_id)!;
    const uses = reader.list(at, 'material_uses', { reservation_id: reservation.id }).map(use => {
      const corrections = reader.list(at, 'ward_material_corrections', { use_id: use.id });
      return { id: use.id, original: use.quantity, quantity: use.quantity - corrections.reduce((sum, row) => sum + row.quantity, 0), corrections: corrections.map(row => ({ quantity: row.quantity, reason: row.reason })) };
    });
    const actual = uses.reduce((sum, use) => sum + use.quantity, 0);
    return { itemId: lot.catalog_item_id, lotId: lot.id, lotNumber: lot.lot_number, reservationId: reservation.id, planned: link.planned ? reservation.quantity : 0, actual, uses };
  });
}
function reserve(ctx: CommandContext, stage: Stage, itemId: string, quantity: number, planned: boolean) {
  const item = ctx.tx.get(ctx.at, 'catalog_items', itemId);
  if (item?.kind !== 'materials') conflict('MATERIAL_NOT_IN_CATALOG');
  const date = localDay(ctx.virtualAt, policy(ctx.tx, ctx.at).timezone);
  const lot = availableStock(ctx.tx, ctx.at, itemId, date).find(row => row.available >= quantity);
  if (!lot) conflict('MATERIAL_INSUFFICIENT_STOCK');
  const reservationId = v7();
  ctx.tx.insert(ctx.at, 'material_reservations', { id: reservationId, surgery_request_id: stage.request_id, lot_id: lot.lotId, quantity, status: 'reserved', version: 1 });
  ctx.tx.insert(ctx.at, 'ward_surgery_supplies', { id: v7(), stage_id: stage.id, reservation_id: reservationId, planned });
  return { reservationId, lotId: lot.lotId };
}
export function openStage(ctx: CommandContext, requestId: string, stage: Stage['stage'], orderId: string, supplies: z.infer<typeof materials>, parentExecutionId: string | null = null) {
  const row: Stage = { id: v7(), request_id: requestId, stage, order_id: orderId, parent_execution_id: parentExecutionId, completed_execution_id: null, version: 1 };
  ctx.tx.insert(ctx.at, 'ward_surgery_stages', row);
  for (const item of supplies) reserve(ctx, row, item.itemId, item.quantity, true);
  return row;
}
export function useSupply(ctx: CommandContext, stage: Stage, input: z.infer<typeof material>, note: string | undefined, billing?: WardBilling) {
  const ledger = supplyLedger(ctx.tx, ctx.at, stage.id);
  const planned = ledger.find(row => row.itemId === input.itemId && row.planned > 0);
  if ((!planned || planned.actual + input.quantity > planned.planned) && !note) conflict('SURGERY_NOTE_REQUIRED');
  const supply = planned ?? reserve(ctx, stage, input.itemId, input.quantity, false);
  const date = localDay(ctx.virtualAt, policy(ctx.tx, ctx.at).timezone);
  if (!availableStock(ctx.tx, ctx.at, input.itemId, date).some(lot => lot.lotId === supply.lotId && lot.available >= input.quantity)) conflict('MATERIAL_INSUFFICIENT_STOCK');
  const movementId = takeStock(ctx.tx, ctx.at, supply.lotId, input.quantity, note ?? 'planned surgical use', ctx.virtualAt, ctx.recordedAt);
  const useId = v7();
  ctx.tx.insert(ctx.at, 'material_uses', { id: useId, movement_id: movementId, reservation_id: supply.reservationId, quantity: input.quantity, ...times(ctx) });
  billing?.freezeMaterialUse(ctx.tx, ctx.at, useId);
  return useId;
}
export function closeReservations(ctx: CommandContext, stage: Stage) {
  for (const supply of supplyLedger(ctx.tx, ctx.at, stage.id)) {
    const reservation = ctx.tx.get(ctx.at, 'material_reservations', supply.reservationId)!;
    if (reservation.status === 'reserved') ctx.tx.update(ctx.at, 'material_reservations', reservation.id, reservation.version, { status: 'closed' });
  }
}
export function correctSupply(ctx: CommandContext, stage: Stage, useId: string, quantity: number, reason: string, billing?: WardBilling) {
  const supply = supplyLedger(ctx.tx, ctx.at, stage.id).find(row => row.uses.some(use => use.id === useId && use.quantity >= quantity));
  if (!supply) conflict('MATERIAL_CORRECTION_CONFLICT');
  const movementId = v7();
  ctx.tx.insert(ctx.at, 'inventory_movements', { id: movementId, lot_id: supply.lotId, quantity_delta: quantity, reason, ...times(ctx) });
  ctx.tx.insert(ctx.at, 'ward_material_corrections', { id: v7(), use_id: useId, quantity, movement_id: movementId, reason, ...times(ctx) });
  billing?.reverseMaterialUse(ctx.tx, ctx.at, useId, quantity, reason, ctx.virtualAt, ctx.recordedAt);
}
const observation = z.object({ codeSystem: z.string(), code: z.string(), value: z.union([z.string(), z.number()]), unit: z.string(), display: localizedName });
export const angiography = z.object({ status: z.enum(['final', 'partial', 'unavailable']), summary: localizedName.nullable(), observations: z.array(observation) });
export function reportFor(reader: StoreReader, at: StoreScope, stageId: string) {
  const link = reader.list(at, 'ward_surgery_charges', { stage_id: stageId, purpose: 'report' })[0];
  const row = link && reader.list(at, 'diagnostic_reports', { order_id: link.order_id }).at(-1);
  return row ? { ...angiography.parse(row.findings), id: row.id, acknowledged: reader.list(at, 'report_acknowledgements', { report_id: row.id }).length > 0 } : null;
}
export function publishAngiography(ctx: CommandContext, stage: Stage, serviceCode: Coding) {
  const item = itemFor(ctx.tx, ctx.at, 'services', serviceCode);
  const service = catalogSchema.shape.services.element.parse(item.definition);
  const source = ctx.tx.readPrivateCaseTruth(ctx.at, { purpose: 'simulation', encounterId: ctx.targetId });
  const truth = caseTruthSchema.extend({ tags: z.array(z.string()).optional() }).safeParse(source?.truth);
  const authored = truth.success && truth.data.results.find(row => row.stage === 'inpatient' && row.revision === 1 && codeMatches(item, row.service));
  const observations = authored ? authored.observations.flatMap(row => {
    const leaf = service.analytes.find(leaf => leaf.code === row.analyte.code && leaf.codeSystem === row.analyte.codeSystem);
    if (!leaf || row.unit && row.unit !== leaf.unit) return [];
    return [{ ...row.analyte, value: row.value, unit: leaf.unit, display: leaf.display }];
  }) : [];
  const result = angiography.parse({ status: !authored || !observations.length ? 'unavailable' : observations.length !== authored.observations.length ? 'partial' : 'final', summary: authored ? authored.summary : null, observations });
  const order = openOrder(ctx.tx, ctx.at, ctx.targetId, item.id, 'examination', 'reported', times(ctx));
  ctx.tx.insert(ctx.at, 'ward_surgery_charges', { id: v7(), stage_id: stage.id, order_id: order.id, purpose: 'report' });
  ctx.tx.insert(ctx.at, 'diagnostic_reports', { id: v7(), order_id: order.id, findings: result, revision: 1, previous_revision_id: null, signed_by: 'procedure-simulation', ...times(ctx) });
}
