import type { EntityRow, StoreReader, StoreScope } from '../../store';
import type { PostingSource } from './contracts';

function fulfilledOrder(reader: StoreReader, at: StoreScope, order: EntityRow<'clinical_orders'>) {
  if (['completed', 'dispensed', 'reported'].includes(order.status)) return true;
  if (reader.list(at, 'order_executions', { order_id: order.id, outcome: 'completed' }).length || reader.list(at, 'diagnostic_reports', { order_id: order.id }).length) return true;
  return reader.list(at, 'prescription_orders', { order_id: order.id }).some(member => reader.list(at, 'dispenses', { prescription_order_id: member.id }).length);
}

export function incurredSources(reader: StoreReader, at: StoreScope, encounterId: string) {
  const sources: PostingSource[] = [];
  for (const order of reader.list(at, 'clinical_orders', { encounter_id: encounterId })) {
    if (reader.get(at, 'ward_order_directions', order.id) || reader.list(at, 'ward_surgery_charges', { order_id: order.id, purpose: 'report' }).length) continue;
    const surgeries = reader.list(at, 'surgery_requests', { order_id: order.id });
    if (!surgeries.length && fulfilledOrder(reader, at, order)) {
      const stage = reader.list(at, 'ward_surgery_stages', { order_id: order.id })[0];
      sources.push(stage?.completed_execution_id ? { kind: 'procedure', id: stage.completed_execution_id, orderId: order.id } : { kind: 'order', id: order.id, orderId: order.id });
    }
    for (const surgery of surgeries) {
      const performed = surgery.status === 'completed' || reader.list(at, 'surgery_executions', { surgery_request_id: surgery.id }).some(execution => execution.outcome === 'completed');
      if (performed) sources.push({ kind: 'procedure', id: surgery.id, orderId: order.id });
      for (const reservation of reader.list(at, 'material_reservations', { surgery_request_id: surgery.id })) {
        for (const use of reader.list(at, 'material_uses', { reservation_id: reservation.id })) {
          sources.push({ kind: 'material-use', id: use.id, orderId: null });
        }
      }
    }
  }
  return sources;
}
