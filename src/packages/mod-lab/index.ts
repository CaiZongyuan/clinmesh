import { z } from 'zod';
import { requireEncounter } from '../patient-visit';
import type { ClinMeshModule, OperationCatalog } from '../platform';
import { issueReceipt, labViewSchema, maxBatch, quote, status, type LabBillingPort } from './lib/contracts';
import { clinicalServices, issueOrders, labOrders, savedDraft, saveDraft } from './lib/orders';
import { moveOrder, publishDue, readOrder, reportsReviewed, reviewReport } from './lib/reports';

export { labViewSchema, issueReceipt, type LabView, type LabOrder, type LabBillingPort } from './lib/contracts';

const base = '/api/his/encounters/:id/lab';
const sign = { capabilities: ['sign'], visitorOnly: true };
const executed = z.object({ version: z.int().positive(), status });
export function createLabModule({ billing }: { billing?: LabBillingPort } = {}): ClinMeshModule<OperationCatalog> {
  return { id: 'mod-lab', kind: 'clinical', version: '1', workbenchTabs: [{ id: 'lab', label: { en: 'Investigations', zh: '检验与功能检查' } }],
    clockAdvanced: publishDue,
    completion: (reader, at, encounterId) => [{ id: 'report-acknowledgement', label: { en: 'Latest investigation reports acknowledged', zh: '最新检验检查报告已阅' }, passed: reportsReviewed(reader, at, encounterId) }],
    registerOperations(catalog) {
      catalog.query({ name: 'lab.read', path: base, access: {} }, labViewSchema, ({ reader, actor, targetId }) => {
        const at = actor.at;
        requireEncounter(reader, at, targetId);
        return { services: clinicalServices(reader, at).map(({ definition, kind, quote: { serviceId, ...price } }) => ({ id: serviceId, ...price, kind, display: definition.display, codeSystem: definition.codeSystem, code: definition.code })),
          draft: savedDraft(reader, at, targetId), orders: labOrders(reader, at, targetId).map(order => readOrder(reader, at, order)) };
      });
      catalog.command({ name: 'lab.save-draft', path: `${base}/draft`, method: 'PUT', access: { capabilities: ['assess'] } }, { serviceIds: z.array(z.uuidv7()).max(maxBatch).refine(items => new Set(items).size === items.length) }, z.object({ version: z.int().positive() }), (context, { serviceIds }) => saveDraft(context, serviceIds));
      catalog.command({ name: 'lab.issue', path: `${base}/issue`, method: 'POST', access: sign }, { items: z.array(quote).min(1).max(maxBatch).refine(items => new Set(items.map(item => item.serviceId)).size === items.length) }, issueReceipt, (context, { items }) => issueOrders(context, items, billing));
      for (const action of ['accept', 'start', 'report-now', 'cancel'] as const) {
        const access = action === 'cancel' ? sign : { capabilities: ['execute-orders', 'sign', 'workspace-admin'], visitorOnly: true };
        catalog.command({ name: `lab.${action}`, path: `/api/his/lab/orders/:id/${action}`, method: 'POST', access }, {}, executed, context => moveOrder(context, action, billing));
      }
      for (const action of ['amend', 'acknowledge'] as const) {
        const capabilities = action === 'amend' ? ['workspace-admin', 'administrator'] : ['review-reports'];
        catalog.command({ name: `lab.${action}`, path: `/api/his/reports/:id/${action}`, method: 'POST', access: { capabilities, visitorOnly: true } }, { reportVersion: z.int().positive() }, executed, (context, { reportVersion }) => reviewReport(context, reportVersion, action === 'amend'));
      }
    },
  };
}
