import { v7 } from 'uuid';
import { z } from 'zod';
import { diagnosisState, reviewedDiagnosisDraft } from '../../clinical-core';
import { requireEncounter } from '../../patient-visit';
import { checkVersion, type CommandContext, type OperationCatalog } from '../../platform';
import { canonicalJson, type EntityRow, type StoreReader, type StoreScope } from '../../store';
import { blockers, pendingTransfer } from './admissions';
import { activeMedicationIds, latestDiagnoses } from './orders';
import { surgeryView } from './surgery';
import { commonView } from './views';
import { advance, conflict, id, mutateAdmission, occupancy, quality, receipt, route, text, times, type Admission, type WardBilling } from './ward';

const frontPage = z.strictObject({ summary: text, disposition: text, followUp: text });

function chartDiagnosis(reader: StoreReader, at: StoreScope, encounterId: string) {
  const state = diagnosisState(reader, at, encounterId);
  return { id: state.diagnosisRevisions.at(-1)?.id, draftReviewed: reviewedDiagnosisDraft(state), diagnoses: latestDiagnoses(reader, at, encounterId) };
}

function reviewCurrent(page: EntityRow<'ward_chart_revisions'>, review: EntityRow<'ward_coding_reviews'> | undefined, basis: ReturnType<typeof chartDiagnosis>) {
  if (!basis.id || page.front_page.diagnosisRevisionId !== basis.id) return false;
  if (!review) return true;
  return review.coding.diagnosisRevisionId === basis.id && Array.isArray(review.coding.diagnoses) && canonicalJson(review.coding.diagnoses) === canonicalJson(basis.diagnoses);
}

function approvedDiagnosis(ctx: CommandContext) {
  const basis = chartDiagnosis(ctx.tx, ctx.at, ctx.targetId);
  if (!basis.id || !basis.draftReviewed) conflict('ADMISSION_DIAGNOSIS_REVIEW_REQUIRED');
  return { ...basis, id: basis.id };
}

export function chartView(reader: StoreReader, at: StoreScope, admission: Admission) {
  const revisions = reader.list(at, 'ward_chart_revisions', { admission_id: admission.id }).sort((first, second) => first.revision - second.revision);
  const last = revisions.at(-1);
  const review = last && reader.list(at, 'ward_coding_reviews', { revision_id: last.id })[0];
  const archive = reader.list(at, 'medical_record_archives', { admission_id: admission.id })[0];
  const basis = last && chartDiagnosis(reader, at, admission.encounter_id);
  let state = last ? 'submitted' : 'open';
  if (last && basis) {
    if (!basis.draftReviewed) state = 'diagnosis-review-required';
    else if (!reviewCurrent(last, review, basis)) state = 'resubmit-required';
    else if (review) state = 'reviewed';
  }
  if (archive) state = 'archived';
  return { state, revision: last?.revision ?? 0,
    revisions: revisions.map(row => ({ revision: row.revision, id: row.id, fields: frontPage.strip().parse(row.front_page), submittedBy: row.submitted_by })), review: ['reviewed', 'archived'].includes(state) ? review?.coding ?? null : null, archive: archive?.archive ?? null };
}
function dischargeReady(ctx: CommandContext, admission: Admission, departing: boolean) {
  if (!reviewedDiagnosisDraft(diagnosisState(ctx.tx, ctx.at, ctx.targetId))) conflict('ADMISSION_DIAGNOSIS_REVIEW_REQUIRED');
  const surgeries = surgeryView(ctx.tx, ctx.at, ctx.targetId);
  const blocking = blockers(ctx.tx, ctx.at, admission, true).some(issue => departing || issue !== 'ACTIVE_WARD_ORDER');
  if (!latestDiagnoses(ctx.tx, ctx.at, ctx.targetId).some(row => row.primary && row.poa) || blocking || pendingTransfer(ctx.tx, ctx.at, admission) || surgeries.some(surgery => surgery.report && !surgery.report.acknowledged)) conflict('DISCHARGE_BLOCKED');
  return surgeries;
}
export function registerDischarge(catalog: OperationCatalog, billing?: WardBilling) {
  catalog.command(route('discharge.issue', 'admit'), { clinicalOverride: z.unknown().optional() }, receipt, (ctx, { clinicalOverride }) => {
    const admission = mutateAdmission(ctx, ['admitted'], 'doctor');
    const surgeries = dischargeReady(ctx, admission, false);
    quality(ctx, { kind: 'discharge', encounterId: ctx.targetId, completedPci: surgeries.some(surgery => surgery.stages.some(stage => stage.kind === 'pci' && stage.executionId)), activeMedicationIds: activeMedicationIds(ctx.tx, ctx.at, ctx.targetId, true) }, clinicalOverride);
    return advance(ctx, admission, 'discharge-pending');
  });
  catalog.command(route('discharge.depart', 'execute-orders'), {}, receipt, ctx => {
    const admission = mutateAdmission(ctx, ['discharge-pending'], 'nurse');
    dischargeReady(ctx, admission, true);
    return advance(ctx, admission, 'departed');
  });
  catalog.command(route('discharge.recall', 'admit'), { reason: text }, receipt, (ctx, { reason }) => {
    const admission = mutateAdmission(ctx, ['discharge-pending', 'departed'], 'doctor');
    if (billing?.readAdmissionFunds(ctx.tx, ctx.at, ctx.targetId).locked) conflict('SETTLEMENT_LOCKED');
    ctx.tx.insert(ctx.at, 'audit_events', { id: v7(), actor: ctx.actor.id, practitioner_role: ctx.actor.role.id, target_id: ctx.targetId, operation: 'ward.discharge.recall-reason', outcome: reason, ...times(ctx) });
    return advance(ctx, admission, 'admitted');
  });
  catalog.command(route('discharge.clear', 'execute-orders'), {}, receipt, ctx => {
    const admission = mutateAdmission(ctx, ['departed'], 'nurse');
    if (billing && !billing.readAdmissionFunds(ctx.tx, ctx.at, ctx.targetId).canClearBed) conflict('SETTLEMENT_REQUIRED');
    const held = occupancy(ctx.tx, ctx.at, admission) ?? conflict('BED_REQUIRED');
    ctx.tx.update(ctx.at, 'bed_occupancies', held.id, held.version, { released_at: ctx.virtualAt });
    return advance(ctx, admission, 'cleared');
  });
  catalog.command(route('chart.submit', 'admit'), frontPage.shape, receipt, (ctx, fields) => {
    const admission = mutateAdmission(ctx, ['cleared'], 'doctor');
    const basis = approvedDiagnosis(ctx);
    const previous = ctx.tx.list(ctx.at, 'ward_chart_revisions', { admission_id: admission.id }).sort((first, second) => second.revision - first.revision)[0];
    ctx.tx.insert(ctx.at, 'ward_chart_revisions', { id: v7(), admission_id: admission.id, previous_revision_id: previous?.id ?? null, revision: (previous?.revision ?? 0) + 1, front_page: { ...frontPage.strip().parse(fields), diagnosisRevisionId: basis.id }, submitted_by: ctx.actor.role.id, ...times(ctx) });
    return advance(ctx, admission);
  });
  function latestPage(ctx: CommandContext, admission: Admission, revision: number) {
    const latest = ctx.tx.list(ctx.at, 'ward_chart_revisions', { admission_id: admission.id }).sort((first, second) => second.revision - first.revision)[0] ?? conflict('FRONT_PAGE_REQUIRED');
    checkVersion(latest.revision, revision);
    return latest;
  }
  catalog.command(route('chart.review', 'code-chart'), { revision: z.int().positive(), coding: text }, receipt, (ctx, input) => {
    const admission = mutateAdmission(ctx, ['cleared']);
    const latest = latestPage(ctx, admission, input.revision);
    const basis = approvedDiagnosis(ctx);
    const prior = ctx.tx.list(ctx.at, 'ward_coding_reviews', { revision_id: latest.id })[0];
    if (!reviewCurrent(latest, prior, basis)) conflict('FRONT_PAGE_RESUBMISSION_REQUIRED');
    if (prior) conflict('CHART_ALREADY_REVIEWED');
    ctx.tx.insert(ctx.at, 'ward_coding_reviews', { id: v7(), revision_id: latest.id, reviewed_by: ctx.actor.role.id, coding: { note: input.coding, diagnosisRevisionId: basis.id, diagnoses: basis.diagnoses }, ...times(ctx) });
    return advance(ctx, admission);
  });
  catalog.command(route('chart.archive', 'code-chart'), { revision: z.int().positive() }, receipt.extend({ archiveId: id }), (ctx, { revision }) => {
    const admission = mutateAdmission(ctx, ['cleared']);
    if (requireEncounter(ctx.tx, ctx.at, ctx.targetId).status !== 'completed' || !ctx.tx.list(ctx.at, 'clinical_record_revisions', { encounter_id: ctx.targetId }).length) conflict('CLINICAL_COMPLETION_REQUIRED');
    const latest = latestPage(ctx, admission, revision);
    const basis = approvedDiagnosis(ctx);
    const review = ctx.tx.list(ctx.at, 'ward_coding_reviews', { revision_id: latest.id })[0] ?? conflict('CODING_REVIEW_REQUIRED');
    if (!reviewCurrent(latest, review, basis)) conflict('FRONT_PAGE_RESUBMISSION_REQUIRED');
    const snapshot = commonView(ctx.tx, ctx.at, ctx.targetId, billing);
    const reports = ctx.tx.list(ctx.at, 'clinical_orders', { encounter_id: ctx.targetId }).flatMap(order => ctx.tx.list(ctx.at, 'diagnostic_reports', { order_id: order.id }));
    const archiveId = v7();
    ctx.tx.insert(ctx.at, 'medical_record_archives', { id: archiveId, admission_id: admission.id, archive: { ...snapshot, revision, diagnosisRevisionId: basis.id, diagnoses: basis.diagnoses, frontPage: latest.front_page, codingReview: review, surgeries: surgeryView(ctx.tx, ctx.at, ctx.targetId), reports,
      clinicalRecords: ctx.tx.list(ctx.at, 'clinical_record_revisions', { encounter_id: ctx.targetId }), settlementId: ctx.tx.list(ctx.at, 'billing_settlements', { encounter_id: ctx.targetId })[0]?.id ?? null }, ...times(ctx) });
    return { ...advance(ctx, admission), archiveId };
  });
}
