import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { pathologyReadingMessageSchema, readingAuthorizationInputSchema, readingCapabilitiesSchema, readingOperationSchema } from '../src/pathology-reading.ts'

// 与 PathJX contracts/fixtures/semantic 下同名文件保持逐字一致，由两个消费者运行同一正反例。
const schemas = { ClinMeshAuthorizationEvent: readingAuthorizationInputSchema, ClinMeshViewerMessage: pathologyReadingMessageSchema,
  ClinMeshCapabilities: readingCapabilitiesSchema, ClinMeshReceipt: readingOperationSchema }
const root = fileURLToPath(new URL('./fixtures/pathology-reading/', import.meta.url))
for (const [name, schema] of Object.entries(schemas)) for (const file of readdirSync(join(root, name))) {
  it(`按共享 PathJX 样例验证 ${name}/${file}`, () => {
    const fixture = z.object({ expect: z.enum(['valid', 'invalid']), value: z.unknown() }).loose()
      .parse(JSON.parse(readFileSync(join(root, name, file), 'utf8')))
    expect(schema.safeParse(fixture.value).success).toBe(fixture.expect === 'valid')
  })
}
