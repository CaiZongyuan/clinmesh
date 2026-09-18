import { join } from 'node:path'

const clientPath = join(import.meta.dir, '..', 'lib', 'client.js')
const clientFile = Bun.file(clientPath)
if (!(await clientFile.exists())) throw new Error('Missing ClinMesh DSH client artifact')

const client = await clientFile.text()
const expectedPrefix = 'window.__ModuleLoader__.load({\n  id: "@clinmesh/dsh-web"'
if (!client.startsWith(expectedPrefix)) throw new Error('Invalid DSH lazy-CJS wrapper')
if (/^\s*import\s/m.test(client)) throw new Error('DSH client contains an ESM import')
if (client.includes('import.meta')) throw new Error('DSH client contains import.meta in lazy-CJS')
if (client.includes('react.production.min')) throw new Error('DSH client bundled a private React runtime')
if (clientFile.size > 4_100_000) throw new Error(`DSH client exceeds size budget: ${clientFile.size}`)

const allowedRequires = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'dsh-react-surface/client',
  '@deepseek-ai/dsh-client-ui-primitives',
])
const requires = Array.from(client.matchAll(/require\(["']([^"']+)["']\)/g))
  .flatMap(match => match[1] === undefined ? [] : [match[1]])
const unsupported = requires.filter(specifier => !allowedRequires.has(specifier))
if (unsupported.length > 0) throw new Error(`Unsupported DSH client modules: ${unsupported.join(', ')}`)

// The bundle requires the vendored runtime at host runtime, and every host
// profile symlinks plugins/react-surface at the monorepo checkout, so a stale
// build of vendor/dsh-react-surface silently no-ops the layout features the
// definition declares (seen live as fullscreen ignoring fullFrameKeepDetails).
// Verify the checkout's built artifact honors every declared feature marker.
// A missing artifact means this environment never builds the vendor runtime
// (CI); the host then fails loudly on the require, so there is nothing to guard.
const surfaceRuntimeFile = Bun.file(join(
  import.meta.dir, '..', '..', '..', 'vendor', 'dsh-react-surface', 'packages', 'runtime', 'lib', 'client.js',
))
if (await surfaceRuntimeFile.exists()) {
  const surfaceRuntime = await surfaceRuntimeFile.text()
  const surfaceRuntimeMarkers = ['fullFrameKeepDetails'] as const
  const missingMarkers = surfaceRuntimeMarkers.filter(marker => !surfaceRuntime.includes(marker))
  if (missingMarkers.length > 0) {
    throw new Error(
      `Stale dsh-react-surface build: missing ${missingMarkers.join(', ')};`
      + ' run `bun run build:runtime` in vendor/dsh-react-surface, then restart the DSH host',
    )
  }
}
