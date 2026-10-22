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
export function compactLazyCjsClient(client: string): string {
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
  const transpiler = new Bun.Transpiler({
    loader: 'js', target: 'browser', minifyWhitespace: true,
    deadCodeElimination: false, inline: false, treeShaking: false,
  })
  return prefix + transpiler.transformSync(body).trimEnd() + '\n' + suffix
}

if (import.meta.main) {
  const path = join(import.meta.dir, '..', 'lib', 'client.js')
  const original = await Bun.file(path).text()
  const compacted = compactLazyCjsClient(original)
  await Bun.write(path, compacted)
  console.info(`DSH client whitespace: ${Buffer.byteLength(original)} -> ${Buffer.byteLength(compacted)} bytes`)
}
