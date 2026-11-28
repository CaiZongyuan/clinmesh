export type ThinkingEffort = 'off' | 'low'

export type BenchmarkTrack = 'backend' | 'frontend'

export type BackendArmId =
  | 'B1-flat-mcp'
  | 'B2-legacy-cli'
  | 'B3-multica-cli'
  | 'B4-stateless-mcp-2026'
  | 'B5-hybrid-tool-search'
  | 'B6-hybrid-codemode'

export type FrontendArmId =
  | 'F1-raw-dom-a11y'
  | 'F2-flat-ui-sdk'
  | 'F3-dual-track-ui-sdk'

export type ArmId = BackendArmId | FrontendArmId

export type BackendTaskId =
  | 'T1-clinical-briefing'
  | 'T2-safety-completion-audit'
  | 'T3-outpatient-e2e-write'

export type FrontendTaskId =
  | 'U1-unsaved-draft-and-human-edit'
  | 'U2-triage-batch-and-confirm-gate'

export type TaskId = BackendTaskId | FrontendTaskId

export interface ToolCallTrace {
  callId: string
  name: string
  argsPreview: string
  durationMs: number
  isError: boolean
  outputChars: number
  outputPreview: string
  nestedCalls?: Array<{
    name: string
    status: string
    durationMs?: number
    argsPreview?: string
    error?: string
  }>
}

export interface TurnTelemetry {
  turnIndex: number
  durationMs: number
  ttftMs: number | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  offeredToolCount: number
  promptCharsEstimate: number
  thinkingChars: number
  textChars: number
  stopReason: string
  toolCalls: ToolCallTrace[]
}

export interface OracleCheck {
  id: string
  label: string
  passed: boolean
  weight: number
  detail: string
  category: 'accuracy' | 'ground-truth' | 'safety' | 'efficiency'
}

export interface OracleResult {
  passed: boolean
  scorePct: number
  passedChecks: number
  totalChecks: number
  caseTruthLeaked: boolean
  highRiskBlockedWhenExpected?: boolean
  humanEditPreserved?: boolean
  confirmGateDeniedBlocked?: boolean
  confirmGateApprovedCommitted?: boolean
  sidebarIsolationZeroControls?: boolean
  checks: OracleCheck[]
}

export interface SkillReceipt {
  skillBundle: string
  schemaVersion: string
  sha256: string
  catalogCount: number
  injectedBytes: number
}

export interface ArmMeta {
  id: ArmId
  track: BenchmarkTrack
  label: string
  shortLabel: string
  category: 'baseline' | 'cli' | 'mcp' | 'hybrid' | 'ui-sdk'
  summary: string
  initialSchemaTokensEst: number
  initialGuidanceChars: number
  offeredToolsTurn1: number
  supportsProgressiveDisclosure: boolean
  supportsCodeExecution: boolean
  supportsHumanEditProtection?: boolean
  supportsConfirmGate?: boolean
}

export interface TaskMeta {
  id: TaskId
  track: BenchmarkTrack
  label: string
  shortLabel: string
  difficulty: 'medium' | 'hard'
  description: string
  requiredCapabilities: string[]
}

export interface BenchmarkRunReceipt {
  runId: string
  track: BenchmarkTrack
  armId: ArmId
  taskId: TaskId
  effort: ThinkingEffort
  provider: string
  modelId: string
  startedAt: string
  finishedAt: string
  status: 'ok' | 'error' | 'turn_limit'
  errorMessage?: string
  wallDurationMs: number
  turn1InputTokens: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  totalTokens: number
  cacheHitRatePct: number
  llmTurns: number
  toolCallCount: number
  nestedCodemodeCallCount: number
  toolErrorCount: number
  avgTtftMs: number | null
  firstTurnTtftMs: number | null
  finalAnswerPreview: string
  finalAnswerFull: string
  skillReceipt?: SkillReceipt
  frontendMetrics?: {
    snapshotControlsCount: number
    sidebarControlsExposed: number
    snapshotChars: number
    humanEditedBeforeValue?: string
    humanEditedAfterValue?: string
    humanEditedAfterUndoValue?: string
    agentFieldAfterUndoCleared?: boolean
    confirmDeniedRequests?: number
    confirmApprovedRequests?: number
    dbRecordVerified?: boolean
  }
  turns: TurnTelemetry[]
  oracle: OracleResult
}

export interface BenchmarkSuiteReport {
  schemaVersion: '1.0.0'
  generatedAt: string
  gitCommit: string
  gitBranch: string
  nodeVersion: string
  platform: string
  provider: string
  modelId: string
  effortsTested: ThinkingEffort[]
  methodology: {
    database: string
    browser: string
    isolation: string
    tokenSource: string
    revealPolicyGuard: string
    retryPolicy: string
  }
  arms: ArmMeta[]
  tasks: TaskMeta[]
  runs: BenchmarkRunReceipt[]
}
