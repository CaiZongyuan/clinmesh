import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, type Page } from '@playwright/test'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)
const artifacts = new Map<string, { script: string; styles: string }>()
export async function buildNonDoctorCard(version: string) {
  const previous = artifacts.get(version)
  if (previous) return previous
  const react = version === '18' ? 'react18' : 'react'
  const reactDom = version === '18' ? 'react-dom18' : 'react-dom'
  const result = await build({
    configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic', jsxDev: false },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    resolve: { alias: [
      { find: /^react$/, replacement: require.resolve(react) },
      { find: 'react/jsx-runtime', replacement: require.resolve(`${react}/jsx-runtime`) },
      { find: 'react-dom/client', replacement: require.resolve(`${reactDom}/client`) },
      { find: /^react-dom$/, replacement: require.resolve(reactDom) },
    ] },
    build: { write: false, lib: { entry: fileURLToPath(new URL('./non-doctor-card.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'NonDoctorCardContract' } },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => 'output' in output ? output.output : [])
  const script = outputs.find(output => output.type === 'chunk')
  if (script?.type !== 'chunk') throw new Error('Missing non-doctor fixture')
  const artifact = { script: script.code, styles: await buildSurfaceStyles() }
  artifacts.set(version, artifact)
  return artifact
}

export async function mountNonDoctorCard(page: Page, version: string, server: { origin: string; password: string }, role: 'registrar' | 'cashier' | 'pharmacist', inputs: Record<string, unknown> = {}, options: { sessionScopeProbe?: boolean } = {}) {
  const login = await page.request.post(`${server.origin}/api/auth/sign-in/email`, {
    headers: { origin: server.origin }, data: { email: `${role}@demo.clinmesh.local`, password: server.password },
  })
  expect(login.status()).toBe(200)
  await page.route(`${server.origin}/card-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
  await page.goto(`${server.origin}/card-contract`)
  const { script, styles } = await buildNonDoctorCard(version)
  await page.setContent(`<!doctype html><html><head><meta charset="UTF-8"><style>body{margin:0}</style><style>${styles}</style></head><body><script>window.nonDoctorInputs=${JSON.stringify(inputs).replaceAll('<', '\\u003c')};window.nonDoctorSessionScopeProbe=${options.sessionScopeProbe === true};${script.replaceAll('</script', '<\\/script')}</script></body></html>`)
}
