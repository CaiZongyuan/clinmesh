import { z } from 'zod'

/** 一次门诊检查开立时冻结的本院价目；来源及用途与住院计费独立。 */
export const outpatientInvestigationPriceSchema = z.object({
  currency: z.literal('CNY'),
  effectiveOn: z.iso.date(),
  id: z.string().min(1).max(512),
  priceFen: z.number().int().positive(),
  source: z.string().min(1).max(256),
  unit: z.string().min(1).max(64),
  version: z.number().int().positive(),
}).strict()
export type OutpatientInvestigationPrice = z.infer<typeof outpatientInvestigationPriceSchema>

/** 财务状态不替代 Clinical Request 的受理、执行和报告状态。 */
export const outpatientInvestigationBillingSchema = z.object({
  chargeItemId: z.string().min(1),
  insuranceFen: z.number().int().nonnegative(),
  paidFen: z.number().int().nonnegative(),
  price: outpatientInvestigationPriceSchema,
  quantity: z.literal(1),
  releasedAt: z.iso.datetime({ offset: true }).optional(),
  remainingFen: z.number().int().nonnegative(),
  status: z.enum(['pending', 'partial', 'ambiguous', 'paid', 'cancelled']),
}).strict()
export type OutpatientInvestigationBilling = z.infer<typeof outpatientInvestigationBillingSchema>
