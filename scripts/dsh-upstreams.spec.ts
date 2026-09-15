import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverUpstreams, publishCandidate } from './dsh-upstreams.ts'

const baseline = {
  schemaVersion: 1,
  hostDependencyLock: 'deployment/dsh/host/package-lock.json',
  profileDependencyLock: 'deployment/dsh/profile/pnpm-lock.yaml',
  components: [{
    name: '@deepseek-ai/dsh', version: '1.0.0',
    source: 'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-1.0.0.tgz',
    integrity: 'sha512-YQ==', owner: 'https://github.com/example/host', role: '宿主',
  }],
}

function release(version: string) {
  return { name: '@deepseek-ai/dsh', version, dist: {
    tarball: `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${version}.tgz`,
    integrity: 'sha512-YQ==',
  } }
}

describe('DSH 上游发现入口', () => {
  it('从所有发布版本选择最高正式版或 RC，不受 latest 或 next 指向 alpha 影响', async () => {
    const versions = ['1.0.0', '1.1.0-rc.2', '1.1.0-rc.10', '2.0.0-alpha.1']
    const result = await discoverUpstreams(baseline, async () => Response.json({
      name: '@deepseek-ai/dsh',
      'dist-tags': { latest: '1.0.0', next: '2.0.0-alpha.1' },
      versions: Object.fromEntries(versions.map(version => [version, release(version)])),
    }))
    expect(result.changes).toEqual([{
      name: '@deepseek-ai/dsh', from: '1.0.0', to: '1.1.0-rc.10',
    }])
    expect(result.target.components[0]).toMatchObject({ version: '1.1.0-rc.10' })
    expect(baseline.components[0]?.version).toBe('1.0.0')
  })

  it.each(['1.1.0-beta.1', '1.1.0-dev.1', '1.1.0-nightly.1', '1.1.0-preview.1'])('排除 %s 且无更新不建 PR', async version => {
    const candidate = await discoverUpstreams(baseline, async () => Response.json({
      name: '@deepseek-ai/dsh', versions: { '1.0.0': release('1.0.0'), [version]: release(version) },
    }))
    expect(candidate.changes).toEqual([])
    expect(await publishCandidate(candidate, { repository: 'example/repo', base: 'main', fetch: async () => { throw new Error('不应调用 GitHub') } })).toEqual({ status: 'no-update' })
  })

  it.each([
    { name: '@deepseek-ai/dsh', versions: {} },
    { name: 'wrong-package', versions: { '1.0.0': release('1.0.0') } },
    { name: '@deepseek-ai/dsh', versions: { '1.0.0': release('1.0.0'), '1.1.0': {} } },
  ])('拒绝撤销版本或非法响应，原基线不变', async response => {
    const before = structuredClone(baseline)
    await expect(discoverUpstreams(baseline, async () => Response.json(response))).rejects.toThrow()
    expect(baseline).toEqual(before)
  })

  it('网络失败不返回部分候选', async () => {
    await expect(discoverUpstreams(baseline, async () => new Response('', { status: 503 }))).rejects.toThrow('HTTP 503')
  })

  it('发行内容被替换时拒绝继续升级', async () => {
    await expect(discoverUpstreams(baseline, async () => Response.json({ name: '@deepseek-ai/dsh', versions: { '1.0.0': { ...release('1.0.0'), dist: { ...release('1.0.0').dist, integrity: 'sha512-Yg==' } } } }))).rejects.toThrow('发行内容发生变化')
  })

  it.each(['diverged', 'invalid'])('拒绝源码 %s 状态', async status => {
    const input = { ...baseline, components: [{ name: 'bridge', source: 'https://github.com/example/bridge.git', owner: 'https://github.com/example/bridge', role: '桥接', commit: 'a'.repeat(40) }] }
    const responses = [{ default_branch: 'main' }, { sha: 'b'.repeat(40) }, { status }]
    await expect(discoverUpstreams(input, async () => Response.json(responses.shift()))).rejects.toThrow('分叉或非法')
  })

  it('默认分支落后支持 commit 时保留支持提交', async () => {
    const input = { ...baseline, components: [{ name: 'bridge', source: 'https://github.com/example/bridge.git', owner: 'https://github.com/example/bridge', role: '桥接', commit: 'a'.repeat(40) }] }
    const responses = [{ default_branch: 'main' }, { sha: 'b'.repeat(40) }, { status: 'behind' }]
    expect((await discoverUpstreams(input, async () => Response.json(responses.shift()))).changes).toEqual([])
  })

  it('发现默认分支同版本的新 commit，保留维护归属', async () => {
    const commit = 'a'.repeat(40)
    const next = 'b'.repeat(40)
    const input = { ...baseline, components: [{ name: 'bridge', source: 'https://github.com/example/bridge.git', owner: 'https://github.com/example/fork', role: '桥接', commit }] }
    const responses = [{ default_branch: 'main' }, { sha: next }, { status: 'ahead' }]
    const urls: string[] = []
    const candidate = await discoverUpstreams(input, async url => { urls.push(url); return Response.json(responses.shift()) })
    expect(candidate.changes).toEqual([{ name: 'bridge', from: commit, to: next }])
    expect(candidate.target.components[0]?.owner).toBe('https://github.com/example/fork')
    expect(urls).toContain('https://api.github.com/repos/example/bridge/commits/main')
  })
})

describe('发现 CLI process 合同', () => {
  it('未知参数返回非零退出码，不写报告或访问来源', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-upstream-cli-'))
    try {
      const entry = fileURLToPath(new URL('./dsh-upstreams-cli.ts', import.meta.url))
      const loader = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href
      const result = await new Promise<{ code: number | string | undefined; stderr: string }>(resolve => {
        execFile(process.execPath, ['--import', loader, entry, '--unknown'], { cwd: directory }, (error, _stdout, stderr) => resolve({ code: error?.code, stderr }))
      })
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('用法：pnpm upstream:discover')
      await expect(access(join(directory, 'dsh-upstreams.discovery.json'))).rejects.toThrow()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})

describe('升级 PR 的 GitHub adapter 合同', () => {
  it('重复运行复用 PR，追加候选提交保留当前人工 HEAD 和非候选文件', async () => {
    const candidate = await discoverUpstreams(baseline, async () => Response.json({ name: '@deepseek-ai/dsh', versions: { '1.0.0': release('1.0.0'), '1.1.0': release('1.1.0') } }))
    const humanHead = 'c'.repeat(40)
    const treeHead = 'd'.repeat(40)
    const newHead = 'e'.repeat(40)
    let stored = ''
    let head = humanHead
    const commits: unknown[] = []
    const trees: unknown[] = []
    let prCreates = 0
    let body = ''
    const fetch = async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname.replace('/repos/example/repo/', '')
      const method = init?.method ?? 'GET'
      const payload = init?.body ? JSON.parse(String(init.body)) : undefined
      if (path === 'pulls' && method === 'GET') return Response.json(prCreates ? [{ number: 7, body, html_url: 'https://github.com/example/repo/pull/7' }] : [])
      if (path.startsWith('git/ref/')) return Response.json({ object: { sha: head } })
      if (path === 'merges') return new Response(null, { status: 204 })
      if (path.startsWith('contents/')) return stored ? Response.json({ encoding: 'base64', content: Buffer.from(stored).toString('base64') }) : new Response('', { status: 404 })
      if (path.startsWith('git/commits/') && method === 'GET') return Response.json({ tree: { sha: treeHead } })
      if (path === 'git/trees') { trees.push(payload); stored = payload.tree[0].content; return Response.json({ sha: treeHead }) }
      if (path === 'git/commits') { commits.push(payload); return Response.json({ sha: newHead }) }
      if (path.startsWith('git/refs/') && method === 'PATCH') { expect(payload.force).toBe(false); head = payload.sha; return Response.json({ object: { sha: head } }) }
      if (path === 'pulls' && method === 'POST') { prCreates++; body = payload.body; return Response.json({ number: 7, html_url: 'https://github.com/example/repo/pull/7' }) }
      throw new Error(`意外请求：${method} ${path}`)
    }
    const options = { repository: 'example/repo', base: 'main', fetch }
    expect((await publishCandidate(candidate, options)).status).toBe('updated')
    expect((await publishCandidate(candidate, options)).status).toBe('unchanged')
    expect(prCreates).toBe(1)
    expect(commits).toHaveLength(1)
    expect(commits[0]).toMatchObject({ parents: [humanHead] })
    expect(trees).toEqual([{ base_tree: treeHead, tree: [{ path: 'deployment/dsh/candidate.json', mode: '100644', type: 'blob', content: stored }] }])
  })

  it('权限不足明确失败，不把候选发布视为成功', async () => {
    const candidate = await discoverUpstreams(baseline, async () => Response.json({ name: '@deepseek-ai/dsh', versions: { '1.0.0': release('1.0.0'), '1.1.0': release('1.1.0') } }))
    await expect(publishCandidate(candidate, { repository: 'example/repo', base: 'main', fetch: async () => Response.json({ message: 'GitHub Actions is not permitted to create or approve pull requests.' }, { status: 403 }) })).rejects.toThrow('GitHub Actions is not permitted to create or approve pull requests.')
  })
})
