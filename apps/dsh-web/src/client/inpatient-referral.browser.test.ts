import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test } from '@playwright/test'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)
const session = { actor: { actorId: 'synthetic-actor', epoch: 'epoch-1', workspaceId: 'workspace-demo', scenarioRunId: 'scenario-run-1',
  roleCode: 'outpatient-doctor' as const, practitionerRoleId: 'practitioner-role-outpatient-doctor' },
  user: { id: 'synthetic-user', name: '合成门诊医生', email: 'doctor@demo.clinmesh.local' }, availableRoles: [] }
for (const version of ['18', '19']) {
  test(`住院证Dialog在React ${version}的ShadowRoot中选择病区并开具`, async ({ page }) => {
    const submitted: Array<{ input: unknown; key: string | undefined }> = []
    await page.route('http://localhost/**', async route => {
      if (route.request().url().endsWith('/api/auth/context')) return route.fulfill({ json: session })
      if (route.request().url().includes('/command-receipts?')) return route.fulfill({ status: 404, json: { error: { code: 'COMMAND_RECEIPT_NOT_FOUND', message: 'synthetic missing' } } })
      if (route.request().url().endsWith('/inpatient/catalog')) return route.fulfill({ json: {
        wards: [{ id: 'ward-general', name: '内科病区', organizationId: 'organization-inpatient-medicine' }], beds: [],
      } })
      if (route.request().url().endsWith('/inpatient/referrals')) {
        submitted.push({ input: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] })
        if (submitted.length === 1) return route.abort('failed')
        return route.fulfill({ json: { auditId: 'synthetic-audit', requestId: 'synthetic-request', effects: [], warnings: [], data: {
          referral: { id: 'synthetic-referral', patientId: 'synthetic-patient', patientName: '合成患者', patientVersion: '1',
            encounterId: 'synthetic-encounter', wardId: 'ward-general', reason: '持续发热需住院观察', status: 'issued', issuedAt: '2026-08-24T09:00:00+08:00' },
        } } })
      }
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' })
    })
    await page.goto('http://localhost/')
    const react = version === '18' ? 'react18' : 'react'
    const reactDom = version === '18' ? 'react-dom18' : 'react-dom'
    const result = await build({ configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic', jsxDev: false },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      resolve: { alias: [
        { find: /^react$/, replacement: require.resolve(react) },
        { find: 'react/jsx-runtime', replacement: require.resolve(`${react}/jsx-runtime`) },
        { find: 'react-dom/client', replacement: require.resolve(`${reactDom}/client`) },
        { find: /^react-dom$/, replacement: require.resolve(reactDom) },
      ] }, build: { write: false, lib: { entry: fileURLToPath(new URL('./inpatient-referral.browser.fixture.tsx', import.meta.url)),
        formats: ['iife'], name: 'InpatientReferral' } } })
    const output = (Array.isArray(result) ? result : [result]).flatMap(result => 'output' in result ? result.output : [])
    const script = output.find(item => item.type === 'chunk')
    if (script?.type !== 'chunk') throw new Error('Missing inpatient referral fixture')
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setContent(`<!doctype html><html><head><style>${await buildSurfaceStyles()}</style></head><body><script>${script.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    await page.getByRole('button', { name: '开具住院证', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '开具住院证', exact: true })
    await expect(dialog).toBeVisible()
    expect(await dialog.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
    await dialog.getByLabel('收治病区').click()
    await page.getByRole('option', { name: '内科病区', exact: true }).click()
    await dialog.getByLabel('住院原因').fill('持续发热需住院观察')
    await dialog.getByRole('button', { name: '确认开具住院证', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('无法连接科灵脉智服务，请检查网络连接后重试。')
    await expect(dialog.getByLabel('住院原因')).toBeDisabled()
    await dialog.getByRole('button', { name: '恢复原住院操作', exact: true }).click()
    await expect(dialog.getByRole('status')).toContainText('住院证已开具')
    expect(submitted).toHaveLength(2)
    expect(submitted[0]?.key).toBeTruthy()
    expect(submitted[1]).toEqual(submitted[0])
    expect(submitted[0]?.input).toEqual({ input: { encounterId: 'synthetic-encounter', encounterVersion: '3', wardId: 'ward-general', reason: '持续发热需住院观察' } })
    expect(errors).toEqual([])
  })
}
