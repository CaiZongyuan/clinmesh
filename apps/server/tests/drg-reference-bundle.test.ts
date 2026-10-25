import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'vite'
import { expect, it } from 'vitest'
import { createDrgReferenceFixture } from './fixtures/drg-reference.ts'
import { createCompactDrgReference } from '../src/drg-reference-compact.ts'

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

    const compact = await createCompactDrgReference({ sourceRoot: directory, sourceLockPath: fixture.lockPath,
      outputDirectory: join(directory, 'compact'), inventoryId: 'synthetic-compact-bundle-v1', createdAt: '2026-10-25T00:00:00.000Z' })
    const compactDatabase = join(directory, 'compact-reference.sqlite')
    const compactArgs = [join(outputDirectory, 'drg-reference-sync.js'), '--database', compactDatabase,
      '--manifest', compact.lockPath, '--input-root', directory]
    const compactFirst = spawnSync(process.execPath, compactArgs, { cwd: packageRoot, encoding: 'utf8' })
    expect(compactFirst.status, compactFirst.stderr).toBe(0)
    expect(JSON.parse(compactFirst.stdout)).toMatchObject({ inventoryId: 'synthetic-compact-bundle-v1', source: 'local', created: true })
    const compactBefore = await readFile(compactDatabase)
    const compactRepeat = spawnSync(process.execPath, compactArgs, { cwd: packageRoot, encoding: 'utf8' })
    expect(compactRepeat.status, compactRepeat.stderr).toBe(0)
    expect(JSON.parse(compactRepeat.stdout)).toMatchObject({ source: 'installed', created: false })
    expect(await readFile(compactDatabase)).toEqual(compactBefore)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
