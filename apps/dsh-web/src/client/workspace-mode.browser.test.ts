import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { z } from 'zod'
import { expect, test } from '@playwright/test'
import { createPatientResponseSchema, sessionContextSchema } from '@clinmesh/contracts/his'
import { inpatientCatalogSchema, inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { agentPageContextRequestSchema } from '@clinmesh/contracts/agent'
import { startBrowserServer } from '../../../server/tests/browser-server.ts'
import { buildSurfaceStyles } from '../surface-styles.ts'
import { AgentExecutionProofIssuer } from '../execution-proof.ts'

const require = createRequire(import.meta.url)
for (const version of ['18', '19']) test.describe(`住院模式发布 React ${version}`, () => {
  let script: string
  let styles: string
  test.beforeAll(async () => {
    const react = version === '18' ? 'react18' : 'react', reactDom = version === '18' ? 'react-dom18' : 'react-dom'
    const result = await build({ configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic', jsxDev: false },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') }, resolve: { alias: [
        { find: /^react$/, replacement: require.resolve(react) },
        { find: 'react/jsx-runtime', replacement: require.resolve(`${react}/jsx-runtime`) },
        { find: 'react-dom/client', replacement: require.resolve(`${reactDom}/client`) },
        { find: /^react-dom$/, replacement: require.resolve(reactDom) },
      ] }, build: { write: false, lib: { entry: fileURLToPath(new URL('./workspace-mode.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'WorkspaceModeContract' } } })
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => {
      if (!('output' in output)) throw new Error('Unexpected browser watcher')
      return output.output
    })
    const chunk = outputs.find(output => output.type === 'chunk')
    if (chunk?.type !== 'chunk') throw new Error('Missing workspace mode fixture')
    script = chunk.code
    styles = await buildSurfaceStyles()
  })
  test('收费员队列模式切换发布真实住院上下文，返回门诊撤下住院工具', async ({ page }) => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-mode-contract-'))
    const secret = 'synthetic-workspace-mode-secret-with-at-least-32-characters'
    const server = await startBrowserServer(directory, { dshBridgeSecret: secret })
    const issuer = new AgentExecutionProofIssuer({ secret })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      const headers = { origin: server.origin }
      const login = await page.request.post(`${server.origin}/api/auth/sign-in/email`, { headers, data: { email: 'registrar@demo.clinmesh.local', password: server.password } })
      expect(login.status()).toBe(200)
      const session = sessionContextSchema.parse(await (await page.request.get(`${server.origin}/api/auth/context`)).json())
      const patientResponse = await page.request.post(`${server.origin}/api/his/v1/patients`, { headers: { ...headers, 'idempotency-key': randomUUID() }, data: { expectedVersions: {}, input: {
        name: '模式接线患者', identifier: 'SYN-MODE-CONTEXT', birthDate: '1980-01-01', gender: 'female',
      } } })
      expect(patientResponse.status()).toBe(200)
      const patient = createPatientResponseSchema.parse(await patientResponse.json()).data.patient
      const catalog = inpatientCatalogSchema.parse(await (await page.request.get(`${server.origin}/api/his/v1/inpatient/catalog`)).json())
      const response = await page.request.post(`${server.origin}/api/his/v1/inpatient/admissions`, { headers: { ...headers, 'idempotency-key': randomUUID() }, data: { input: {
        expectedEpoch: session.actor.epoch, patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct', wardId: catalog.wards[0]!.id, depositFen: 0,
      } } })
      expect(response.status()).toBe(200)
      const admission = inpatientCommandResponseSchema.parse(await response.json()).data.admission
      expect((await page.request.post(`${server.origin}/api/auth/sign-out`, { headers, data: {} })).status()).toBe(200)
      const views: Array<{ viewId: string; selection?: string }> = []
      page.on('request', request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/agent/v1/page-contexts') {
          const input = agentPageContextRequestSchema.parse(request.postDataJSON())
          views.push({ viewId: input.claim.viewId, ...(input.claim.selection ? { selection: input.claim.selection.id } : {}) })
        }
      })
      await page.route(`${server.origin}/clinmesh-agent-proof`, async route => {
        const input = z.object({ contextId: z.string(), pageRevision: z.string(), scopeKey: z.string(), toolName: z.string() }).parse(route.request().postDataJSON())
        const dispose = issuer.begin({ ...input, callId: randomUUID(), dshSessionId: 'workspace-mode-session' })
        try { await route.fulfill({ json: { data: { proof: issuer.issue(input) } } }) }
        finally { dispose() }
      })
      await page.route(`${server.origin}/__workspace-mode-contract.js`, route => route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script }))
      await page.route(`${server.origin}/__workspace-mode-contract`, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8"><style>${styles}</style></head><body><script src="/__workspace-mode-contract.js"></script></body></html>` }))
      await page.goto(`${server.origin}/__workspace-mode-contract`)
      expect(errors).toEqual([])
      await page.getByLabel('账户邮箱').fill('cashier@demo.clinmesh.local')
      await page.getByLabel('账户密码').fill(server.password)
      await page.getByRole('button', { name: '登录', exact: true }).click()
      const published = page.getByLabel('宿主已发布工具')
      await expect(published).toContainText('clinmesh_navigate')
      await page.getByRole('button', { name: '住院', exact: true }).click()
      await page.getByRole('button', { name: '查看模式接线患者', exact: true }).click()
      await expect(published).toContainText('clinmesh_select_inpatient_stage')
      await expect(page.getByRole('heading', { name: '住院收费', level: 1, exact: true })).toBeVisible()
      expect(views).toContainEqual({ viewId: 'inpatient', selection: admission.id })
      await page.getByRole('button', { name: '门诊', exact: true }).click()
      await expect(published).toContainText('clinmesh_navigate')
      await expect(published).not.toContainText('clinmesh_select_inpatient_stage')
      await expect(page.getByRole('heading', { name: '门诊收费', level: 1, exact: true })).toBeVisible()
      await page.getByRole('button', { name: '助手切换住院', exact: true }).click()
      await expect(page.getByRole('heading', { name: '住院收费', level: 1, exact: true })).toBeVisible()
      await page.getByRole('button', { name: '查看模式接线患者', exact: true }).click()
      await expect(published).toContainText('clinmesh_select_inpatient_stage')
      await page.getByRole('button', { name: '助手切换门诊', exact: true }).click()
      await expect(page.getByRole('heading', { name: '门诊收费', level: 1, exact: true })).toBeVisible()
      await expect(published).not.toContainText('clinmesh_select_inpatient_stage')
      expect(errors).toEqual([])
    } finally { await server.close(); await rm(directory, { recursive: true, force: true }) }
  })
})
