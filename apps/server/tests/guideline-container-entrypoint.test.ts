import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { expect, it } from 'vitest'
import { runGuidelinePrepare } from '../src/guideline-prepare.ts'
import { createGuidelinePackage } from '../src/guideline-package.ts'
import { GuidelineCorpus } from '../src/infrastructure/sqlite/guideline-corpus.ts'
import { createGuidelineReleaseFixture, guidelineDigest } from './fixtures/guideline-release.ts'

it('容器重建复用持久卷并离线核验镜像资产，更新镜像不能解除已发布限制且支持自定义库路径', async () => {
  const packageRoot = resolve(import.meta.dirname, '..')
  const temporaryParent = join(packageRoot, '.data')
  await mkdir(temporaryParent, { recursive: true })
  const directory = await mkdtemp(join(temporaryParent, 'guideline-container-test-'))
  try {
    const fixture = await createGuidelineReleaseFixture(directory)
    const restrictions = ['withdrawn', 'superseded', 'pending', 'unreadable', 'license'] as const
    const template = structuredClone(fixture.manifest.sources[0]!)
    const extraction = JSON.parse(await readFile(join(fixture.inputRoot, 'extracted.json'), 'utf8'))
    const verification = JSON.parse(await readFile(join(fixture.inputRoot, 'verification.json'), 'utf8'))
    const pin = async (path: string, value: unknown) => {
      const bytes = JSON.stringify(value)
      await writeFile(join(fixture.inputRoot, path), bytes)
      return { path, sha256: guidelineDigest(bytes), sizeBytes: Buffer.byteLength(bytes) }
    }
    fixture.manifest.sources = await Promise.all(restrictions.map(async restriction => {
      const record = structuredClone(template)
      record.source.id = `synthetic-${restriction}`
      record.source.license.usage = 'open'
      record.extracted = await pin(`${restriction}-extracted.json`, { ...extraction, sourceId: record.source.id })
      record.verification = await pin(`${restriction}-verification.json`, { ...verification, textSha256: record.extracted.sha256 })
      return record
    }))
    await rm(join(fixture.inputRoot, 'extracted.json'))
    await rm(join(fixture.inputRoot, 'verification.json'))
    const release = async () => {
      await writeFile(join(fixture.inputRoot, 'manifest.json'), JSON.stringify(fixture.manifest))
      const lock = await createGuidelinePackage({ inputRoot: fixture.inputRoot,
        outputPath: fixture.archivePath, url: fixture.lock.artifact.url })
      await writeFile(fixture.lockPath, JSON.stringify(lock))
      return lock
    }
    let lock = await release()
    const outputDirectory = join(directory, 'dist')
    await build({ root: packageRoot, configFile: join(packageRoot, 'vite.config.ts'), logLevel: 'silent',
      build: { outDir: outputDirectory }, plugins: [{ name: 'container-guideline-entry', configResolved(config) {
        const input = config.build.rollupOptions.input
        if (input === undefined || typeof input === 'string' || Array.isArray(input) || input['guideline-prepare'] === undefined) {
          throw new Error('Production guideline entry is missing')
        }
        config.build.rollupOptions.input = { 'guideline-prepare': input['guideline-prepare'] }
      } }],
    })
    const image = async (name: string) => {
      const root = join(directory, name)
      await cp(outputDirectory, join(root, 'dist'), { recursive: true })
      // Isolate unrelated startup processes; the guideline entry and SQLite stay real.
      for (const entry of ['drg-reference-sync', 'database-cli', 'index']) {
        await writeFile(join(root, 'dist', `${entry}.js`), 'export {}\n')
      }
      await cp(join(packageRoot, 'container-entrypoint.sh'), join(root, 'container-entrypoint.sh'))
      await mkdir(join(root, 'reference-data'))
      await cp(fixture.lockPath, join(root, 'reference-data', 'guideline-release.lock.json'))
      await cp(fixture.inputRoot, join(root, 'guidelines', lock.manifest.sha256), { recursive: true })
      await runGuidelinePrepare({ databasePath: join(root, 'guidelines.sqlite'),
        installDirectory: join(root, 'guidelines'), lockPath: fixture.lockPath })
      return root
    }
    const firstImage = await image('image-first')
    const secondImage = await image('image-recreated')
    const dockerfile = await readFile(resolve(packageRoot, '../../Dockerfile'), 'utf8')
    const configuredDatabase = dockerfile.match(/^ENV CLINMESH_GUIDELINE_DATABASE_PATH=(.+)$/mu)![1]!.trim()
    const volumePath: string = JSON.parse(dockerfile.match(/^VOLUME (.+)$/mu)![1]!)[0]
    const volume = join(directory, 'persistent-volume')
    const databasePath = (root: string) => configuredDatabase.startsWith(`${volumePath}/`)
      ? join(volume, configuredDatabase.slice(volumePath.length + 1))
      : join(root, configuredDatabase.slice('/opt/clinmesh/'.length))
    const offlineGuard = join(directory, 'offline.mjs')
    await writeFile(offlineGuard, "globalThis.fetch = async () => { throw new Error('Synthetic container must stay offline') }\n")
    const start = (root: string, target = databasePath(root)) => {
      const result = spawnSync('sh', [join(root, 'container-entrypoint.sh')], { cwd: root, encoding: 'utf8',
        timeout: 15_000, env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(offlineGuard).href}`,
          CLINMESH_REFERENCE_RELEASE_ID: 'synthetic-reference', CLINMESH_REFERENCE_DATABASE_PATH: join(root, 'reference.sqlite'),
          CLINMESH_DATABASE_PATH: join(volume, 'business.sqlite'), CLINMESH_GUIDELINE_DATABASE_PATH: target,
          CLINMESH_GUIDELINE_DEPLOYMENT_POLICY: 'internal-testing' } })
      expect(result.status, `${result.error?.message ?? ''}\n${result.stderr}`).toBe(0)
      return JSON.parse(result.stdout)
    }
    const restrict = (target: string) => {
      const writer = new GuidelineCorpus({ databasePath: target })
      try {
        for (const restriction of restrictions) {
          const source = structuredClone(writer.sources().find(item => item.source.id === `synthetic-${restriction}`)!.source)
          if (restriction === 'withdrawn' || restriction === 'superseded') source.status = restriction
          else if (restriction === 'license') {
            source.license.usage = 'unverified'
            delete source.distribution
          } else source.distribution!.textStatus = restriction
          writer.importDocument({ source, passages: [] })
        }
      } finally { writer.close() }
    }
    const expectRestricted = (target: string) => {
      const reader = new GuidelineCorpus({ databasePath: target, readOnly: true, deploymentPolicy: 'internal-testing' })
      try {
        const sources = reader.sources()
        expect(sources).toHaveLength(5)
        expect(sources.find(item => item.source.id === 'synthetic-withdrawn')!.source.status).toBe('withdrawn')
        expect(sources.find(item => item.source.id === 'synthetic-superseded')!.source.status).toBe('superseded')
        expect(sources.find(item => item.source.id === 'synthetic-pending')!.source.distribution?.textStatus).toBe('pending')
        expect(sources.find(item => item.source.id === 'synthetic-unreadable')!.source.distribution?.textStatus).toBe('unreadable')
        expect(sources.find(item => item.source.id === 'synthetic-license')!.source).toMatchObject({ license: { usage: 'unverified' } })
        expect(reader.search('diabetes').guidelines).toEqual([])
      } finally { reader.close() }
    }

    expect(start(firstImage)).toMatchObject({ source: 'installed', searchableSourceCount: 5 })
    restrict(databasePath(firstImage))
    start(secondImage)
    expectRestricted(databasePath(secondImage))
    expect(databasePath(firstImage)).toBe(join(volume, 'guidelines.sqlite'))

    fixture.manifest.releaseId = 'synthetic-guidelines-v2'
    for (const record of fixture.manifest.sources) {
      const extracted = JSON.parse(await readFile(join(fixture.inputRoot, record.extracted.path), 'utf8'))
      extracted.passages.push({ locator: '合成新增段', text: 'Updated synthetic diabetes guidance for the next image.' })
      record.extracted = await pin(record.extracted.path, extracted)
      record.verification = await pin(record.verification.path, { ...verification, textSha256: record.extracted.sha256,
        locators: [...verification.locators, '合成新增段'] })
    }
    lock = await release()
    const updatedImage = await image('image-updated')
    expect(start(updatedImage)).toMatchObject({ source: 'installed', releaseId: 'synthetic-guidelines-v2',
      searchableSourceCount: 0, passageCount: 10 })
    expectRestricted(databasePath(updatedImage))

    const custom = join(volume, 'custom', 'guidelines.sqlite')
    expect(start(updatedImage, custom)).toMatchObject({ created: true, searchableSourceCount: 5 })
    restrict(custom)
    start(secondImage, custom)
    expectRestricted(custom)
    expectRestricted(databasePath(updatedImage))
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 60_000)
