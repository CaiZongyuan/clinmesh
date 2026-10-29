import { z } from 'zod'
import { createClinMeshRuntime } from '../../src/runtime.ts'

const [databasePath, password] = z.tuple([z.string().min(1), z.string().min(1)]).parse(process.argv.slice(2))
const requestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('close') }).strict(),
  z.object({ kind: z.literal('run'), path: z.string().regex(/^\/api\/his\/v1\/(?:payments\/[A-Za-z0-9.-]+\/actions\/confirm|inpatient\/admissions\/[A-Za-z0-9.-]+\/payments\/confirm)$/),
    cookie: z.string().min(1), key: z.string().min(1), body: z.unknown(), startAt: z.number().int(),
  }).strict(),
])

const runtime = await createClinMeshRuntime({
  authBaseUrl: 'http://localhost', trustedOrigins: ['http://localhost'],
  authSecret: 'test-auth-secret-with-at-least-32-characters',
  cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
  databasePath, demoPassword: password, migrationMode: 'verify',
})

process.on('message', async raw => {
  try {
    const input = requestSchema.parse(raw)
    if (input.kind === 'close') {
      await runtime.close()
      process.disconnect?.()
      return
    }
    await new Promise(resolve => setTimeout(resolve, Math.max(0, input.startAt - Date.now())))
    const response = await runtime.app.request(input.path, {
      method: 'POST',
      headers: { cookie: input.cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': input.key },
      body: JSON.stringify(input.body),
    })
    process.send?.({ kind: 'result', status: response.status, body: await response.json() })
  } catch (error) {
    process.send?.({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    process.exitCode = 1
    await runtime.close()
    process.disconnect?.()
  }
})
process.send?.({ kind: 'ready' })
