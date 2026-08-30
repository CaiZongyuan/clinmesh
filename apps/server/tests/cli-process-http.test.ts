import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ServerType } from '@hono/node-server'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { startServer } from '../src/server.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function listen(server: ServerType): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', resolve)
  })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

async function closeServer(server: ServerType): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error))
  })
}

async function reservePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await listen(server)
  const port = (server.address() as AddressInfo).port
  await closeServer(server)
  return port
}

async function runCli(
  args: string[],
  env: Record<string, string>,
  stdin?: string,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  const tsx = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url))
  const entry = fileURLToPath(new URL('../../cli/src/index.ts', import.meta.url))
  const child = spawn(tsx, [entry, ...args], {
    env: {
      PATH: process.env.PATH,
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  child.stdin.end(stdin)
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  return { code, stderr, stdout }
}

function responseDroppingProxy(upstreamOrigin: string): Server {
  let dropped = false
  return createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const headers = new Headers()
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || ['connection', 'content-length', 'host'].includes(name)) continue
        for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
      }
      const body = Buffer.concat(chunks)
      const upstream = await fetch(new URL(request.url ?? '/', upstreamOrigin), {
        ...(body.length === 0 ? {} : { body }),
        headers,
        method: request.method ?? 'GET',
      })
      const payload = Buffer.from(await upstream.arrayBuffer())
      if (
        !dropped
        && request.method === 'POST'
        && request.url?.startsWith('/api/his/v1/patients') === true
      ) {
        dropped = true
        response.destroy()
        return
      }
      const responseHeaders: Record<string, string> = {}
      upstream.headers.forEach((value, name) => { responseHeaders[name] = value })
      response.writeHead(upstream.status, responseHeaders)
      response.end(payload)
    } catch {
      response.destroy()
    }
  })
}

describe('clinmesh CLI process over real HTTP', () => {
  it('recovers one response-lost Agent write through its Command receipt without duplicating the Effect', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-cli-process-'))
    const password = 'synthetic-cli-process-password'
    const port = await reservePort()
    const serverOrigin = `http://127.0.0.1:${port}`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: serverOrigin,
      authSecret: 'synthetic-cli-process-secret-32-bytes',
      cursorSecret: 'synthetic-cli-process-cursor-secret',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      trustedOrigins: [serverOrigin],
    })
    const server = startServer({ app: runtime.app, hostname: '127.0.0.1', port })
    expect(await listen(server)).toBe(serverOrigin)
    cleanups.push(async () => {
      await closeServer(server)
      await runtime.close()
      await rm(directory, { force: true, recursive: true })
    })

    const humanEnv = { CLINMESH_CONFIG_DIR: join(directory, 'cli-config') }
    const humanLogin = await runCli([
      'auth', 'login',
      '--profile', 'admin',
      '--server-url', serverOrigin,
      '--email', 'admin@demo.clinmesh.local',
      '--password-stdin',
    ], humanEnv, `${password}\n`)
    expect(humanLogin).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(humanLogin.stdout)).toMatchObject({
      data: { authMode: 'human', profile: 'admin', serverUrl: serverOrigin },
      ok: true,
    })
    const humanContext = await runCli(
      ['context', 'show', '--profile', 'admin'],
      humanEnv,
    )
    expect(humanContext).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(humanContext.stdout)).toMatchObject({
      data: { actor: { roleCode: 'administrator', workspaceId: 'workspace-demo' } },
      ok: true,
    })

    const signIn = await fetch(`${serverOrigin}/api/auth/sign-in/email`, {
      body: JSON.stringify({ email: 'admin@demo.clinmesh.local', password }),
      headers: { 'content-type': 'application/json', origin: serverOrigin },
      method: 'POST',
    })
    expect(signIn.status).toBe(200)
    const cookie = signIn.headers.getSetCookie()[0]?.split(';', 1)[0] ?? ''
    const controlHeaders = {
      'content-type': 'application/json',
      cookie,
      origin: serverOrigin,
    }
    const clientResponse = await fetch(`${serverOrigin}/api/agent/v1/clients`, {
      body: JSON.stringify({ name: 'CLI process registrar' }),
      headers: controlHeaders,
      method: 'POST',
    })
    const client = await clientResponse.json() as { agentClientId: string }
    const grantResponse = await fetch(`${serverOrigin}/api/agent/v1/grants`, {
      body: JSON.stringify({
        agentClientId: client.agentClientId,
        operationIds: ['patient.create', 'patient.search'],
        practitionerRoleId: 'practitioner-role-registrar',
        ttlSeconds: 3600,
      }),
      headers: controlHeaders,
      method: 'POST',
    })
    expect(grantResponse.status).toBe(200)
    const grant = await grantResponse.json() as { token: string }
    const agentEnv = {
      CLINMESH_AGENT_ID: 'cli-process-agent',
      CLINMESH_AGENT_TASK_ID: 'cli-process-task',
      CLINMESH_SERVER_URL: serverOrigin,
      CLINMESH_TOKEN: grant.token,
    }

    const initialQuery = await runCli(
      ['patient', 'search', '--query', 'MZ20260826001'],
      agentEnv,
    )
    expect(initialQuery).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(initialQuery.stdout)).toMatchObject({
      ok: true,
      operation: { id: 'patient.search' },
    })

    const proxy = responseDroppingProxy(serverOrigin)
    proxy.listen(0, '127.0.0.1')
    const proxyOrigin = await listen(proxy)
    cleanups.push(() => closeServer(proxy))
    const patientInput = JSON.stringify({
      birthDate: '1992-05-06',
      gender: 'female',
      identifier: 'CLI-E2E-0001',
      name: '合成 CLI 患者',
    })
    const idempotencyKey = 'cli-e2e-patient-create-0001'
    const ambiguous = await runCli([
      'patient', 'create',
      '--input', '-',
      '--idempotency-key', idempotencyKey,
    ], { ...agentEnv, CLINMESH_SERVER_URL: proxyOrigin }, patientInput)
    expect(ambiguous.code).toBe(7)
    expect(ambiguous.stdout).toBe('')
    expect(JSON.parse(ambiguous.stderr)).toMatchObject({
      error: {
        code: 'ambiguous_outcome',
        idempotencyKey,
        operationId: 'patient.create',
        outcome: 'ambiguous',
      },
      ok: false,
    })

    const receipt = await runCli([
      'command', 'receipt', 'get',
      '--operation-id', 'patient.create',
      '--idempotency-key', idempotencyKey,
    ], agentEnv)
    expect(receipt).toMatchObject({ code: 0, stderr: '' })
    const receiptEnvelope = JSON.parse(receipt.stdout)
    expect(receiptEnvelope).toMatchObject({
      data: {
        idempotencyKey,
        operationId: 'patient.create',
        status: 'completed',
      },
      ok: true,
    })

    const replay = await runCli([
      'patient', 'create',
      '--input', '-',
      '--idempotency-key', idempotencyKey,
    ], agentEnv, patientInput)
    expect(replay).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(replay.stdout).data).toEqual(receiptEnvelope.data.response)

    const finalQuery = await runCli(
      ['patient', 'search', '--query', 'CLI-E2E-0001'],
      agentEnv,
    )
    expect(finalQuery).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(finalQuery.stdout)).toMatchObject({
      data: {
        items: [expect.objectContaining({ identifier: 'CLI-E2E-0001' })],
        total: 1,
      },
      ok: true,
    })
  }, 30_000)
})
