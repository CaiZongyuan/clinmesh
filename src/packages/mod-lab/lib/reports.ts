import { v7 } from 'uuid';
import { z } from 'zod';
import { caseTruthSchema, catalogSchema } from '../../data-pack';
import { checkVersion, CoreError, type CommandContext } from '../../platform';
import type { EntityRow, StoreReader, StoreScope, StoreTx } from '../../store';
import { findings, status, type LabBillingPort, type LabOrder } from './contracts';
import { activeEncounter, labOrders } from './orders';
import { resolveFindings } from './results';

type Order = EntityRow<'clinical_orders'>;
type Execution = Pick<CommandContext, 'tx' | 'at' | 'virtualAt' | 'recordedAt'>;
type Report = EntityRow<'diagnostic_reports'>;
const privateTruth = caseTruthSchema.extend({ tags: z.array(z.string()).optional() });

function requireOrder(reader: StoreReader, at: StoreScope, id: string) {
  const order = reader.get(at, 'clinical_orders', id);
  if (!order || !reader.list(at, 'lab_requests', { order_id: id }).length) throw new CoreError(404, 'LAB_ORDER_NOT_FOUND');
  return order;
}

function serviceFor(reader: StoreReader, at: StoreScope, order: Order) {
  return catalogSchema.shape.services.element.parse(reader.get(at, 'catalog_items', order.catalog_item_id)?.definition);
}

function reportHistory(reader: StoreReader, at: StoreScope, orderId: string) {
  return reader.list(at, 'diagnostic_reports', { order_id: orderId }).sort((first, second) => first.revision - second.revision);
}

function acknowledgement(reader: StoreReader, at: StoreScope, reportId: string) {
  const ack = reader.list(at, 'report_acknowledgements', { report_id: reportId })[0];
  return ack ? { id: ack.id, role: ack.practitioner_role, at: ack.virtual_at } : null;
}

function dueTime(reader: StoreReader, at: StoreScope, order: Order) {
  if (order.status !== 'in-progress') return null;
  const start = reader.list(at, 'order_executions', { order_id: order.id, outcome: 'in-progress' })[0];
  if (!start) return null;
  const minutes = serviceFor(reader, at, order).turnaroundMinutes ?? 30;
  return new Date(Date.parse(start.virtual_at) + minutes * 60_000).toISOString();
}

export function readOrder(reader: StoreReader, at: StoreScope, order: Order): LabOrder {
  const reports = reportHistory(reader, at, order.id).map(report => ({ ...findings.parse(report.findings), id: report.id, version: report.revision, previousId: report.previous_revision_id,
    signedAt: report.virtual_at, acknowledged: acknowledgement(reader, at, report.id) }));
  return { id: order.id, serviceId: order.catalog_item_id, status: status.parse(order.status), version: order.version, issuedAt: order.virtual_at, reports, dueAt: dueTime(reader, at, order) };
}

export function reportsReviewed(reader: StoreReader, at: StoreScope, encounterId: string) {
  return labOrders(reader, at, encounterId).every(order => {
    if (order.status === 'cancelled') return true;
    const latest = order.status === 'acknowledged' && reportHistory(reader, at, order.id).at(-1);
    return !!latest && !!acknowledgement(reader, at, latest.id);
  });
}

function transition({ tx, at, virtualAt, recordedAt }: Execution, order: Order, next: LabOrder['status'], role: string) {
  tx.update(at, 'clinical_orders', order.id, order.version, { status: next });
  tx.insert(at, 'order_executions', { id: v7(), order_id: order.id, practitioner_role: role, outcome: next, virtual_at: virtualAt, recorded_at: recordedAt });
  return { version: order.version + 1, status: next };
}

export function moveOrder(context: CommandContext, operation: 'accept' | 'start' | 'cancel' | 'report-now', billing?: LabBillingPort) {
  const { tx, at, actor, targetId, expectedVersion } = context;
  const order = requireOrder(tx, at, targetId);
  activeEncounter(context, order.encounter_id, operation === 'cancel');
  checkVersion(order.version, expectedVersion);
  const funds = actor.enabledModules.includes('mod-billing') ? billing : undefined;
  if (operation === 'accept' && order.status === 'issued') {
    if (funds && !funds.readOrderFunds(tx, at, order.id).released) throw new CoreError(409, 'PAYMENT_REQUIRED');
    return transition(context, order, 'accepted', actor.role.id);
  }
  if (operation === 'start' && order.status === 'accepted') return transition(context, order, 'in-progress', actor.role.id);
  if (operation === 'report-now' && order.status === 'in-progress') return publish(context, order);
  if (operation === 'cancel' && ['issued', 'accepted', 'in-progress', 'generation-failed'].includes(order.status)) {
    if (funds?.readOrderFunds(tx, at, order.id).locked) throw new CoreError(409, 'CHARGE_LOCKED');
    return transition(context, order, 'cancelled', actor.role.id);
  }
  throw new CoreError(409, 'INVALID_ORDER_STATE');
}

function publish(context: Execution, order: Order, previous?: Report) {
  const { tx, at, virtualAt, recordedAt } = context;
  const revision = (previous?.revision ?? 0) + 1;
  const request = tx.list(at, 'lab_requests', { order_id: order.id })[0]!;
  const source = tx.readPrivateCaseTruth(at, { purpose: 'simulation', encounterId: order.encounter_id });
  const truth = privateTruth.safeParse(source?.truth);
  const result = truth.success && resolveFindings(truth.data, serviceFor(tx, at, order), request.stages, revision);
  if (!result) {
    if (previous) throw new CoreError(409, 'AMENDMENT_UNAVAILABLE');
    return transition(context, order, 'generation-failed', 'lab-simulation');
  }
  tx.insert(at, 'diagnostic_reports', { id: v7(), order_id: order.id, revision, previous_revision_id: previous?.id ?? null, findings: result, signed_by: 'lab-simulation', virtual_at: virtualAt, recorded_at: recordedAt });
  return transition(context, order, 'reported', 'lab-simulation');
}

export function publishDue(tx: StoreTx, at: StoreScope, to: string, recordedAt: string) {
  const pending = tx.list(at, 'clinical_orders', { status: 'in-progress' });
  for (const order of pending) {
    if (!tx.list(at, 'lab_requests', { order_id: order.id }).length) continue;
    if (tx.get(at, 'encounters', order.encounter_id)?.status !== 'active') continue;
    const due = dueTime(tx, at, order);
    if (!due || Date.parse(due) > Date.parse(to)) continue;
    const result = publish({ tx, at, virtualAt: due, recordedAt }, order);
    tx.insert(at, 'audit_events', { id: v7(), actor: 'lab-simulation', practitioner_role: 'lab-simulation', operation: 'lab.publish-due', target_id: order.id, outcome: result.status, virtual_at: due, recorded_at: recordedAt });
  }
}

export function reviewReport(context: CommandContext, reportVersion: number, amend: boolean) {
  const { tx, at, targetId, expectedVersion, actor } = context;
  const report = tx.get(at, 'diagnostic_reports', targetId);
  if (!report) throw new CoreError(404, 'REPORT_NOT_FOUND');
  const order = requireOrder(tx, at, report.order_id);
  activeEncounter(context, order.encounter_id, !amend);
  if (reportHistory(tx, at, order.id).at(-1)?.id !== report.id) throw new CoreError(409, 'REPORT_SUPERSEDED');
  checkVersion(report.revision, reportVersion);
  if (!amend && order.status === 'acknowledged' && [order.version - 1, order.version].includes(expectedVersion) && acknowledgement(tx, at, report.id)) return { status: 'acknowledged' as const, version: order.version };
  checkVersion(order.version, expectedVersion);
  if (amend && (order.status === 'reported' || order.status === 'acknowledged')) return publish(context, order, report);
  if (amend || order.status !== 'reported') throw new CoreError(409, 'INVALID_ORDER_STATE');
  tx.insert(at, 'report_acknowledgements', { id: v7(), report_id: report.id, practitioner_role: actor.role.id, virtual_at: context.virtualAt, recorded_at: context.recordedAt });
  return transition(context, order, 'acknowledged', actor.role.id);
}
