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
  const postedUses = new Set(bill.charges.map(line => line.materialUseId));
  const missing: string[] = [];
  const price = (itemId: string, quantity = 1) => {
    const item = reader.get(at, 'catalog_items', itemId);
    if (!item || item.amount_minor === null || item.currency_code !== bill.currency.code || item.currency_exponent !== bill.currency.minorUnitExponent) { missing.push(itemId); return 0; }
    return amount.parse(Number(BigInt(item.amount_minor) * BigInt(quantity)));
  };
  const committed: number[] = [], reserved: number[] = [], planned: number[] = [];
  const plannedCodes = new Set<string>(), performedCodes = new Set<string>();
  for (const order of orders) {
    const surgeries = reader.list(at, 'surgery_requests', { order_id: order.id }).filter(request => request.status !== 'cancelled');
    if (!surgeries.length) {
      if (!posted.has(order.id)) {
        const fulfilled = ['completed', 'dispensed', 'reported'].includes(order.status) || reader.list(at, 'order_executions', { order_id: order.id }).length || reader.list(at, 'diagnostic_reports', { order_id: order.id }).length || reader.list(at, 'prescription_orders', { order_id: order.id }).some(member => reader.list(at, 'dispenses', { prescription_order_id: member.id }).length);
        if (fulfilled) missing.push(`unposted-order:${order.id}`);
        else committed.push(price(order.catalog_item_id));
      }
      continue;
    }
    for (const surgery of surgeries) {
      const item = reader.get(at, 'catalog_items', surgery.procedure_item_id)!;
      const performed = surgery.status === 'completed' || reader.list(at, 'surgery_executions', { surgery_request_id: surgery.id }).some(execution => execution.outcome === 'completed');
      if (item.code_system === rules.procedureSystem) (performed ? performedCodes : plannedCodes).add(item.code);
      if (!posted.has(order.id)) {
        if (performed) missing.push(`unposted-procedure:${surgery.id}`);
        else planned.push(price(item.id));
      }
      for (const reservation of reader.list(at, 'material_reservations', { surgery_request_id: surgery.id })) {
        const uses = reader.list(at, 'material_uses', { reservation_id: reservation.id });
        for (const use of uses) if (!postedUses.has(use.id)) missing.push(`unposted-material-use:${use.id}`);
        if (['cancelled', 'released', 'closed'].includes(reservation.status)) continue;
        const consumed = sum(uses.map(use => use.quantity));
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
