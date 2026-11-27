import { z } from 'zod';
import { catalogSchema, organizationSchema, wardKnowledgeSchema } from '../../data-pack';
import { requireEncounter } from '../../patient-visit';
import { localizedName } from '../../platform';
import type { StoreReader, StoreScope } from '../../store';
import { pendingTransfer } from './admissions';
import { latestDiagnoses, wardOrders } from './orders';
import { id, occupancy, organization, requireAdmission, type WardBilling } from './ward';

const named = z.object({ id, code: z.string(), kind: z.string(), display: localizedName, definition: z.record(z.string(), z.json()) });
export const directorySchema = z.object({ organization: organizationSchema, frequencies: z.array(z.string()), bedDayId: id.nullable(), items: z.array(named),
  admissions: z.array(z.object({ encounterId: id, patient: z.string(), ward: z.string(), bed: z.string().nullable(), status: z.string(), version: z.int() })),
  referrals: z.array(z.object({ id, encounterId: id, patient: z.string(), ward: z.string(), reason: z.string() })), outpatients: z.array(z.object({ id, patient: z.string(), version: z.int() })) });
export function directory(reader: StoreReader, at: StoreScope) {
  const pack = reader.list(at, 'data_pack_installations')[0]!;
  const settings = wardKnowledgeSchema.optional().parse(pack.knowledge.inpatient);
  const patient = (patientId: string) => reader.get(at, 'patients', patientId)!.display_name;
  const items = reader.list(at, 'catalog_items').filter(item => item.kind !== 'diagnoses');
  return { organization: organization(reader, at), frequencies: Object.keys(settings?.schedules ?? {}), bedDayId: items.find(item => item.kind === 'services' && item.code === settings?.bedDay.code && item.code_system === settings.bedDay.codeSystem)?.id ?? null,
    items: items.map(item => ({ id: item.id, code: item.code, kind: item.kind, display: localizedName.parse(item.definition.display), definition: item.definition })),
    admissions: reader.list(at, 'inpatient_admissions').map(row => ({ encounterId: row.encounter_id, ward: row.ward, patient: patient(requireEncounter(reader, at, row.encounter_id).patient_id), bed: occupancy(reader, at, row)?.bed ?? null, status: row.status, version: row.version })),
    referrals: reader.list(at, 'ward_certificates').filter(cert => !reader.list(at, 'ward_referrals', { certificate_id: cert.id }).length).map(cert => ({ id: cert.id, encounterId: cert.source_encounter_id, ward: cert.ward, reason: cert.reason, patient: patient(cert.patient_id) })),
    outpatients: reader.list(at, 'encounters', { encounter_class: 'outpatient', status: 'active' }).map(row => ({ id: row.id, patient: patient(row.patient_id), version: row.version })) };
}
export const commonWardView = z.object({ encounterId: id, patient: z.string(), ward: z.string(), status: z.string(), clinical: z.string(), bed: z.string().nullable(), version: z.int(),
  finance: z.object({ outstandingMinor: z.int().nullable(), canClearBed: z.boolean(), locked: z.boolean() }),
  transfer: z.object({ id, from: z.string(), to: z.string(), status: z.string(), version: z.int() }).nullable(), diagnosisRevision: z.int(), diagnoses: z.array(z.object({ codeSystem: z.string(), code: z.string(), primary: z.boolean(), ordinal: z.int(), poa: z.string().nullable() })),
  orders: z.array(z.object({ id, itemId: id, status: z.string(), duration: z.string(), frequency: z.string(), kind: z.string(), directions: z.record(z.string(), z.json()), surgeryExecutionId: id.nullable() })),
  tasks: z.array(z.object({ id, orderId: id, day: z.string(), dueAt: z.string(), reason: z.string().nullable(), status: z.string(), lots: z.array(z.object({ lotNumber: z.string(), quantity: z.int() })) })),
  specimens: z.array(z.object({ tube: z.string(), orderIds: z.array(id) })),
});
export function specimenCards(reader: StoreReader, at: StoreScope, encounterId: string) {
  const cards = new Map<string, string[]>();
  for (const order of reader.list(at, 'clinical_orders', { encounter_id: encounterId, status: 'issued' })) {
    if (!reader.list(at, 'lab_requests', { order_id: order.id }).length) continue;
    const item = reader.get(at, 'catalog_items', order.catalog_item_id)!;
    const container = catalogSchema.shape.services.element.parse(item.definition).specimenContainer;
    const tube = container ? `${container.specimen} / ${container.container} / ${container.capColor ?? '—'}` : String(item.code);
    const group = container?.mergeable && container.capColor ? tube : `${tube} · ${order.id}`;
    cards.set(group, [...cards.get(group) ?? [], order.id]);
  }
  return [...cards].map(([tube, orderIds]) => ({ tube, orderIds }));
}
export function commonView(reader: StoreReader, at: StoreScope, encounterId: string, billing?: WardBilling) {
  const admission = requireAdmission(reader, at, encounterId), encounter = requireEncounter(reader, at, encounterId);
  const orders = wardOrders(reader, at, encounterId);
  return { encounterId, patient: reader.get(at, 'patients', encounter.patient_id)!.display_name, ward: admission.ward, status: admission.status, clinical: encounter.status, bed: occupancy(reader, at, admission)?.bed ?? null, version: admission.version,
    finance: billing?.readAdmissionFunds(reader, at, encounterId) ?? { canClearBed: true, outstandingMinor: 0, locked: false }, transfer: pendingTransfer(reader, at, admission) ?? null, diagnosisRevision: reader.list(at, 'diagnosis_revisions', { encounter_id: encounterId }).length, diagnoses: latestDiagnoses(reader, at, encounterId),
    orders: orders.map(({ order, schedule }) => ({ id: order.id, itemId: order.catalog_item_id, kind: order.kind, status: order.status, duration: schedule.duration, frequency: schedule.frequency, directions: schedule.directions, surgeryExecutionId: schedule.surgery_execution_id })),
    tasks: orders.flatMap(({ order }) => reader.list(at, 'ward_tasks', { order_id: order.id }).map(task => ({ id: task.id, orderId: order.id, day: task.business_day, dueAt: task.due_at, reason: task.reason, status: task.status,
      lots: reader.list(at, 'ward_deliveries', { task_id: task.id }).map(line => ({ quantity: line.quantity, lotNumber: reader.get(at, 'inventory_lots', reader.get(at, 'inventory_movements', line.movement_id)!.lot_id)!.lot_number })) }))), specimens: specimenCards(reader, at, encounterId) };
}
