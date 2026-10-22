import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { expect, test } from 'vitest'

test('compacts the lazy client while preserving loader, literal and external module semantics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-dsh-compact-'))
  try {
    const path = join(directory, 'client.js')
    const source = `window.__ModuleLoader__.load({
  id: "@clinmesh/dsh-web",
  factory: (require) => {
    /*! @license Synthetic fixture MIT */
    // ${'Ordinary build comment. '.repeat(100)}
    var module = { exports: {} };
    var exports = module.exports;
    const react = require("react");
    function buildSurfaceAgentTools() {
      return [react.version, \`line one
    line two\`, /[ /]+/.test(" / ")];
    }
    exports.buildSurfaceAgentTools = buildSurfaceAgentTools;
    return module.exports;
  },
});
`
    await writeFile(path, source)
    execFileSync('bun', [fileURLToPath(new URL('./compact-artifact.ts', import.meta.url)), path])
    const compact = await readFile(path, 'utf8')
    expect(Buffer.byteLength(compact)).toBeLessThan(Buffer.byteLength(source) / 2)
    expect(compact).toContain('/*! @license Synthetic fixture MIT */')
    expect(compact).toContain('function buildSurfaceAgentTools(')
    expect(compact).toContain('require("react")')
    expect(compact).toMatch(/^window\.__ModuleLoader__\.load\(\{id:"@clinmesh\/dsh-web",factory:\(require\)=>\{/)
    const evaluate = (script: string) => {
      let factory: ((require: (name: string) => unknown) => { buildSurfaceAgentTools: () => unknown }) | undefined
      let requires = 0
      runInNewContext(script, { window: { __ModuleLoader__: { load: (module: { id: string; factory: typeof factory }) => {
        expect(module.id).toBe('@clinmesh/dsh-web')
        factory = module.factory
      } } } })
      expect(requires).toBe(0)
      if (factory === undefined) throw new Error('Missing lazy factory')
      const exported = factory(name => { expect(name).toBe('react'); requires++; return { version: 'host-react' } })
      expect(requires).toBe(1)
      return JSON.stringify(exported.buildSurfaceAgentTools())
    }
    expect(evaluate(compact)).toBe(evaluate(source))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
