import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Synthea Docker Provider contract', () => {
  it('pins immutable verified source inputs and a non-root runtime', async () => {
    const dockerfile = await readFile(
      new URL('../../synthea-provider/Dockerfile', import.meta.url),
      'utf8',
    )

    expect(dockerfile).toContain(
      'FROM --platform=$BUILDPLATFORM eclipse-temurin:17-jdk-jammy AS build',
    )
    expect(dockerfile).not.toMatch(/^ARG SYNTHEA_(?:COMMIT|ARCHIVE_SHA256)=/mu)
    expect(dockerfile).toMatch(/synthea_commit=[0-9a-f]{40} \\/u)
    expect(dockerfile).toMatch(/synthea_archive_sha256=[0-9a-f]{64} \\/u)
    expect(dockerfile).toMatch(/cn_health_commit=[0-9a-f]{40} \\/u)
    expect(dockerfile).toMatch(/profile_archive_sha256=[0-9a-f]{64} \\/u)
    expect(dockerfile).toMatch(/cn_health_license_sha256=[0-9a-f]{64} \\/u)
    expect(dockerfile).toMatch(/cn_health_notice_sha256=[0-9a-f]{64} \\/u)
    expect(dockerfile).toMatch(/\/releases\/download\/synthea-cn-[^/]+\/synthea-cn-profile\.tar\.gz/u)
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

  it('runs pinned self-contained images and localizes every Bundle before returning it', async () => {
    const [dockerfile, providerSource, compose, environmentExample] = await Promise.all([
      readFile(new URL('../../synthea-provider/Dockerfile', import.meta.url), 'utf8'),
      readFile(new URL('../../synthea-provider/ProviderServer.java', import.meta.url), 'utf8'),
      readFile(new URL('../../../compose.synthea-provider.yaml', import.meta.url), 'utf8'),
      readFile(new URL('../../../.env.example', import.meta.url), 'utf8'),
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
    expect(compose).toMatch(
      /image: ghcr\.io\/caizongyuan\/cn-health-synthea-localizer@sha256:[0-9a-f]{64}/u,
    )
    expect(compose).toMatch(
      /image: ghcr\.io\/caizongyuan\/clinmesh-synthea-provider@sha256:[0-9a-f]{64}/u,
    )
    expect(compose).not.toContain('build:')
    expect(compose).not.toContain('volumes:')
    expect(compose).not.toContain('CN_HEALTH_DATA_')
    expect(compose).not.toContain('CN_HEALTH_SYNTHEA_')
    expect(environmentExample).not.toContain('CN_HEALTH_DATA_')
    expect(environmentExample).toContain('CLINMESH_SYNTHEA_PROVIDER_URL=http://127.0.0.1:51878')
    expect(environmentExample).toContain('CLINMESH_SYNTHEA_PROVIDER_PORT=51878')
    expect(compose).toContain('condition: service_healthy')
    const cpuLimits = compose.match(/^    cpus: /gmu) ?? []
    const memoryLimits = compose.match(/^    mem_limit: /gmu) ?? []
    expect(cpuLimits).toHaveLength(2)
    expect(memoryLimits).toHaveLength(2)
  })

  it('publishes the tested native-amd64 Provider image with attestations', async () => {
    const workflow = await readFile(
      new URL('../../../.github/workflows/synthea-provider.yml', import.meta.url),
      'utf8',
    )

    expect(workflow).toContain('ghcr.io/caizongyuan/clinmesh-synthea-provider')
    expect(workflow).toContain('packages: write')
    expect(workflow).toContain('platforms: linux/amd64')
    expect(workflow).not.toContain('linux/arm64')
    expect(workflow).toContain('os: [ubuntu-latest, windows-latest]')
    expect(workflow).toContain('vitest run scripts/synthea-runtime.spec.ts')
    expect(workflow).toContain('compose.synthea-provider.yaml config --images')
    expect(workflow).toContain('ProviderServer --smoke')
    expect(workflow).toContain('docker save clinmesh-synthea-provider:test')
    expect(workflow).toContain('docker load --input')
    expect(workflow).toContain('docker push "$image_tag"')
    expect(workflow.match(/docker\/build-push-action@v7/gu)).toHaveLength(1)
    expect(workflow).toContain('attest-sbom')
    expect(workflow).toContain('attest-build-provenance')
  })
})
