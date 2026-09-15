import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, access, readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { candidatePath, discoveryPath, discoverUpstreams, lockDigest, parseLock, publishCandidate } from './dsh-upstreams.ts'

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
    const reads: string[] = []
    expect(await publishCandidate(candidate, { repository: 'example/repo', base: 'main', fetch: async (url, init) => {
      expect(init?.method).toBe('GET')
      expect(new URL(url).pathname).toBe('/repos/example/repo/pulls')
      reads.push(url)
      return Response.json([])
    } })).toEqual({ status: 'no-update' })
    expect(reads).toHaveLength(1)
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
  it.each(['可读取', '读取失败'])('目标分支基线%s：发布不采用本地升级锁', async availability => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-upstream-base-'))
    try {
      const local = structuredClone(baseline)
      local.components[0] = { ...local.components[0]!, version: '1.1.0', source: release('1.1.0').dist.tarball }
      const localText = JSON.stringify(local)
      await writeFile(join(directory, 'dsh-upstreams.lock.json'), localText)
      const fixture = join(directory, 'network.mjs')
      await writeFile(fixture, `
        import { writeFileSync } from 'node:fs';
        const baseline = ${JSON.stringify(baseline)};
        globalThis.fetch = async (url, init = {}) => {
          const parsed = new URL(url);
          const path = parsed.pathname.replace('/repos/example/repo/', '');
          if (parsed.origin === 'https://registry.npmjs.org') return Response.json(${JSON.stringify({ name: '@deepseek-ai/dsh', versions: { '1.0.0': release('1.0.0') } })});
          if (path === 'git/ref/heads/main') return Response.json({ object: { sha: 'b'.repeat(40) } });
          if (path === 'contents/dsh-upstreams.lock.json' && ${availability === '读取失败'}) return new Response('', { status: 503 });
          if (path === 'contents/dsh-upstreams.lock.json' && parsed.searchParams.get('ref') === 'b'.repeat(40)) return Response.json({ encoding: 'base64', content: Buffer.from(JSON.stringify(baseline)).toString('base64') });
          if (path === 'pulls' && (init.method ?? 'GET') === 'GET') { writeFileSync('lookup.json', JSON.stringify({ head: parsed.searchParams.get('head'), base: parsed.searchParams.get('base') })); return Response.json([]); }
          throw new Error('不应读取其他基线或创建 PR：' + url);
        };
      `)
      const entry = fileURLToPath(new URL('./dsh-upstreams-cli.ts', import.meta.url))
      const loader = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href
      const execution = promisify(execFile)(process.execPath, ['--import', loader, '--import', pathToFileURL(fixture).href, entry, '--publish'], {
        cwd: directory, env: { ...process.env, GH_TOKEN: '', GITHUB_REPOSITORY: 'example/repo', UPSTREAM_BASE: 'main' },
      })
      if (availability === '读取失败') {
        await expect(execution).rejects.toThrow('HTTP 503')
        await expect(access(join(directory, 'lookup.json'))).rejects.toThrow()
        await expect(access(join(directory, 'dsh-upstreams.discovery.json'))).rejects.toThrow()
        expect(await readFile(join(directory, 'dsh-upstreams.lock.json'), 'utf8')).toBe(localText)
        return
      }
      const result = await execution
      expect(JSON.parse(result.stdout)).toMatchObject({ status: 'no-update' })
      const report = JSON.parse(await readFile(join(directory, 'dsh-upstreams.discovery.json'), 'utf8'))
      expect(report.target.components[0].version).toBe('1.0.0')
      expect(JSON.parse(await readFile(join(directory, 'lookup.json'), 'utf8'))).toEqual({ head: `example:automation/dsh-upstreams-0d6e4079-${report.baselineDigest.slice(0, 12)}`, base: 'main' })
      expect(await readFile(join(directory, 'dsh-upstreams.lock.json'), 'utf8')).toBe(localText)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it.each(['仅候选撤销', '基线与候选共用的版本撤销', '整包 404'])('%s 时，CLI 保存待适配证据且不调度安装', async scenario => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-upstream-withdrawn-'))
    try {
      const input = { ...baseline, components: [...baseline.components, { name: 'bridge', source: 'https://github.com/example/bridge.git', owner: 'https://github.com/example/bridge', role: '桥接', commit: 'c'.repeat(40) }] }
      const target = parseLock(input)
      if (scenario === '仅候选撤销') Object.assign(target.components[0]!, { version: '1.1.0', source: release('1.1.0').dist.tarball })
      target.components[1]!.commit = 'd'.repeat(40)
      const active = { schemaVersion: 1, baselineDigest: lockDigest(parseLock(input)), target, changes: [{ name: 'bridge', from: 'c'.repeat(40), to: 'd'.repeat(40) }] }
      const baselineText = JSON.stringify(input)
      await writeFile(join(directory, 'dsh-upstreams.lock.json'), baselineText)
      const fixture = join(directory, 'network.mjs')
      await writeFile(fixture, `
        import { writeFileSync } from 'node:fs';
        const active = ${JSON.stringify(active)};
        const baseline = ${JSON.stringify(input)};
        const registry = ${JSON.stringify({ name: '@deepseek-ai/dsh', versions: scenario === '仅候选撤销' ? { '1.0.0': release('1.0.0') } : {} })};
        const head = 'a'.repeat(40);
        globalThis.fetch = async (url, init = {}) => {
          if (String(url).startsWith('https://registry.npmjs.org/')) return Response.json(registry, { status: ${scenario === '整包 404' ? 404 : 200} });
          if (String(url) === 'https://api.github.com/repos/example/bridge') return Response.json({ default_branch: 'main' });
          if (String(url) === 'https://api.github.com/repos/example/bridge/commits/main') return Response.json({ sha: 'c'.repeat(40) });
          const path = new URL(url).pathname.replace('/repos/example/repo/', '');
          const method = init.method ?? 'GET';
          if (path === 'pulls' && method === 'GET') return Response.json([{ number: 7, body: '人工说明', html_url: 'https://github.com/example/repo/pull/7' }]);
          if (path.startsWith('git/ref/') && method === 'GET') return Response.json({ object: { sha: head } });
          if (path === 'contents/dsh-upstreams.lock.json' && method === 'GET') return Response.json({ encoding: 'base64', content: Buffer.from(JSON.stringify(baseline)).toString('base64') });
          if (path === 'contents/deployment/dsh/candidate.json' && method === 'GET') return Response.json({ encoding: 'base64', content: Buffer.from(JSON.stringify(active)).toString('base64') });
          if (path === 'statuses/' + head && method === 'POST') { writeFileSync('observed-status.json', init.body); return Response.json({}); }
          if (path === 'pulls/7' && method === 'PATCH') return Response.json({});
          throw new Error('不应创建或改写候选：' + method + ' ' + path);
        };
      `)
      const entry = fileURLToPath(new URL('./dsh-upstreams-cli.ts', import.meta.url))
      const loader = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href
      const result = await promisify(execFile)(process.execPath, ['--import', loader, '--import', pathToFileURL(fixture).href, entry, '--publish'], {
        cwd: directory, env: { ...process.env, GH_TOKEN: '', GITHUB_REPOSITORY: 'example/repo', UPSTREAM_BASE: 'main', GITHUB_OUTPUT: join(directory, 'outputs') },
      })
      expect(JSON.parse(result.stdout)).toMatchObject({ status: 'awaiting-adaptation', invalidatedHead: 'a'.repeat(40) })
      expect(JSON.parse(await readFile(join(directory, 'observed-status.json'), 'utf8'))).toMatchObject({ state: 'failure' })
      expect(JSON.parse(await readFile(join(directory, 'dsh-upstreams.discovery.json'), 'utf8'))).toMatchObject({ result: { status: 'awaiting-adaptation', reason: expect.stringContaining('已撤销') } })
      if (scenario !== '仅候选撤销') {
        expect(JSON.parse(await readFile(join(directory, 'dsh-upstreams.discovery.json'), 'utf8'))).toMatchObject({ discoveryError: scenario === '整包 404' ? expect.stringContaining('HTTP 404') : '已验证版本被撤销：@deepseek-ai/dsh@1.0.0' })
      }
      expect(await readFile(join(directory, 'outputs'), 'utf8')).toBe('status=awaiting-adaptation\nhead=\nbranch=\n')
      expect(await readFile(join(directory, 'dsh-upstreams.lock.json'), 'utf8')).toBe(baselineText)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

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
  it.each(['available', 'network-error', 'forbidden', 'timeout', 'redirect', 'malformed', 'head-changed'])('无更新复查 %s 时不误写兼容状态', async scenario => {
    const active = await discoverUpstreams(baseline, async () => Response.json({ name: '@deepseek-ai/dsh', versions: { '1.0.0': release('1.0.0'), '1.1.0': release('1.1.0') } }))
    const fresh = await discoverUpstreams(baseline, async () => Response.json({ name: '@deepseek-ai/dsh', versions: { '1.0.0': release('1.0.0') } }))
    const writes: string[] = []
    let refs = 0
    const fetch = async (url: string, init?: RequestInit) => {
      if (url.startsWith('https://registry.npmjs.org/')) {
        if (scenario === 'network-error') return new Response('', { status: 503 })
        if (scenario === 'forbidden') return new Response('', { status: 403 })
        if (scenario === 'timeout') throw new DOMException('registry 请求超时', 'TimeoutError')
        if (scenario === 'redirect') {
          if (init?.redirect === 'error') throw new TypeError('registry 重定向被拒绝')
          return new Response('', { status: 404 })
        }
        if (scenario === 'malformed') return Response.json({ name: '@deepseek-ai/dsh' })
        return Response.json({ name: '@deepseek-ai/dsh', versions: scenario === 'available' ? { '1.1.0': release('1.1.0') } : {} })
      }
      const path = new URL(url).pathname.replace('/repos/example/repo/', '')
      if (init?.method !== 'GET') { writes.push(path); throw new Error('不应写入') }
      if (path === 'pulls') return Response.json([{ number: 7, body: '' }])
      if (path.startsWith('git/ref/')) return Response.json({ object: { sha: (++refs === 1 ? 'a' : 'b').repeat(40) } })
      if (path === `contents/${candidatePath}`) return Response.json({ encoding: 'base64', content: Buffer.from(JSON.stringify(active)).toString('base64') })
      throw new Error(`意外请求：${path}`)
    }
    const result = publishCandidate(fresh, { repository: 'example/repo', base: 'main', fetch })
    if (scenario === 'available') await expect(result).resolves.toEqual({ status: 'no-update' })
    else {
      const errors: Record<string, string> = { 'network-error': 'HTTP 503', forbidden: 'HTTP 403', timeout: '请求超时', redirect: '重定向被拒绝', 'head-changed': 'HEAD 已变化', malformed: 'JSON 对象' }
      await expect(result).rejects.toThrow(errors[scenario])
    }
    expect(writes).toEqual([])
  })

  it('无更新时仍将已撤销的活动候选标为待适配，保留候选和人工正文', async () => {
    const active = await discoverUpstreams(baseline, async () => Response.json({ name: '@deepseek-ai/dsh', versions: { '1.0.0': release('1.0.0'), '1.1.0': release('1.1.0') } }))
    const fresh = await discoverUpstreams(baseline, async () => Response.json({ name: '@deepseek-ai/dsh', versions: { '1.0.0': release('1.0.0') } }))
    const head = 'a'.repeat(40)
    const statuses: unknown[] = []
    let body = '人工说明：保留支持提交。'
    const fetch = async (url: string, init?: RequestInit) => {
      if (url.startsWith('https://registry.npmjs.org/')) return Response.json({ name: '@deepseek-ai/dsh', versions: { '1.0.0': release('1.0.0') } })
      const path = new URL(url).pathname.replace('/repos/example/repo/', '')
      const method = init?.method ?? 'GET'
      const payload = init?.body ? JSON.parse(String(init.body)) : undefined
      if (path === 'pulls' && method === 'GET') return Response.json([{ number: 7, body, html_url: 'https://github.com/example/repo/pull/7' }])
      if (path.startsWith('git/ref/') && method === 'GET') return Response.json({ object: { sha: head } })
      if (path === `contents/${candidatePath}` && method === 'GET') return Response.json({ encoding: 'base64', content: Buffer.from(JSON.stringify(active)).toString('base64') })
      if (path === `statuses/${head}` && method === 'POST') { statuses.push(payload); return Response.json({}) }
      if (path === 'pulls/7' && method === 'PATCH') { body = payload.body; return Response.json({}) }
      throw new Error(`不应改写候选或创建 PR：${method} ${path}`)
    }
    const result = await publishCandidate(fresh, { repository: 'example/repo', base: 'main', fetch })
    expect(result).toMatchObject({ status: 'awaiting-adaptation', invalidatedHead: head })
    expect(result).not.toHaveProperty('head')
    expect(statuses).toEqual([expect.objectContaining({ state: 'failure', context: 'DSH candidate compatibility' })])
    expect(body).toContain('人工说明：保留支持提交。')
    expect(body).toContain('已撤销')
    expect(body).toContain('1.1.0')
  })

  it('人工指定支持提交后，下一次发现拒绝覆盖且不合并目标分支', async () => {
    const input = { ...baseline, components: [{ name: 'bridge', source: 'https://github.com/example/bridge.git', owner: 'https://github.com/example/bridge', role: '桥接', commit: 'a'.repeat(40) }] }
    const responses = [{ default_branch: 'main' }, { sha: 'b'.repeat(40) }, { status: 'ahead' }]
    const discovered = await discoverUpstreams(input, async () => Response.json(responses.shift()))
    const manual = structuredClone(discovered)
    manual.target.components[0]!.commit = 'c'.repeat(40)
    manual.changes[0]!.to = 'c'.repeat(40)
    const mutations: string[] = []
    const fetch = async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname.replace('/repos/example/repo/', '')
      const method = init?.method ?? 'GET'
      if (method !== 'GET') mutations.push(path)
      if (path === 'pulls') return Response.json([{ number: 7, body: '', html_url: 'https://github.com/example/repo/pull/7' }])
      if (path.startsWith('git/ref/')) return Response.json({ object: { sha: 'd'.repeat(40) } })
      if (path === 'merges') return new Response(null, { status: 204 })
      if (path.startsWith('contents/')) return Response.json({ encoding: 'base64', content: Buffer.from(JSON.stringify(path.endsWith('candidate.json') ? manual : discovered)).toString('base64') })
      throw new Error(`意外请求：${method} ${path}`)
    }
    await expect(publishCandidate(discovered, { repository: 'example/repo', base: 'main', fetch })).rejects.toThrow('保留人工候选目标')
    expect(mutations).toEqual([])
  })

  it('旧候选缺少自动发现记录时保留现场，不猜测目标归属', async () => {
    const candidate = await discoverUpstreams(baseline, async () => Response.json({ name: '@deepseek-ai/dsh', versions: { '1.0.0': release('1.0.0'), '1.1.0': release('1.1.0') } }))
    const mutations: string[] = []
    const fetch = async (url: string, init?: RequestInit) => {
      if (url.startsWith('https://registry.npmjs.org/')) return Response.json({ name: '@deepseek-ai/dsh', versions: { '1.0.0': release('1.0.0'), '1.1.0': release('1.1.0') } })
      const path = new URL(url).pathname.replace('/repos/example/repo/', '')
      const method = init?.method ?? 'GET'
      if (method !== 'GET') mutations.push(path)
      if (path === 'pulls') return Response.json([{ number: 7, body: '', html_url: 'https://github.com/example/repo/pull/7' }])
      if (path.startsWith('git/ref/')) return Response.json({ object: { sha: 'c'.repeat(40) } })
      if (path === 'merges') return new Response(null, { status: 204 })
      if (path === 'contents/deployment/dsh/candidate.json') return Response.json({ encoding: 'base64', content: Buffer.from(JSON.stringify(candidate)).toString('base64') })
      if (path.startsWith('contents/')) return new Response('', { status: 404 })
      throw new Error(`意外请求：${method} ${path}`)
    }
    await expect(publishCandidate(candidate, { repository: 'example/repo', base: 'main', fetch })).rejects.toThrow('缺少自动发现记录')
    expect(mutations).toEqual([])
  })

  it('重复运行复用 PR，追加候选提交保留当前人工 HEAD 和非候选文件', async () => {
    const candidate = await discoverUpstreams(baseline, async () => Response.json({ name: '@deepseek-ai/dsh', versions: { '1.0.0': release('1.0.0'), '1.1.0': release('1.1.0') } }))
    const humanHead = 'c'.repeat(40)
    const treeHead = 'd'.repeat(40)
    const newHead = 'e'.repeat(40)
    const stored = new Map<string, string>()
    let head = humanHead
    const commits: unknown[] = []
    const trees: unknown[] = []
    let prCreates = 0
    let body = ''
    const fetch = async (url: string, init?: RequestInit) => {
      if (url.startsWith('https://registry.npmjs.org/')) return Response.json({ name: '@deepseek-ai/dsh', versions: { '1.0.0': release('1.0.0'), '1.1.0': release('1.1.0'), '1.2.0': release('1.2.0') } })
      const path = new URL(url).pathname.replace('/repos/example/repo/', '')
      const method = init?.method ?? 'GET'
      const payload = init?.body ? JSON.parse(String(init.body)) : undefined
      if (path === 'pulls' && method === 'GET') return Response.json(prCreates ? [{ number: 7, body, html_url: 'https://github.com/example/repo/pull/7' }] : [])
      if (path.startsWith('git/ref/')) return Response.json({ object: { sha: head } })
      if (path === 'merges') return new Response(null, { status: 204 })
      if (path.startsWith('contents/')) {
        const content = stored.get(path.slice('contents/'.length))
        return content ? Response.json({ encoding: 'base64', content: Buffer.from(content).toString('base64') }) : new Response('', { status: 404 })
      }
      if (path.startsWith('git/commits/') && method === 'GET') return Response.json({ tree: { sha: treeHead } })
      if (path === 'git/trees') {
        trees.push(payload)
        for (const file of payload.tree) stored.set(file.path, file.content)
        return Response.json({ sha: treeHead })
      }
      if (path === 'git/commits') { commits.push(payload); return Response.json({ sha: newHead }) }
      if (path.startsWith('git/refs/') && method === 'PATCH') { expect(payload.force).toBe(false); head = payload.sha; return Response.json({ object: { sha: head } }) }
      if (path === 'pulls' && method === 'POST') { prCreates++; body = payload.body; return Response.json({ number: 7, html_url: 'https://github.com/example/repo/pull/7' }) }
      if (path === 'pulls/7' && method === 'PATCH') { body = payload.body; return Response.json({ number: 7, html_url: 'https://github.com/example/repo/pull/7' }) }
      throw new Error(`意外请求：${method} ${path}`)
    }
    const options = { repository: 'example/repo', base: 'main', fetch }
    expect((await publishCandidate(candidate, options)).status).toBe('updated')
    expect((await publishCandidate(candidate, options)).status).toBe('unchanged')
    expect(prCreates).toBe(1)
    expect(commits).toHaveLength(1)
    expect(commits[0]).toMatchObject({ parents: [humanHead] })
    expect(trees).toEqual([{ base_tree: treeHead, tree: [candidatePath, discoveryPath].map(path => ({ path, mode: '100644', type: 'blob', content: stored.get(path) })) }])
    expect(JSON.parse(stored.get(discoveryPath)!)).toEqual(candidate)
    const newer = structuredClone(candidate)
    const newerRelease = release('1.2.0')
    Object.assign(newer.target.components[0]!, { version: '1.2.0', source: newerRelease.dist.tarball })
    newer.changes[0]!.to = '1.2.0'
    expect((await publishCandidate(newer, options)).status).toBe('updated')
    expect(JSON.parse(stored.get(candidatePath)!)).toEqual(newer)
    expect(JSON.parse(stored.get(discoveryPath)!)).toEqual(newer)
    expect(prCreates).toBe(1)
  })

  it('权限不足明确失败，不把候选发布视为成功', async () => {
    const candidate = await discoverUpstreams(baseline, async () => Response.json({ name: '@deepseek-ai/dsh', versions: { '1.0.0': release('1.0.0'), '1.1.0': release('1.1.0') } }))
    await expect(publishCandidate(candidate, { repository: 'example/repo', base: 'main', fetch: async () => Response.json({ message: 'GitHub Actions is not permitted to create or approve pull requests.' }, { status: 403 }) })).rejects.toThrow('GitHub Actions is not permitted to create or approve pull requests.')
  })
})
