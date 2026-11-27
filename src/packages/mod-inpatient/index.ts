import { v7 } from 'uuid';
import { acceptDispatchedInvestigation } from '../mod-lab';
import type { ClinMeshModule, OperationCatalog } from '../platform';
import { registerAdmission, registerAdmissions } from './lib/admissions';
import { rollDay } from './lib/calendar';
import { chartView, registerDischarge } from './lib/discharge';
import { identifiers, registerOrders } from './lib/orders';
import { registerSurgery, surgeryView } from './lib/surgery';
import { initializeMaterials } from './lib/surgery-facts';
import { wardViewSchema } from './lib/view-contract';
import { commonView, directory, directorySchema, specimenCards } from './lib/views';
import { advance, clinician, conflict, mutateAdmission, organization, receipt, requireAdmission, route, times, wardsBase, type WardBilling } from './lib/ward';

export { directorySchema } from './lib/views';
export { completionPreviewSchema } from './lib/surgery';
export { wardViewSchema, type WardView } from './lib/view-contract';
export function createInpatientModule(billing?: WardBilling): ClinMeshModule<OperationCatalog> {
  return { id: 'mod-inpatient', kind: 'clinical', version: '1', initializeEpoch: initializeMaterials, midnight: (tx, at, day) => rollDay(tx, at, day, billing),
    availableInEpoch: (reader, at) => !!reader.list(at, 'data_pack_installations')[0]?.knowledge.inpatient,
    encounterStarted(tx, at, encounterId, virtualAt, recordedAt) {
      const encounter = tx.get(at, 'encounters', encounterId)!;
      if (encounter.encounter_class !== 'inpatient' || !tx.list(at, 'data_pack_installations')[0]?.knowledge.inpatient) return;
      const org = organization(tx, at);
      const departments = org.practitioners.filter(person => person.roleId === encounter.active_practitioner_role).map(person => person.departmentId);
      const ward = org.wards.find(ward => departments.includes(ward.departmentId)) ?? org.wards[0] ?? conflict('WARD_NOT_IN_PACK');
      const responsible = clinician(tx, at, ward.id);
      if (encounter.active_practitioner_role !== responsible) tx.update(at, 'encounters', encounter.id, encounter.version, { active_practitioner_role: responsible });
      registerAdmission(tx, at, encounter.id, ward.id, virtualAt, recordedAt);
    },
    guardEncounter({ tx, at }, write) {
      const [admission] = tx.list(at, 'inpatient_admissions', { encounter_id: write.encounterId });
      if (!admission) return;
      if (tx.list(at, 'medical_record_archives', { admission_id: admission.id }).length) conflict('CHART_ARCHIVED');
      if (!tx.list(at, 'data_pack_installations')[0]?.knowledge.inpatient) return;
      if (admission.status === 'cleared' && (write.kind === 'record' || write.kind === 'complete')) return;
      if (write.kind === 'complete' || !['admitted', 'discharge-pending'].includes(admission.status)) conflict('ADMISSION_STATE_CONFLICT');
      if (write.kind === 'diagnose') conflict('ADMISSION_POA_REQUIRED');
      if (write.kind === 'accept-investigation' && tx.list(at, 'lab_requests', { order_id: write.orderId }).length && !tx.list(at, 'ward_specimen_dispatches', { order_id: write.orderId }).length) conflict('WARD_DISPATCH_REQUIRED');
    }, registerOperations(catalog) {
    registerAdmissions(catalog);
    registerOrders(catalog, billing);
    registerSurgery(catalog, billing);
    registerDischarge(catalog, billing);
    catalog.command(route('investigation.dispatch', 'execute-orders'), { orderIds: identifiers }, receipt, (ctx, { orderIds }) => {
      const admission = mutateAdmission(ctx, ['admitted'], 'nurse');
      if (!ctx.moduleEnabled?.('mod-lab')) conflict('LAB_MODULE_REQUIRED');
      const cards = specimenCards(ctx.tx, ctx.at, ctx.targetId);
      for (const orderId of orderIds) {
        const card = cards.find(card => card.orderIds.includes(orderId));
        if (!card) conflict('WARD_SPECIMEN_CONFLICT');
        ctx.tx.insert(ctx.at, 'ward_specimen_dispatches', { id: v7(), order_id: orderId, sent_by: ctx.actor.role.id, tube: card.tube, ...times(ctx) });
        acceptDispatchedInvestigation({ ...ctx, targetId: orderId, expectedVersion: ctx.tx.get(ctx.at, 'clinical_orders', orderId)!.version }, billing);
      }
      return advance(ctx, admission);
    });
    catalog.query({ name: 'ward.directory', path: wardsBase, access: {} }, directorySchema, ({ reader, actor }) => directory(reader, actor.at));
    catalog.query({ name: 'ward.read', path: `${wardsBase}/:id`, access: {} }, wardViewSchema, ({ reader, actor, targetId }) => ({ ...commonView(reader, actor.at, targetId, billing), surgeries: surgeryView(reader, actor.at, targetId), chart: chartView(reader, actor.at, requireAdmission(reader, actor.at, targetId)) }));
  } };
}
