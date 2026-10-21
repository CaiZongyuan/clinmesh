import type { SessionContext } from '@clinmesh/contracts/his'
import type { ModelUsageAttempt, ModelUsageControl, ModelUsageOverview } from '@clinmesh/contracts/model-usage'

export const usageSession: SessionContext = {
  actor: { actorId: 'actor-doctor', workspaceId: 'workspace-synthetic', epoch: 'epoch-current',
    scenarioRunId: 'run-current', practitionerId: 'doctor', practitionerRoleId: 'doctor-role',
    roleCode: 'outpatient-doctor', organizationId: 'hospital', locationId: 'clinic' },
  availableRoles: [{ code: 'outpatient-doctor', id: 'doctor-role', practitionerId: 'doctor',
    practitionerName: '合成医生', organizationId: 'hospital', locationId: 'clinic' }],
  user: { id: 'user-doctor', name: '合成医生', email: 'doctor@example.test' },
}

export const usageAttempt: ModelUsageAttempt = {
  id: '2c6cd150-5647-4a6f-91b1-089d6aa4c508',
  context: { workspaceId: 'workspace-synthetic', epoch: 'epoch-current', taskId: 'task-synthetic',
    caseId: 'case-synthetic', encounterId: 'encounter-synthetic', stage: 'verification-2', trigger: 'automatic',
    sources: [{ kind: 'turn', id: 'turn-a', relationship: 'trigger' },
      { kind: 'recording-source', id: 'source-b', relationship: 'trigger' },
      { kind: 'document', id: 'document-c', relationship: 'evidence' }] },
  feature: 'doctor_recommendation_verification', provider: 'synthetic-provider',
  requestedModel: 'configured-model', actualModel: 'historical-actual-model', reasoningEffort: 'high', outputLimit: 1024,
  kind: 'format-repair', status: 'unknown', dispatch: 'dispatched', startedAt: '2026-10-20T01:00:00.000Z', endedAt: '2026-10-20T01:01:00.000Z',
  providerRequestId: 'provider-request-synthetic', httpStatus: 200,
  usage: { inputTokens: 120, outputTokens: null, cachedInputTokens: 30, reasoningOutputTokens: null,
    totalTokens: null, mapping: 'dsh-v1', raw: { format: 'dsh', uncachedInputTokens: 90,
      outputTokens: null, cacheReadTokens: 20, cacheWriteTokens: 10, reasoningTokens: null, totalTokens: null } },
  cost: { status: 'price-not-configured', cny: null },
}

export const usageOverview: ModelUsageOverview = {
  totals: { requests: 3, inFlight: 1, unknownRequests: 1, knownTokens: 120,
    unknownTokenRequests: 2, unpricedRequests: 3, cny: null },
  trend: [{ date: '2026-10-19', requests: 1, knownTokens: 0 }, { date: '2026-10-20', requests: 2, knownTokens: 120 }],
  features: [{ feature: 'patient_dialogue_reply', requests: 1, knownTokens: 0 },
    { feature: 'doctor_recommendation_verification', requests: 2, knownTokens: 120 }],
  coverage: 'server-direct-bridge-and-host', policy: { enabled: true, requests: null, tokens: null, cny: null },
}

export const usageControl: ModelUsageControl = {
  workspace: { enabled: true, requests: null, automaticRetries: true, version: 1,
    requestsStartedAt: null, used: 0, reserved: 0, remaining: null },
  deployment: { enabled: true, requests: 10, automaticRetries: false, version: 1,
    requestsStartedAt: '2026-10-20T00:00:00.000Z', used: 3, reserved: 1, remaining: 6 },
  effective: { enabled: true, automaticRetries: false }, waiting: 2, inFlight: 1,
  lastRejection: { code: 'MODEL_RETRY_DISABLED' as const, scope: 'deployment' as const, at: '2026-10-20T01:02:00.000Z' },
}
