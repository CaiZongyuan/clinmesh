import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const syntheaCommit = 'd9d07a6eef91ee5144293b42ab64224d84d124f8'
const syntheaArchiveSha256 = 'e5f097863440524935e8d1e081e66aea811692a66ba450d78e78e8a728f4722b'

describe('Synthea Docker Provider contract', () => {
  it('pins immutable verified source inputs and a non-root runtime', async () => {
    const dockerfile = await readFile(
      new URL('../../synthea-provider/Dockerfile', import.meta.url),
      'utf8',
    )

    expect(dockerfile).not.toMatch(/^ARG SYNTHEA_(?:COMMIT|ARCHIVE_SHA256)=/mu)
    expect(dockerfile).toContain(`synthea_commit=${syntheaCommit}`)
    expect(dockerfile).toContain(`synthea_archive_sha256=${syntheaArchiveSha256}`)
    expect(dockerfile).toContain('COPY --from=build --chown=10001:10001 /src/synthea/LICENSE')
    expect(dockerfile).toContain('COPY --from=build --chown=10001:10001 /src/synthea/NOTICE')
    expect(dockerfile).toContain('USER 10001:10001')
    expect(dockerfile).toContain('HEALTHCHECK')
  })
})
