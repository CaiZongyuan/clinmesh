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
    expect(dockerfile).toContain('/tmp/synthea-modules.txt')
    expect(dockerfile).toContain('/opt/synthea/modules.txt')
  })

  it('generates enough history and trims every Bundle to the exact requested dates', async () => {
    const providerSource = await readFile(
      new URL('../../synthea-provider/ProviderServer.java', import.meta.url),
      'utf8',
    )

    expect(providerSource).toContain(
      'Math.max(1, (historyDays + 364) / 365)',
    )
    expect(providerSource).toContain(
      'trimBundleToTimeRange(value.getAsJsonObject(), request)',
    )
    expect(providerSource).toContain('pruneDanglingReferences(bundle)')
  })

  it('runs the mounted cn-health profile and localizes every Bundle before returning it', async () => {
    const [dockerfile, providerSource, compose] = await Promise.all([
      readFile(new URL('../../synthea-provider/Dockerfile', import.meta.url), 'utf8'),
      readFile(new URL('../../synthea-provider/ProviderServer.java', import.meta.url), 'utf8'),
      readFile(new URL('../../../compose.synthea-provider.yaml', import.meta.url), 'utf8'),
    ])

    expect(providerSource).toContain('SYNTHEA_CLASSPATH')
    expect(providerSource).toContain('CN_HEALTH_LOCALIZER_ENDPOINT')
    expect(providerSource).toContain('command.add("-cp")')
    expect(providerSource).toContain('command.add("App")')
    expect(providerSource).toContain('command.add("中国")')
    expect(providerSource).toContain('localizeBundle(')
    expect(providerSource).toContain('metadata.add("localization"')
    expect(providerSource).toContain('body.add("modules"')
    expect(providerSource).toContain('"moduleMode":"all","modules":[]')
    expect(providerSource).not.toContain('Docker diabetes smoke')
    expect(providerSource).not.toContain('Docker hypertension smoke')
    expect(providerSource).not.toContain('command.add("Massachusetts")')
    expect(dockerfile).toContain('SYNTHEA_CLASSPATH_PATH=/opt/cn-health/synthea-profile/classpath')
    expect(dockerfile).toContain('SYNTHEA_CONFIG_PATH=/opt/cn-health/synthea-profile/synthea.properties')
    expect(dockerfile).not.toContain('COPY --from=build --chown=10001:10001 /src/provider/synthea.properties')
    expect(compose).toContain('cn-health-localizer:')
    expect(compose).toContain('Dockerfile.synthea-localizer')
    expect(compose).toContain('CN_HEALTH_DATA_RUN_AS')
    expect(compose).toContain('/data/profile:ro')
    expect(compose).toContain('/data/names:ro')
    expect(compose).toContain('/data/geography:ro')
    expect(compose).toContain('/data/population:ro')
    expect(compose).toContain('/data/translation:ro')
    expect(compose).toContain('CN_HEALTH_SYNTHEA_TRANSLATION_CATALOG_PATH')
    expect(compose).toContain('CN_HEALTH_SYNTHEA_CLINICAL_DISPLAY_PROJECTION_ID')
    expect(compose).toContain('condition: service_healthy')
    const cpuLimits = compose.match(/^    cpus: /gmu) ?? []
    const memoryLimits = compose.match(/^    mem_limit: /gmu) ?? []
    expect(cpuLimits).toHaveLength(2)
    expect(memoryLimits).toHaveLength(2)
  })
})
