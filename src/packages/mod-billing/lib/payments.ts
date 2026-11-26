import { v7 } from 'uuid';
import { z } from 'zod';
import { checkVersion, sha256, type CommandContext } from '../../platform';
import { canonicalJson } from '../../store';
import { account, conflict, reconcile } from './account';
import { allocation, amount, attemptKind, attemptSchema, chargeSchema, id, positive, simulation, tender, type BillingAccount, type BillingOptions, type Simulation, type Tender } from './contracts';
import { sumMinor } from './money';

const refundCeiling = 1_000_000_000;
const planSchema = z.strictObject({ kind: z.union([attemptKind, z.literal('settlement')]), amountMinor: amount, tenders: z.array(tender), allocations: z.array(allocation), originId: id.nullable(), reason: z.string(), simulation, correctionId: id.optional(), accountVersion: amount.optional() });
type Plan = z.infer<typeof planSchema>;
export const previewSchema = z.object({ ...planSchema.omit({ simulation: true, accountVersion: true }).shape, commitToken: id, expiresAt: z.iso.datetime(), version: amount, fingerprint: z.string(), review: z.object({ charges: z.array(chargeSchema), payments: z.array(attemptSchema), netMinor: amount, coverageMinor: amount, cashMinor: amount, balanceMinor: z.int() }).optional() });
export const paymentResult = z.object({ paymentId: id, status: z.enum(['succeeded', 'declined', 'unknown']) });
export function currentBill(context: CommandContext, options: BillingOptions, check = true) {
  const bill = account(context.tx, context.at, context.targetId, options);
  if (check) checkVersion(bill.version, context.expectedVersion);
  if (bill.policy === 'free') conflict('BILLING_FREE');
  return bill;
}

export function charge(bill: BillingAccount, chargeId: string) {
  return bill.charges.find(line => line.id === chargeId) ?? conflict('CHARGE_NOT_IN_ACCOUNT');
}
function collectionTenders(total: number, channels?: Tender[]) {
  const result = channels ?? [{ method: 'cash' as const, amountMinor: total }];
  if (sumMinor(result.map(channel => channel.amountMinor)) !== total) conflict('TENDER_TOTAL_MISMATCH');
  return result;
}
export function collect(bill: BillingAccount, input: { chargeIds: string[]; amountMinor?: number; tenders?: Tender[]; simulation: Simulation }): Plan {
  if (bill.encounterClass !== 'outpatient') conflict('OUTPATIENT_REQUIRED');
  const allocations = input.chargeIds.map(chargeId => {
    const line = charge(bill, chargeId);
    if (line.pending) conflict('FUNDS_PENDING');
    if (line.payerPending) conflict('PAYER_REVIEW_REQUIRED');
    if (line.cancelled || !line.outstandingMinor) conflict('CHARGE_UNAVAILABLE');
    const amountMinor = input.chargeIds.length > 1 ? line.outstandingMinor : input.amountMinor ?? (input.tenders ? sumMinor(input.tenders.map(channel => channel.amountMinor)) : line.outstandingMinor);
    if (amountMinor > line.outstandingMinor) conflict('COLLECTION_LIMIT');
    return { chargeId, amountMinor };
  });
  const total = sumMinor(allocations.map(item => item.amountMinor));
  if (input.amountMinor !== undefined && total !== input.amountMinor) conflict('TENDER_TOTAL_MISMATCH');
  return { kind: 'collection', allocations, amountMinor: total, tenders: collectionTenders(total, input.tenders), originId: null, reason: '', simulation: input.simulation };
}

function requirePool(bill: BillingAccount) {
  if (bill.encounterClass !== 'inpatient') conflict('ADMISSION_REQUIRED');
  if (bill.pending) conflict('FUNDS_PENDING');
  if (bill.payerPending) conflict('PAYER_REVIEW_REQUIRED');
}
function correctionLimit(bill: BillingAccount, correctionId: string | undefined, direction: number) {
  if (!bill.settlement) {
    if (correctionId) conflict('SETTLEMENT_REQUIRED');
    return Number.MAX_SAFE_INTEGER;
  }
  const correction = bill.corrections.find(item => item.id === correctionId);
  if (!correction) conflict('CORRECTION_REQUIRED');
  return Math.max(0, correction.remainingMinor * direction);
}
export function deposit(bill: BillingAccount, input: { amountMinor: number; tenders?: Tender[]; simulation: Simulation; correctionId?: string }): Plan {
  requirePool(bill);
  if (input.amountMinor > correctionLimit(bill, input.correctionId, 1)) conflict('CORRECTION_LIMIT');
  if ((bill.settlement || bill.admissionStatus === 'departed') && input.amountMinor > bill.balanceMinor) conflict('COLLECTION_LIMIT');
  return { kind: 'deposit', amountMinor: input.amountMinor, allocations: [], tenders: collectionTenders(input.amountMinor, input.tenders), originId: null, reason: '', simulation: input.simulation, ...(input.correctionId && { correctionId: input.correctionId }) };
}
export function refund(bill: BillingAccount, input: { paymentId: string; chargeId?: string; amountMinor: number; reason: string; simulation: Simulation; correctionId?: string }): Plan {
  const pool = input.chargeId === undefined;
  if (pool) requirePool(bill);
  else if (bill.encounterClass !== 'outpatient') conflict('OUTPATIENT_REQUIRED');
  const original = bill.payments.find(payment => payment.id === input.paymentId);
  if (!original || original.kind !== (pool ? 'deposit' : 'collection')) conflict('ORIGINAL_PAYMENT_REQUIRED');
  const prior = bill.payments.filter(payment => payment.originId === original.id && payment.status !== 'declined');
  const line = input.chargeId ? charge(bill, input.chargeId) : undefined;
  if (line?.pending || original.status === 'unknown' || prior.some(payment => payment.status === 'unknown')) conflict('FUNDS_PENDING');
  if (line?.payerPending) conflict('PAYER_REVIEW_REQUIRED');
  if (original.status !== 'succeeded') conflict('ORIGINAL_PAYMENT_REQUIRED');
  const allocationCap = line ? (original.allocations.find(item => item.chargeId === line.id)?.amountMinor ?? 0) - sumMinor(prior.flatMap(payment => payment.allocations.filter(item => item.chargeId === line.id).map(item => item.amountMinor))) : Number.MAX_SAFE_INTEGER;
  const basis = line ? -line.adjustedMinor - line.refundedMinor : -bill.balanceMinor;
  if (pool && input.amountMinor > correctionLimit(bill, input.correctionId, -1)) conflict('CORRECTION_LIMIT');
  const originalCap = original.amountMinor - sumMinor(prior.map(payment => payment.amountMinor));
  if (input.amountMinor > Math.min(refundCeiling, basis, originalCap, allocationCap)) conflict('REFUND_LIMIT');
  let remaining = input.amountMinor;
  const channels: Tender[] = [];
  for (const channel of original.tenders.toReversed()) {
    const used = sumMinor(prior.flatMap(payment => payment.tenders.filter(item => item.method === channel.method).map(item => item.amountMinor)));
    const assigned = (payment: typeof original) => sumMinor(payment.tenderAllocations.filter(item => item.method === channel.method && item.chargeId === line?.id).map(item => item.amountMinor));
    const lineRemaining = line ? assigned(original) - sumMinor(prior.map(assigned)) : remaining;
    const returned = Math.min(remaining, channel.amountMinor - used, lineRemaining);
    if (returned > 0) channels.push({ method: channel.method, amountMinor: returned });
    remaining -= Math.max(0, returned);
  }
  if (remaining) conflict('REFUND_LIMIT');
  return { kind: pool ? 'deposit-refund' : 'refund', amountMinor: input.amountMinor, tenders: channels, allocations: line ? [{ chargeId: line.id, amountMinor: input.amountMinor }] : [], originId: original.id, reason: input.reason, simulation: input.simulation, ...(input.correctionId && { correctionId: input.correctionId }) };
}

export function settlementPlan(bill: BillingAccount): Plan {
  requirePool(bill);
  if (bill.settlement) conflict('BILLING_LOCKED');
  if (bill.admissionStatus !== 'departed') conflict('DEPARTURE_REQUIRED');
  if (bill.unpostedSources.length) conflict('INPATIENT_CHARGES_UNPOSTED');
  if (bill.balanceMinor) conflict('SETTLEMENT_UNBALANCED');
  return { kind: 'settlement', amountMinor: bill.netMinor, allocations: [], tenders: [], originId: null, reason: '', simulation: 'approved' };
}

function reviewed(bill: BillingAccount, plan: Plan) {
  if (bill.encounterClass === 'inpatient') return { charges: bill.charges, payments: bill.payments, netMinor: bill.netMinor, coverageMinor: bill.coverageMinor, cashMinor: bill.cashMinor, balanceMinor: bill.balanceMinor };
  const ids = new Set(plan.allocations.map(item => item.chargeId));
  const charges = bill.charges.filter(line => ids.has(line.id));
  const payments = bill.payments.filter(payment => (plan.originId && (payment.id === plan.originId || payment.originId === plan.originId)) || payment.allocations.some(item => ids.has(item.chargeId)));
  const netMinor = sumMinor(charges.map(line => line.netMinor)), coverageMinor = sumMinor(charges.map(line => line.coverageMinor)), cashMinor = sumMinor(charges.map(line => line.netPaidMinor));
  return { charges, payments, netMinor, coverageMinor, cashMinor, balanceMinor: sumMinor([netMinor, -coverageMinor, -cashMinor]) };
}
const fingerprintOf = (bill: BillingAccount, plan: Plan) => sha256(canonicalJson(bill.encounterClass === 'inpatient' ? bill : { currency: bill.currency, policy: bill.policy, ...reviewed(bill, plan) }));
export async function preview(context: CommandContext, bill: BillingAccount, plan: Plan) {
  const commitToken = v7();
  const expiresAt = new Date(Date.parse(context.recordedAt) + 300_000).toISOString();
  const fingerprint = await fingerprintOf(bill, plan);
  context.tx.insert(context.at, 'billing_previews', { id: commitToken, encounter_id: bill.encounterId, actor_id: context.actor.id, practitioner_role: context.actor.role.id, plan: { ...plan, accountVersion: bill.version }, fingerprint, expires_at: expiresAt, virtual_at: context.virtualAt, recorded_at: context.recordedAt });
  return previewSchema.parse({ ...plan, commitToken, expiresAt, version: bill.version, fingerprint, review: reviewed(bill, plan) });
}

async function frozen(context: CommandContext, bill: BillingAccount, commitToken: string, kind: Plan['kind']) {
  const row = context.tx.get(context.at, 'billing_previews', commitToken);
  if (!row || row.actor_id !== context.actor.id || row.practitioner_role !== context.actor.role.id || row.encounter_id !== bill.encounterId || row.expires_at <= context.recordedAt) conflict('PREVIEW_EXPIRED');
  const plan = planSchema.parse(row.plan);
  if (plan.kind !== kind || row.fingerprint !== await fingerprintOf(bill, plan) || (context.expectedVersion !== plan.accountVersion && context.expectedVersion !== bill.version)) conflict('PREVIEW_STALE');
  return { plan, fingerprint: row.fingerprint };
}

export async function confirm(context: CommandContext, bill: BillingAccount, options: BillingOptions, token: string, kind: z.infer<typeof attemptKind>) {
  const { tx, at, recordedAt, virtualAt } = context;
  const { plan } = await frozen(context, bill, token, kind);
  const paymentId = v7();
  const money = { currency_code: bill.currency.code, currency_exponent: bill.currency.minorUnitExponent };
  const times = { virtual_at: virtualAt, recorded_at: recordedAt };
  const terminal = plan.simulation === 'approved' || plan.simulation === 'delayed-approval' ? 'succeeded' : 'declined';
  const status = plan.simulation.startsWith('delayed-') ? 'unknown' : terminal;
  tx.insert(at, 'payment_transactions', { id: paymentId, encounter_id: bill.encounterId, amount_minor: plan.amountMinor, ...money, ...times });
  tx.insert(at, 'billing_attempts', { id: v7(), payment_id: paymentId, preview_id: token, origin_id: plan.originId, kind, initial_status: status, terminal_status: terminal });
  const unassigned = plan.allocations.map(item => ({ ...item }));
  for (const channel of plan.tenders) {
    const tenderId = v7();
    tx.insert(at, 'payment_tenders', { id: tenderId, payment_id: paymentId, method: channel.method, amount_minor: channel.amountMinor, ...money });
    let available = channel.amountMinor;
    while (available && unassigned.length) {
      const item = unassigned[0]!;
      const assigned = Math.min(item.amountMinor, available);
      tx.insert(at, 'payment_allocations', { id: v7(), tender_id: tenderId, charge_id: item.chargeId, amount_minor: assigned, ...money });
      item.amountMinor -= assigned;
      available -= assigned;
      if (!item.amountMinor) unassigned.shift();
    }
  }
  if (status === 'succeeded') reconcile(tx, at, bill.encounterId, virtualAt, recordedAt, options);
  return { paymentId, status };
}

export function recover(context: CommandContext, bill: BillingAccount, paymentId: string, version: number, options: BillingOptions) {
  const payment = bill.payments.find(payment => payment.id === paymentId);
  if (!payment || payment.status !== 'unknown') conflict('PAYMENT_ALREADY_RESOLVED');
  checkVersion(payment.version, version);
  const attempt = context.tx.list(context.at, 'billing_attempts', { payment_id: paymentId })[0]!;
  const status = attempt.terminal_status;
  context.tx.insert(context.at, 'billing_recoveries', { id: v7(), payment_id: paymentId, status, virtual_at: context.virtualAt, recorded_at: context.recordedAt });
  reconcile(context.tx, context.at, bill.encounterId, context.virtualAt, context.recordedAt, options);
  return { paymentId, status };
}

export async function settle(context: CommandContext, bill: BillingAccount, commitToken: string) {
  settlementPlan(bill);
  const { fingerprint } = await frozen(context, bill, commitToken, 'settlement');
  const snapshot = { fingerprint, version: bill.version, charges: bill.charges, payments: bill.payments, incurredSources: bill.incurredSources, netMinor: bill.netMinor, coverageMinor: bill.coverageMinor, cashMinor: bill.cashMinor };
  context.tx.insert(context.at, 'billing_settlements', { id: v7(), encounter_id: bill.encounterId, preview_id: commitToken, snapshot, virtual_at: context.virtualAt, recorded_at: context.recordedAt });
  return snapshot;
}

export function adjust(context: CommandContext, bill: BillingAccount, input: { chargeId: string; amountMinor: number; reason: string }, correction: boolean, options: BillingOptions) {
  const line = charge(bill, input.chargeId);
  if (line.pending || (bill.encounterClass === 'inpatient' && bill.pending)) conflict('FUNDS_PENDING');
  if (bill.payerPending) conflict('PAYER_REVIEW_REQUIRED');
  if (Boolean(bill.settlement) !== correction) conflict(correction ? 'SETTLEMENT_REQUIRED' : 'BILLING_LOCKED');
  const delta = correction ? input.amountMinor : -positive.parse(input.amountMinor);
  if (!delta || sumMinor([line.netMinor, delta]) < 0) conflict('ADJUSTMENT_LIMIT');
  const adjustmentId = v7();
  context.tx.insert(context.at, 'charge_adjustments', { id: adjustmentId, charge_id: line.id, amount_minor: delta, currency_code: bill.currency.code, currency_exponent: bill.currency.minorUnitExponent, reason: input.reason, virtual_at: context.virtualAt, recorded_at: context.recordedAt });
  reconcile(context.tx, context.at, bill.encounterId, context.virtualAt, context.recordedAt, options);
  return { adjustmentId };
}
