import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { discoverUpstreams, publishCandidate } from './dsh-upstreams.ts'

export async function runDiscovery(args: string[], environment: NodeJS.ProcessEnv = process.env) {
  if (args.some(arg => arg !== '--publish')) throw new Error('用法：pnpm upstream:discover [--publish]')
  const baseline = JSON.parse(await readFile('dsh-upstreams.lock.json', 'utf8'))
  const fetch: typeof globalThis.fetch = (input, init) => {
    const headers = new Headers(init?.headers)
    if (String(input).startsWith('https://api.github.com/') && environment.GH_TOKEN) headers.set('Authorization', `Bearer ${environment.GH_TOKEN}`)
    headers.set('Accept', 'application/json')
    return globalThis.fetch(input, { ...init, headers })
  }
  const candidate = await discoverUpstreams(baseline, fetch)
  const result = args.includes('--publish')
    ? await publishCandidate(candidate, { repository: environment.GITHUB_REPOSITORY ?? 'CaiZongyuan/clinmesh', base: environment.UPSTREAM_BASE ?? 'main', fetch })
    : { status: candidate.changes.length ? 'discovered' : 'no-update' }
  // 只有所有来源与发布都成功后才替换本地报告，网络失败保留上一份证据。
  await writeFile('dsh-upstreams.discovery.json', `${JSON.stringify(candidate, null, 2)}\n`)
  if (environment.GITHUB_OUTPUT) {
    await appendFile(environment.GITHUB_OUTPUT, `status=${result.status}\nhead=${'head' in result ? result.head : ''}\nbranch=${'branch' in result ? result.branch : ''}\n`)
  }
  return { ...result, changes: candidate.changes }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runDiscovery(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error instanceof Error ? error.message : '上游发现失败')
    process.exitCode = 1
  })
}
