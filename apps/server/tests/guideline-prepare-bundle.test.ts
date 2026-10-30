import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'vite'
import { expect, it } from 'vitest'
import { GuidelineCorpus } from '../src/infrastructure/sqlite/guideline-corpus.ts'
import { createGuidelineReleaseFixture } from './fixtures/guideline-release.ts'

it('runs the production guideline entry and reuses the prepared corpus offline without writing', async () => {
  const packageRoot = resolve(import.meta.dirname, '..')
  const temporaryParent = join(packageRoot, '.data')
  await mkdir(temporaryParent, { recursive: true })
  const directory = await mkdtemp(join(temporaryParent, 'guideline-bundle-test-'))
  try {
    const fixture = await createGuidelineReleaseFixture(directory)
    const outputDirectory = join(directory, 'dist')
    await build({
      root: packageRoot,
      configFile: join(packageRoot, 'vite.config.ts'),
      logLevel: 'silent',
      build: { outDir: outputDirectory },
      plugins: [{
        name: 'verify-guideline-entries',
        configResolved(config) {
          const input = config.build.rollupOptions.input
          if (input === undefined || typeof input === 'string' || Array.isArray(input)
            || input['guideline-prepare'] === undefined || input['guideline-package'] === undefined) {
            throw new Error('Production guideline entries are missing')
          }
          config.build.rollupOptions.input = {
            'guideline-prepare': input['guideline-prepare'],
            'guideline-package': input['guideline-package'],
          }
        },
      }],
    })
    const databasePath = join(directory, 'guidelines.sqlite')
    const args = [join(outputDirectory, 'guideline-prepare.js'), '--database', databasePath,
      '--manifest', fixture.lockPath, '--input-root', fixture.inputRoot]
    const options = { cwd: packageRoot, encoding: 'utf8' as const,
      env: { ...process.env, CLINMESH_GUIDELINE_DEPLOYMENT_POLICY: 'internal-testing' } }
    const first = spawnSync(process.execPath, args, options)
    expect(first.status, first.stderr).toBe(0)
    expect(JSON.parse(first.stdout)).toMatchObject({ releaseId: 'synthetic-guidelines-v1', created: true,
      searchableSourceCount: 1, searchablePassageCount: 1 })
    const before = await readFile(databasePath)

    const repeat = spawnSync(process.execPath, args, options)
    expect(repeat.status, repeat.stderr).toBe(0)
    expect(JSON.parse(repeat.stdout)).toMatchObject({ created: false, searchableSourceCount: 1 })
    expect(await readFile(databasePath)).toEqual(before)

    const check = spawnSync(process.execPath, [...args, '--check'], options)
    expect(check.status, check.stderr).toBe(0)
    expect(JSON.parse(check.stdout)).toMatchObject({ created: false, searchableSourceCount: 1 })
    expect(await readFile(databasePath)).toEqual(before)

    const corpus = new GuidelineCorpus({ databasePath, readOnly: true, deploymentPolicy: 'internal-testing' })
    try {
      expect(corpus.search('糖尿病').guidelines).toMatchObject([{ title: '合成免费糖尿病指南', locator: '合成第3节第1段' }])
    } finally { corpus.close() }

    const writer = new GuidelineCorpus({ databasePath })
    try { writer.importDocument({ source: { ...writer.sources()[0]!.source, status: 'withdrawn' }, passages: [] }) }
    finally { writer.close() }
    const restore = spawnSync(process.execPath, [...args, '--restore-source', fixture.source.id, '--restore-source', fixture.source.id], options)
    expect(restore.status, restore.stderr).toBe(0)
    expect(JSON.parse(restore.stdout)).toMatchObject({ created: true, searchableSourceCount: 1 })
    const restored = new GuidelineCorpus({ databasePath, readOnly: true, deploymentPolicy: 'internal-testing' })
    try { expect(restored.search('糖尿病').guidelines).toHaveLength(1) } finally { restored.close() }
    const readOnlyRestore = spawnSync(process.execPath, [...args, '--check', '--restore-source', fixture.source.id], options)
    expect(readOnlyRestore.status).not.toBe(0)
    expect(readOnlyRestore.stderr).toContain('cannot be combined with read-only checking')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
