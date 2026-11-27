import { z } from 'zod';
import { CoreError, localizedName } from '../../platform';
import type { StoreReader, StoreScope } from '../../store';

export const amount = z.int().nonnegative();
const text = z.string().min(1);
const bps = amount.max(10_000);
const policy = z.strictObject({ deductibleMinor: amount, ratioBps: bps, capMinor: amount });
const plan = z.strictObject({ id: text, name: localizedName, openingAccountMinor: amount, outpatient: policy, inpatient: policy });
const rulesSchema = z.strictObject({ version: text, sourceVersion: text, synthetic: z.literal(true), baseRateMinor: z.int().positive(), diagnosisSystem: z.url(), procedureSystem: z.url(),
  groups: z.array(z.strictObject({ group: text, principalDiagnosis: text, principalProcedure: text, weightBp: z.int().positive() })).min(1),
  insuranceTiers: z.array(text), tiers: z.record(text, z.strictObject({ included: z.boolean(), priorSelfPayBps: bps }).refine(tier => tier.included || !tier.priorSelfPayBps)),
  catalogCoverage: z.record(z.url(), z.record(text, text)), plans: z.array(plan).min(1),
}).refine(rules => new Set(rules.plans.map(plan => plan.id)).size === rules.plans.length && new Set(rules.groups.map(group => JSON.stringify([group.principalDiagnosis, group.principalProcedure]))).size === rules.groups.length && rules.insuranceTiers.every(tier => Object.hasOwn(rules.tiers, tier)) && Object.values(rules.catalogCoverage).every(system => Object.values(system).every(tier => Object.hasOwn(rules.tiers, tier))));
export type RegionalRules = z.infer<typeof rulesSchema>;
export function parseRegionalRules(input: unknown) { return rulesSchema.parse(input); }
export function regionalRules(reader: StoreReader, at: StoreScope) {
  const pack = reader.list(at, 'data_pack_installations')[0]!;
  const raw = z.object({ regionalRules: z.record(z.string(), z.json()).optional() }).parse(pack.knowledge).regionalRules?.['mod-drg-cn'];
  const rules = rulesSchema.safeParse(raw);
  if (!rules.success) throw new CoreError(409, 'REGIONAL_RULES_UNAVAILABLE');
  return rules.data;
}
export function ratio(amountMinor: number, numerator: number) {
  return amount.parse(Number(BigInt(amountMinor) * BigInt(numerator) / 10_000n));
}
export function sum(values: readonly number[]) { return z.int().parse(Number(values.reduce((total, value) => total + BigInt(value), 0n))); }
