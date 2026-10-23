import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const packageDirectory = fileURLToPath(new URL('..', import.meta.url))
function compact(source: string) {
  return execFileSync('bun', ['--eval', `
    import { compactLazyCjsClient } from './src/compact-client.ts';
    process.stdout.write(compactLazyCjsClient(JSON.parse(await Bun.stdin.text())));
  `], { cwd: packageDirectory, input: JSON.stringify(source), encoding: 'utf8', stdio: 'pipe' })
}

const artifact = `window.__ModuleLoader__.load({
  id: "@clinmesh/dsh-web",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    // A dependency must stay lazy and use the host require.
    var react = require("react");
    var runtime = require("dsh-react-surface/client");
    function describe() {
      return \`description line one
    description line two with \${react.name}\`;
    }
    module.exports = {
      description: describe(),
      literal: "// apparent comment and <script> text",
      pattern: /\\s+/, runtime
    };
    return module.exports;
  },
});
`

describe('DSH lazy-CJS artifact compression', () => {
  it('preserves lazy host imports and multiline strings while reducing bytes', () => {
    const result = compact(artifact)
    expect(Buffer.byteLength(result)).toBeLessThan(Buffer.byteLength(artifact))
    const required: string[] = []
    let factory: ((require: (name: string) => unknown) => unknown) | undefined
    runInNewContext(result, { window: { __ModuleLoader__: { load: (definition: { id: string; factory: typeof factory }) => {
      expect(definition.id).toBe('@clinmesh/dsh-web')
      factory = definition.factory
    } } } })
    expect(required).toEqual([])
    expect(factory).toBeDefined()
    const exports = factory!(name => { required.push(name); return { name } })
    expect(required).toEqual(['react', 'dsh-react-surface/client'])
    expect(exports).toMatchObject({
      description: 'description line one\n    description line two with react',
      literal: '// apparent comment and <script> text', runtime: { name: 'dsh-react-surface/client' },
    })
    expect(exports).toMatchObject({ pattern: /\s+/ })
    expect(result.startsWith('window.__ModuleLoader__.load({\n  id: "@clinmesh/dsh-web"')).toBe(true)
  })

  it('is stable when the same artifact is compacted again', () => {
    const once = compact(artifact)
    expect(compact(once)).toBe(once)
  })

  it('rejects an unexpected wrapper instead of rewriting it', () => {
    expect(() => compact(artifact.replace('"@clinmesh/dsh-web"', '"other/client"'))).toThrow()
    expect(() => compact(artifact + 'window.unexpected = true;\n')).toThrow()
  })
})
