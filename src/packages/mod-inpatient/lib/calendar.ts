import { v7 } from 'uuid';
import { z } from 'zod';
import { wardKnowledgeSchema, type Coding } from '../../data-pack';
import type { EntityRow, StoreReader, StoreScope, StoreTx } from '../../store';
import { chargeOrder, conflict, openOrder, wardDepartment, type WardBilling } from './ward';

export function policy(reader: StoreReader, at: StoreScope) {
  const installation = reader.list(at, 'data_pack_installations')[0]!;
  return { timezone: z.string().parse(installation.manifest.timezone), settings: wardKnowledgeSchema.parse(installation.knowledge.inpatient) };
}
export function itemFor(reader: StoreReader, at: StoreScope, kind: string, coding: Coding) {
  return reader.list(at, 'catalog_items', { kind, code_system: coding.codeSystem, code: coding.code })[0] ?? conflict('WARD_CATALOG_CONFLICT');
}
const calendars = new Map<string, Intl.DateTimeFormat>();
function localMinute(instant: string | number, timeZone: string) {
  let calendar = calendars.get(timeZone);
  if (!calendar) {
    calendar = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    calendars.set(timeZone, calendar);
  }
  return calendar.format(new Date(instant)).replace(' ', 'T');
}
export const localDay = (instant: string, zone: string) => localMinute(instant, zone).slice(0, 10);
function localInstant(day: string, slot: string, zone: string) {
  const target = `${day}T${slot}`;
  const naive = Date.parse(`${target}:00Z`);
  const dayMs = 86_400_000;
  const candidates = [naive - dayMs, naive + dayMs].map(probe => naive + probe - Date.parse(`${localMinute(probe, zone)}:00Z`));
  const found = candidates.filter(candidate => localMinute(candidate, zone) === target).sort((first, second) => first - second)[0];
  return found === undefined ? undefined : new Date(found).toISOString();
}
export function task(tx: StoreTx, at: StoreScope, orderId: string, day: string, slot: string, dueAt: string, reason: string | null = null) {
  if (tx.list(at, 'ward_tasks', { order_id: orderId, business_day: day, slot }).length) return;
  tx.insert(at, 'ward_tasks', { id: v7(), order_id: orderId, business_day: day, slot, due_at: dueAt, status: 'pending', reason, version: 1 });
}
export function expand(tx: StoreTx, at: StoreScope, order: EntityRow<'ward_order_directions'>, day: string, calendar: ReturnType<typeof policy>, from?: string) {
  if (order.frequency === 'PRN') return;
  if (order.frequency === 'ONCE') { if (from) task(tx, at, order.id, day, 'ONCE', from); return; }
  for (const slot of calendar.settings.schedules[order.frequency] ?? []) {
    const due = localInstant(day, slot, calendar.timezone);
    if (due && (!from || Date.parse(due) >= Date.parse(from))) task(tx, at, order.id, day, slot, due);
  }
}
export function rollDay(tx: StoreTx, at: StoreScope, day: string, billing?: WardBilling) {
  const patients = tx.list(at, 'inpatient_admissions').filter(row => ['admitted', 'discharge-pending'].includes(row.status));
  if (!patients.length || !tx.list(at, 'data_pack_installations')[0]?.knowledge.inpatient) return;
  const calendar = policy(tx, at);
  const bedDay = itemFor(tx, at, 'services', calendar.settings.bedDay);
  const virtualAt = localInstant(day, '00:00', calendar.timezone) ?? localInstant(day, '01:00', calendar.timezone)!;
  for (const admission of patients) {
    for (const order of tx.list(at, 'clinical_orders', { encounter_id: admission.encounter_id, status: 'verified' })) {
      const directions = tx.get(at, 'ward_order_directions', order.id);
      if (directions?.duration === 'long') expand(tx, at, directions, day, calendar);
    }
    if (tx.list(at, 'ward_bed_days', { admission_id: admission.id, business_day: day }).length) continue;
    const service = openOrder(tx, at, admission.encounter_id, bedDay.id, 'nursing', 'completed', { virtual_at: virtualAt, recorded_at: new Date().toISOString() });
    tx.insert(at, 'ward_bed_days', { id: v7(), admission_id: admission.id, business_day: day, order_id: service.id });
    chargeOrder(billing, tx, at, service, 1, wardDepartment(tx, at, admission.ward));
  }
}
