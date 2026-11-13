import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { createClinMeshRuntime, type CreateClinMeshRuntimeOptions } from '../../src/runtime.ts'
import { OpenAIChatCompletionsClient } from '../../src/infrastructure/ai/openai-chat-completions.ts'
import { pciAgentGeneration, pciAgentVerification } from './inpatient-drg-agent.ts'

const [encoded, barrierDirectory, worker] = z.tuple([z.string(), z.string(), z.enum(['0', '1'])]).parse(process.argv.slice(2))
const options: CreateClinMeshRuntimeOptions = JSON.parse(encoded)
let armed = false
const parked = new Int32Array(new SharedArrayBuffer(4))
function waitFor(path: string) {
  const deadline = Date.now() + 10_000
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error('Synthetic recovery interleaving did not reach its barrier')
    Atomics.wait(parked, 0, 0, 10)
  }
}
const provider = new OpenAIChatCompletionsClient({ apiKey: 'synthetic-only', baseUrl: 'https://synthetic.invalid/v1', fetch: async (_url, init) => {
  const request = JSON.parse(String(init?.body)), feature = request.response_format.json_schema.name
  const input = z.object({ deviation: z.unknown().optional() }).passthrough().parse(JSON.parse(request.messages[1].content))
  const result = input.deviation ? feature === 'inpatient_drg_recommendation'
    ? { explanation: '本笔分支保护超出原计划，核实后续实际用量。', costExplanation: null }
    : { supported: true, costExplanationSupported: null }
    : feature === 'inpatient_drg_recommendation' ? pciAgentGeneration : pciAgentVerification
  return Response.json({ id: `synthetic-recovery-${worker}`, model: 'synthetic-drg-model', choices: [{ message: { content: JSON.stringify(result) } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })
} })
const runtime = await createClinMeshRuntime({ ...options, migrationMode: 'verify', chatCompletionsProvider: provider,
  performanceObserver: {
    observeTransaction: () => undefined,
    observeStatement: ({ sql }) => {
      if (!armed || !sql.includes("json_extract(input_json,'$.kind')='intraoperative-review'") || !sql.includes('ORDER BY analysis_id')) return
      armed = false
      // 两个真实连接都先取得旧读取结果；第二个连接在第一个恢复提交后才继续。
      writeFileSync(join(barrierDirectory, `read-${worker}`), '')
      waitFor(join(barrierDirectory, `read-${worker === '0' ? '1' : '0'}`))
      if (worker === '1') waitFor(join(barrierDirectory, 'first-complete'))
    },
  },
})
const messageSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('close') }).strict(),
  z.object({ kind: z.literal('recover'), cookie: z.string(), path: z.string().regex(/^\/api\/his\/v1\/inpatient\/admissions\/[A-Za-z0-9.-]+$/) }).strict()])
process.on('message', async raw => {
  try {
    const message = messageSchema.parse(raw)
    if (message.kind === 'close') { await runtime.close(); process.disconnect?.(); return }
    armed = true
    await runtime.dispatchPending()
    if (worker === '0') writeFileSync(join(barrierDirectory, 'first-complete'), '')
    const state = await runtime.app.request(`${message.path}/drg/agent`, { headers: { cookie: message.cookie } })
    const usage = await runtime.app.request(`/api/model-usage/requests?caseId=${message.path.split('/').at(-1)}`, { headers: { cookie: message.cookie } })
    process.send?.({ kind: 'result', stateStatus: state.status, state: await state.json(), usageStatus: usage.status, usage: await usage.json() })
  } catch (error) {
    process.send?.({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    await runtime.close(); process.disconnect?.()
  }
})
process.send?.({ kind: 'ready' })
