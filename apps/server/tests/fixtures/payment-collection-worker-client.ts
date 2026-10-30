import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const replySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready') }),
  z.object({ kind: z.literal('result'), status: z.number().int(), body: z.unknown() }),
  z.object({ kind: z.literal('error'), message: z.string() }),
])

/** Independent runtime and SQLite connection; readiness and request deadlines are separate. */
export async function openPaymentCollectionWorker(databasePath: string, password: string, registerCleanup: (cleanup: () => Promise<void>) => void) {
  const child = fork(fileURLToPath(new URL('./shared-payment-collection-worker.ts', import.meta.url)), [databasePath, password], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, TSX_DISABLE_CACHE: '1' },
  })
  let stderr = ''
  child.stderr!.on('data', chunk => { stderr += String(chunk) })
  registerCleanup(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>(resolve => {
      const fallback = setTimeout(() => child.kill(), 5000)
      child.once('exit', () => { clearTimeout(fallback); resolve() })
      if (child.connected) child.send({ kind: 'close' })
      else child.kill()
    })
  })
  async function message(timeoutMs = 15_000) {
    return new Promise<z.infer<typeof replySchema>>((resolve, reject) => {
      const timeout = setTimeout(() => { detach(); reject(new Error(`收款工作进程未响应：${stderr}`)) }, timeoutMs)
      const received = (raw: unknown) => {
        detach()
        try { resolve(replySchema.parse(raw)) } catch (error) { reject(error) }
      }
      const failed = (code: number | null) => { detach(); reject(new Error(`收款工作进程退出 ${code}：${stderr}`)) }
      function detach() { clearTimeout(timeout); child.off('message', received); child.off('exit', failed) }
      child.once('message', received)
      child.once('exit', failed)
    })
  }
  const ready = await message(30_000)
  if (ready.kind !== 'ready') throw new Error(JSON.stringify(ready))
  return {
    pid: child.pid,
    async run(input: { path: string; cookie: string; key: string; body: unknown; startAt: number }) {
      const result = message()
      child.send({ kind: 'run', ...input })
      const response = await result
      if (response.kind !== 'result') throw new Error(JSON.stringify(response))
      return response
    },
  }
}
