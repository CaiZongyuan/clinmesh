import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { discoverUpstreams, publishCandidate, readPublishedBaseline, reconcileActiveCandidate, type Candidate } from './dsh-upstreams.ts'

export async function runDiscovery(args: string[], environment: NodeJS.ProcessEnv = process.env) {
  if (args.some(arg => arg !== '--publish')) throw new Error('用法：pnpm upstream:discover [--publish]')
  const publish = args.includes('--publish')
  const fetch: typeof globalThis.fetch = (input, init) => {
    const headers = new Headers(init?.headers)
    if (String(input).startsWith('https://api.github.com/') && environment.GH_TOKEN) headers.set('Authorization', `Bearer ${environment.GH_TOKEN}`)
    headers.set('Accept', 'application/json')
    return globalThis.fetch(input, { ...init, headers })
  }
  const options = { repository: environment.GITHUB_REPOSITORY ?? 'CaiZongyuan/clinmesh', base: environment.UPSTREAM_BASE ?? 'main', fetch }
  const baseline = publish
    ? await readPublishedBaseline(options)
    : JSON.parse(await readFile('dsh-upstreams.lock.json', 'utf8'))
  const invalidated = publish ? await reconcileActiveCandidate(baseline, options) : undefined
  let candidate: Candidate | undefined
  let discoveryError: string | undefined
  try {
    candidate = await discoverUpstreams(baseline, fetch)
  } catch (error) {
    if (!invalidated) throw error
    discoveryError = error instanceof Error ? error.message : '上游发现失败'
  }
  const result = invalidated ?? (candidate && publish
    ? await publishCandidate(candidate, options)
    : { status: candidate?.changes.length ? 'discovered' : 'no-update' })
  // 已失效候选的证据独立于发现结果保存，报告中的错误不构成新候选。
  await writeFile('dsh-upstreams.discovery.json', `${JSON.stringify({ ...candidate, result, ...(discoveryError ? { discoveryError } : {}) }, null, 2)}\n`)
  if (environment.GITHUB_OUTPUT) {
    await appendFile(environment.GITHUB_OUTPUT, `status=${result.status}\nhead=${'head' in result ? result.head : ''}\nbranch=${'branch' in result ? result.branch : ''}\n`)
  }
  return { ...result, changes: candidate?.changes ?? [], ...(discoveryError ? { discoveryError } : {}) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runDiscovery(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error instanceof Error ? error.message : '上游发现失败')
    process.exitCode = 1
  })
}
