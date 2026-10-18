import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { fileSha256, preparedManifestSchema } from '../../apps/server/src/infrastructure/reference-data/prepared-catalogues.ts'

// 只复制已验证的规范化输入；不执行资料包中的任何脚本。
const sourceIndex = process.argv.indexOf('--source')
if (sourceIndex < 0 || process.argv[sourceIndex + 1] === undefined) throw new Error('用法：pnpm reference:prepare --source <r3 清洗目录>')
const source = resolve(process.argv[sourceIndex + 1]!)
const output = resolve('.data/reference-prepared/r3')
const checksumsText = await readFile(join(source, 'checksums.json'), 'utf8')
const checksums = z.array(z.object({ path: z.string(), sha256: z.string() }).loose()).parse(JSON.parse(checksumsText))
const candidate = z.object({ releaseId: z.string(), sources: z.record(z.string(), z.json()) }).loose().parse(JSON.parse(await readFile(join(source, 'release-candidate.json'), 'utf8')))
if (candidate.releaseId !== 'clinmesh-five-catalogues-2026-10-16.r3') throw new Error('仅支持已核验 r3 输入')
const files = []
for (const dataset of ['icd10', 'icd9', 'services', 'drugs', 'drg', 'prices', 'assessment']) {
  const names = (await readdir(join(source, 'standardized', dataset))).filter(name => name.endsWith('.jsonl')).sort()
  await mkdir(join(output, dataset), { recursive: true })
  for (const name of names) {
    const relative = `standardized/${dataset}/${name}`
    const expected = checksums.find(entry => entry.path.replaceAll('\\', '/') === relative)
    const actual = await fileSha256(join(source, relative))
    if (expected?.sha256 !== actual) throw new Error(`清洗档案校验失败：${relative}`)
    const path = `${dataset}/${name}`
    await copyFile(join(source, relative), join(output, path))
    let rows = 0
    for await (const line of createInterface({ input: createReadStream(join(output, path)), crlfDelay: Infinity })) if (line.trim()) rows++
    const metadata = candidate.sources[dataset]
    const sourceVersion = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata) && typeof metadata.version === 'string'
      ? metadata.version : candidate.releaseId
    files.push({ path, dataset, table: name.slice(0, -6), sha256: actual, rows, sourceVersion })
  }
}
const manifest = preparedManifestSchema.parse({ schemaVersion: 'clinmesh.prepared-catalogues.v1',
  releaseId: candidate.releaseId, createdAt: '2026-10-18T00:00:00.000Z',
  archiveChecksumsSha256: createHash('sha256').update(checksumsText).digest('hex'), sources: candidate.sources, files })
const text = `${JSON.stringify(manifest, null, 2)}\n`
await writeFile(join(output, 'manifest.json'), text)
console.info(JSON.stringify({ releaseId: manifest.releaseId, manifestPath: '.data/reference-prepared/r3/manifest.json', manifestSha256: createHash('sha256').update(text).digest('hex'), rows: files.reduce((sum, file) => sum + file.rows, 0) }))
