import { v7 } from 'uuid';
import { z } from 'zod';
import type { Coding } from '../../data-pack';
import { requireEncounter } from '../../patient-visit';
import { checkVersion, sha256, type CommandContext, type OperationCatalog } from '../../platform';
import { canonicalJson, type StoreReader, type StoreScope } from '../../store';
import { itemFor } from './calendar';
import { latestDiagnoses, validateMedication, wardOrders } from './orders';
import { closeReservations, correctSupply, material, materials, notice, openStage, procedure, publishAngiography, reportFor, supplyLedger, useSupply, type Stage } from './surgery-facts';
import { advance, chargeOrder, conflict, id, mutateAdmission, openOrder, organization, quality, receipt, route, text, times, wardDepartment, type WardBilling } from './ward';

const requestField = { requestId: id };
const medication = z.strictObject({ itemId: id, dose: z.number().positive(), route: text });
const staged = (reader: StoreReader, at: StoreScope, requestId: string) => reader.list(at, 'ward_surgery_stages', { request_id: requestId });
function current(ctx: CommandContext, requestId: string, role: 'doctor' | 'nurse' = 'doctor') {
  const admission = mutateAdmission(ctx, ['admitted'], role);
  const request = ctx.tx.get(ctx.at, 'surgery_requests', requestId);
  const plan = ctx.tx.get(ctx.at, 'ward_surgery_plans', requestId);
  if (!request || !plan || ctx.tx.get(ctx.at, 'clinical_orders', request.order_id)?.encounter_id !== ctx.targetId) conflict('SURGERY_NOT_FOUND');
  const stages = staged(ctx.tx, ctx.at, requestId);
  return { admission, request, plan: notice.parse(plan.notice), stages, stage: stages.at(-1)! };
}
type Current = ReturnType<typeof current>;
function changeStatus(ctx: CommandContext, surgery: Current, status: string) { ctx.tx.update(ctx.at, 'surgery_requests', surgery.request.id, surgery.request.version, { status }); }
function preoperative(ctx: CommandContext, surgery: Current) {
  if (surgery.plan.preopOrderPolicy !== 'stop-on-completion') return [];
  return wardOrders(ctx.tx, ctx.at, ctx.targetId).filter(({ order, schedule }) => schedule.duration === 'long' && !schedule.surgery_execution_id && ['signed', 'verified'].includes(order.status)).map(({ order }) => order);
}
function stopOrders(ctx: CommandContext, surgery: Current) {
  for (const order of preoperative(ctx, surgery)) ctx.tx.update(ctx.at, 'clinical_orders', order.id, order.version, { status: 'stop-requested' });
}
function report(ctx: CommandContext, surgery: Current) { return reportFor(ctx.tx, ctx.at, surgery.stages[0]!.id); }
function stageProcedure(ctx: CommandContext, stage: Stage) { return procedure(ctx.tx, ctx.at, ctx.tx.get(ctx.at, 'clinical_orders', stage.order_id)!.catalog_item_id); }
function ffrFor(ctx: CommandContext, surgery: Current) {
  const ffr = stageProcedure(ctx, surgery.stages[0]!).binding?.ffr;
  const value = report(ctx, surgery)?.observations.find(row => ffr && row.code === ffr.code && row.codeSystem === ffr.codeSystem && row.unit === '1')?.value;
  return typeof value === 'number' ? value : undefined;
}
function post(ctx: CommandContext, surgery: Current, itemId: string, quantity: number, purpose: 'medication' | 'nursing', billing?: WardBilling) {
  const order = openOrder(ctx.tx, ctx.at, ctx.targetId, itemId, purpose, 'completed', times(ctx));
  ctx.tx.insert(ctx.at, 'ward_surgery_charges', { id: v7(), stage_id: surgery.stage.id, order_id: order.id, purpose });
  ctx.tx.insert(ctx.at, 'order_executions', { id: v7(), order_id: order.id, practitioner_role: ctx.actor.role.id, outcome: purpose === 'medication' ? 'administered' : 'completed', ...times(ctx) });
  chargeOrder(billing, ctx.tx, ctx.at, order, quantity, wardDepartment(ctx.tx, ctx.at, surgery.admission.ward));
}
function recordMedication(ctx: CommandContext, surgery: Current, drug: z.infer<typeof medication>, override: unknown, billing?: WardBilling) {
  const item = ctx.tx.get(ctx.at, 'catalog_items', drug.itemId);
  if (item?.kind !== 'medications') conflict('MEDICATION_NOT_IN_CATALOG');
  const directions = validateMedication(ctx, item, drug.dose, drug.route, 1, override);
  post(ctx, surgery, item.id, directions.quantity, 'medication', billing);
}
function standby(surgery: Current) { return surgery.stage.stage === 'planned' && surgery.plan.standbyAdHocPci; }
async function preview(ctx: CommandContext, surgery: Current) {
  const ledger = supplyLedger(ctx.tx, ctx.at, surgery.stage.id);
  const autoStop = standby(surgery) ? [] : preoperative(ctx, surgery).map(order => order.id);
  const deviation = ledger.some(row => row.actual !== row.planned);
  const fingerprint = await sha256(canonicalJson({ request: surgery.request.id, version: surgery.admission.version, stage: surgery.stage.id, autoStop, ledger }));
  return { fingerprint, autoStop, deviation };
}
function complete(ctx: CommandContext, surgery: Current, note: string | undefined, billing?: WardBilling) {
  const { stage } = surgery;
  if (stage.completed_execution_id) conflict('SURGERY_STAGE_COMPLETE');
  if (supplyLedger(ctx.tx, ctx.at, stage.id).some(row => row.actual !== row.planned) && !note) conflict('SURGERY_NOTE_REQUIRED');
  const order = ctx.tx.get(ctx.at, 'clinical_orders', stage.order_id)!;
  const { binding } = stageProcedure(ctx, stage);
  const executionId = v7();
  ctx.tx.insert(ctx.at, 'surgery_executions', { id: executionId, surgery_request_id: surgery.request.id, outcome: 'completed', ...times(ctx) });
  ctx.tx.update(ctx.at, 'ward_surgery_stages', stage.id, stage.version, { completed_execution_id: executionId });
  ctx.tx.update(ctx.at, 'clinical_orders', order.id, order.version, { status: 'completed' });
  ctx.tx.insert(ctx.at, 'order_executions', { id: v7(), order_id: order.id, practitioner_role: ctx.actor.role.id, outcome: note ?? 'completed', ...times(ctx) });
  chargeOrder(billing, ctx.tx, ctx.at, { ...order, ...times(ctx) }, 1, wardDepartment(ctx.tx, ctx.at, surgery.admission.ward));
  if (binding?.reportService) publishAngiography(ctx, stage, binding.reportService);
  if (binding?.nursing) {
    const item = itemFor(ctx.tx, ctx.at, 'services', binding.nursing);
    const charged = surgery.stages.some(previous => ctx.tx.list(ctx.at, 'ward_surgery_charges', { stage_id: previous.id, purpose: 'nursing' }).some(link => ctx.tx.get(ctx.at, 'clinical_orders', link.order_id)?.catalog_item_id === item.id));
    if (!charged) post(ctx, surgery, item.id, 1, 'nursing', billing);
  }
  closeReservations(ctx, stage);
  changeStatus(ctx, surgery, standby(surgery) ? 'standby-pci' : 'completed');
  if (!standby(surgery)) stopOrders(ctx, surgery);
  return { ...advance(ctx, surgery.admission), executionId };
}
export function registerSurgery(catalog: OperationCatalog, billing?: WardBilling) {
  catalog.command(route('surgery.request', 'schedule-procedure'), { ...notice.shape, clinicalOverride: z.unknown().optional() }, receipt.extend({ requestId: id }), (ctx, { clinicalOverride, ...input }) => {
    const admission = mutateAdmission(ctx, ['admitted'], 'doctor');
    const { binding } = procedure(ctx.tx, ctx.at, input.procedureId);
    const org = organization(ctx.tx, ctx.at);
    const physicians = org.practitioners.filter(member => org.practitionerRoles.some(role => role.id === member.roleId && role.capabilities.includes('sign')));
    if (!physicians.some(member => member.id === input.surgeon) || input.assistant && (input.assistant === input.surgeon || !physicians.some(member => member.id === input.assistant))) conflict('SURGERY_TEAM_INVALID');
    if (![...org.departments, ...org.wards].some(site => site.id === input.location)) conflict('SURGERY_LOCATION_INVALID');
    if (input.standbyAdHocPci && binding?.kind !== 'angiography') conflict('ANGIOGRAPHY_REQUIRED');
    if (binding?.kind === 'pci') quality(ctx, { kind: 'pci', encounterId: ctx.targetId }, clinicalOverride);
    const order = openOrder(ctx.tx, ctx.at, ctx.targetId, input.procedureId, 'surgery', 'signed', times(ctx));
    const requestId = v7();
    ctx.tx.insert(ctx.at, 'surgery_requests', { id: requestId, order_id: order.id, procedure_item_id: input.procedureId, status: 'requested', version: 1 });
    ctx.tx.insert(ctx.at, 'ward_surgery_plans', { id: requestId, notice: notice.strip().parse(input) });
    openStage(ctx, requestId, 'planned', order.id, input.materials);
    return { ...advance(ctx, admission), requestId };
  });
  function prepare(ctx: CommandContext, surgery: Current, kind: 'consent' | 'nursing', document: Record<string, z.core.util.JSONType>) {
    if (surgery.request.status !== 'requested' || ctx.tx.list(ctx.at, 'ward_surgery_preparations', { request_id: surgery.request.id, kind }).length) conflict('PREPARATION_LOCKED');
    ctx.tx.insert(ctx.at, 'ward_surgery_preparations', { id: v7(), request_id: surgery.request.id, kind, document, signed_by: ctx.actor.role.id, ...times(ctx) });
    if (ctx.tx.list(ctx.at, 'ward_surgery_preparations', { request_id: surgery.request.id }).length === 2) changeStatus(ctx, surgery, 'ready');
    return advance(ctx, surgery.admission);
  }
  catalog.command(route('surgery.consent', 'schedule-procedure'), { ...requestField, signer: text, risks: text, diagnosisRevision: z.int().nonnegative() }, receipt, (ctx, { requestId, signer, risks, diagnosisRevision }) => {
    const surgery = current(ctx, requestId);
    const revisions = ctx.tx.list(ctx.at, 'diagnosis_revisions', { encounter_id: ctx.targetId });
    checkVersion(Math.max(0, ...revisions.map(row => row.revision)), diagnosisRevision);
    const patient = ctx.tx.get(ctx.at, 'patients', requireEncounter(ctx.tx, ctx.at, ctx.targetId).patient_id)!;
    return prepare(ctx, surgery, 'consent', { patient: patient.display_name, encounterId: ctx.targetId, signer, risks, diagnosisRevision, diagnoses: latestDiagnoses(ctx.tx, ctx.at, ctx.targetId), notice: surgery.plan });
  });
  catalog.command(route('surgery.check', 'execute-orders'), { ...requestField, checklist: text }, receipt, (ctx, { requestId, checklist }) => prepare(ctx, current(ctx, requestId, 'nurse'), 'nursing', { checklist }));
  catalog.command(route('surgery.cancel', 'schedule-procedure'), { ...requestField, reason: text }, receipt, (ctx, { requestId, reason }) => {
    const surgery = current(ctx, requestId);
    if (!['requested', 'ready'].includes(surgery.request.status) || surgery.stage.parent_execution_id) conflict('SURGERY_STATE_CONFLICT');
    closeReservations(ctx, surgery.stage);
    changeStatus(ctx, surgery, 'cancelled');
    const order = ctx.tx.get(ctx.at, 'clinical_orders', surgery.stage.order_id)!;
    ctx.tx.update(ctx.at, 'clinical_orders', order.id, order.version, { status: 'cancelled' });
    ctx.tx.insert(ctx.at, 'order_executions', { id: v7(), order_id: order.id, practitioner_role: ctx.actor.role.id, outcome: reason, ...times(ctx) });
    return advance(ctx, surgery.admission);
  });
  catalog.command(route('surgery.start', 'schedule-procedure'), requestField, receipt, (ctx, { requestId }) => {
    const surgery = current(ctx, requestId);
    if (surgery.request.status !== 'ready') conflict('SURGERY_NOT_READY');
    changeStatus(ctx, surgery, 'in-progress');
    return advance(ctx, surgery.admission);
  });
  const inProgress = (ctx: CommandContext, requestId: string) => {
    const surgery = current(ctx, requestId);
    if (surgery.request.status !== 'in-progress') conflict('SURGERY_NOT_IN_PROGRESS');
    return surgery;
  };
  catalog.command(route('surgery.record-material', 'schedule-procedure'), { ...requestField, ...material.shape, note: text.optional() }, receipt.extend({ useId: id }), (ctx, input) => {
    const surgery = inProgress(ctx, input.requestId);
    const useId = useSupply(ctx, surgery.stage, input, input.note, billing);
    return { ...advance(ctx, surgery.admission), useId };
  });
  catalog.command(route('surgery.correct-material', 'schedule-procedure'), { ...requestField, useId: id, quantity: material.shape.quantity, note: text }, receipt, (ctx, input) => {
    const surgery = inProgress(ctx, input.requestId);
    correctSupply(ctx, surgery.stage, input.useId, input.quantity, input.note, billing);
    return advance(ctx, surgery.admission);
  });
  catalog.command(route('surgery.record-medication', 'schedule-procedure'), { ...requestField, ...medication.shape, clinicalOverride: z.unknown().optional() }, receipt, (ctx, input) => {
    const surgery = inProgress(ctx, input.requestId);
    recordMedication(ctx, surgery, input, input.clinicalOverride, billing);
    return advance(ctx, surgery.admission);
  });
  const executed = receipt.extend({ executionId: id });
  catalog.command(route('surgery.execute', 'schedule-procedure'), { ...requestField, materials: materials.default([]), medications: z.array(medication).max(12).default([]), note: text.optional(), clinicalOverride: z.unknown().optional() }, executed, (ctx, input) => {
    const surgery = current(ctx, input.requestId);
    if (surgery.request.status !== 'ready') conflict('SURGERY_NOT_READY');
    for (const item of input.materials) useSupply(ctx, surgery.stage, item, input.note, billing);
    for (const drug of input.medications) recordMedication(ctx, surgery, drug, input.clinicalOverride, billing);
    return complete(ctx, surgery, input.note, billing);
  });
  catalog.command(route('surgery.preview-completion', 'schedule-procedure'), requestField, z.object({ fingerprint: z.string(), autoStop: z.array(id), deviation: z.boolean() }), (ctx, { requestId }) => preview(ctx, inProgress(ctx, requestId)));
  catalog.command(route('surgery.complete', 'schedule-procedure'), { ...requestField, fingerprint: z.string().length(64), note: text.optional() }, executed, async (ctx, input) => {
    const surgery = inProgress(ctx, input.requestId);
    if ((await preview(ctx, surgery)).fingerprint !== input.fingerprint) conflict('STALE_SURGERY_PREVIEW');
    return complete(ctx, surgery, input.note, billing);
  });
  catalog.command(route('surgery.convert-to-pci', 'schedule-procedure'), { ...requestField, procedureId: id, materials: materials.default([]), clinicalOverride: z.unknown().optional() }, receipt, (ctx, input) => {
    const surgery = current(ctx, input.requestId);
    const result = report(ctx, surgery);
    if (surgery.request.status !== 'standby-pci' || !result?.observations.length || !surgery.stage.completed_execution_id || procedure(ctx.tx, ctx.at, input.procedureId).binding?.kind !== 'pci') conflict('PCI_CONVERSION_UNAVAILABLE');
    quality(ctx, { kind: 'pci', encounterId: ctx.targetId, ffr: ffrFor(ctx, surgery) }, input.clinicalOverride);
    const order = openOrder(ctx.tx, ctx.at, ctx.targetId, input.procedureId, 'surgery', 'signed', times(ctx));
    openStage(ctx, input.requestId, 'ad-hoc-pci', order.id, input.materials, surgery.stage.completed_execution_id);
    changeStatus(ctx, surgery, 'ready');
    return advance(ctx, surgery.admission);
  });
  catalog.command(route('surgery.finalize-standby', 'schedule-procedure'), { ...requestField, note: text.optional() }, receipt, (ctx, { requestId, note }) => {
    const surgery = current(ctx, requestId);
    const abandonPci = surgery.stage.stage === 'ad-hoc-pci' && surgery.request.status === 'ready';
    if (!abandonPci && surgery.request.status !== 'standby-pci') conflict('SURGERY_STATE_CONFLICT');
    if (abandonPci) {
      if (!note) conflict('SURGERY_NOTE_REQUIRED');
      const order = ctx.tx.get(ctx.at, 'clinical_orders', surgery.stage.order_id)!;
      ctx.tx.update(ctx.at, 'clinical_orders', order.id, order.version, { status: 'cancelled' });
      ctx.tx.insert(ctx.at, 'order_executions', { id: v7(), order_id: order.id, practitioner_role: ctx.actor.role.id, outcome: note, ...times(ctx) });
      closeReservations(ctx, surgery.stage);
    }
    changeStatus(ctx, surgery, 'completed');
    stopOrders(ctx, surgery);
    return advance(ctx, surgery.admission);
  });
  catalog.command(route('surgery.acknowledge', 'review-reports'), requestField, receipt, (ctx, { requestId }) => {
    const surgery = current(ctx, requestId);
    const result = report(ctx, surgery);
    if (!result || result.acknowledged) conflict('SURGERY_REPORT_CONFLICT');
    ctx.tx.insert(ctx.at, 'report_acknowledgements', { id: v7(), report_id: result.id, practitioner_role: ctx.actor.role.id, ...times(ctx) });
    return advance(ctx, surgery.admission);
  });
}

export function surgeryView(reader: StoreReader, at: StoreScope, encounterId: string) {
  return reader.list(at, 'clinical_orders', { encounter_id: encounterId, kind: 'surgery' }).flatMap(order => reader.list(at, 'surgery_requests', { order_id: order.id }).flatMap(request => {
    const plan = reader.get(at, 'ward_surgery_plans', request.id);
    if (!plan) return [];
    const stages = staged(reader, at, request.id).map(stage => {
      const procedureId = reader.get(at, 'clinical_orders', stage.order_id)!.catalog_item_id;
      const config = procedure(reader, at, procedureId);
      return { id: stage.id, procedureId, kind: config.binding?.kind ?? 'other', stage: stage.stage, parentExecutionId: stage.parent_execution_id, executionId: stage.completed_execution_id, supplies: supplyLedger(reader, at, stage.id),
        medications: reader.list(at, 'ward_surgery_charges', { stage_id: stage.id, purpose: 'medication' }).map(row => reader.get(at, 'clinical_orders', row.order_id)!.catalog_item_id) };
    });
    const last = stages.filter(stage => stage.executionId).at(-1);
    const setId = last && procedure(reader, at, last.procedureId).binding?.postoperativeSetId;
    const postoperative: (Coding & { kind: string })[] = [];
    if (setId && request.status === 'completed') {
      const sets = z.array(z.object({ id: z.string(), members: z.array(z.object({ kind: z.string(), code: z.string(), codeSystem: z.string() })) })).parse(reader.list(at, 'data_pack_installations')[0]!.knowledge.orderSetTemplates);
      postoperative.push(...sets.find(set => set.id === setId)?.members ?? []);
    }
    return [{ id: request.id, status: request.status, plan: notice.parse(plan.notice), stages, report: reportFor(reader, at, stages[0]!.id), postoperative,
      preparations: reader.list(at, 'ward_surgery_preparations', { request_id: request.id }).map(row => ({ kind: row.kind, signedBy: row.signed_by, at: row.virtual_at, document: row.document })) }];
  }));
}
