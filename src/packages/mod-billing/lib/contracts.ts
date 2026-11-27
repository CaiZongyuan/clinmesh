import { z } from 'zod';
import { distinctInput } from '../../operation-catalog';
import type { StoreReader, StoreScope, StoreTx } from '../../store';
import { currencySchema } from './money';

export const amount = z.int().nonnegative();
export const positive = z.int().positive();
export const id = z.uuidv7();
export const reason = z.string().trim().min(1).max(500);
export const tender = z.strictObject({ method: z.string().min(1), amountMinor: positive });
export const tenders = distinctInput(z.array(tender.extend({ method: z.enum(['cash', 'card', 'mobile']) })).min(1).max(3), 'method');
export const simulation = z.enum(['approved', 'declined', 'delayed-approval', 'delayed-decline']).default('approved');
export const chargeIds = distinctInput(z.array(id).min(1).max(20));
export const allocation = z.object({ chargeId: id, amountMinor: positive });
export const attemptKind = z.enum(['collection', 'refund', 'deposit', 'deposit-refund']);
export const fundsStatus = z.enum(['succeeded', 'declined', 'unknown']);
export const attemptSchema = z.object({ id, kind: attemptKind, originId: id.nullable(), status: fundsStatus, version: positive, amountMinor: positive, recordedAt: z.iso.datetime(), tenders: z.array(tender), allocations: z.array(allocation), tenderAllocations: z.array(allocation.extend({ method: z.string().min(1) })).default([]), correctionId: id.nullable().default(null) });
export const adjustmentSchema = z.object({ id, amountMinor: z.int(), reason, virtualAt: z.iso.datetime() });
export const chargeSchema = z.object({ id, orderId: id.nullable(), materialUseId: id.nullable().default(null), catalogItemId: id.nullable(), catalogVersion: z.string().nullable(), description: z.string(), department: z.string().nullable(), businessDay: z.iso.date(), quantity: positive, unitPriceMinor: amount,
  amountMinor: amount, adjustedMinor: z.int(), netMinor: amount, coverageMinor: amount, payerRevision: amount, payerPending: z.boolean(), netPaidMinor: amount, refundedMinor: amount, outstandingMinor: amount, pending: z.boolean(), cancelled: z.boolean(), releaseRecorded: z.boolean().default(false), released: z.boolean(), version: positive, adjustments: z.array(adjustmentSchema) });
const postingSource = z.object({ kind: z.enum(['order', 'procedure', 'material-use']), id, orderId: id.nullable() });
export type PostingSource = z.infer<typeof postingSource>;
export const snapshotSchema = z.object({ fingerprint: z.string(), version: amount, charges: z.array(chargeSchema), payments: z.array(attemptSchema), incurredSources: z.array(postingSource).default([]), netMinor: amount, coverageMinor: amount, cashMinor: amount });
export const accountSchema = z.object({ encounterId: id, encounterClass: z.enum(['outpatient', 'inpatient']), admissionStatus: z.string().nullable(), policy: z.enum(['free', 'prepaid', 'postpaid']), currency: currencySchema, version: amount, charges: z.array(chargeSchema), payments: z.array(attemptSchema), netMinor: amount, coverageMinor: amount, cashMinor: amount, balanceMinor: z.int(), pending: z.boolean(), payerPending: z.boolean(), incurredSources: z.array(postingSource).default([]), unpostedSources: z.array(postingSource).default([]), settlement: snapshotSchema.nullable(), corrections: z.array(z.object({ id, chargeId: id, reason, amountMinor: z.int(), remainingMinor: z.int() })).default([]) });
export const cashierQueueSchema = z.array(z.object({ encounterId: id, name: z.string(), encounterClass: z.enum(['outpatient', 'inpatient']) }));
export type BillingAccount = z.infer<typeof accountSchema>;
export type BillingCharge = z.infer<typeof chargeSchema>;
export type Attempt = z.infer<typeof attemptSchema>;
export type Tender = z.infer<typeof tender>;
export type Simulation = z.infer<typeof simulation>;
export type FrozenCharge = { encounterId: string; orderId: string; catalogItemId: string; catalogVersion: string; quantity: number; unitPriceMinor: number; currencyCode: string; currencyExponent: number; virtualAt: string; recordedAt: string; department?: string };
export type OrderFunds = { chargeId: string | null; state: 'free' | 'unpaid' | 'partial' | 'settled' | 'unknown'; releaseRecorded: boolean; released: boolean; locked: boolean; netPaidMinor: number };
export interface ClinicalBillingPort {
  freezeCharge(tx: StoreTx, at: StoreScope, row: FrozenCharge): string | null;
  readOrderFunds(reader: StoreReader, at: StoreScope, orderId: string): OrderFunds;
}
export interface PayerBenefitHook {
  coverage(reader: StoreReader, at: StoreScope, encounterId: string): ReadonlyMap<string, { amountMinor: number; revision: number; basisMinor?: number; requiresReview?: boolean }>;
  correctionCoverage?(reader: StoreReader, at: StoreScope, encounterId: string): ReadonlyMap<string, number>;
}
export interface BillingOptions {
  payerBenefit?: PayerBenefitHook;
  onRelease?(tx: StoreTx, at: StoreScope, fact: { encounterId: string; orderId: string; chargeId: string }): void;
}
