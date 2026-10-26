import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'vite'
import { expect, it } from 'vitest'
import { createDrgReferenceFixture } from './fixtures/drg-reference.ts'

it('runs the production DRG installer without invoking another bundled CLI and reuses its inventory without writing', async () => {
  const packageRoot = resolve(import.meta.dirname, '..')
  const temporaryParent = join(packageRoot, '.data')
  await mkdir(temporaryParent, { recursive: true })
  const directory = await mkdtemp(join(temporaryParent, 'drg-bundle-test-'))
  try {
    const fixture = await createDrgReferenceFixture(directory)
    const outputDirectory = join(directory, 'dist')
    await build({
      root: packageRoot,
      configFile: join(packageRoot, 'vite.config.ts'),
      logLevel: 'silent',
      build: { outDir: outputDirectory },
      plugins: [{
        name: 'verify-drg-entry',
        configResolved(config) {
          const input = config.build.rollupOptions.input
          if (input === undefined || typeof input === 'string' || Array.isArray(input)
            || input['drg-reference-sync'] === undefined) throw new Error('Production DRG installer entry is missing')
          config.build.rollupOptions.input = { 'drg-reference-sync': input['drg-reference-sync'] }
        },
      }],
    })
    const databasePath = join(directory, 'reference.sqlite')
    const args = [join(outputDirectory, 'drg-reference-sync.js'), '--database', databasePath,
      '--manifest', fixture.lockPath, '--input-root', directory]
    const first = spawnSync(process.execPath, args, { cwd: packageRoot, encoding: 'utf8' })
    expect(first.status, first.stderr).toBe(0)
    expect(JSON.parse(first.stdout)).toMatchObject({ inventoryId: 'synthetic-inventory-v1', created: true })
    const before = await readFile(databasePath)

    const repeat = spawnSync(process.execPath, args, { cwd: packageRoot, encoding: 'utf8' })
    expect(repeat.status, repeat.stderr).toBe(0)
    expect(JSON.parse(repeat.stdout)).toMatchObject({ inventoryId: 'synthetic-inventory-v1', created: false })
    expect(await readFile(databasePath)).toEqual(before)

  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
