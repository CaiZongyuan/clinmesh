import { v7 } from 'uuid';
import { z } from 'zod';
import { caseTruthSchema, manifestSchema } from '../../data-pack';
import { editEncounter, requireEncounter } from '../../patient-visit';
import { CoreError, type ClinMeshModule, type CommandContext, type OperationCatalog } from '../../platform';
import type { EntityRow, StoreReader, StoreScope } from '../../store';
import { createReportLifecycle, executionReceipt, pricedServices, quote, readDiagnosticOrder, requestStages, requireOrderPrerequisites, sameQuote, serviceFor, type DiagnosticBillingPort } from '../../diagnostic-workflow';
import { frameList, reviewMode, storedStudy, studyViewSchema, type StudyKind } from './contracts';

type Definition = {
  kind: StudyKind; label: { en: string; zh: string }; gateLabel: { en: string; zh: string };
  validateHistory(context: CommandContext, encounter: EntityRow<'encounters'>, priorSurgeryId?: string): void;
};
const sign = { capabilities: ['sign'], visitorOnly: true };
const review = { capabilities: ['review-reports'], visitorOnly: true };
const execute = { capabilities: ['sign', 'execute-orders', 'workspace-admin'], visitorOnly: true };
const reportVersion = z.int().positive();
const resultSource = caseTruthSchema.pick({ results: true }).strip();
const requestFor = (reader: StoreReader, at: StoreScope, orderId: string) => reader.list(at, 'study_requests', { order_id: orderId })[0];

export function createStudyModule(definition: Definition, billing?: DiagnosticBillingPort): ClinMeshModule<OperationCatalog> {
  const { kind, label, gateLabel } = definition;
  const base = `/api/his/encounters/:id/${kind}`;
  const lifecycle = createReportLifecycle({
    name: kind, notFound: 'STUDY_NOT_FOUND',
    owns: (reader, at, order) => order.kind === kind && !!requestFor(reader, at, order.id),
    resolve(reader, at, order, revision) {
      const request = requestFor(reader, at, order.id)!;
      const source = reader.readPrivateCaseTruth(at, { purpose: 'simulation', encounterId: order.encounter_id });
      const results = resultSource.safeParse(source?.truth);
      if (!results.success) return undefined;
      const service = serviceFor(reader, at, order);
      const matches = results.data.results.filter(result => result.service.codeSystem === service.codeSystem && result.service.code === service.code && (result.priorSurgeryId ?? null) === request.prior_surgery_id);
      const stage = request.stages.find(stage => matches.some(item => item.stage === stage));
      const result = matches.find(item => item.stage === stage && item.revision === revision);
      if (result?.sections?.kind !== kind) return undefined;
      const policy = manifestSchema.shape.policies.parse(reader.list(at, 'data_pack_installations')[0]!.manifest.policies);
      const frames = result.images ?? [];
      return { sections: result.sections, frames, requireFirstFrame: frames.length > 0 && !!policy.requireRenderedReportFrame, ...(result.amendmentReason && { amendmentReason: result.amendmentReason }) };
    },
  });
  const services = (reader: StoreReader, at: StoreScope) => pricedServices(reader, at).filter(item => item.definition.kind === kind);
  return { id: `mod-${kind}`, kind: 'clinical', version: '1', workbenchTabs: [{ id: kind, label }], clockAdvanced: lifecycle.publishDue,
    completion: (reader, at, id) => [{ id: `${kind}-acknowledgement`, label: gateLabel, passed: lifecycle.reportsReviewed(reader, at, id) }],
    registerOperations(catalog) {
      catalog.query({ name: `${kind}.read`, path: base, access: { capabilities: [...execute.capabilities, 'review-reports'] } }, studyViewSchema, ({ reader, actor, targetId }) => {
        const { at } = actor;
        requireEncounter(reader, at, targetId);
        return { services: services(reader, at).map(item => ({ quote: item.quote, display: item.definition.display })), orders: lifecycle.orders(reader, at, targetId).map(order => ({
          ...readDiagnosticOrder(reader, at, order, raw => { const { frames, ...text } = storedStudy.parse(raw); return { ...text, frameCount: frames.length }; }), priorSurgeryId: requestFor(reader, at, order.id)!.prior_surgery_id,
        })) };
      });
      catalog.command({ name: `${kind}.issue`, path: `${base}/issue`, method: 'POST', access: sign }, { item: quote, priorSurgeryId: z.string().min(1).optional() }, z.object({ orderId: z.uuidv7(), version: z.int().positive() }), (context, { item, priorSurgeryId }) => {
        const { tx, at, targetId, actor, virtualAt, recordedAt } = context;
        const version = editEncounter(context);
        const encounter = requireEncounter(tx, at, targetId);
        requireOrderPrerequisites(context);
        definition.validateHistory(context, encounter, priorSurgeryId);
        if (!sameQuote(services(tx, at).find(service => service.quote.serviceId === item.serviceId)?.quote, item)) throw new CoreError(409, 'CATALOG_CONFLICT');
        const prior = lifecycle.orders(tx, at, targetId).filter(order => order.catalog_item_id === item.serviceId && requestFor(tx, at, order.id)?.prior_surgery_id === (priorSurgeryId ?? null));
        const stages = requestStages(tx, at, encounter, prior);
        if (!stages) throw new CoreError(409, 'ACTIVE_ORDER_EXISTS');
        const orderId = v7();
        const { serviceId, ...price } = item;
        tx.insert(at, 'clinical_orders', { id: orderId, encounter_id: targetId, catalog_item_id: serviceId, kind, status: 'issued', version: 1, virtual_at: virtualAt, recorded_at: recordedAt });
        tx.insert(at, 'study_requests', { id: v7(), order_id: orderId, stages, prior_surgery_id: priorSurgeryId ?? null });
        if (actor.enabledModules.includes('mod-billing')) billing?.freezeCharge(tx, at, { ...price, orderId, encounterId: targetId, catalogItemId: serviceId, quantity: 1, virtualAt, recordedAt });
        return { orderId, version };
      });
      for (const action of ['accept', 'start', 'report-now', 'cancel'] as const) {
        catalog.command({ name: `${kind}.${action}`, path: `/api/his/${kind}/orders/:id/${action}`, method: 'POST', access: action === 'cancel' ? sign : execute }, {}, executionReceipt, context => lifecycle.moveOrder(context, action, billing));
      }
      const reportPath = `/api/his/${kind}/reports/:id`;
      catalog.command({ name: `${kind}.amend`, path: `${reportPath}/amend`, method: 'POST', access: { capabilities: ['workspace-admin'], visitorOnly: true } }, { reportVersion }, executionReceipt, (context, input) => lifecycle.reviewReport(context, input.reportVersion, true));
      catalog.command({ name: `${kind}.acknowledge`, path: `${reportPath}/acknowledge`, method: 'POST', access: review }, { reportVersion, mode: reviewMode }, executionReceipt, (context, { reportVersion, mode }) => lifecycle.reviewReport(context, reportVersion, false, report => {
        const study = storedStudy.parse(report.findings);
        if (mode === 'text' ? study.requireFirstFrame : !study.frames.length) throw new CoreError(409, 'REPORT_REVIEW_MODE_INVALID');
        context.tx.insert(context.at, 'audit_events', { id: v7(), actor: context.actor.id, practitioner_role: context.actor.role.id, operation: `${kind}.review-mode`, target_id: report.id, outcome: mode, virtual_at: context.virtualAt, recorded_at: context.recordedAt });
      }));
      catalog.query({ name: `${kind}.frames`, path: `${base}/reports/:reportId/frames`, access: review }, frameList, ({ reader, actor, targetId, params }) => {
        const encounter = requireEncounter(reader, actor.at, targetId);
        if (encounter.active_practitioner_role !== actor.role.id) throw new CoreError(403, 'RESPONSIBLE_ROLE_REQUIRED');
        const report = reader.get(actor.at, 'diagnostic_reports', z.uuidv7().parse(params?.reportId));
        const order = report && reader.get(actor.at, 'clinical_orders', report.order_id);
        if (!report || order?.kind !== kind || order.encounter_id !== targetId || !requestFor(reader, actor.at, order.id)) throw new CoreError(404, 'REPORT_NOT_FOUND');
        return { reportId: report.id, frames: storedStudy.parse(report.findings).frames };
      });
    },
  };
}
