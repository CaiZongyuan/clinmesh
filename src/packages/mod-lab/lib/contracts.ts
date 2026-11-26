import { z } from 'zod';
import { localizedName } from '../../platform';
import type { StoreReader, StoreScope, StoreTx } from '../../store';

export const quote = z.strictObject({ serviceId: z.uuidv7(), catalogVersion: z.string().min(1), unitPriceMinor: z.int().nonnegative(), currencyCode: z.string().regex(/^[A-Z]{3}$/), currencyExponent: z.int().min(0).max(9) });
export type Quote = z.infer<typeof quote>;
export const maxBatch = 20;
export const serviceView = quote.omit({ serviceId: true }).extend({ id: z.uuidv7(), codeSystem: z.url(), code: z.string(), display: localizedName, kind: z.enum(['lab', 'examination']) });
export const status = z.enum(['issued', 'accepted', 'in-progress', 'reported', 'acknowledged', 'cancelled', 'generation-failed']);
export const interpretation = z.enum(['normal', 'high', 'low', 'abnormal']);
export const findings = z.object({ summary: localizedName, amendmentReason: localizedName.optional(), observations: z.array(z.object({ codeSystem: z.url(), code: z.string(), display: localizedName, unit: z.string(), value: z.union([z.number(), z.string()]), interpretation, critical: z.boolean() })) });
export const reportView = findings.extend({ id: z.uuidv7(), version: z.int().positive(), previousId: z.uuidv7().nullable(), signedAt: z.iso.datetime(), acknowledged: z.object({ id: z.uuidv7(), role: z.string(), at: z.iso.datetime() }).nullable() });
export const labViewSchema = z.object({
  services: z.array(serviceView), draft: z.object({ version: z.int().nonnegative(), items: z.array(quote) }),
  orders: z.array(z.object({ id: z.uuidv7(), serviceId: z.uuidv7(), version: z.int().positive(), status, issuedAt: z.iso.datetime(), dueAt: z.iso.datetime().nullable(), reports: z.array(reportView) })),
});
export type LabView = z.infer<typeof labViewSchema>;
export type LabOrder = LabView['orders'][number];
export const issueReceipt = z.object({ version: z.int().nonnegative(), results: z.array(z.union([
  z.object({ serviceId: z.uuidv7(), orderId: z.uuidv7() }), z.object({ serviceId: z.uuidv7(), error: z.enum(['CATALOG_CONFLICT', 'ACTIVE_ORDER_EXISTS']) }),
])) });

type ChargeSource = Omit<Quote, 'serviceId'> & { catalogItemId: string; encounterId: string; orderId: string; quantity: number; virtualAt: string; recordedAt: string };
export interface LabBillingPort {
  freezeCharge(tx: StoreTx, at: StoreScope, row: ChargeSource): string | null;
  readOrderFunds(reader: StoreReader, at: StoreScope, orderId: string): { released: boolean; locked: boolean };
}
