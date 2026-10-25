import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { offlineReferenceLockSchema } from '@clinmesh/contracts/reference-data'
import { openCompactStorage, type CompactIndex } from '../src/infrastructure/reference-data/drg-compact-storage.ts'
import { createDrgReferenceFixture, sha256 } from './fixtures/drg-reference.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'clinmesh-compact-reader-'))
  roots.push(root)
  const source = await createDrgReferenceFixture(root)
  const lock = offlineReferenceLockSchema.parse(JSON.parse(source.lockBytes))
  const objectPath = `${source.packageRoot}/services/records.jsonl`
  const manifestPath = '.data/drg-compact/index.json'
  await mkdir(join(root, '.data/drg-compact'), { recursive: true })
  const index: CompactIndex = { schemaVersion: 'clinmesh.drg-compact.v1',
    files: {
      [objectPath]: { sha256: sha256(source.records), sizeBytes: Buffer.byteLength(source.records), recipe: { kind: 'file', path: objectPath } },
      [`${source.packageRoot}/services/alias.jsonl`]: { sha256: sha256(source.records), sizeBytes: Buffer.byteLength(source.records), recipe: { kind: 'file', path: objectPath } },
    },
    objects: { [objectPath]: { sha256: sha256(source.records), sizeBytes: Buffer.byteLength(source.records) } },
  }
  async function save() {
    const bytes = `${JSON.stringify(index)}\n`
    await writeFile(join(root, manifestPath), bytes)
    lock.storage = { format: 'clinmesh.drg-compact.v1', manifest: { path: manifestPath, sha256: sha256(bytes) } }
  }
  await save()
  return { root, source, lock, index, save, objectPath }
}

it('reads both logical identities from one verified object without creating an alias', async () => {
  const input = await fixture()
  const storage = await openCompactStorage(input.lock, input.root)
  expect((await storage.read(input.objectPath)).toString()).toBe(input.source.records)
  expect((await storage.read(`${input.source.packageRoot}/services/alias.jsonl`)).toString()).toBe(input.source.records)
  await expect(readFile(join(input.root, input.source.packageRoot, 'services/alias.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  await writeFile(join(input.root, input.objectPath), 'damaged')
  await expect(storage.read(input.objectPath)).rejects.toThrow(/checksum|size/)
})

it('rejects a modified index before interpreting it', async () => {
  const input = await fixture()
  await writeFile(join(input.root, input.lock.storage.manifest.path), '{}')
  await expect(openCompactStorage(input.lock, input.root)).rejects.toThrow(/checksum/)
})

it.each(['../outside', 'C:/outside', '.data/drg-compact/../outside'])('rejects escaping object path %s', async path => {
  const input = await fixture()
  input.index.files[input.objectPath]!.recipe = { kind: 'file', path }
  input.index.objects = { [path]: { sha256: sha256(input.source.records), sizeBytes: Buffer.byteLength(input.source.records) } }
  await input.save()
  await expect(openCompactStorage(input.lock, input.root)).rejects.toThrow(/path/)
})

it('rejects dangling objects and unknown logical paths', async () => {
  const input = await fixture()
  delete input.index.objects[input.objectPath]
  await input.save()
  const storage = await openCompactStorage(input.lock, input.root)
  await expect(storage.read(input.objectPath)).rejects.toThrow(/missing|unlisted/)
  await expect(storage.read('unlisted')).rejects.toThrow(/unlisted/)
})

it('rejects a derived recipe dependency cycle', async () => {
  const input = await fixture()
  input.index.files[input.objectPath]!.recipe = { kind: 'dataset-csv', source: input.objectPath }
  await input.save()
  const storage = await openCompactStorage(input.lock, input.root)
  await expect(storage.read(input.objectPath)).rejects.toThrow(/cycle/)
})

it.skipIf(process.platform === 'win32')('rejects directory links whose real target differs only in case', async () => {
  const input = await fixture()
  const parent = join(input.root, input.source.packageRoot)
  await rename(join(parent, 'services'), join(parent, 'SERVICES'))
  await symlink(join(parent, 'SERVICES'), join(parent, 'services'), 'dir')
  const storage = await openCompactStorage(input.lock, input.root)
  await expect(storage.read(input.objectPath)).rejects.toThrow(/without links/)
})
