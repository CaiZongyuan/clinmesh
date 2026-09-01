import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import { generatePatientBrief } from './application/patient-brief-service.ts'
import { readServerConfig, readServerEnvironment } from './config.ts'
import { OpenAIChatCompletionsClient } from './infrastructure/ai/openai-chat-completions.ts'

const hiddenResources = [{
  code: {
    coding: [{
      code: 'SYNTHETIC-HIDDEN-001',
      display: '合成隐匿诊断占位',
      system: 'urn:clinmesh:synthetic-live-smoke',
    }],
  },
  id: 'synthetic-hidden-condition',
  resourceType: 'Condition',
}]

const payload = {
  caseType: 'new-problem',
  demographics: { birthDate: '1988-03-16', gender: 'female' },
  privateEpisodeEvidence: [{
    codes: ['SYNTHETIC-HIDDEN-001'],
    resourceType: 'Condition',
    terms: ['合成隐匿诊断占位'],
  }],
  visibleHistory: [{
    clinicalDate: '2025-01-10T09:05:00+08:00',
    resourceType: 'Condition',
    sourceReference: 'urn:uuid:synthetic-prior-condition',
    title: '既往反复头晕',
  }],
}

function errorCode(error: unknown): string {
  if (error instanceof SyntaxError) return 'JSON_PARSE_FAILED'
  if (error instanceof z.ZodError) return 'BRIEF_RESPONSE_INVALID'
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return 'LIVE_SMOKE_FAILED'
  }
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)
    ? code
    : 'LIVE_SMOKE_FAILED'
}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('httpStatus' in error)) return undefined
  const status = (error as { httpStatus?: unknown }).httpStatus
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined
}

function validationIssues(error: unknown): unknown {
  if (error instanceof z.ZodError) {
    return error.issues.map(issue => ({ code: issue.code, path: issue.path.join('.') }))
  }
  if (typeof error !== 'object' || error === null || !('validationIssues' in error)) return undefined
  return (error as { validationIssues?: unknown }).validationIssues
}

try {
  const config = readServerConfig(readServerEnvironment(process.env))
  if (config.ai === undefined) throw new Error('AI configuration is required')
  const provider = new OpenAIChatCompletionsClient({
    apiKey: config.ai.apiKey,
    baseUrl: config.ai.baseUrl,
    maxResponseBytes: config.ai.maxResponseBytes,
    timeoutMs: config.ai.timeoutMs,
  })
  const startedAt = performance.now()
  const result = await generatePatientBrief({
    hiddenResources,
    model: config.ai.briefModel,
    payload,
    provider,
    visibleResources: [],
  })
  console.info(JSON.stringify({
    durationMs: Math.round(performance.now() - startedAt),
    model: result.model,
    outputHash: result.outputHash,
    status: 'passed',
  }))
} catch (error) {
  const status = httpStatus(error)
  const issues = validationIssues(error)
  console.error(JSON.stringify({
    code: errorCode(error),
    ...(status === undefined ? {} : { httpStatus: status }),
    ...(issues === undefined ? {} : { validationIssues: issues }),
    status: 'failed',
  }))
  process.exitCode = 1
}
