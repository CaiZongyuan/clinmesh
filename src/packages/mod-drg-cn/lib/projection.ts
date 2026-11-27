import { z } from 'zod';
import type { StoreReader, StoreScope } from '../../store';
import { activeClaims, claimEvents, type Billing } from './claims';
import { amount, ratio, regionalRules, sum } from './rules';

const groupSchema = z.object({ group: z.string(), referenceMinor: amount });
const costs = z.object({ incurredMinor: amount, committedMinor: amount, reservedMinor: amount, plannedMinor: amount, projectedMinor: amount.nullable(), missing: z.array(z.string()) });
const archiveDecision = z.object({ group: z.string().min(1), referenceMinor: amount, approvedMinor: amount });
export const projectionSchema = z.object({ costs, group: groupSchema.nullable(), basis: z.enum(['planned', 'performed', 'unavailable']), progress: z.enum(['within', 'near', 'over', 'unavailable']), archive: z.object({ archived: z.boolean(), reconciled: z.boolean(), frozenMinor: amount.nullable(), determination: archiveDecision.nullable() }),
  plans: z.array(z.object({ id: z.string(), name: z.object({ en: z.string(), zh: z.string() }) })), claims: z.array(z.object({ id: z.uuidv7(), planId: z.string(), year: z.int(), annualVersion: amount, chargeIds: z.array(z.uuidv7()), fundMinor: amount, accountMinor: amount, cashMinor: amount })) });

export function projection(reader: StoreReader, at: StoreScope, encounterId: string, billing: Billing) {
  const rules = regionalRules(reader, at);
  const bill = billing.readAccount(reader, at, encounterId);
  const orders = reader.list(at, 'clinical_orders', { encounter_id: encounterId }).filter(order => !['cancelled', 'withdrawn'].includes(order.status));
  const posted = new Set(bill.charges.map(line => line.orderId));
  const unpostedOrders = new Set(bill.unpostedSources.filter(source => source.kind === 'order').map(source => source.id));
  const missing = bill.unpostedSources.map(source => `unposted-${source.kind}:${source.id}`);
  const price = (itemId: string, quantity = 1) => {
    const item = reader.get(at, 'catalog_items', itemId);
    if (!item || item.amount_minor === null || item.currency_code !== bill.currency.code || item.currency_exponent !== bill.currency.minorUnitExponent) { missing.push(itemId); return 0; }
    return amount.parse(Number(BigInt(item.amount_minor) * BigInt(quantity)));
  };
  const committed: number[] = [], reserved: number[] = [], planned: number[] = [];
  const plannedCodes = new Set<string>(), performedCodes = new Set<string>();
  for (const order of orders) {
    if (reader.list(at, 'ward_surgery_charges', { order_id: order.id, purpose: 'report' }).length) continue;
    const wardOrder = reader.get(at, 'ward_order_directions', order.id);
    if (wardOrder) {
      const pending = reader.list(at, 'ward_tasks', { order_id: order.id, status: 'pending' }).length;
      if (pending) committed.push(price(order.catalog_item_id, pending * z.int().positive().parse(wardOrder.directions.quantity ?? 1)));
      continue;
    }
    const surgeries = reader.list(at, 'surgery_requests', { order_id: order.id }).filter(request => request.status !== 'cancelled');
    if (!surgeries.length) {
      if (reader.list(at, 'ward_surgery_stages', { order_id: order.id }).length) continue;
      if (!posted.has(order.id) && !unpostedOrders.has(order.id)) committed.push(price(order.catalog_item_id));
      continue;
    }
    for (const surgery of surgeries) {
      const item = reader.get(at, 'catalog_items', surgery.procedure_item_id)!;
      const performed = surgery.status === 'completed' || reader.list(at, 'surgery_executions', { surgery_request_id: surgery.id }).some(execution => execution.outcome === 'completed');
      const stages = reader.list(at, 'ward_surgery_stages', { request_id: surgery.id }).flatMap(stage => {
        const performedOrder = reader.get(at, 'clinical_orders', stage.order_id)!;
        if (performedOrder.status === 'cancelled') return [];
        if (!stage.completed_execution_id && !posted.has(stage.order_id)) planned.push(price(performedOrder.catalog_item_id));
        return [{ stage, item: reader.get(at, 'catalog_items', performedOrder.catalog_item_id)! }];
      });
      const definitive = stages.find(row => row.stage.stage === 'ad-hoc-pci') ?? stages[0];
      const principal = definitive?.item ?? item;
      if (principal.code_system === rules.procedureSystem) ((definitive ? !!definitive.stage.completed_execution_id : performed) ? performedCodes : plannedCodes).add(principal.code);
      if (!stages.length && !posted.has(order.id) && !performed) planned.push(price(item.id));
      for (const reservation of reader.list(at, 'material_reservations', { surgery_request_id: surgery.id })) {
        const uses = reader.list(at, 'material_uses', { reservation_id: reservation.id });
        if (['cancelled', 'released', 'closed'].includes(reservation.status)) continue;
        const consumed = sum(uses.map(use => use.quantity - sum(reader.list(at, 'ward_material_corrections', { use_id: use.id }).map(correction => correction.quantity))));
        const remaining = Math.max(0, reservation.quantity - consumed);
        if (remaining) reserved.push(price(reader.get(at, 'inventory_lots', reservation.lot_id)!.catalog_item_id, remaining));
      }
    }
  }
  const revision = reader.list(at, 'diagnosis_revisions', { encounter_id: encounterId }).sort((first, second) => second.revision - first.revision)[0];
  const diagnosis = revision && reader.list(at, 'diagnosis_confirmations', { revision_id: revision.id, is_primary: true })[0];
  const candidates = new Set([...performedCodes, ...plannedCodes]);
  const groups = [...candidates].map(code => rules.groups.find(group => diagnosis?.code_system === rules.diagnosisSystem && group.principalDiagnosis === diagnosis.code && group.principalProcedure === code));
  const first = groups[0];
  const group = first && groups.every(item => item?.group === first.group && item.weightBp === first.weightBp) ? { group: first.group, referenceMinor: ratio(rules.baseRateMinor, first.weightBp) } : null;
  const parts = { incurredMinor: bill.netMinor, committedMinor: sum(committed), reservedMinor: sum(reserved), plannedMinor: sum(planned) };
  const projectedMinor = missing.length ? null : sum(Object.values(parts));
  const progress = !group || !group.referenceMinor || projectedMinor === null ? 'unavailable' : projectedMinor > group.referenceMinor ? 'over' : BigInt(projectedMinor) * 10n >= BigInt(group.referenceMinor) * 9n ? 'near' : 'within';
  const admission = reader.list(at, 'inpatient_admissions', { encounter_id: encounterId })[0];
  const archive = admission && reader.list(at, 'medical_record_archives', { admission_id: admission.id })[0];
  const determination = archiveDecision.safeParse(archive?.archive.payerDetermination).data ?? null;
  const snapshot = bill.settlement;
  const events = claimEvents(reader, at);
  const claims = activeClaims(reader, at, encounterId).map(claim => ({ id: claim.id, year: claim.year, planId: claim.planId, annualVersion: events.filter(entry => entry.year === claim.year && entry.patientId === claim.patientId).length, chargeIds: claim.allocations.items.map(item => item.chargeId), fundMinor: claim.allocations.fundMinor, accountMinor: claim.allocations.accountMinor, cashMinor: claim.allocations.cashMinor }));
  return projectionSchema.parse({ costs: { ...parts, projectedMinor, missing }, group, basis: plannedCodes.size ? 'planned' : performedCodes.size ? 'performed' : 'unavailable', progress,
    archive: { archived: Boolean(archive), reconciled: Boolean(snapshot && snapshot.netMinor === sum([snapshot.cashMinor, snapshot.coverageMinor])), frozenMinor: snapshot?.netMinor ?? null, determination }, plans: rules.plans, claims });
}
