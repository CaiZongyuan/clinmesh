import { z } from 'zod';
import type { OperationCatalog } from '../../platform';
import { cancelBenefit, claimSchema, confirmBenefit, quote, type Billing } from './claims';
import { projection, projectionSchema } from './projection';

export function createDrgModule(billing: Billing) {
  const path = '/api/his/encounters/:id/payer';
  const access = { capabilities: ['review-payer'], visitorOnly: true };
  const route = (name: string) => ({ name, path: `${path}/${name}`, access, method: 'POST' as const });
  const selection = { planId: z.string().min(1), chargeIds: z.array(z.uuidv7()).min(1).max(200).refine(ids => new Set(ids).size === ids.length) };
  return { id: 'mod-drg-cn', kind: 'extension' as const, version: '1', registerOperations(catalog: OperationCatalog) {
    catalog.query({ name: 'drg.summary', path, access }, projectionSchema, ({ reader, actor, targetId }) => projection(reader, actor.at, targetId, billing));
    catalog.command({ ...route('benefit.preview'), mode: 'preview' }, selection, claimSchema, (ctx, input) => quote(ctx, billing, input));
    catalog.command(route('benefit.confirm'), { ...selection, fingerprint: claimSchema.shape.fingerprint }, z.object({ claimId: z.uuidv7() }), (ctx, input) => confirmBenefit(ctx, billing, input));
    catalog.command(route('benefit.cancel'), { claimId: z.uuidv7(), annualVersion: z.int().nonnegative() }, z.object({ claimId: z.uuidv7() }), (ctx, input) => cancelBenefit(ctx, billing, input));
  } };
}
