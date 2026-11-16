import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const packageDirectory = fileURLToPath(new URL('..', import.meta.url))
function compact(source: string) {
  return execFileSync('bun', ['--eval', `
    import { compactLazyCjsClient } from './src/compact-client.ts';
    process.stdout.write(await compactLazyCjsClient(JSON.parse(await Bun.stdin.text())));
  `], { cwd: packageDirectory, input: JSON.stringify(source), encoding: 'utf8', stdio: 'pipe' })
}

function wrap(body: string) { return `window.__ModuleLoader__.load({
  id: "@clinmesh/dsh-web",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${body}
    return module.exports;
  },
});
` }

const artifact = wrap(`
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
`)

function execute(source: string): unknown {
  let factory: (() => unknown) | undefined
  runInNewContext(source, { window: { __ModuleLoader__: { load: (definition: { factory: () => unknown }) => {
    factory = definition.factory
  } } } })
  if (!factory) throw new Error('Missing lazy factory')
  return factory()
}

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

  it('preserves evaluation order, short circuits, exceptions and finally effects', () => {
    const source = wrap(`
      const effects = [];
      const record = value => { effects.push(value); return value; };
      const object = { get value() { return record("getter"); } };
      const values = [false && record("skipped"), true || record("also skipped"),
        undefined ?? record("fallback"), object.value, record("left") + record("right")];
      try { record("try"); throw new Error("synthetic failure"); }
      catch (error) { effects.push(error.message); }
      finally { record("finally"); }
      module.exports = { effects, values };
    `)
    expect(execute(compact(source))).toEqual({
      effects: ['fallback', 'getter', 'left', 'right', 'try', 'synthetic failure', 'finally'],
      values: [false, true, 'fallback', 'getter', 'leftright'],
    })
  })

  it('preserves declared and inferred function and class names without renaming bindings', () => {
    const source = wrap(`
      function buildSurfaceAgentTools() { return "descriptor"; }
      class NamedClass {}
      const inferredFunction = function() {};
      const inferredArrow = () => {};
      const inferredClass = class {};
      const conditionalFunction = true ? function() {} : function() {};
      const commaArrow = (0, () => {});
      const conditionalClass = true ? class {} : class {};
      const object = { method() {}, anonymous: function() {}, arrow: () => {},
        get value() { return "value"; } };
      module.exports = { names: [buildSurfaceAgentTools.name, NamedClass.name, inferredFunction.name,
        inferredArrow.name, inferredClass.name, object.method.name, object.anonymous.name,
        object.arrow.name, Object.getOwnPropertyDescriptor(object, "value").get.name,
        conditionalFunction.name, commaArrow.name, conditionalClass.name],
        value: buildSurfaceAgentTools() };
    `)
    const result = compact(source)
    expect(result).toContain('function buildSurfaceAgentTools(')
    expect(execute(result)).toEqual({ names: ['buildSurfaceAgentTools', 'NamedClass', 'inferredFunction',
      'inferredArrow', 'inferredClass', 'method', 'anonymous', 'arrow', 'get value', '', '', ''], value: 'descriptor' })
  })

  it('keeps legal comments and Unicode string values', () => {
    const result = compact(wrap('/*! Synthetic dependency license. */\nmodule.exports = "合成病例 · 🏥";'))
    expect(result).toContain('/*! Synthetic dependency license. */')
    expect(execute(result)).toBe('合成病例 · 🏥')
  })

  it('preserves intrinsic literal values and locally shadowed builtin names', () => {
    const result = compact(wrap(`
      function shadowed(undefined, NaN, Infinity) { return [undefined, NaN, Infinity]; }
      module.exports = { literals: [undefined, NaN, Infinity, -Infinity, -0],
        local: shadowed("local undefined", "local NaN", "local Infinity"),
        keys: Object.keys({ true: "true key", false: "false key" }) };
    `))
    expect(execute(result)).toEqual({ literals: [undefined, NaN, Infinity, -Infinity, -0],
      local: ['local undefined', 'local NaN', 'local Infinity'], keys: ['true', 'false'] })
  })

  it('rejects an unexpected wrapper instead of rewriting it', () => {
    expect(() => compact(artifact.replace('"@clinmesh/dsh-web"', '"other/client"'))).toThrow()
    expect(() => compact(artifact + 'window.unexpected = true;\n')).toThrow()
  })
})
