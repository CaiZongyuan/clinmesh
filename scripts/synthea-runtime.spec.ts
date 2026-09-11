import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  providerUrlFromEnvironment,
  runSyntheaRuntimeCommand,
  type SyntheaRuntimeDependencies,
} from './synthea-runtime.ts'

const health = {
  localization: {
    profileId: 'synthea-cn@2026-08-29.r4',
  },
  modules: ['hypertension', 'metabolic/diabetes'],
  status: 'ok',
  syntheaCommit: 'd9d07a6eef91ee5144293b42ab64224d84d124f8',
}
const removeRuntimeArguments = [
  'compose',
  '--file',
  'compose.synthea-provider.yaml',
  'rm',
  '--force',
  '--stop',
  'synthea-provider',
  'cn-health-localizer',
]

function dependencies(): SyntheaRuntimeDependencies & {
  output: string[]
  runDocker: ReturnType<typeof vi.fn>
} {
  const output: string[] = []
  return {
    fetch: vi.fn(async () => Response.json(health)),
    output,
    providerUrl: 'http://127.0.0.1:51878',
    runDocker: vi.fn(async () => undefined),
    write: message => output.push(message),
  }
}

describe('Synthea runtime command', () => {
  it('is exposed through the root package commands and regular test suite', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> }

    expect(manifest.scripts).toMatchObject({
      'synthea:doctor': 'tsx scripts/synthea-runtime.ts doctor',
      'synthea:down': 'tsx scripts/synthea-runtime.ts down',
      'synthea:up': 'tsx scripts/synthea-runtime.ts up',
    })
    expect(manifest.scripts.test).toContain('scripts/synthea-runtime.spec.ts')
  })

  it('starts only the two pinned services, waits for health, and prints the address', async () => {
    const runtime = dependencies()

    await runSyntheaRuntimeCommand('up', runtime)

    expect(runtime.runDocker).toHaveBeenCalledOnce()
    expect(runtime.runDocker).toHaveBeenCalledWith([
      'compose',
      '--file',
      'compose.synthea-provider.yaml',
      'up',
      '--detach',
      '--pull',
      'always',
      '--wait',
      '--wait-timeout',
      '180',
      'cn-health-localizer',
      'synthea-provider',
    ])
    expect(runtime.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:51878/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(runtime.output).toEqual([
      'Synthea Provider 已就绪：http://127.0.0.1:51878（Synthea d9d07a6eef91ee5144293b42ab64224d84d124f8，synthea-cn@2026-08-29.r4，2 个模块）。',
    ])
  })

  it('remains idempotent when startup is repeated', async () => {
    const runtime = dependencies()

    await runSyntheaRuntimeCommand('up', runtime)
    await runSyntheaRuntimeCommand('up', runtime)

    expect(runtime.runDocker).toHaveBeenCalledTimes(2)
    expect(runtime.runDocker.mock.calls[0]).toEqual(runtime.runDocker.mock.calls[1])
    expect(runtime.fetch).toHaveBeenCalledTimes(2)
    expect(runtime.output).toHaveLength(2)
  })

  it('stops and removes only the two Synthea runtime services', async () => {
    const runtime = dependencies()

    await runSyntheaRuntimeCommand('down', runtime)

    expect(runtime.runDocker).toHaveBeenCalledWith(removeRuntimeArguments)
    expect(runtime.runDocker.mock.calls.flat()).not.toContain('down')
    expect(runtime.runDocker.mock.calls.flat()).not.toContain('--volumes')
    expect(runtime.fetch).not.toHaveBeenCalled()
  })

  it('removes a partial runtime when startup fails', async () => {
    const runtime = dependencies()
    runtime.runDocker
      .mockRejectedValueOnce(new Error('port is already allocated'))
      .mockResolvedValueOnce(undefined)

    await expect(runSyntheaRuntimeCommand('up', runtime)).rejects.toThrow(
      'port is already allocated',
    )
    expect(runtime.runDocker).toHaveBeenCalledTimes(2)
    expect(runtime.runDocker.mock.calls[1]?.[0]).toEqual(removeRuntimeArguments)
  })

  it('removes a partial runtime when post-start health validation fails', async () => {
    const runtime = dependencies()
    runtime.fetch = vi.fn(async () => Response.json({ status: 'starting' }))

    await expect(runSyntheaRuntimeCommand('up', runtime)).rejects.toThrow(
      'Synthea Provider 健康响应无效',
    )
    expect(runtime.runDocker).toHaveBeenCalledTimes(2)
    expect(runtime.runDocker.mock.calls[1]?.[0]).toEqual(removeRuntimeArguments)
  })

  it('checks bounded health before running the full Provider smoke', async () => {
    const runtime = dependencies()

    await runSyntheaRuntimeCommand('doctor', runtime)

    expect(runtime.runDocker).toHaveBeenCalledWith([
      'compose',
      '--file',
      'compose.synthea-provider.yaml',
      'exec',
      '--no-TTY',
      'synthea-provider',
      'java',
      '-cp',
      '/opt/provider:/opt/synthea/synthea.jar',
      'ProviderServer',
      '--smoke',
    ])
    expect(runtime.output).toEqual([
      'Synthea Provider 健康：Synthea d9d07a6eef91ee5144293b42ab64224d84d124f8，synthea-cn@2026-08-29.r4，2 个模块。',
      'Synthea Provider 全模块患者 smoke 通过。',
    ])
  })

  it('rejects malformed Provider health JSON', async () => {
    const runtime = dependencies()
    runtime.fetch = vi.fn(async () => Response.json({ status: 'ok' }))

    await expect(runSyntheaRuntimeCommand('doctor', runtime)).rejects.toThrow(
      'Synthea Provider 健康响应无效',
    )
    expect(runtime.runDocker).not.toHaveBeenCalled()
  })

  it('bounds health responses even without a Content-Length header', async () => {
    const runtime = dependencies()
    let pulls = 0
    runtime.fetch = vi.fn(async () => new Response(new ReadableStream({
      pull: (controller) => {
        pulls += 1
        controller.enqueue(new Uint8Array(64 * 1024))
        if (pulls === 10) controller.close()
      },
    })))

    await expect(runSyntheaRuntimeCommand('doctor', runtime)).rejects.toThrow(
      'Synthea Provider 健康响应过大',
    )
    expect(pulls).toBeLessThan(10)
    expect(runtime.runDocker).not.toHaveBeenCalled()
  })

  it('uses the configured host port and rejects invalid values', () => {
    expect(providerUrlFromEnvironment({})).toBe('http://127.0.0.1:51878')
    expect(providerUrlFromEnvironment({ CLINMESH_SYNTHEA_PROVIDER_PORT: '51978' })).toBe(
      'http://127.0.0.1:51978',
    )
    expect(() => providerUrlFromEnvironment({
      CLINMESH_SYNTHEA_PROVIDER_PORT: 'not-a-port',
    })).toThrow('CLINMESH_SYNTHEA_PROVIDER_PORT 必须是有效端口')
  })
})
