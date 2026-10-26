import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('loads every public contract in a native Node ESM host', () => {
  // DSH loads contracts without the extension resolution supplied by Vitest or Bun.
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import { readFileSync } from 'node:fs';
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
    for (const entry of Object.keys(manifest.exports)) {
      await import(manifest.name + entry.slice(1));
    }
  `], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { NODE_OPTIONS: '' },
    encoding: 'utf8',
    timeout: 10_000,
  })

  expect(result.status, result.error?.message ?? result.stderr).toBe(0)
})
