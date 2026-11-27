import { z } from 'zod';
import { localizedName } from '../../platform';
import { orderHeader, quote, reportHeader } from '../../diagnostic-workflow';
export type { DiagnosticBillingPort as LabBillingPort, Quote } from '../../diagnostic-workflow';
export { quote };

export const maxBatch = 20;
export const serviceView = quote.omit({ serviceId: true }).extend({ id: z.uuidv7(), codeSystem: z.url(), code: z.string(), display: localizedName, kind: z.enum(['lab', 'examination']) });
export const interpretation = z.enum(['normal', 'high', 'low', 'abnormal']);
export const findings = z.object({ summary: localizedName, stSegmentDeviation: z.boolean().optional(), amendmentReason: localizedName.optional(), observations: z.array(z.object({ codeSystem: z.url(), code: z.string(), display: localizedName, unit: z.string(), value: z.union([z.number(), z.string()]), interpretation, critical: z.boolean() })) });
export const reportView = reportHeader.extend(findings.shape);
export const labViewSchema = z.object({
  services: z.array(serviceView), draft: z.object({ version: z.int().nonnegative(), items: z.array(quote) }),
  orders: z.array(orderHeader.extend({ reports: z.array(reportView) })),
});
export type LabView = z.infer<typeof labViewSchema>;
export type LabOrder = LabView['orders'][number];
export const issueReceipt = z.object({ version: z.int().nonnegative(), results: z.array(z.union([
  z.object({ serviceId: z.uuidv7(), orderId: z.uuidv7() }), z.object({ serviceId: z.uuidv7(), error: z.enum(['CATALOG_CONFLICT', 'ACTIVE_ORDER_EXISTS']) }),
])) });
