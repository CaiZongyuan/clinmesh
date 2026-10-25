import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CompactIndex } from '../../src/infrastructure/reference-data/drg-compact-storage.ts'
import { offlineReferenceLockSchema } from '@clinmesh/contracts/reference-data'

export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

export async function writeDrgCompactFixtureIndex(root: string, paths: string[]) {
  const index: CompactIndex = { schemaVersion: 'clinmesh.drg-compact.v1', files: {}, objects: {} }
  let unpackedSizeBytes = 0
  for (const path of paths) {
    const bytes = await readFile(join(root, path))
    const metadata = { sha256: sha256(bytes), sizeBytes: bytes.length }
    index.files[path] = { ...metadata, recipe: { kind: 'file', path } }
    index.objects[path] = metadata
    unpackedSizeBytes += bytes.length
  }
  const indexPath = '.data/drg-compact/v1/index.json'
  const indexBytes = `${JSON.stringify(index)}\n`
  await mkdir(join(root, '.data/drg-compact/v1'), { recursive: true })
  await writeFile(join(root, indexPath), indexBytes)
  return { storage: { format: 'clinmesh.drg-compact.v1' as const, manifest: { path: indexPath, sha256: sha256(indexBytes) } },
    physicalPaths: [...paths, indexPath], unpackedSizeBytes: unpackedSizeBytes + Buffer.byteLength(indexBytes) }
}

export async function createDrgReferenceFixture(root: string) {
  const packageRoot = '.data/reference-prepared/r3'
  const records = '{"code":"synthetic-service","sourceUnit":"次"}\n'
  await mkdir(join(root, packageRoot, 'services'), { recursive: true })
  await writeFile(join(root, packageRoot, 'services/records.jsonl'), records)
  const manifest = JSON.stringify({
    schemaVersion: 'clinmesh.prepared-catalogues.v1', releaseId: 'synthetic-prepared-v1', sources: {},
    files: [{ path: 'services/records.jsonl', sha256: sha256(records), rows: 1, sourceVersion: 'synthetic-2026' }],
  })
  await writeFile(join(root, packageRoot, 'manifest.json'), manifest)
  const compact = await writeDrgCompactFixtureIndex(root, [`${packageRoot}/manifest.json`, `${packageRoot}/services/records.jsonl`])
  const lock = {
    schemaVersion: 'clinmesh.offline-inventory.v1', inventoryId: 'synthetic-inventory-v1',
    createdAt: '2026-10-22T00:00:00.000Z', scheme: 'CHS-DRG-3.0',
    storage: compact.storage,
    packages: [{ id: 'prepared-five-catalogues', format: 'prepared-catalogues-v1', root: packageRoot,
      version: 'synthetic-prepared-v1', manifest: { path: 'manifest.json', sha256: sha256(manifest) },
      sourceUrl: 'https://example.test/synthetic-prepared', quarantineReasons: ['usage-terms-unconfirmed'] }],
  }
  const lockPath = join(root, 'offline.lock.json')
  const lockBytes = JSON.stringify(offlineReferenceLockSchema.parse(lock))
  await writeFile(lockPath, lockBytes)
  return { lockPath, lockBytes, packageRoot, records, manifest, ...compact }
}
