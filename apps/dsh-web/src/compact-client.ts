import { join } from 'node:path'
import ts from 'typescript'

const prefix = `window.__ModuleLoader__.load({
  id: "@clinmesh/dsh-web",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
`
const suffix = `    return module.exports;
  },
});
`

/** Keep the host wrapper and names used by verify-artifact; compact only bundled code. */
export async function compactLazyCjsClient(client: string): Promise<string> {
  const parsed = ts.createSourceFile('client.js', client, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const statement = parsed.statements[0]
  const call = statement && ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
    ? statement.expression : undefined
  const definition = call?.arguments[0]
  const factory = definition && ts.isObjectLiteralExpression(definition) ? definition.properties[1] : undefined
  if (!client.startsWith(prefix) || !client.endsWith(suffix) || parsed.statements.length !== 1
    || call?.expression.getText(parsed) !== 'window.__ModuleLoader__.load' || call.arguments.length !== 1
    || !definition || !ts.isObjectLiteralExpression(definition) || definition.properties.length !== 2
    || !factory || !ts.isPropertyAssignment(factory) || factory.name.getText(parsed) !== 'factory'
    || !ts.isArrowFunction(factory.initializer) || !ts.isBlock(factory.initializer.body)) {
    throw new Error('Unexpected ClinMesh DSH lazy-CJS wrapper; rebuild before compacting')
  }
  const body = client.slice(prefix.length, -suffix.length)
  const result = await Bun.build({
    entrypoints: ['clinmesh:compact-client'],
    target: 'browser', format: 'cjs', external: ['*'],
    minify: { whitespace: true, syntax: true, identifiers: false },
    treeShaking: false,
    plugins: [{ name: 'clinmesh-generated-client', setup(build) {
      build.onResolve({ filter: /^clinmesh:compact-client$/ }, () => ({ path: 'client.js', namespace: 'clinmesh-generated-client' }))
      build.onLoad({ filter: /.*/, namespace: 'clinmesh-generated-client' }, () => ({ contents: body, loader: 'js' }))
    } }],
  })
  if (!result.success) throw new AggregateError(result.logs, 'Unable to compact the generated DSH client')
  const output = result.outputs[0]
  if (output === undefined || result.outputs.length !== 1) throw new Error('Expected one compacted DSH client body')
  return prefix + (await output.text()).trimEnd() + '\n' + suffix
}

if (import.meta.main) {
  const path = join(import.meta.dir, '..', 'lib', 'client.js')
  const original = await Bun.file(path).text()
  const compacted = await compactLazyCjsClient(original)
  await Bun.write(path, compacted)
  console.info(`DSH client compaction: ${Buffer.byteLength(original)} -> ${Buffer.byteLength(compacted)} bytes`)
}
