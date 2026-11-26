import { v7 } from 'uuid';
import { z } from 'zod';
import type { createBillingModule, PayerBenefitHook } from '../../mod-billing';
import { requireEncounter } from '../../patient-visit';
import { checkVersion, CoreError, sha256, type CommandContext } from '../../platform';
import { canonicalJson, type StoreReader, type StoreScope } from '../../store';
import { allocateBenefits, allocationsSchema } from './benefits';
import { amount, regionalRules, sum } from './rules';

export type Billing = Pick<ReturnType<typeof createBillingModule>, 'readAccount' | 'reconcile'>;
const payer = 'mod-drg-cn';
const terms = z.object({ patientId: z.uuidv7(), year: z.int(), encounterClass: z.enum(['outpatient', 'inpatient']), planId: z.string(), annualVersion: amount, allocations: allocationsSchema });
export const claimSchema = terms.extend({ fingerprint: z.string().regex(/^[0-9a-f]{64}$/) });
const event = terms.extend({ action: z.enum(['confirm', 'cancel']), originalId: z.uuidv7().nullable(), replacementRequired: z.boolean().default(false), correctionId: z.uuidv7().nullable().default(null) });
export function claimEvents(reader: StoreReader, at: StoreScope, encounterId?: string) {
  return reader.list(at, 'regional_payer_records', { payer_code: payer, ...(encounterId ? { encounter_id: encounterId } : {}) }).map(row => ({ id: row.id, encounterId: row.encounter_id, ...event.parse(row.determination) }));
}
export const regionalPayer: PayerBenefitHook = {
  coverage(reader, at, encounterId) {
    const coverage = new Map<string, { amountMinor: number; revision: number; basisMinor?: number; requiresReview?: boolean }>();
    const enabled = z.object({ enabledModules: z.array(z.string()) }).parse(reader.list(at, 'data_pack_installations')[0]?.manifest).enabledModules;
    if (!enabled.includes(payer)) return coverage;
    for (const entry of claimEvents(reader, at, encounterId)) for (const item of entry.allocations.items) {
      const previous = coverage.get(item.chargeId);
      const delta = sum([item.fundMinor, item.accountMinor]) * (entry.action === 'confirm' ? 1 : -1);
      coverage.set(item.chargeId, { amountMinor: sum([previous?.amountMinor ?? 0, delta]), revision: (previous?.revision ?? 0) + 1, basisMinor: entry.action === 'confirm' ? item.netMinor : undefined, requiresReview: entry.action === 'cancel' && entry.replacementRequired });
    }
    return coverage;
  },
  correctionCoverage(reader, at, encounterId) {
    const credited = new Map<string, number>();
    for (const claim of claimEvents(reader, at, encounterId)) if (claim.correctionId) {
      const value = sum([claim.allocations.fundMinor, claim.allocations.accountMinor]) * (claim.action === 'confirm' ? 1 : -1);
      credited.set(claim.correctionId, sum([credited.get(claim.correctionId) ?? 0, value]));
    }
    return credited;
  },
};
export function activeClaims(reader: StoreReader, at: StoreScope, encounterId: string) {
  const entries = claimEvents(reader, at, encounterId);
  const cancelled = new Set(entries.filter(entry => entry.action === 'cancel').map(entry => entry.originalId));
  return entries.filter(entry => entry.action === 'confirm' && !cancelled.has(entry.id));
}
function denied(code: string): never { throw new CoreError(409, code); }
export async function quote(context: CommandContext, billing: Billing, input: { planId: string; chargeIds: string[] }) {
  const { at, tx, targetId } = context;
  const bill = billing.readAccount(tx, at, targetId);
  checkVersion(bill.version, context.expectedVersion);
  const encounter = requireEncounter(tx, at, targetId);
  const events = claimEvents(tx, at, targetId);
  const replacement = events.findLast(entry => entry.action === 'cancel' && entry.replacementRequired && !events.some(later => later.action === 'confirm' && later.originalId === entry.originalId));
  if (bill.pending || bill.policy === 'free' || (bill.settlement && !replacement) || (!bill.settlement && bill.encounterClass === 'inpatient' && bill.admissionStatus !== 'departed')) denied('INSURANCE_FUNDS_CONFLICT');
  if (replacement && (replacement.planId !== input.planId || input.chargeIds.length !== replacement.allocations.items.length || !replacement.allocations.items.every(item => input.chargeIds.includes(item.chargeId)))) denied('ORIGINAL_BENEFIT_REQUIRED');
  const defaults = regionalRules(tx, at);
  const plan = defaults.plans.find(plan => plan.id === input.planId) ?? denied('INSURANCE_PLAN_UNAVAILABLE');
  const zone = z.object({ timezone: z.string() }).parse(tx.list(at, 'data_pack_installations')[0]!.manifest).timezone;
  const year = replacement?.year ?? Number(new Intl.DateTimeFormat('en', { timeZone: zone, year: 'numeric' }).format(new Date(context.virtualAt)));
  const history = claimEvents(tx, at).filter(entry => entry.patientId === encounter.patient_id && entry.year === year);
  if (history.some(entry => entry.planId !== plan.id)) denied('ANNUAL_PLAN_LOCKED');
  const active = new Set(activeClaims(tx, at, targetId).flatMap(entry => entry.allocations.items.map(item => item.chargeId)));
  const lines = input.chargeIds.toSorted().map(chargeId => {
    const line = bill.charges.find(line => line.id === chargeId) ?? denied('CHARGE_NOT_IN_ACCOUNT');
    if (active.has(chargeId) || line.netPaidMinor || line.pending || line.cancelled || (!replacement && !line.netMinor)) denied('INSURANCE_FUNDS_CONFLICT');
    const item = line.catalogItemId ? tx.get(at, 'catalog_items', line.catalogItemId) : undefined;
    if (!item) denied('INSURANCE_COVERAGE_UNAVAILABLE');
    if (bill.encounterClass === 'outpatient' && item.kind === 'medications' && encounter.status !== 'completed') denied('INSURANCE_FUNDS_CONFLICT');
    const tier = z.object({ insuranceTier: z.string().optional() }).parse(item.definition).insuranceTier ?? defaults.catalogCoverage[item.code_system]?.[item.code];
    if (!tier || !defaults.tiers[tier]) denied('INSURANCE_COVERAGE_UNAVAILABLE');
    const prescriptionId = line.orderId ? tx.list(at, 'prescription_orders', { order_id: line.orderId })[0]?.prescription_id : undefined;
    if (prescriptionId) {
      const prescriptionOrders = new Set(tx.list(at, 'prescription_orders', { prescription_id: prescriptionId }).map(member => member.order_id));
      if (bill.charges.some(other => other.orderId && prescriptionOrders.has(other.orderId) && other.netMinor > 0 && !other.cancelled && !input.chargeIds.includes(other.id))) denied('PRESCRIPTION_COVERAGE_INCOMPLETE');
    }
    return { chargeId, tier, netMinor: line.netMinor, prescriptionId };
  });
  const annual = (key: 'fundMinor' | 'accountMinor' | 'eligibleMinor') => sum(history.filter(entry => key === 'accountMinor' || entry.encounterClass === bill.encounterClass).map(entry => entry.allocations[key] * (entry.action === 'confirm' ? 1 : -1)));
  const allocations = allocateBenefits(defaults, plan, bill.encounterClass, { eligibleMinor: annual('eligibleMinor'), fundMinor: annual('fundMinor'), accountUsedMinor: annual('accountMinor') }, lines);
  const result = { patientId: encounter.patient_id, year, planId: plan.id, encounterClass: bill.encounterClass, annualVersion: history.length, allocations };
  return { ...result, replacesId: replacement?.originalId ?? null, correctionId: replacement?.correctionId ?? null, fingerprint: await sha256(canonicalJson({ result, encounterId: targetId, billVersion: bill.version, epoch: at.epoch, actor: context.actor.id })) };
}
export async function confirmBenefit(ctx: CommandContext, billing: Billing, input: { planId: string; chargeIds: string[]; fingerprint: string }) {
  const { fingerprint, replacesId, correctionId, ...terms } = await quote(ctx, billing, input);
  if (fingerprint !== input.fingerprint) denied('BENEFIT_PREVIEW_STALE');
  const claimId = v7();
  ctx.tx.insert(ctx.at, 'regional_payer_records', { id: claimId, encounter_id: ctx.targetId, payer_code: payer, reference: fingerprint, determination: { ...terms, action: 'confirm', originalId: replacesId, correctionId }, virtual_at: ctx.virtualAt, recorded_at: ctx.recordedAt });
  billing.reconcile(ctx.tx, ctx.at, ctx.targetId, ctx.virtualAt, ctx.recordedAt);
  return { claimId };
}
export function cancelBenefit(ctx: CommandContext, billing: Billing, input: { claimId: string; annualVersion: number }) {
  const bill = billing.readAccount(ctx.tx, ctx.at, ctx.targetId);
  checkVersion(bill.version, ctx.expectedVersion);
  if (bill.pending) denied('INSURANCE_FUNDS_CONFLICT');
  const original = activeClaims(ctx.tx, ctx.at, ctx.targetId).find(claim => claim.id === input.claimId) ?? denied('CLAIM_NOT_ACTIVE');
  const affected = new Set(original.allocations.items.filter(item => bill.charges.some(line => line.id === item.chargeId && line.payerPending)).map(item => item.chargeId));
  const correctionId = bill.settlement ? bill.corrections.findLast(correction => affected.has(correction.chargeId))?.id ?? denied('INSURANCE_FUNDS_CONFLICT') : null;
  checkVersion(claimEvents(ctx.tx, ctx.at).filter(entry => entry.patientId === original.patientId && entry.year === original.year).length, input.annualVersion);
  const claimId = v7();
  ctx.tx.insert(ctx.at, 'regional_payer_records', { id: claimId, encounter_id: ctx.targetId, payer_code: payer, reference: original.id, determination: { ...terms.parse(original), annualVersion: input.annualVersion, action: 'cancel', originalId: original.id, replacementRequired: Boolean(bill.settlement), correctionId }, virtual_at: ctx.virtualAt, recorded_at: ctx.recordedAt });
  return { claimId };
}
