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
if (clientFile.size > 4_000_000) throw new Error(`DSH client exceeds size budget: ${clientFile.size}`)

const allowedRequires = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'dsh-react-surface/client',
])
const requires = Array.from(client.matchAll(/require\(["']([^"']+)["']\)/g))
  .flatMap(match => match[1] === undefined ? [] : [match[1]])
const unsupported = requires.filter(specifier => !allowedRequires.has(specifier))
if (unsupported.length > 0) throw new Error(`Unsupported DSH client modules: ${unsupported.join(', ')}`)
