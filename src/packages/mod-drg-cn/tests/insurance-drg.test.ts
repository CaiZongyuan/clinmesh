import { expect, it } from 'vitest';
import { v7 } from 'uuid';
import cardiology from '../../../../data/packs/cn-cardiology/pack.json';
import { allocateBenefits, parseRegionalRules } from '../index';

const rules = parseRegionalRules(cardiology.knowledge.regionalRules['mod-drg-cn']);
const employee = rules.plans.find(plan => plan.id === 'employee-v1')!;

it('applies the individual product terms before the annual deductible, fund cap and shared account', () => {
  const items = [{ chargeId: v7(), tier: '甲', netMinor: 1000 }, { chargeId: v7(), tier: '乙', netMinor: 1001 }, { chargeId: v7(), tier: '丙', netMinor: 500 }];
  const result = allocateBenefits(rules, employee, 'outpatient', { eligibleMinor: 500, fundMinor: 99700, accountUsedMinor: 1950 }, items);
  expect(result.items.map(item => [item.outsideMinor, item.priorSelfPayMinor, item.eligibleMinor])).toEqual([[0, 0, 1000], [0, 100, 901], [500, 0, 0]]);
  expect(result).toMatchObject({ eligibleMinor: 1901, deductibleMinor: 500, fundMinor: 300, accountMinor: 50, cashMinor: 2151 });
  const resident = rules.plans.find(plan => plan.id === 'resident-v1')!;
  expect(allocateBenefits(rules, resident, 'outpatient', { eligibleMinor: 0, fundMinor: 0, accountUsedMinor: 0 }, items)).toMatchObject({ fundMinor: 0, accountMinor: 0, cashMinor: 2501 });
});

it('rounds the approved amount per prescription after splitting the product tiers', () => {
  const prescriptionId = v7();
  const calculate = (tiers: string[], grouped: boolean) => allocateBenefits(rules, employee, 'outpatient', { eligibleMinor: 1000, fundMinor: 0, accountUsedMinor: 2000 }, tiers.map(tier => ({ chargeId: v7(), tier, netMinor: 1, ...(grouped && { prescriptionId }) })));
  expect(calculate(['甲', '乙', '丙'], true)).toMatchObject({ eligibleMinor: 2, fundMinor: 1, cashMinor: 2 });
  expect(calculate(['甲', '乙', '甲'], true)).toMatchObject({ eligibleMinor: 3, fundMinor: 2, cashMinor: 1 });
  expect(calculate(['甲', '乙', '甲'], false)).toMatchObject({ fundMinor: 0 });
});
