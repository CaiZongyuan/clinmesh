import { v7 } from 'uuid';
import { z } from 'zod';
import { medicationSchema, pharmacyRulesSchema, readClinicalCase } from '../../data-pack';
import { availableStock, checkPrescription, takeStock } from '../../mod-pharmacy';
import { requireEncounter } from '../../patient-visit';
import type { CommandContext, OperationCatalog } from '../../platform';
import type { EntityRow, StoreReader, StoreScope } from '../../store';
import { expand, localDay, policy, task } from './calendar';
import { advance, chargeOrder, conflict, id, mutateAdmission, openOrder, quality, receipt, route, text, times, wardDepartment, type WardBilling } from './ward';

export const identifiers = z.array(id).min(1).max(20).refine(ids => new Set(ids).size === ids.length);
const diagnosis = z.strictObject({ codeSystem: z.url(), code: text, primary: z.boolean(), ordinal: z.int().min(1).max(8), poa: z.enum(['Y', 'N', 'U', 'W', '1']) });
const directions = z.object({ dose: z.number().positive(), route: text, quantity: z.int().positive(), timesPerDay: z.int().positive() });
export function latestDiagnoses(reader: StoreReader, at: StoreScope, encounterId: string) {
  const latest = reader.list(at, 'diagnosis_revisions', { encounter_id: encounterId }).sort((first, second) => second.revision - first.revision)[0];
  return latest ? reader.list(at, 'diagnosis_confirmations', { revision_id: latest.id }).sort((first, second) => first.ordinal - second.ordinal)
    .map(row => ({ codeSystem: row.code_system, code: row.code, primary: row.is_primary, ordinal: row.ordinal, poa: row.poa_code })) : [];
}
export function wardOrders(reader: StoreReader, at: StoreScope, encounterId: string) {
  return reader.list(at, 'clinical_orders', { encounter_id: encounterId }).flatMap(order => {
    const schedule = reader.get(at, 'ward_order_directions', order.id);
    return schedule ? [{ order, schedule }] : [];
  });
}
export function activeMedicationIds(reader: StoreReader, at: StoreScope, encounterId: string) {
  return wardOrders(reader, at, encounterId).filter(({ order }) => order.kind === 'medication' && ['signed', 'verified'].includes(order.status)).map(({ order }) => order.catalog_item_id);
}
export function validateMedication(ctx: CommandContext, item: EntityRow<'catalog_items'>, dose: number | undefined, routeCode: string | undefined, timesPerDay: number, override: unknown, intraoperative = false) {
  const { tx, at, targetId } = ctx;
  const drug = medicationSchema.parse(item.definition);
  if (drug.source !== 'internal' || !dose || !routeCode) conflict('WARD_MEDICATION_DIRECTIONS_REQUIRED');
  const quantity = dose / drug.inpatientDoseBasis.amount;
  if (!Number.isSafeInteger(quantity) || quantity < 1) conflict('INVALID_PREPARATION_QUANTITY');
  const active = intraoperative ? [] : activeMedicationIds(tx, at, targetId);
  const allergies = readClinicalCase(tx, at, requireEncounter(tx, at, targetId).source_case_id)!.priorHistory.allergies;
  const line = { codeSystem: item.code_system, code: item.code, dose, timesPerDay, routeCode, quantity, days: 1 };
  const rules = tx.list(at, 'data_pack_installations')[0]!.knowledge.pharmacy;
  const medicines = tx.list(at, 'catalog_items', { kind: 'medications' });
  const issues = checkPrescription(medicines.map(row => medicationSchema.parse(row.definition)), [line], { rules: rules ? pharmacyRulesSchema.strip().parse(rules) : null,
    allergies: allergies.status === 'confirmed' ? allergies.items.map(entry => entry.groupCode) : [], diagnoses: latestDiagnoses(tx, at, targetId), activeMedications: medicines.filter(row => active.includes(row.id)).map(row => ({ codeSystem: row.code_system, code: row.code })) });
  if (issues.length) conflict(issues[0]!);
  quality(ctx, { kind: 'medication', encounterId: targetId, lines: [line], activeMedicationIds: active }, override);
  return { dose, route: routeCode, quantity, timesPerDay };
}

export function registerOrders(catalog: OperationCatalog, billing?: WardBilling) {
  catalog.command(route('diagnose', 'admit'), { diagnoses: z.array(diagnosis).min(1).max(8) }, receipt, (ctx, { diagnoses }) => {
    const admission = mutateAdmission(ctx, ['admitted'], 'doctor');
    const members = diagnoses.toSorted((first, second) => first.ordinal - second.ordinal);
    if (members.filter(item => item.primary).length !== 1 || members.some((item, index) => item.ordinal !== index + 1) || new Set(members.map(item => JSON.stringify([item.codeSystem, item.code]))).size !== members.length) conflict('INVALID_ADMISSION_DIAGNOSIS');
    for (const item of members) if (!ctx.tx.list(ctx.at, 'catalog_items', { kind: 'diagnoses', code_system: item.codeSystem, code: item.code }).length) conflict('DIAGNOSIS_NOT_IN_CATALOG');
    const previous = ctx.tx.list(ctx.at, 'diagnosis_revisions', { encounter_id: ctx.targetId }).sort((first, second) => second.revision - first.revision)[0];
    for (const row of ctx.tx.list(ctx.at, 'diagnosis_drafts', { encounter_id: ctx.targetId })) ctx.tx.remove(ctx.at, 'diagnosis_drafts', row.id, row.version);
    for (const item of members) ctx.tx.insert(ctx.at, 'diagnosis_drafts', { id: v7(), encounter_id: ctx.targetId, code_system: item.codeSystem, code: item.code, is_primary: item.primary, poa_code: item.poa, ordinal: item.ordinal, version: 1 });
    ctx.tx.appendDiagnosisRevision(ctx.at, { id: v7(), encounter_id: ctx.targetId, confirmed_by: ctx.actor.role.id, revision: (previous?.revision ?? 0) + 1, previous_revision_id: previous?.id ?? null, ...times(ctx) }, members.map(item => ({ id: v7(), code_system: item.codeSystem, code: item.code, ordinal: item.ordinal, is_primary: item.primary, poa_code: item.poa })));
    return advance(ctx, admission);
  });
  catalog.command(route('order.sign', 'admit'), { itemId: id, duration: z.enum(['long', 'temporary']), frequency: text, dose: z.number().positive().optional(), route: text.optional(), surgeryExecutionId: id.optional(), clinicalOverride: z.unknown().optional() }, receipt.extend({ orderId: id }), (ctx, input) => {
    const admission = mutateAdmission(ctx, ['admitted'], 'doctor');
    if (!latestDiagnoses(ctx.tx, ctx.at, ctx.targetId).some(item => item.poa)) conflict('DIAGNOSIS_UNCONFIRMED');
    const settings = policy(ctx.tx, ctx.at).settings;
    const frequency = input.frequency;
    const daily = frequency === 'PRN' ? 4 : frequency === 'ONCE' ? 1 : settings.schedules[frequency]?.length;
    if (!daily || (frequency !== 'PRN' && (frequency === 'ONCE') !== (input.duration === 'temporary'))) conflict('WARD_FREQUENCY_INVALID');
    if (input.surgeryExecutionId) {
      const execution = ctx.tx.get(ctx.at, 'surgery_executions', input.surgeryExecutionId);
      const request = execution && ctx.tx.get(ctx.at, 'surgery_requests', execution.surgery_request_id);
      if (request?.status !== 'completed' || execution?.outcome !== 'completed' || ctx.tx.get(ctx.at, 'clinical_orders', request.order_id)?.encounter_id !== ctx.targetId) conflict('COMPLETED_SURGERY_REQUIRED');
    }
    const item = ctx.tx.get(ctx.at, 'catalog_items', input.itemId) ?? conflict('WARD_CATALOG_CONFLICT');
    const medication = item.kind === 'medications';
    if (medication && !ctx.actor.enabledModules.includes('mod-pharmacy')) conflict('WARD_PHARMACY_UNAVAILABLE');
    if (!medication && (item.kind !== 'services' || item.definition.kind !== 'nursing' || item.code === settings.bedDay.code && item.code_system === settings.bedDay.codeSystem)) conflict('WARD_CATALOG_CONFLICT');
    const sign = medication ? validateMedication(ctx, item, input.dose, input.route, daily, input.clinicalOverride) : {};
    const order = openOrder(ctx.tx, ctx.at, ctx.targetId, item.id, medication ? 'medication' : 'nursing', 'signed', times(ctx));
    ctx.tx.insert(ctx.at, 'ward_order_directions', { id: order.id, frequency, duration: input.duration, directions: sign, surgery_execution_id: input.surgeryExecutionId ?? null });
    return { ...advance(ctx, admission), orderId: order.id };
  });
  for (const action of ['verify', 'request-stop', 'verify-stop'] as const) catalog.command(route(`order.${action}`, action === 'request-stop' ? 'admit' : 'execute-orders'), { orderIds: identifiers }, receipt, (ctx, { orderIds }) => {
    const admission = mutateAdmission(ctx, action === 'verify' ? ['admitted'] : ['admitted', 'discharge-pending'], action === 'request-stop' ? 'doctor' : 'nurse');
    const calendar = policy(ctx.tx, ctx.at);
    for (const orderId of orderIds) {
      const order = ctx.tx.get(ctx.at, 'clinical_orders', orderId), schedule = ctx.tx.get(ctx.at, 'ward_order_directions', orderId);
      if (!order || !schedule || order.encounter_id !== ctx.targetId) conflict('WARD_ORDER_NOT_FOUND');
      const allowed = action === 'verify' ? ['signed'] : action === 'request-stop' ? ['signed', 'verified'] : ['stop-requested'];
      if (!allowed.includes(order.status)) conflict('WARD_ORDER_STATE_CONFLICT');
      const status = action === 'verify' ? 'verified' : action === 'request-stop' ? 'stop-requested' : 'stopped';
      if (action === 'verify') expand(ctx.tx, ctx.at, schedule, localDay(ctx.virtualAt, calendar.timezone), calendar, ctx.virtualAt);
      if (action === 'verify-stop') for (const task of ctx.tx.list(ctx.at, 'ward_tasks', { order_id: orderId })) {
        if (['pending', 'dispensed'].includes(task.status)) ctx.tx.update(ctx.at, 'ward_tasks', task.id, task.version, { status: 'cancelled' });
      }
      ctx.tx.update(ctx.at, 'clinical_orders', orderId, order.version, { status });
    }
    return advance(ctx, admission);
  });
  catalog.command(route('task.request-prn', 'execute-orders'), { orderId: id, reason: text }, receipt, (ctx, input) => {
    const admission = mutateAdmission(ctx, ['admitted'], 'nurse');
    const order = ctx.tx.get(ctx.at, 'clinical_orders', input.orderId), schedule = ctx.tx.get(ctx.at, 'ward_order_directions', input.orderId);
    if (schedule?.frequency !== 'PRN' || order?.encounter_id !== ctx.targetId || order.status !== 'verified') conflict('PRN_ORDER_REQUIRED');
    const day = localDay(ctx.virtualAt, policy(ctx.tx, ctx.at).timezone);
    const all = ctx.tx.list(ctx.at, 'ward_tasks', { order_id: order.id });
    const today = all.filter(task => task.business_day === day);
    if (today.filter(task => task.status !== 'cancelled').length >= 4 || schedule.duration === 'temporary' && all.some(task => task.status !== 'cancelled')) conflict('PRN_DAILY_LIMIT');
    task(ctx.tx, ctx.at, order.id, day, `PRN-${today.length + 1}`, ctx.virtualAt, input.reason);
    return advance(ctx, admission);
  });
  for (const action of ['dispense', 'administer', 'complete'] as const) catalog.command(route(`task.${action}`, action === 'dispense' ? 'dispense' : 'execute-orders'), { taskIds: identifiers }, receipt, (ctx, { taskIds }) => {
    const admission = mutateAdmission(ctx, ['admitted'], action === 'dispense' ? 'other' : 'nurse');
    const date = localDay(ctx.virtualAt, policy(ctx.tx, ctx.at).timezone);
    for (const taskId of taskIds) {
      const task = ctx.tx.get(ctx.at, 'ward_tasks', taskId);
      const order = task && ctx.tx.get(ctx.at, 'clinical_orders', task.order_id);
      if (!task || !order || order.encounter_id !== ctx.targetId || order.status !== 'verified') conflict('WARD_TASK_CONFLICT');
      const medication = order.kind === 'medication';
      if (medication === (action === 'complete')) conflict('WARD_TASK_CONFLICT');
      if (action === 'administer' && task.status !== 'dispensed') conflict('DISPENSE_REQUIRED');
      if (action !== 'administer' && task.status !== 'pending') conflict('WARD_TASK_CONFLICT');
      if (action !== 'dispense' && Date.parse(task.due_at) > Date.parse(ctx.virtualAt)) conflict('TASK_NOT_DUE');
      const schedule = ctx.tx.get(ctx.at, 'ward_order_directions', order.id)!;
      if (action !== 'administer') {
        const quantity = medication ? directions.parse(schedule.directions).quantity : 1;
        const incurred = openOrder(ctx.tx, ctx.at, ctx.targetId, order.catalog_item_id, order.kind, 'completed', times(ctx));
        ctx.tx.insert(ctx.at, 'ward_incurred_orders', { id: v7(), task_id: taskId, order_id: incurred.id });
        chargeOrder(billing, ctx.tx, ctx.at, incurred, quantity, wardDepartment(ctx.tx, ctx.at, admission.ward));
        if (action === 'dispense') {
          if (!ctx.actor.enabledModules.includes('mod-pharmacy')) conflict('WARD_PHARMACY_UNAVAILABLE');
          if (billing && !billing.readOrderFunds(ctx.tx, ctx.at, incurred.id).released) conflict('PAYMENT_REQUIRED');
          let remaining = quantity;
          for (const lot of availableStock(ctx.tx, ctx.at, order.catalog_item_id, date)) {
            const issued = Math.min(remaining, lot.available);
            const movementId = takeStock(ctx.tx, ctx.at, lot.lotId, issued, 'ward-dispense', ctx.virtualAt, ctx.recordedAt);
            ctx.tx.insert(ctx.at, 'ward_deliveries', { id: v7(), task_id: taskId, movement_id: movementId, quantity: issued, ...times(ctx) });
            remaining -= issued;
            if (!remaining) break;
          }
          if (remaining) conflict('PHARMACY_INSUFFICIENT_STOCK');
        }
      }
      const outcome = action === 'dispense' ? 'dispensed' : action === 'administer' ? 'administered' : 'completed';
      ctx.tx.update(ctx.at, 'ward_tasks', taskId, task.version, { status: outcome });
      ctx.tx.insert(ctx.at, 'order_executions', { id: v7(), order_id: order.id, practitioner_role: ctx.actor.role.id, outcome, ...times(ctx) });
      if (schedule.duration === 'temporary' && action !== 'dispense') ctx.tx.update(ctx.at, 'clinical_orders', order.id, order.version, { status: 'completed' });
    }
    return advance(ctx, admission);
  });
}
