import { z } from 'zod';
import type { Coding } from '../packages/data-pack';
import { studyViewSchema } from '../packages/diagnostic-studies';
import { issueReceipt, labViewSchema } from '../packages/mod-lab';
import { CoreError } from '../packages/platform';
import type { StorePort, StoreScope } from '../packages/store';

export const studyKinds = ['lab', 'imaging', 'pathology'] as const;
type Kind = typeof studyKinds[number];
type Call = (operation: string, targetId: string, version?: number, fields?: object) => Promise<unknown>;
export async function evaluationStudies(store: StorePort, at: StoreScope, encounterId: string, call: Call, enabled: (name: string) => boolean) {
  const services: { kind: Kind; id: string; code: string; codeSystem: string; name: string }[] = [];
  const read = async (kind: Kind) => {
    const output = await call(`${kind}.read`, encounterId);
    return kind === 'lab' ? labViewSchema.parse(output) : studyViewSchema.parse(output);
  };
  for (const kind of studyKinds.filter(kind => enabled(`${kind}.read`))) {
    const view = await read(kind);
    services.push(...await store.read(reader => view.services.map(service => {
      const id = 'quote' in service ? service.quote.serviceId : service.id;
      const catalog = reader.get(at, 'catalog_items', id)!;
      return { kind, id, code: catalog.code, codeSystem: catalog.code_system, name: service.display.en };
    })));
  }
  const reviewed = new Set<string>();
  const located = new Map<string, Kind>();
  async function locate(reportId: string, reportVersion: number) {
    const kind = located.get(reportId);
    if (!kind) throw new CoreError(404, 'REPORT_NOT_FOUND');
    const order = (await read(kind)).orders.find(item => item.reports.some(report => report.id === reportId));
    const report = order?.reports.find(item => item.id === reportId && item.version === reportVersion);
    if (!order || !report) throw new CoreError(409, 'REPORT_SUPERSEDED');
    return { kind, order, report };
  }
  return { services,
    async investigate(serviceId: string, encounterVersion: number, priorSurgeryId?: string) {
      const service = services.find(item => item.id === serviceId);
      if (!service) throw new CoreError(400, 'SERVICE_NOT_IN_CATALOG');
      const { kind } = service;
      let orderId: string;
      if (kind === 'lab') {
        const view = labViewSchema.parse(await call('lab.read', encounterId));
        await call('lab.save-draft', encounterId, view.draft.version, { serviceIds: [service.id] });
        const { draft } = labViewSchema.parse(await call('lab.read', encounterId));
        const issued = issueReceipt.parse(await call('lab.issue', encounterId, draft.version, { items: draft.items })).results[0];
        if (!issued || !('orderId' in issued)) throw new CoreError(409, 'INVESTIGATION_NOT_ISSUED');
        orderId = issued.orderId;
      } else {
        const view = studyViewSchema.parse(await call(`${kind}.read`, encounterId));
        const item = view.services.find(item => item.quote.serviceId === service.id)!.quote;
        const receipt = await call(`${kind}.issue`, encounterId, encounterVersion, { item, ...(priorSurgeryId && { priorSurgeryId }) });
        orderId = z.object({ orderId: z.uuidv7() }).parse(receipt).orderId;
      }
      let version = 1;
      for (const step of ['accept', 'start', 'report-now']) version = z.object({ version: z.int() }).parse(await call(`${kind}.${step}`, orderId, version)).version;
      const report = (await read(kind)).orders.find(item => item.id === orderId)?.reports.at(-1);
      if (!report) throw new CoreError(409, 'REPORT_UNAVAILABLE');
      located.set(report.id, kind);
      return { service: service.name, serviceId, reportId: report.id, reportVersion: report.version };
    },
    async report(reportId: string, reportVersion: number) {
      const { report, kind } = await locate(reportId, reportVersion);
      reviewed.add(`${reportId}/${reportVersion}`);
      return { kind, report, reviewMode: 'requireFirstFrame' in report && report.requireFirstFrame ? 'frames-unavailable' : 'text' };
    },
    async acknowledge(reportId: string, reportVersion: number, mode: 'text' | 'frames-unavailable') {
      if (!reviewed.has(`${reportId}/${reportVersion}`)) throw new CoreError(409, 'REPORT_REVIEW_REQUIRED');
      const { order, kind } = await locate(reportId, reportVersion);
      return call(`${kind}.acknowledge`, reportId, order.version, { reportVersion, ...(kind !== 'lab' && { mode }) });
    },
    async signed(): Promise<Coding[]> {
      const actual: Coding[] = [];
      for (const kind of new Set(services.map(item => item.kind))) {
        for (const order of (await read(kind)).orders) if (order.reports.length) actual.push(...services.filter(item => item.id === order.serviceId));
      }
      return actual;
    },
  };
}
