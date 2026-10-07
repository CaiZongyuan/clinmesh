import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { chromium, expect } from '@playwright/test'
import { startManagedProcess } from './dsh-upstreams-process.ts'
import { verificationEnvironment } from './dsh-upstreams-verify.ts'
import { parseLock } from './dsh-upstreams.ts'
import { createClinMeshRuntime } from '../apps/server/src/runtime.ts'
import { persona, signIn, startConsultationCase, StubSyntheaProvider } from '../apps/server/tests/fixtures/consultation.ts'

// Explicit opt-in smoke against the locked, installed host; no external model or credentials.
const root = resolve(import.meta.dirname, '..')
const lock = parseLock(JSON.parse(await readFile(join(root, 'dsh-upstreams.lock.json'), 'utf8')))
const hostVersion = lock.components.find(component => component.name === '@deepseek-ai/dsh')?.version
if (hostVersion === undefined) throw new Error('The upstream lock has no DSH host version')
const runtimeDirectory = resolve(process.env.CLINMESH_DSH_SMOKE_RUNTIME ?? join(root, `.data/dsh-runtime/versions/dsh-${hostVersion}`))
const cli = join(runtimeDirectory, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const scratch = await mkdtemp(join(tmpdir(), 'clinmesh-dsh-model-smoke-'))
const profile = join(scratch, 'home/profiles/web')
const secret = 'synthetic-bridge-secret-at-least-32-characters'
const callsPath = join(scratch, 'calls.jsonl')
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
let managed: ReturnType<typeof startManagedProcess> | undefined
let hospital: Awaited<ReturnType<typeof createClinMeshRuntime>> | undefined
const browser = await chromium.launch({ headless: true })

async function freePort() {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('No smoke port')
  await new Promise<void>(resolve => server.close(() => resolve()))
  return address.port
}

async function launch(port: number, profileName = 'web') {
  let output = ''
  managed = startManagedProcess(process.execPath, [cli, '--profile', profileName, '--port', String(port), '--no-open'], {
    cwd: scratch, env: { ...verificationEnvironment(scratch), DSH_HOME: join(scratch, 'home'), DSH_TELEMETRY_DISABLED: '1', CLINMESH_DSH_BRIDGE_SECRET: secret },
  })
  managed.child.stdout?.on('data', value => { output += value })
  managed.child.stderr?.on('data', value => { output += value })
  for (let attempt = 0; attempt < 180; attempt++) {
    if (managed.child.exitCode !== null) throw new Error('Synthetic DSH host exited during startup')
    const token = /[?&]token=([A-Za-z0-9_-]+)/.exec(output)?.[1]
    if (token) {
      try {
        const url = `http://127.0.0.1:${port}/?token=${token}`
        const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1000) })
        if (response.ok || response.status === 303 || response.status === 302) return url
      } catch { /* Not listening yet. */ }
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  // Never include raw startup output: it contains a temporary access token.
  throw new Error('Synthetic DSH host did not become ready')
}

try {
  await mkdir(join(profile, 'node_modules/@clinmesh'), { recursive: true })
  const synthetic = join(profile, 'node_modules/synthetic-models')
  await mkdir(synthetic)
  await symlink(join(root, 'apps/dsh-web'), join(profile, 'node_modules/@clinmesh/dsh-web'), process.platform === 'win32' ? 'junction' : 'dir')
  await symlink(join(root, 'vendor/dsh-react-surface/packages/runtime'), join(profile, 'node_modules/dsh-react-surface'), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(join(synthetic, 'package.json'), json({ name: 'synthetic-models', type: 'module', main: './index.js' }))
  const sdk = pathToFileURL(join(runtimeDirectory, 'node_modules/@deepseek-ai/dsh-llm/lib/index.js')).href
  await writeFile(join(synthetic, 'index.js'), `import { LlmAdapter } from ${JSON.stringify(sdk)};
import { appendFileSync } from 'node:fs';
export const inject = ['llm'];
class SyntheticAdapter extends LlmAdapter {
  listModels(provider) { return Promise.resolve([{provider,id:'same-model',name:'Synthetic model'}]); }
  async *stream(options) {
    appendFileSync(${JSON.stringify(callsPath)},JSON.stringify({provider:options.provider,model:options.model,session:options.sessionId,tools:options.tools})+'\\n');
    const content = options.system.includes('患者档案') ? ${JSON.stringify(JSON.stringify(persona))} : JSON.stringify({reply:'一周了，站起来就晕。'});
    yield {type:'text-delta',index:0,text:content};
    yield {type:'finish',reason:{kind:'stop'}};
  }
}
export function apply(ctx) {ctx.llm.registerAdapter(['synthetic-a','synthetic-b'],new SyntheticAdapter());}
`)
  await writeFile(join(profile, 'package.json'), json({ name: 'synthetic-profile', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-react-surface', '@clinmesh/dsh-web'] } } }))
  await writeFile(join(profile, 'cordis.yml'), '[]\n')
  await writeFile(join(profile, 'cordis.patch.yml'), `- id: agent-default-model
  config:
    provider: synthetic-a
    model: same-model
- insert:
    - id: synthetic-models
      name: synthetic-models
`)
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.goto(await launch(port))
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 15_000 })
  for (let attempt = 0; attempt < 60; attempt++) {
    const actions = page.getByRole('button', { name: /^(我知道了|Got it|I understand|跳过|Skip|开始设置|Get started|Start setup|继续|Continue|稍后配置|暂不配置|稍后|Configure later)$/ })
    for (let index = (await actions.count()) - 1; index >= 0; index--) {
      const action = actions.nth(index)
      if (await action.isVisible() && await action.isEnabled()) {
        await action.click({ timeout: 3000 }).catch(() => {})
        break
      }
    }
    await page.waitForTimeout(500)
    if (await page.getByRole('dialog').count() === 0) break
  }
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // Open the real host's settings menu without opening a ClinMesh Surface or Session.
  const launcher = page.getByRole('button', { name: /^(设置|Settings)$/ })
  await expect(launcher).toBeVisible({ timeout: 30_000 })
  await launcher.click()
  const selected = page.getByLabel(/^(ClinMesh 模型|ClinMesh model)$/)
  await expect(selected).toBeEnabled({ timeout: 30_000 })
  await expect(selected).toHaveValue('default')
  const routeB = 'dsh:' + JSON.stringify({ provider: 'synthetic-b', model: 'same-model' })
  await selected.selectOption(routeB)
  await expect(selected).toHaveValue(routeB)
  await expect(page.getByRole('status').filter({ hasText: /^(已保存|Saved)$/ })).toBeVisible()
  const hostCookie = (await page.context().cookies()).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
  const description = await (await fetch(`${origin}/api/settings/describe`, { method: 'POST', headers: { cookie: hostCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'settings/describe', payload: { args: {} } }),
  })).json()
  expect(description.result.ok).toBe(true)
  expect(JSON.stringify(description).includes(secret)).toBe(false)
  // The browser's model route must reject direct invocation.
  expect(await page.evaluate(async () => (await fetch('/clinmesh-model-bridge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"operation":"resolve"}' })).status)).toBe(403)
  console.log('DSH 原生设置入口、候选和保存通过')
  await page.reload()
  await expect(launcher).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1000)
  if (await launcher.getAttribute('aria-expanded') !== 'true') await launcher.click()
  await expect(selected).toHaveValue(routeB, { timeout: 30_000 })
  await managed!.stop()
  await page.goto(await launch(port))
  await expect(launcher).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1000)
  if (await launcher.getAttribute('aria-expanded') !== 'true') await launcher.click()
  await expect(selected).toHaveValue(routeB, { timeout: 30_000 })
  console.log('Profile 刷新与宿主重启持久化通过')
  hospital = await createClinMeshRuntime({
    dshModelBridge: { origin, secret, timeoutMs: 5000, maxResponseBytes: 1048576 },
    authBaseUrl: 'http://localhost', authSecret: secret, cursorSecret: secret,
    databasePath: join(scratch, 'clinmesh.sqlite'), demoPassword: 'Synthetic-Demo-Password-2026!',
    migrationMode: 'apply', syntheaProvider: new StubSyntheaProvider(), trustedOrigins: ['http://localhost'],
  })
  const started = await startConsultationCase(hospital)
  const cookie = await signIn(hospital, 'doctor@demo.clinmesh.local')
  const reply = await hospital.app.request(`/api/his/v1/encounters/${started.encounterId}/actions/ask-consultation-question`, {
    method: 'POST', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions: { [`Encounter/${started.encounterId}`]: started.encounterVersion, [`Task/${started.doctorTaskId}`]: '1' }, input: { expectedConsultationVersion: 2, message: '多久了？' } }),
  })
  expect(reply.status).toBe(200)
  const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(calls.length).toBeGreaterThanOrEqual(2)
  expect(calls.every(call => call.provider === 'synthetic-b' && call.model === 'same-model' && !call.session && !call.tools)).toBe(true)
  expect(pageErrors).toEqual([])
  console.log('真实宿主患者档案与问诊路由、会话隔离通过（合成 Provider）')
  await managed!.stop()
  const freshProfile = join(scratch, 'home/profiles/fresh')
  await mkdir(freshProfile, { recursive: true })
  await symlink(join(profile, 'node_modules'), join(freshProfile, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(join(freshProfile, 'package.json'), await readFile(join(profile, 'package.json')))
  await writeFile(join(freshProfile, 'cordis.patch.yml'), `- id: agent-default-model
  config:
    provider: synthetic-a
    model: same-model
- insert:
    - id: synthetic-models
      name: synthetic-models
`)
  await launch(port, 'fresh')
  const resolved = await (await fetch(`${origin}/clinmesh-model-bridge`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: '{"operation":"resolve"}',
  })).json()
  expect(resolved.model).toBe('dsh:' + JSON.stringify({ provider: 'synthetic-a', model: 'same-model' }))
  console.log('不同 Profile 的模型隔离与设置密钥隐藏通过')
} finally {
  await hospital?.close()
  await managed?.stop()
  await browser.close()
  await rm(scratch, { recursive: true, force: true })
}
