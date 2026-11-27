import { z } from 'zod';
import { requireEncounter } from '../patient-visit';
import { executionReceipt, readDiagnosticOrder } from '../diagnostic-workflow';
import type { ClinMeshModule, OperationCatalog } from '../platform';
import { findings, issueReceipt, labViewSchema, maxBatch, quote, type LabBillingPort } from './lib/contracts';
import { clinicalServices, issueOrders, legacyProcedure, savedDraft, saveDraft } from './lib/orders';
import { labOrders, moveOrder, publishDue, reportsReviewed, reviewReport } from './lib/reports';

export { labViewSchema, issueReceipt, type LabView, type LabOrder, type LabBillingPort } from './lib/contracts';
export { findings as signedFindingsSchema } from './lib/contracts';
export function acceptDispatchedInvestigation(context: Parameters<typeof moveOrder>[0], billing?: LabBillingPort) { return moveOrder(context, 'accept', billing); }

const base = '/api/his/encounters/:id/lab';
const sign = { capabilities: ['sign'] };
export function createLabModule({ billing, legacyProcedures = [] }: { billing?: LabBillingPort; legacyProcedures?: z.infer<typeof legacyProcedure>[] } = {}): ClinMeshModule<OperationCatalog> {
  const legacy = z.array(legacyProcedure).parse(legacyProcedures);
  return { id: 'mod-lab', kind: 'clinical', version: '1', workbenchTabs: [{ id: 'lab', label: { en: 'Investigations', zh: '检验与功能检查' } }],
    clockAdvanced: publishDue,
    completion: (reader, at, encounterId) => [{ id: 'report-acknowledgement', label: { en: 'Latest investigation reports acknowledged', zh: '最新检验检查报告已阅' }, passed: reportsReviewed(reader, at, encounterId) }],
    registerOperations(catalog) {
      catalog.query({ name: 'lab.read', path: base, access: {}, assistantRead: 'encounter' }, labViewSchema, ({ reader, actor, targetId }) => {
        const at = actor.at;
        requireEncounter(reader, at, targetId);
        return { services: clinicalServices(reader, at, legacy).map(({ definition, kind, quote: { serviceId, ...price } }) => ({ id: serviceId, ...price, kind, display: definition.display, codeSystem: definition.codeSystem, code: definition.code })),
          draft: savedDraft(reader, at, targetId), orders: labOrders(reader, at, targetId).map(order => readDiagnosticOrder(reader, at, order, findings.parse)) };
      });
      catalog.command({ name: 'lab.save-draft', path: `${base}/draft`, method: 'PUT', access: { capabilities: ['assess'] }, risk: 'write' }, { serviceIds: z.array(z.uuidv7()).max(maxBatch).refine(items => new Set(items).size === items.length) }, z.object({ version: z.int().positive() }), (context, { serviceIds }) => saveDraft(context, serviceIds, legacy));
      catalog.command({ name: 'lab.issue', cliPath: 'lab order issue', path: `${base}/issue`, method: 'POST', access: sign }, { items: z.array(quote).min(1).max(maxBatch).refine(items => new Set(items.map(item => item.serviceId)).size === items.length) }, issueReceipt, (context, { items }) => issueOrders(context, items, legacy, billing));
      for (const action of ['accept', 'start', 'report-now', 'cancel'] as const) {
        const access = action === 'cancel' ? { ...sign, visitorOnly: true } : { capabilities: ['execute-orders', 'sign', 'workspace-admin'] };
        catalog.command({ name: `lab.${action}`, cliPath: `lab order ${action}`, path: `/api/his/lab/orders/:id/${action}`, method: 'POST', access }, {}, executionReceipt, context => moveOrder(context, action, billing));
      }
      for (const action of ['amend', 'acknowledge'] as const) {
        const capabilities = action === 'amend' ? ['workspace-admin', 'administrator'] : ['review-reports'];
        catalog.command({ name: `lab.${action}`, cliPath: `lab report ${action}`, path: `/api/his/reports/:id/${action}`, method: 'POST', access: { capabilities, visitorOnly: action === 'amend' } }, { reportVersion: z.int().positive() }, executionReceipt, (context, { reportVersion }) => reviewReport(context, reportVersion, action === 'amend'));
      }
    },
  };
}
