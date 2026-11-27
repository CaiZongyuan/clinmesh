import { v7 } from 'uuid';
import { z } from 'zod';
import { requireEncounter, startEncounter } from '../../patient-visit';
import { checkVersion, CoreError, type CommandContext, type OperationCatalog } from '../../platform';
import type { StoreReader, StoreScope, StoreTx } from '../../store';
import { advance, clinician, conflict, id, mutateAdmission, occupancy, organization, receipt, roleOnWard, route, text, times, wardDepartment, type Admission } from './ward';

export function registerAdmission(tx: StoreTx, at: StoreScope, encounterId: string, ward: string, virtualAt: string, recordedAt: string) {
  const encounter = requireEncounter(tx, at, encounterId);
  const visits = tx.list(at, 'encounters', { patient_id: encounter.patient_id, encounter_class: 'inpatient' });
  if (visits.some(visit => tx.list(at, 'inpatient_admissions', { encounter_id: visit.id }).some(row => row.status !== 'cleared'))) conflict('PATIENT_ALREADY_ADMITTED');
  const admissionId = v7();
  tx.insert(at, 'inpatient_admissions', { id: admissionId, encounter_id: encounterId, ward, status: 'registered', version: 1, virtual_at: virtualAt, recorded_at: recordedAt });
  return { admissionId, encounterId, version: 1 };
}

function register(ctx: CommandContext, sourceCase: string, ward: string) {
  const responsibleRole = clinician(ctx.tx, ctx.at, ward);
  const { encounterId } = startEncounter({ ...ctx, targetId: sourceCase, expectedVersion: 0 }, undefined, { responsibleRole });
  return registerAdmission(ctx.tx, ctx.at, encounterId, ward, ctx.virtualAt, ctx.recordedAt);
}
function assign(ctx: CommandContext, admission: Admission, ward: string, bed: string) {
  const { tx, at } = ctx;
  if (!organization(tx, at).beds.some(item => item.id === bed && item.wardId === ward)) conflict('BED_NOT_IN_WARD');
  if (tx.list(at, 'bed_occupancies', { bed, released_at: null }).length) conflict('BED_OCCUPIED');
  const held = occupancy(tx, at, admission);
  if (held) tx.update(at, 'bed_occupancies', held.id, held.version, { released_at: ctx.virtualAt });
  tx.insert(at, 'bed_occupancies', { id: v7(), admission_id: admission.id, bed, occupied_at: ctx.virtualAt, released_at: null, version: 1 });
  return advance(ctx, admission, 'admitted', ward);
}
export function pendingTransfer(reader: StoreReader, at: StoreScope, admission: Admission) {
  return reader.list(at, 'inpatient_transfers', { admission_id: admission.id }).flatMap(row => {
    const task = reader.get(at, 'ward_transfer_tasks', row.id);
    return task && task.status !== 'completed' ? [{ id: row.id, from: row.from_ward, to: row.to_ward, status: task.status, version: task.version }] : [];
  })[0];
}
export function blockers(reader: StoreReader, at: StoreScope, admission: Admission, discharge = false) {
  const blocked: string[] = [];
  for (const order of reader.list(at, 'clinical_orders', { encounter_id: admission.encounter_id })) {
    if (reader.get(at, 'ward_order_directions', order.id) && !['completed', 'stopped'].includes(order.status)) blocked.push('ACTIVE_WARD_ORDER');
    const investigation = reader.list(at, 'lab_requests', { order_id: order.id }).length || reader.list(at, 'study_requests', { order_id: order.id }).length;
    if (investigation && (discharge ? !['acknowledged', 'cancelled'].includes(order.status) : order.status === 'issued')) blocked.push('OPEN_INVESTIGATION');
    if (reader.list(at, 'surgery_requests', { order_id: order.id }).some(row => !['completed', 'cancelled'].includes(row.status))) blocked.push('OPEN_SURGERY');
  }
  return [...new Set(blocked)];
}
export function registerAdmissions(catalog: OperationCatalog) {
  const registered = receipt.extend({ admissionId: id, encounterId: id });
  catalog.command(route('register', 'register', 'admit'), { ward: text }, registered, (ctx, input) => { checkVersion(0, ctx.expectedVersion); return register(ctx, ctx.targetId, input.ward); });
  catalog.command(route('certificate.issue', 'sign'), { ward: text, reason: text }, receipt.extend({ certificateId: id }), (ctx, input) => {
    const encounter = requireEncounter(ctx.tx, ctx.at, ctx.targetId);
    if (encounter.encounter_class !== 'outpatient' || encounter.status !== 'active' || encounter.active_practitioner_role !== ctx.actor.role.id) conflict('OUTPATIENT_REFERRAL_REQUIRED');
    checkVersion(encounter.version, ctx.expectedVersion);
    clinician(ctx.tx, ctx.at, input.ward);
    const certificateId = v7();
    ctx.tx.insert(ctx.at, 'ward_certificates', { id: certificateId, source_encounter_id: encounter.id, patient_id: encounter.patient_id, ward: input.ward, reason: input.reason, signed_by: ctx.actor.role.id, ...times(ctx) });
    ctx.tx.update(ctx.at, 'encounters', encounter.id, encounter.version, { status: encounter.status });
    return { certificateId, version: encounter.version + 1 };
  });
  catalog.command(route('certificate.redeem', 'register'), {}, registered, ctx => {
    checkVersion(0, ctx.expectedVersion);
    const cert = ctx.tx.get(ctx.at, 'ward_certificates', ctx.targetId);
    if (!cert) throw new CoreError(404, 'CERTIFICATE_NOT_FOUND');
    if (ctx.tx.list(ctx.at, 'ward_referrals', { certificate_id: cert.id }).length) conflict('CERTIFICATE_REDEEMED');
    const source = requireEncounter(ctx.tx, ctx.at, cert.source_encounter_id);
    const result = register(ctx, source.source_case_id, cert.ward);
    if (requireEncounter(ctx.tx, ctx.at, result.encounterId).patient_id !== cert.patient_id) conflict('PATIENT_IDENTITY_CONFLICT');
    ctx.tx.insert(ctx.at, 'ward_referrals', { id: v7(), certificate_id: cert.id, admission_id: result.admissionId });
    return result;
  });
  catalog.command(route('bed.assign', 'execute-orders'), { bed: text }, receipt, (ctx, { bed }) => {
    const admission = mutateAdmission(ctx, ['registered', 'admitted'], 'nurse');
    return assign(ctx, admission, admission.ward, bed);
  });
  catalog.command(route('bed.swap', 'execute-orders'), { otherEncounterId: id, otherVersion: z.int().positive() }, receipt, (ctx, input) => {
    const first = mutateAdmission(ctx, ['admitted'], 'nurse');
    const second = mutateAdmission({ ...ctx, targetId: input.otherEncounterId, expectedVersion: input.otherVersion }, ['admitted'], 'nurse');
    if (first.id === second.id || first.ward !== second.ward) conflict('INVALID_BED_SWAP');
    const left = occupancy(ctx.tx, ctx.at, first), right = occupancy(ctx.tx, ctx.at, second);
    if (!left || !right) conflict('BED_REQUIRED');
    for (const held of [left, right]) ctx.tx.update(ctx.at, 'bed_occupancies', held.id, held.version, { released_at: ctx.virtualAt });
    assign(ctx, second, second.ward, left.bed);
    return assign(ctx, first, first.ward, right.bed);
  });
  catalog.command(route('transfer.request', 'admit'), { ward: text }, receipt, (ctx, { ward }) => {
    const admission = mutateAdmission(ctx, ['admitted'], 'doctor');
    if (ward === admission.ward || pendingTransfer(ctx.tx, ctx.at, admission)) conflict('TRANSFER_CONFLICT');
    wardDepartment(ctx.tx, ctx.at, ward);
    const transferId = v7();
    ctx.tx.insert(ctx.at, 'inpatient_transfers', { id: transferId, admission_id: admission.id, from_ward: admission.ward, to_ward: ward, ...times(ctx) });
    ctx.tx.insert(ctx.at, 'ward_transfer_tasks', { id: transferId, status: 'requested', version: 1 });
    return advance(ctx, admission);
  });
  for (const action of ['handover', 'receive'] as const) catalog.command(route(`transfer.${action}`, 'execute-orders'), { bed: text.optional() }, receipt, (ctx, { bed }) => {
    const admission = mutateAdmission(ctx, ['admitted']);
    const transfer = pendingTransfer(ctx.tx, ctx.at, admission);
    if (!transfer || transfer.status !== (action === 'handover' ? 'requested' : 'handed-over')) conflict('TRANSFER_CONFLICT');
    roleOnWard(ctx, action === 'handover' ? transfer.from : transfer.to);
    if (blockers(ctx.tx, ctx.at, admission).length) conflict('TRANSFER_BLOCKED');
    ctx.tx.update(ctx.at, 'ward_transfer_tasks', transfer.id, transfer.version, { status: action === 'handover' ? 'handed-over' : 'completed' });
    if (action === 'handover') return advance(ctx, admission);
    if (!bed) conflict('BED_REQUIRED');
    const encounter = requireEncounter(ctx.tx, ctx.at, ctx.targetId);
    ctx.tx.update(ctx.at, 'encounters', encounter.id, encounter.version, { active_practitioner_role: clinician(ctx.tx, ctx.at, transfer.to) });
    return assign(ctx, admission, transfer.to, bed);
  });
}
