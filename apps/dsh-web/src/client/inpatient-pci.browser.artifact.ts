import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)

export async function buildInpatientPciFixture(version: string) {
  const react = version === '18' ? 'react18' : 'react', reactDom = version === '18' ? 'react-dom18' : 'react-dom'
  const result = await build({ configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic', jsxDev: false }, define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    resolve: { alias: [{ find: /^react$/, replacement: require.resolve(react) }, { find: 'react/jsx-runtime', replacement: require.resolve(`${react}/jsx-runtime`) }, { find: 'react-dom/client', replacement: require.resolve(`${reactDom}/client`) }, { find: /^react-dom$/, replacement: require.resolve(reactDom) }] },
    build: { write: false, lib: { entry: fileURLToPath(new URL('./inpatient-pci.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'InpatientPci' } } })
  const chunk = (Array.isArray(result) ? result : [result]).flatMap(item => 'output' in item ? item.output : []).find(item => item.type === 'chunk')
  if (chunk?.type !== 'chunk') throw new Error('Missing inpatient PCI fixture')
  return { code: chunk.code, styles: await buildSurfaceStyles() }
}
