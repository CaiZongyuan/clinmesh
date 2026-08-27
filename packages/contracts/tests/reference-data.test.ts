import { describe, expect, it } from 'vitest'
import { referenceImportManifestSchema } from '../src/reference-data.ts'

describe('Reference Data contracts', () => {
  it('requires every imported source to declare its license', () => {
    expect(referenceImportManifestSchema.safeParse({
      createdAt: '2026-08-28T00:00:00.000Z',
      releaseId: 'reference-test-v1',
      schemaVersion: '1',
      sources: [{
        acquisitionMethod: 'bundled-fixture',
        artifactPath: 'concepts.json',
        checksum: 'a'.repeat(64),
        retrievedAt: '2026-08-28T00:00:00.000Z',
        sourceId: 'synthetic-source',
        sourceUrl: 'https://example.test/reference/synthetic-source',
        upstreamVersion: 'synthetic-v1',
      }],
    }).success).toBe(false)
  })
})
