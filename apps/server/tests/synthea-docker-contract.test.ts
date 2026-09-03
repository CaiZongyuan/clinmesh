import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const syntheaCommit = 'd9d07a6eef91ee5144293b42ab64224d84d124f8'
const syntheaArchiveSha256 = 'e5f097863440524935e8d1e081e66aea811692a66ba450d78e78e8a728f4722b'
const cnHealthCommit = '518ab099061408bc4a6d4c8db8693756bef2fe84'
const profileArchiveSha256 = '615f777f61d6599a597651c4517cd7690b933efe0f74beb196ee3de5dd2913eb'
const cnHealthLicenseSha256 = '0174a00c6dfceae24528f777821bb589bfdc22d184763ec756208f1cfd648dc5'
const cnHealthNoticeSha256 = '616aefa83119c799df487f300ed9f937cd14f5f67b616d02c2400783f4e7364b'

describe('Synthea Docker Provider contract', () => {
  it('pins immutable verified source inputs and a non-root runtime', async () => {
    const dockerfile = await readFile(
      new URL('../../synthea-provider/Dockerfile', import.meta.url),
      'utf8',
    )

    expect(dockerfile).not.toMatch(/^ARG SYNTHEA_(?:COMMIT|ARCHIVE_SHA256)=/mu)
    expect(dockerfile).toContain(`synthea_commit=${syntheaCommit}`)
    expect(dockerfile).toContain(`synthea_archive_sha256=${syntheaArchiveSha256}`)
    expect(dockerfile).toContain(`cn_health_commit=${cnHealthCommit}`)
    expect(dockerfile).toContain(`profile_archive_sha256=${profileArchiveSha256}`)
    expect(dockerfile).toContain(`cn_health_license_sha256=${cnHealthLicenseSha256}`)
    expect(dockerfile).toContain(`cn_health_notice_sha256=${cnHealthNoticeSha256}`)
    expect(dockerfile).toContain('/releases/download/synthea-cn-2026-08-29.r4-preview.1/')
    expect(dockerfile).toContain('synthea-cn-profile.tar.gz')
    expect(dockerfile).toContain('COPY --from=build --chown=10001:10001 /src/synthea/LICENSE')
    expect(dockerfile).toContain('COPY --from=build --chown=10001:10001 /src/synthea/NOTICE')
    expect(dockerfile).toContain('COPY --from=build --chown=10001:10001 /tmp/synthea-profile')
    expect(dockerfile).toContain('/opt/cn-health/synthea-profile')
    expect(dockerfile).toContain('/opt/licenses/CN-HEALTH-DATA-LICENSE')
    expect(dockerfile).toContain('/opt/licenses/CN-HEALTH-DATA-NOTICE')
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
    expect(providerSource).toContain('catch (LocalizationException error)')
    expect(providerSource).toContain('validateTranslationWarning(')
    expect(providerSource).toContain('metadata.add("translationWarnings"')
    expect(providerSource).toContain('new GsonBuilder().serializeNulls().create()')
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
    expect(compose).toContain('CN_HEALTH_SYNTHEA_EXPECTED_CATALOG_SHA256')
    expect(compose).toContain('d7a25fc414d4008cf59145fd8fc3448556635dd2d5ab8e1e7974bc236f825811')
    expect(compose).toContain('condition: service_healthy')
    const cpuLimits = compose.match(/^    cpus: /gmu) ?? []
    const memoryLimits = compose.match(/^    mem_limit: /gmu) ?? []
    expect(cpuLimits).toHaveLength(2)
    expect(memoryLimits).toHaveLength(2)
  })

  it('publishes a verified multi-platform Provider image', async () => {
    const workflow = await readFile(
      new URL('../../../.github/workflows/synthea-provider.yml', import.meta.url),
      'utf8',
    )

    expect(workflow).toContain('ghcr.io/caizongyuan/clinmesh-synthea-provider')
    expect(workflow).toContain('packages: write')
    expect(workflow).toContain('linux/amd64,linux/arm64')
    expect(workflow).toContain(
      'ghcr.io/caizongyuan/cn-health-synthea-localizer@sha256:8b716811d6912b4502168bd23e2cf5f8c25b2f7dcc64caae6706eb1b45262448',
    )
    expect(workflow).toContain('ProviderServer --smoke')
    expect(workflow).toContain('push: true')
    expect(workflow).toContain('sbom: true')
    expect(workflow).toContain('attest-build-provenance')
  })
})
