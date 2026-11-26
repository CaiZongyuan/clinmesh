import { z } from 'zod';
import { CoreError } from '../../platform';
import { amount, ratio, sum, type RegionalRules } from './rules';

const itemSchema = z.object({ chargeId: z.uuidv7(), tier: z.string(), netMinor: amount, outsideMinor: amount, priorSelfPayMinor: amount, eligibleMinor: amount, deductibleMinor: amount, fundMinor: amount, accountMinor: amount, cashMinor: amount });
export const allocationsSchema = z.object({ items: z.array(itemSchema), eligibleMinor: amount, deductibleMinor: amount, fundMinor: amount, accountMinor: amount, cashMinor: amount });
export type AnnualBalance = { eligibleMinor: number; fundMinor: number; accountUsedMinor: number };
type Line = Pick<z.infer<typeof itemSchema>, 'chargeId' | 'tier' | 'netMinor'> & { prescriptionId?: string };
export function allocateBenefits(rules: RegionalRules, plan: RegionalRules['plans'][number], encounterClass: 'outpatient' | 'inpatient', balance: AnnualBalance, lines: readonly Line[]) {
  const policy = plan[encounterClass];
  let deductibleLeft = Math.max(0, policy.deductibleMinor - balance.eligibleMinor);
  let fundLeft = Math.max(0, policy.capMinor - balance.fundMinor);
  let accountLeft = Math.max(0, plan.openingAccountMinor - balance.accountUsedMinor);
  const groups = new Map<string, Line[]>();
  for (const line of lines) {
    const key = line.prescriptionId ?? line.chargeId;
    const group = groups.get(key);
    if (group) group.push(line); else groups.set(key, [line]);
  }
  const items = [...groups.values()].flatMap(group => {
    let previousEligible = 0, previousFund = 0;
    return group.map(line => {
      const tier = rules.tiers[line.tier];
      if (!tier) throw new CoreError(409, 'INSURANCE_COVERAGE_UNAVAILABLE');
      const outsideMinor = tier.included ? 0 : line.netMinor;
      const priorSelfPayMinor = ratio(line.netMinor, tier.priorSelfPayBps);
      const eligibleMinor = line.netMinor - outsideMinor - priorSelfPayMinor;
      const deductibleMinor = Math.min(eligibleMinor, deductibleLeft);
      deductibleLeft -= deductibleMinor;
      previousEligible = sum([previousEligible, eligibleMinor - deductibleMinor]);
      const groupFund = ratio(previousEligible, policy.ratioBps);
      const fundMinor = Math.min(fundLeft, groupFund - previousFund);
      previousFund = groupFund;
      fundLeft -= fundMinor;
      const accountMinor = Math.min(accountLeft, eligibleMinor - fundMinor);
      accountLeft -= accountMinor;
      return { ...line, outsideMinor, priorSelfPayMinor, eligibleMinor, deductibleMinor, fundMinor, accountMinor, cashMinor: line.netMinor - fundMinor - accountMinor };
    });
  });
  const total = (key: 'eligibleMinor' | 'fundMinor' | 'deductibleMinor' | 'accountMinor' | 'cashMinor') => sum(items.map(item => item[key]));
  return allocationsSchema.parse({ items, eligibleMinor: total('eligibleMinor'), deductibleMinor: total('deductibleMinor'), fundMinor: total('fundMinor'), accountMinor: total('accountMinor'), cashMinor: total('cashMinor') });
}
