import { createHash } from 'node:crypto'

type Component = {
  name: string
  source: string
  owner: string
  role: string
  version?: string
  integrity?: string
  commit?: string
  checkout?: string
  requires?: string[]
  supportPullRequest?: string
}
export type UpstreamLock = {
  schemaVersion: 1
  hostDependencyLock: string
  profileDependencyLock: string
  components: Component[]
}
export type Candidate = {
  schemaVersion: 1
  baselineDigest: string
  target: UpstreamLock
  changes: { name: string; from: string; to: string }[]
}
type Fetch = (url: string, init?: RequestInit) => Promise<Response>

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('响应必须是 JSON 对象')
  return Object.fromEntries(Object.entries(value))
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('字段必须是非空字符串')
  return value
}
function versionParts(version: string) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/.exec(version)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? Infinity : Number(match[4])] : undefined
}
function compareVersions(a: string, b: string) {
  const left = versionParts(a)
  const right = versionParts(b)
  if (!left || !right) throw new Error('仅接受正式版与 rc.N 版本')
  for (let i = 0; i < 4; i++) {
    if (left[i]! > right[i]!) return 1
    if (left[i]! < right[i]!) return -1
  }
  return 0
}
function sha(value: unknown) {
  const result = string(value)
  if (!/^[a-f0-9]{40}$/.test(result)) throw new Error('源码 commit 必须为完整 SHA-1')
  return result
}
function integrity(value: unknown) {
  const result = string(value)
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(result)) throw new Error('缺少有效 sha512 integrity')
  return result
}
function tarball(value: unknown) {
  const result = string(value)
  const url = new URL(result)
  if (url.origin !== 'https://registry.npmjs.org' || url.username || url.password || url.search || url.hash) {
    throw new Error('npm tarball 必须来自公开 registry.npmjs.org')
  }
  return result
}
export function parseLock(value: unknown): UpstreamLock {
  const lock = object(value)
  if (lock.schemaVersion !== 1 || !Array.isArray(lock.components) || !lock.components.length) throw new Error('非法上游清单')
  if (lock.hostDependencyLock !== 'deployment/dsh/host/package-lock.json' || lock.profileDependencyLock !== 'deployment/dsh/profile/pnpm-lock.yaml') throw new Error('非法依赖锁路径')
  const components = lock.components.map(value => {
    const item = object(value)
    const component: Component = {
      name: string(item.name), source: string(item.source), owner: string(item.owner), role: string(item.role),
    }
    if (!/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(component.name)) throw new Error('非法 npm 包名')
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(component.owner)) throw new Error('非法维护归属')
    if (item.version !== undefined) {
      component.version = string(item.version)
      if (!versionParts(component.version) || item.commit !== undefined) throw new Error('非法锁定版本')
      component.integrity = integrity(item.integrity)
      component.source = tarball(item.source)
    } else if (item.commit !== undefined) {
      component.commit = sha(item.commit)
      if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/.test(component.source)) throw new Error('非法 Git 来源')
    } else if (component.name !== '@clinmesh/dsh-web' || component.source !== 'workspace:apps/dsh-web') throw new Error('非法 workspace 来源')
    if (item.requires !== undefined) {
      if (!Array.isArray(item.requires)) throw new Error('非法依赖关系')
      component.requires = item.requires.map(string)
    }
    if (item.checkout !== undefined) {
      if (item.checkout !== 'vendor/dsh-react-surface') throw new Error('非法源码检出路径')
      component.checkout = item.checkout
    }
    if (item.supportPullRequest !== undefined) {
      component.supportPullRequest = string(item.supportPullRequest)
      if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(component.supportPullRequest)) throw new Error('非法支持 PR')
    }
    return component
  })
  const names = new Set(components.map(item => item.name))
  if (names.size !== components.length || components.some(item => item.requires?.some(name => !names.has(name)))) throw new Error('重复组件或缺失依赖')
  return { schemaVersion: 1, hostDependencyLock: lock.hostDependencyLock, profileDependencyLock: lock.profileDependencyLock, components }
}

export function lockDigest(lock: UpstreamLock) {
  return createHash('sha256').update(JSON.stringify(parseLock(lock))).digest('hex')
}
async function json(fetch: Fetch, url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`上游请求失败：HTTP ${response.status} ${url}`)
  return object(await response.json())
}

export async function discoverUpstreams(input: unknown, fetch: Fetch = globalThis.fetch): Promise<Candidate> {
  const baseline = parseLock(input)
  const target = structuredClone(baseline)
  for (const item of target.components) {
    if (item.version) {
      const packument = await json(fetch, `https://registry.npmjs.org/${encodeURIComponent(item.name)}`)
      if (packument.name !== item.name) throw new Error(`npm 包身份不匹配：${item.name}`)
      const versions = object(packument.versions)
      if (!versions[item.version]) throw new Error(`已验证版本被撤销：${item.name}@${item.version}`)
      const selected = Object.keys(versions).filter(value => versionParts(value)).sort(compareVersions).at(-1)
      if (!selected) throw new Error(`无正式版或 RC：${item.name}`)
      for (const version of new Set([item.version, selected])) {
        const release = object(versions[version])
        if (release.name !== item.name || release.version !== version) throw new Error(`npm 发行身份不匹配：${item.name}`)
        const dist = object(release.dist)
        const source = tarball(dist.tarball)
        const hash = integrity(dist.integrity)
        if (version === item.version && (source !== item.source || hash !== item.integrity)) throw new Error(`已验证发行内容发生变化：${item.name}`)
        if (version === selected) Object.assign(item, { version, source, integrity: hash })
      }
    } else if (item.commit) {
      const repo = item.source.replace('https://github.com/', '').replace(/\.git$/, '')
      const metadata = await json(fetch, `https://api.github.com/repos/${repo}`)
      const branch = string(metadata.default_branch)
      const head = await json(fetch, `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(branch)}`)
      const commit = sha(head.sha)
      if (commit !== item.commit) {
        const comparison = await json(fetch, `https://api.github.com/repos/${repo}/compare/${item.commit}...${commit}`)
        if (comparison.status === 'ahead') item.commit = commit
        else if (comparison.status !== 'behind') throw new Error(`源码历史分叉或非法比较响应，需人工适配：${item.name}`)
      }
    }
  }
  const changes = target.components.flatMap((item, index) => {
    const before = baseline.components[index]!
    const from = before.version ?? before.commit ?? 'workspace'
    const to = item.version ?? item.commit ?? 'workspace'
    return from === to ? [] : [{ name: item.name, from, to }]
  })
  return { schemaVersion: 1, baselineDigest: lockDigest(baseline), target, changes }
}

export const candidatePath = 'deployment/dsh/candidate.json'
export const discoveryPath = 'deployment/dsh/discovery.json'

export function parseCandidate(value: unknown): Candidate {
  const input = object(value)
  const target = parseLock(input.target)
  if (input.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(string(input.baselineDigest)) || !Array.isArray(input.changes)) throw new Error('非法升级候选')
  const changes = input.changes.map(value => {
    const item = object(value)
    const name = string(item.name)
    const from = string(item.from)
    const to = string(item.to)
    const component = target.components.find(component => component.name === name)
    if (!component || (component.version ?? component.commit) !== to || !(versionParts(from) || /^[a-f0-9]{40}$/.test(from))) throw new Error('非法候选差异')
    return { name, from, to }
  })
  return { schemaVersion: 1, baselineDigest: string(input.baselineDigest), target, changes }
}

function candidateBody(candidate: Candidate, base: string) {
  return [
    '<!-- dsh-upstreams:start -->',
    '## 上游升级候选', '',
    `以 ${base} 上的已验证组合为基线。当前状态：待适配与验收；仅由维护者人工合并。`, '',
    '| 组件 | 当前 | 目标 | 来源 |', '| --- | --- | --- | --- |',
    ...candidate.target.components.map(item => {
      const change = candidate.changes.find(change => change.name === item.name)
      const target = item.version ?? item.commit ?? 'workspace'
      return `| ${item.name} | ${change?.from ?? target} | ${target} | ${item.source} |`
    }), '',
    '发现不会改写已验证锁或日常 Profile。候选安装、构建与检查由同次 Actions 运行显式执行，不依赖机器人创建 PR 触发 pull_request 事件。失败日志与准备补丁保留在该运行的 artifacts 中；维护者可追加适配提交。', '',
    '按照 docs/deployment.md 的持续升级流程采用候选并核对人工验收证据。仅自动检查成功不代表原生会话与人工审阅已验收。', '',
    'Part of #92', '<!-- dsh-upstreams:end -->',
  ].join('\n')
}

export async function publishCandidate(candidate: Candidate, options: {
  repository: string
  base: string
  fetch: Fetch
}) {
  if (!candidate.changes.length) return { status: 'no-update' as const }
  const scope = createHash('sha256').update(options.base).digest('hex').slice(0, 8)
  const upgradeBranch = `automation/dsh-upstreams-${scope}-${candidate.baselineDigest.slice(0, 12)}`
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.repository) || !/^[\w./-]+$/.test(options.base)) throw new Error('非法 GitHub 仓库或分支')
  const api = `https://api.github.com/repos/${options.repository}`
  async function request(path: string, method = 'GET', body?: unknown, missing = false): Promise<unknown> {
    const response = await options.fetch(`${api}/${path}`, {
      method, headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    })
    if (missing && response.status === 404) return undefined
    if (!response.ok) {
      const failure = await response.json().catch(() => undefined)
      const message = failure && typeof failure === 'object' && 'message' in failure && typeof failure.message === 'string'
        ? `；${failure.message}` : ''
      throw new Error(`GitHub ${method} ${path} 失败：HTTP ${response.status}${message}；需要 contents:write 与 pull-requests:write，且允许 Actions 创建 PR；未推进基线`)
    }
    if (response.status === 204) return undefined
    return response.json()
  }
  const pulls = await request(`pulls?state=open&head=${encodeURIComponent(`${options.repository.split('/')[0]}:${upgradeBranch}`)}&base=${encodeURIComponent(options.base)}`)
  if (!Array.isArray(pulls) || pulls.length > 1) throw new Error('活动升级 PR 响应不唯一')
  const pull = pulls[0] === undefined ? undefined : object(pulls[0])
  const branch = await request(`git/ref/heads/${upgradeBranch}`, 'GET', undefined, true)
  async function readCandidate(path: string, head: string) {
    const response = await request(`contents/${path}?ref=${encodeURIComponent(head)}`, 'GET', undefined, true)
    if (response === undefined) return undefined
    const file = object(response)
    if (file.encoding !== 'base64') throw new Error('非法候选文件编码')
    return parseCandidate(JSON.parse(Buffer.from(string(file.content), 'base64').toString('utf8')))
  }
  async function protectManualTarget(head: string) {
    const current = await readCandidate(candidatePath, head)
    const discovered = await readCandidate(discoveryPath, head)
    if ((current || pull) && !discovered) throw new Error('缺少自动发现记录，保留旧候选；请人工核对目标后建立 discovery.json')
    if (JSON.stringify(current) !== JSON.stringify(discovered)) throw new Error('保留人工候选目标：candidate.json 与上次自动发现结果不同；请协调目标后再恢复自动更新')
  }
  let head: string
  if (branch === undefined) {
    const base = object(await request(`git/ref/heads/${options.base}`))
    head = sha(object(base.object).sha)
    await request('git/refs', 'POST', { ref: `refs/heads/${upgradeBranch}`, sha: head })
  } else {
    head = sha(object(object(branch).object).sha)
    await protectManualTarget(head)
    const merged = await request('merges', 'POST', {
      base: upgradeBranch, head: options.base,
      commit_message: 'chore(upstream): 合入当前基线并保留人工适配\n\n背景：\n- 验收需包含目标分支的当前实现\n\n变更：\n- 普通合并目标分支，冲突时停止\n\n验证：\n- GitHub 执行无冲突合并；兼容检查由后续 CI 执行\n\n关联：\n- Refs #92',
    })
    if (merged !== undefined) {
      head = sha(object(merged).sha)
      await protectManualTarget(head)
    }
  }
  const current = await readCandidate(candidatePath, head)
  const content = `${JSON.stringify(parseCandidate(candidate), null, 2)}\n`
  const changed = JSON.stringify(current) !== JSON.stringify(candidate)
  if (changed) {
    const parent = object(await request(`git/commits/${head}`))
    const tree = object(await request('git/trees', 'POST', {
      base_tree: sha(object(parent.tree).sha), tree: [candidatePath, discoveryPath].map(path => ({ path, mode: '100644', type: 'blob', content })),
    }))
    const commit = object(await request('git/commits', 'POST', {
      message: 'chore(upstream): 更新 DSH 上游候选\n\n背景：\n- 发现新的正式版、RC 或源码提交\n\n变更：\n- 追加候选清单，保留人工适配与已验证基线\n\n验证：\n- 发现入口已校验来源与版本；兼容验收由 CI 执行\n\n关联：\n- Refs #92',
      tree: sha(tree.sha), parents: [head],
    }))
    head = sha(commit.sha)
    await request(`git/refs/heads/${upgradeBranch}`, 'PATCH', { sha: head, force: false })
  }
  const body = candidateBody(candidate, options.base)
  let result: Record<string, unknown>
  if (!pull) {
    result = object(await request('pulls', 'POST', {
      title: 'chore(upstream): 验证并适配 DSH 上游更新', head: upgradeBranch, base: options.base, body, draft: true,
    }))
  } else {
    if (!Number.isSafeInteger(pull.number)) throw new Error('非法 PR 编号')
    const previous = typeof pull.body === 'string' ? pull.body : ''
    const updated = previous.includes('<!-- dsh-upstreams:start -->')
      ? previous.replace(/<!-- dsh-upstreams:start -->[\s\S]*?<!-- dsh-upstreams:end -->/, body)
      : `${previous}\n\n${body}`
    result = updated === previous ? pull : object(await request(`pulls/${pull.number}`, 'PATCH', { body: updated }))
  }
  return { status: changed ? 'updated' as const : 'unchanged' as const, head, branch: upgradeBranch, pullRequest: string(result.html_url), number: result.number }
}
