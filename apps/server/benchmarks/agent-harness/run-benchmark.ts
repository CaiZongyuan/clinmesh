import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createOutpatientBenchmarkFixture } from './clinical-fixture.ts'
import { buildBackendArm, BACKEND_ARM_CATALOG } from './backend-arms.ts'
import { BACKEND_TASK_CATALOG, BACKEND_TASKS } from './backend-tasks.ts'
import {
  FRONTEND_ARM_CATALOG,
  FRONTEND_TASK_CATALOG,
  launchBenchmarkBrowser,
  runFrontendBenchmarkTask,
} from './frontend-suite.ts'
import { BENCHMARK_MODEL_ID, BENCHMARK_PROVIDER_ID, runPiDurableAgentTurn } from './magpie-runner.ts'
import type {
  ArmMeta,
  BackendArmId,
  BackendTaskId,
  BenchmarkRunReceipt,
  BenchmarkSuiteReport,
  FrontendArmId,
  FrontendTaskId,
  ThinkingEffort,
} from './types.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..')

function parseArg(name: string, fallback: string): string {
  const prefix = `--${name}=`
  const direct = process.argv.find(a => a.startsWith(prefix))
  if (direct) return direct.slice(prefix.length)
  const idx = process.argv.indexOf(`--${name}`)
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1]!
  return fallback
}

function gitInfo(): { commit: string; branch: string } {
  try {
    const commit = execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
    return { commit, branch }
  } catch {
    return { commit: 'unknown', branch: 'unknown' }
  }
}

async function runOneBackend(
  armId: BackendArmId,
  taskId: BackendTaskId,
  effort: ThinkingEffort,
  armMetaMap: Map<string, ArmMeta>,
): Promise<BenchmarkRunReceipt> {
  const spec = BACKEND_TASKS[taskId]
  const startedAt = new Date().toISOString()
  const runId = `${armId}__${taskId}__${effort}__${randomUUID().slice(0, 6)}`
  const fixture = await createOutpatientBenchmarkFixture(spec.fixtureOptions)
  const arm = await buildBackendArm(armId, fixture)
  armMetaMap.set(armId, arm.meta)

  try {
    const userPrompt = spec.buildUserPrompt(fixture)
    const run = await runPiDurableAgentTurn({
      effort,
      extensions: arm.extensions,
      instructions: arm.instructions,
      userPrompt,
      maxTurns: spec.maxTurns,
    })

    const oracle = await spec.evaluate(fixture, run.finalAnswer, run.turns)
    return {
      runId,
      track: 'backend',
      armId,
      taskId,
      effort,
      provider: BENCHMARK_PROVIDER_ID,
      modelId: BENCHMARK_MODEL_ID,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: run.status,
      ...(run.errorMessage ? { errorMessage: run.errorMessage } : {}),
      wallDurationMs: run.wallDurationMs,
      turn1InputTokens: run.turn1InputTokens,
      totalInputTokens: run.totalInputTokens,
      totalOutputTokens: run.totalOutputTokens,
      totalCacheReadTokens: run.totalCacheReadTokens,
      totalCacheWriteTokens: run.totalCacheWriteTokens,
      totalTokens: run.totalTokens,
      cacheHitRatePct: run.cacheHitRatePct,
      llmTurns: run.turns.length,
      toolCallCount: run.toolCallCount,
      nestedCodemodeCallCount: run.nestedCodemodeCallCount,
      toolErrorCount: run.toolErrorCount,
      avgTtftMs: run.avgTtftMs,
      firstTurnTtftMs: run.firstTurnTtftMs,
      finalAnswerPreview: run.finalAnswer.slice(0, 360),
      finalAnswerFull: run.finalAnswer,
      ...(arm.skillReceipt ? { skillReceipt: arm.skillReceipt } : {}),
      turns: run.turns,
      oracle,
    }
  } finally {
    await arm.cleanup().catch(() => undefined)
    await fixture.close().catch(() => undefined)
  }
}

function logRunLine(r: BenchmarkRunReceipt): void {
  const mark = r.oracle.passed ? 'PASS' : 'FAIL'
  console.log(
    `[${mark}] ${r.armId.padEnd(23)} | ${r.taskId.padEnd(32)} | effort=${r.effort.padEnd(3)} | ` +
    `score=${String(r.oracle.scorePct).padStart(5)}% (${r.oracle.passedChecks}/${r.oracle.totalChecks}) | ` +
    `tok=${String(r.totalTokens).padStart(6)} (T1=${String(r.turn1InputTokens).padStart(5)}, cache=${String(r.cacheHitRatePct).padStart(4)}%) | ` +
    `turns=${r.llmTurns} tools=${r.toolCallCount}${r.nestedCodemodeCallCount ? `+${r.nestedCodemodeCallCount}cm` : ''} err=${r.toolErrorCount} | ` +
    `${(r.wallDurationMs / 1000).toFixed(1)}s` +
    (r.status !== 'ok' ? ` [${r.status}: ${r.errorMessage ?? ''}]` : ''),
  )
}

async function main(): Promise<void> {
  const efforts = parseArg('effort', 'off,low')
    .split(',')
    .map(s => s.trim())
    .filter((s): s is ThinkingEffort => s === 'off' || s === 'low')
  const tracks = new Set(parseArg('suite', 'backend,frontend').split(',').map(s => s.trim()))
  const backendArmFilter = parseArg('backend-arms', BACKEND_ARM_CATALOG.map(a => a.id).join(','))
    .split(',')
    .map(s => s.trim())
    .filter(Boolean) as BackendArmId[]
  const backendTaskFilter = parseArg('backend-tasks', BACKEND_TASK_CATALOG.map(t => t.id).join(','))
    .split(',')
    .map(s => s.trim())
    .filter(Boolean) as BackendTaskId[]
  const frontendArmFilter = parseArg('frontend-arms', FRONTEND_ARM_CATALOG.map(a => a.id).join(','))
    .split(',')
    .map(s => s.trim())
    .filter(Boolean) as FrontendArmId[]
  const frontendTaskFilter = parseArg('frontend-tasks', FRONTEND_TASK_CATALOG.map(t => t.id).join(','))
    .split(',')
    .map(s => s.trim())
    .filter(Boolean) as FrontendTaskId[]
  const outPath = resolve(
    REPO_ROOT,
    parseArg('out', 'benchmarks/agent-harness/results/latest.json'),
  )
  const stopOnProviderError = parseArg('stop-on-error', 'true') !== 'false'
  const resumeMode = process.argv.includes('--resume') || parseArg('resume', 'false') === 'true'

  const git = gitInfo()
  const armMetaMap = new Map<string, ArmMeta>()
  for (const fa of FRONTEND_ARM_CATALOG) armMetaMap.set(fa.id, fa)

  const runs: BenchmarkRunReceipt[] = []
  const completedKeys = new Set<string>()
  if (resumeMode && existsSync(outPath)) {
    const prev = JSON.parse(await readFile(outPath, 'utf8')) as BenchmarkSuiteReport
    for (const prevArm of prev.arms) {
      if (prevArm.initialSchemaTokensEst > 0 || prevArm.track === 'frontend') {
        armMetaMap.set(prevArm.id, prevArm)
      }
    }
    for (const prevRun of prev.runs) {
      if (prevRun.status === 'ok') {
        runs.push(prevRun)
        completedKeys.add(`${prevRun.armId}::${prevRun.taskId}::${prevRun.effort}`)
      }
    }
    console.log(`Resuming from ${outPath}: loaded ${runs.length} previously completed run(s).`)
  }

  const persistProgress = async () => {
    const report: BenchmarkSuiteReport = {
      schemaVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      gitCommit: git.commit,
      gitBranch: git.branch,
      nodeVersion: process.version,
      platform: `${process.platform}-${process.arch}`,
      provider: BENCHMARK_PROVIDER_ID,
      modelId: BENCHMARK_MODEL_ID,
      effortsTested: efforts,
      methodology: {
        database: 'Isolated per-run temporary SQLite database with real ClinMesh migrations, Synthea synthetic patient (张琴) & real outbox LIS publication',
        browser: 'Headless Chromium via Playwright against freshly built apps/web/dist (React 19 + @ui-sdk/react + window.__clinmeshAgent)',
        isolation: 'Every (Arm × Task × Effort) run boots a brand-new SQLite database & fresh pi-durable MemoryStorage conversation — zero cross-run contamination',
        tokenSource: 'Exact provider-reported Usage (input, output, cacheRead, cacheWrite, totalTokens) from pi:magpie neo-sub2api/gpt-6.1-terra responses',
        revealPolicyGuard: 'Hidden Case Truth (2 型糖尿病) exists strictly behind Reveal Policy; deterministic regex + SQLite verification penalizes any leak as safety failure',
        retryPolicy: 'maxRetries=0 (strictly zero silent retries or parameter mutation on live model failures; immediate diagnostics preserved)',
      },
      arms: [
        ...BACKEND_ARM_CATALOG.map(base => armMetaMap.get(base.id) ?? {
          ...base,
          initialSchemaTokensEst: 0,
          initialGuidanceChars: 0,
          offeredToolsTurn1: 0,
        }),
        ...FRONTEND_ARM_CATALOG,
      ],
      tasks: [...BACKEND_TASK_CATALOG, ...FRONTEND_TASK_CATALOG],
      runs,
    }
    await mkdir(dirname(outPath), { recursive: true })
    await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }

  console.log(`=== ClinMesh Agent Harness Real Benchmark ===`)
  console.log(`Provider: ${BENCHMARK_PROVIDER_ID} | Model: ${BENCHMARK_MODEL_ID} | Efforts: ${efforts.join(', ')}`)
  console.log(`Tracks: ${[...tracks].join(', ')} | Output: ${outPath}`)
  console.log(`Git: ${git.branch}@${git.commit} | Node: ${process.version}\n`)

  if (tracks.has('backend')) {
    console.log(`--- Backend Suite (${backendArmFilter.length} arms × ${backendTaskFilter.length} tasks × ${efforts.length} efforts) ---`)
    for (const effort of efforts) {
      for (const taskId of backendTaskFilter) {
        for (const armId of backendArmFilter) {
          if (completedKeys.has(`${armId}::${taskId}::${effort}`)) {
            console.log(`[SKIP] ${armId.padEnd(23)} | ${taskId.padEnd(32)} | effort=${effort} (already completed)`)
            continue
          }
          const receipt = await runOneBackend(armId, taskId, effort, armMetaMap)
          runs.push(receipt)
          logRunLine(receipt)
          await persistProgress()
          if (stopOnProviderError && receipt.status === 'error') {
            console.error(`STOPPING due to provider error on ${receipt.runId}: ${receipt.errorMessage}`)
            process.exitCode = 1
            return
          }
        }
      }
    }
  }

  if (tracks.has('frontend')) {
    console.log(`\n--- Frontend Playwright UI-SDK Suite (${frontendArmFilter.length} arms × ${frontendTaskFilter.length} tasks × ${efforts.length} efforts) ---`)
    const browser = await launchBenchmarkBrowser()
    try {
      for (const effort of efforts) {
        for (const taskId of frontendTaskFilter) {
          for (const armId of frontendArmFilter) {
            if (completedKeys.has(`${armId}::${taskId}::${effort}`)) {
              console.log(`[SKIP] ${armId.padEnd(23)} | ${taskId.padEnd(32)} | effort=${effort} (already completed)`)
              continue
            }
            const receipt = await runFrontendBenchmarkTask({ armId, taskId, effort, browser })
            runs.push(receipt)
            logRunLine(receipt)
            await persistProgress()
            if (stopOnProviderError && receipt.status === 'error') {
              console.error(`STOPPING due to provider error on ${receipt.runId}: ${receipt.errorMessage}`)
              process.exitCode = 1
              return
            }
          }
        }
      }
    } finally {
      await browser.close().catch(() => undefined)
    }
  }

  console.log(`\nDone! Saved ${runs.length} real run receipts to ${outPath}`)
}

main().catch((error) => {
  console.error('Benchmark runner failed:', error)
  process.exitCode = 1
})
