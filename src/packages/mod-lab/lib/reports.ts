import { z } from 'zod';
import { caseTruthSchema } from '../../data-pack';
import { createReportLifecycle, serviceFor } from '../../diagnostic-workflow';
import { resolveFindings } from './results';

const labResult = caseTruthSchema.shape.results.element.omit({ images: true, sections: true, priorSurgeryId: true }).strip();
const truthSchema = caseTruthSchema.pick({ normalBaselines: true }).extend({ results: z.array(labResult) }).strip();
export const { orders: labOrders, moveOrder, publishDue, reportsReviewed, reviewReport } = createReportLifecycle({
  name: 'lab', notFound: 'LAB_ORDER_NOT_FOUND',
  owns: (reader, at, order) => (order.kind === 'lab' || order.kind === 'examination') && reader.list(at, 'lab_requests', { order_id: order.id }).length > 0,
  resolve(reader, at, order, revision) {
    const source = reader.readPrivateCaseTruth(at, { purpose: 'simulation', encounterId: order.encounter_id });
    const parsed = truthSchema.safeParse(source?.truth);
    const request = reader.list(at, 'lab_requests', { order_id: order.id })[0]!;
    return parsed.success ? resolveFindings(parsed.data, serviceFor(reader, at, order), request.stages, revision) : undefined;
  },
});
