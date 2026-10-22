import { join } from 'node:path'

const clientPath = process.argv[2] ?? join(import.meta.dir, '..', 'lib', 'client.js')
const client = await Bun.file(clientPath).text()
// Keep the upstream lazy factory, names and external requires intact. Only
// compact its printed whitespace/comments; the artifact verifier runs next.
const transpiler = new Bun.Transpiler({
  loader: 'js',
  target: 'browser',
  minifyWhitespace: true,
  deadCodeElimination: false,
  treeShaking: false,
  inline: false,
  trimUnusedImports: false,
})
await Bun.write(clientPath, `${transpiler.transformSync(client).trimEnd()}\n`)
