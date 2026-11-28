import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  SIMULATION_SCORING_DISCLAIMER_ZH,
  UNEVALUATED_AGENT_OUTPUT_LABEL_ZH,
  agentOutputEvaluationBadgeSchema,
  agentOutputEvaluationStateSchema,
  agentOutputScoreResultSchema,
  agentScoringRubricSchema,
  createUnevaluatedAgentOutputState,
  evaluateAgentOutputInputSchema,
  liveModelScoringPermitSchema,
} from '../src/agent-output-scorer.ts'

describe('agent-output-scorer contracts', () => {
  it('provides exact unevaluated default state and Chinese labels', () => {
    expect(UNEVALUATED_AGENT_OUTPUT_LABEL_ZH).toBe('Agent 输出未评测')
    expect(SIMULATION_SCORING_DISCLAIMER_ZH).toBe('仿真评测（受控模型流），不代表真实模型临床效果')

    const state = createUnevaluatedAgentOutputState()
    expect(state).toEqual({
      badge: {
        labelZh: 'Agent 输出未评测',
        status: 'unevaluated',
      },
      scoreResult: null,
    })
    expect(agentOutputEvaluationStateSchema.parse(state)).toEqual(state)
  })

  it('rejects unknown fields and invalid live-model permits', () => {
    expect(() => liveModelScoringPermitSchema.parse({
      authorizedAt: '2026-08-24T10:00:00+08:00',
      authorizedByActorId: 'actor-admin',
      explicitUserPermissionGranted: false,
      runId: 'run-1',
    })).toThrow()

    expect(() => agentScoringRubricSchema.parse({
      extraField: true,
      items: [{
        expectedPatterns: ['LDL'],
        id: 'item-1',
        labelZh: 'LDL 复查',
        omissionPenaltyPoints: 2,
        positivePoints: 5,
      }],
      packId: 'coronary-cad',
      rubricId: 'rubric-1',
      taskId: 'followup-review',
      version: '1.0.0',
    })).toThrow()
  })

  it('supports JSON schema generation for all public scorer contracts', () => {
    expect(() => z.toJSONSchema(agentScoringRubricSchema)).not.toThrow()
    expect(() => z.toJSONSchema(evaluateAgentOutputInputSchema)).not.toThrow()
    expect(() => z.toJSONSchema(agentOutputEvaluationBadgeSchema)).not.toThrow()
    expect(() => z.toJSONSchema(agentOutputScoreResultSchema)).not.toThrow()
    expect(() => z.toJSONSchema(agentOutputEvaluationStateSchema)).not.toThrow()
  })
})
