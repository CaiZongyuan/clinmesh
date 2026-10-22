import { z } from 'zod'
import type { paymentSimulatorRuleSchema } from '@clinmesh/contracts/his'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { RepositoryContext } from '../infrastructure/sqlite/fhir-repository.ts'
import { WorkflowError } from './workflow-error.ts'

/** Freeze the synthetic channel query result when an attempt is created. */
export function paymentChannelPlan(database: ClinMeshDatabase, context: RepositoryContext, rule: z.infer<typeof paymentSimulatorRuleSchema>) {
  const row = z.object({ outcome: z.enum(['success', 'declined', 'ambiguous']) }).optional().parse(database.driver.prepare(`
    SELECT outcome FROM scenario_simulator_rule WHERE workspace_id=? AND epoch=? AND simulator='payment' AND rule_code=?
  `).get(context.workspaceId, context.epoch, rule.startsWith('ambiguous') ? 'ambiguous' : rule))
  if (!row) throw new WorkflowError('CATALOG_CONFLICT', 'The payment simulator rule is unavailable')
  return { outcome: row.outcome, recoveryOutcome: rule === 'ambiguous' ? 'success' as const : rule === 'ambiguous-decline' ? 'declined' as const : 'ambiguous' as const }
}
