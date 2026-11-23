import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { build } from 'vite'
import { expect, test, type Page } from '@playwright/test'
import { pathologyReadingProtocol, type PathologyReadingMessage, type PathologyReadingSession } from '@clinmesh/contracts/pathology-reading'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)
type Session = PathologyReadingSession & { active: boolean }
const artifacts = new Map<string, { script: string; styles: string }>()

async function buildFixture(version: string) {
  const existing = artifacts.get(version)
  if (existing) return existing
  const react = version === '18' ? 'react18' : 'react', reactDom = version === '18' ? 'react-dom18' : 'react-dom'
  const result = await build({ configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic', jsxDev: false },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') }, resolve: { alias: [
      { find: /^react$/, replacement: require.resolve(react) }, { find: 'react/jsx-runtime', replacement: require.resolve(`${react}/jsx-runtime`) },
      { find: 'react-dom/client', replacement: require.resolve(`${reactDom}/client`) }, { find: /^react-dom$/, replacement: require.resolve(reactDom) },
    ] }, build: { write: false, lib: { entry: fileURLToPath(new URL('./pathology-reading.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'PathologyReadingContract' } } })
  const script = (Array.isArray(result) ? result : [result]).flatMap(output => 'output' in output ? output.output : []).find(output => output.type === 'chunk')
  if (script?.type !== 'chunk') throw new Error('Missing production pathology reading fixture')
  const artifact = { script: script.code, styles: await buildSurfaceStyles() }
  artifacts.set(version, artifact)
  return artifact
}

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing contract server address')
  return `http://127.0.0.1:${address.port}`
}

async function startFixture(version: string) {
  const { script, styles } = await buildFixture(version), sessions: Session[] = [], displayed: PathologyReadingMessage[] = [], closed: string[] = []
  let origin = '', holdDisplayed = false, releaseDisplayed = () => {}, displayedGate = Promise.resolve(), expireNextOpen = false
  const openKeys: string[] = []
  const viewer = createServer((request, response) => {
    const id = new URL(request.url!, 'http://localhost').searchParams.get('id'), session = sessions.find(item => item.id === id)
    if (!session) { response.writeHead(404); response.end(); return }
    const context = { protocol: pathologyReadingProtocol, sessionId: session.sessionId, generation: session.generation,
      requestId: session.requestId, reportId: session.reportId, reportVersion: session.reportVersion }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(`<!doctype html><html><body><h1>合成专用阅片服务</h1><output id="launch">等待受信启动</output><canvas width="2" height="2" aria-label="合成画布"></canvas><button id="display" disabled>显示合成阅片</button><button id="fail">报告显示失败</button><script>
      const context=${JSON.stringify(context)};let launched=false;const parentOrigin=${JSON.stringify(origin)};
      addEventListener('message',event=>{if(event.source!==parent||event.origin!==parentOrigin)return;const message=event.data;
        if(message.protocol!==context.protocol||message.type!=='launch'||message.launchToken!==${JSON.stringify(session.launchToken)}||message.generation!==context.generation)return;
        launched=true;document.querySelector('#launch').textContent='已收到当前会话启动';document.querySelector('#display').disabled=false;});
      const emit=type=>parent.postMessage({...context,type},parentOrigin);document.querySelector('#display').onclick=()=>{if(!launched)return;const canvas=document.querySelector('canvas');canvas.getContext('2d').fillRect(0,0,2,2);requestAnimationFrame(()=>emit('displayed'));};
      document.querySelector('#fail').onclick=()=>emit('failed');parent.postMessage({protocol:context.protocol,type:'ready'},parentOrigin);
      </script></body></html>`)
  })
  const viewerOrigin = await listen(viewer)
  const parent = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost'), send = (body: unknown) => { response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)) }
    if (!url.pathname.startsWith('/api/')) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style><style>${styles}</style></head><body><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`); return
    }
    let data = ''; for await (const chunk of request) data += String(chunk)
    if (url.pathname.endsWith('/reading-sessions') && request.method === 'POST') {
      openKeys.push(String(request.headers['idempotency-key']))
      if (expireNextOpen) {
        expireNextOpen = false
        response.writeHead(403, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: { code: 'PATHOLOGY_READING_SESSION_EXPIRED', message: 'Synthetic original intent expired after recovery' } })); return
      }
      const input = JSON.parse(data) as { reportId: string; reportVersion: string; generation: string }, id = randomUUID()
      const current: Session = { id, sessionId: `pathjx-${sessions.length}`, requestId: decodeURIComponent(url.pathname.split('/').at(-2)!), reportId: input.reportId,
        reportVersion: input.reportVersion, generation: input.generation, viewerOrigin, viewerUrl: `${viewerOrigin}/clinmesh/reading?id=${id}`,
        launchToken: `synthetic-launch-${randomUUID()}`, expiresAt: '2099-01-01T00:00:00Z', writable: true, active: true }
      sessions.push(current); const { active: _active, ...result } = current; send(result); return
    }
    const current = sessions.find(item => url.pathname.includes(item.id))
    if (!current) { response.writeHead(404); response.end(); return }
    if (request.method === 'DELETE') { current.active = false; closed.push(current.id) }
    if (url.pathname.endsWith('/displayed')) { displayed.push(JSON.parse(data) as PathologyReadingMessage); if (holdDisplayed) await displayedGate }
    send({ id: current.id, active: url.pathname.endsWith('/displayed') ? true : current.active, writable: true, displayed: true, expiresAt: current.expiresAt })
  })
  origin = await listen(parent)
  return { origin, viewerOrigin, sessions, displayed, closed, openKeys, expireNextOpen: () => { expireNextOpen = true },
    holdDisplayed: () => { holdDisplayed = true; displayedGate = new Promise<void>(resolve => { releaseDisplayed = resolve }) },
    releaseDisplayed: () => { holdDisplayed = false; releaseDisplayed() },
    close: async () => { releaseDisplayed(); await Promise.all([parent, viewer].map(server => new Promise<void>(resolve => server.close(() => resolve())))) } }
}

function message(session: Session, type: PathologyReadingMessage['type'] = 'displayed'): PathologyReadingMessage {
  return { protocol: pathologyReadingProtocol, type, sessionId: session.sessionId, generation: session.generation,
    requestId: session.requestId, reportId: session.reportId, reportVersion: session.reportVersion }
}
async function forged(page: Page, data: unknown, origin: string, correctSource = true) {
  await page.evaluate(({ data, origin, correctSource }) => {
    const host = document.getElementById('pathology-reading-host')!, frame = (host.shadowRoot ?? host).querySelector('iframe')!
    window.dispatchEvent(new MessageEvent('message', { data, origin, source: correctSource ? frame.contentWindow : window }))
  }, { data, origin, correctSource })
}

async function releaseDisplay(page: Page, release: () => void) {
  const received = page.waitForResponse(response => response.url().endsWith('/displayed'))
  release()
  await received
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

for (const { version, surface, title } of [
  { version: '19', surface: false, title: 'standalone React 19' },
  { version: '18', surface: true, title: 'ShadowRoot React 18' },
  { version: '19', surface: true, title: 'ShadowRoot React 19' },
]) test.describe(`PathJX 外壳 ${title}`, () => {
  test('原创建结果查明已过期后，明确重试使用新意图并恢复阅片', async ({ page }) => {
    const app = await startFixture(version)
    app.expireNextOpen()
    try {
      await page.goto(`${app.origin}/fixture?surface=${surface ? '1' : '0'}`)
      await page.getByRole('button', { name: '重新打开切片', exact: true }).click()
      await expect(page.frameLocator('iframe').getByText('已收到当前会话启动', { exact: true })).toBeVisible()
      expect(app.openKeys).toHaveLength(2)
      expect(app.openKeys[0]).not.toBe(app.openKeys[1])
    } finally { await app.close() }
  })

  test('严格绑定消息，实际iframe握手后才授予显示资格，失败及时撤销', async ({ page }) => {
    test.setTimeout(120_000)
    const app = await startFixture(version), errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      await page.goto(`${app.origin}/fixture?surface=${surface ? '1' : '0'}`)
      const frame = page.frameLocator('iframe'), confirm = page.getByRole('button', { name: '确认当前报告已阅', exact: true })
      await expect(frame.getByText('已收到当前会话启动', { exact: true })).toBeVisible()
      const session = app.sessions[0]!
      await expect(confirm).toBeDisabled()
      for (const [body, origin, source] of [
        [message(session), app.origin, true], [message(session), app.viewerOrigin, false],
        [{ ...message(session), sessionId: 'wrong-session' }, app.viewerOrigin, true],
        [{ ...message(session), generation: randomUUID() }, app.viewerOrigin, true],
        [{ ...message(session), reportVersion: '2' }, app.viewerOrigin, true],
        [{ ...message(session), requestId: 'wrong-request' }, app.viewerOrigin, true],
        [{ ...message(session), unexpected: true }, app.viewerOrigin, true],
      ] as const) await forged(page, body, origin, source)
      await expect(confirm).toBeDisabled(); expect(app.displayed).toEqual([])
      await frame.getByRole('button', { name: '显示合成阅片', exact: true }).click()
      await expect(confirm).toBeEnabled(); expect(app.displayed).toEqual([message(session)])
      await frame.getByRole('button', { name: '报告显示失败', exact: true }).click()
      await expect(confirm).toBeDisabled()
      await expect(page.getByText('阅片服务暂不可用。文字报告仍可阅读，恢复后请重新打开切片。', { exact: true })).toBeVisible()
      await expect.poll(() => app.closed).toContain(session.id)
      expect(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage }, url: location.href }))).toEqual({ local: {}, session: {}, url: `${app.origin}/fixture?surface=${surface ? '1' : '0'}` })
      expect(errors).toEqual([])
    } finally { await app.close() }
  })

  test('失败或关闭及切患者后，迟到显示回执不能恢复资格，病历输入保留', async ({ page }) => {
    test.setTimeout(120_000)
    const app = await startFixture(version)
    try {
      await page.goto(`${app.origin}/fixture?surface=${surface ? '1' : '0'}`)
      const confirm = page.getByRole('button', { name: '确认当前报告已阅', exact: true }), frame = page.frameLocator('iframe')
      await expect(frame.getByText('已收到当前会话启动', { exact: true })).toBeVisible()
      await page.getByRole('textbox', { name: '未提交病历', exact: true }).fill('合成未提交病历保持原文。')
      app.holdDisplayed()
      await frame.getByRole('button', { name: '显示合成阅片', exact: true }).click()
      await expect.poll(() => app.displayed.length).toBe(1)
      await frame.getByRole('button', { name: '报告显示失败', exact: true }).click()
      await expect(page.getByRole('button', { name: '重新打开切片', exact: true })).toBeVisible()
      await releaseDisplay(page, app.releaseDisplayed)
      await expect(confirm).toBeDisabled()
      await page.getByRole('button', { name: '重新打开切片', exact: true }).click()
      await expect(page.frameLocator('iframe').getByText('已收到当前会话启动', { exact: true })).toBeVisible()
      app.holdDisplayed()
      await page.frameLocator('iframe').getByRole('button', { name: '显示合成阅片', exact: true }).click()
      await expect.poll(() => app.displayed.length).toBe(2)
      await page.getByRole('button', { name: '切换患者', exact: true }).click()
      await expect(page.getByRole('heading', { name: /^合成患者乙/ })).toBeVisible()
      await releaseDisplay(page, app.releaseDisplayed)
      await expect(confirm).toBeDisabled()
      await expect(page.frameLocator('iframe').getByText('已收到当前会话启动', { exact: true })).toBeVisible()
      app.holdDisplayed()
      await page.frameLocator('iframe').getByRole('button', { name: '显示合成阅片', exact: true }).click()
      await expect.poll(() => app.displayed.length).toBe(3)
      await page.getByRole('button', { name: '关闭阅片窗口', exact: true }).click()
      await expect(page.locator('iframe')).toHaveCount(0)
      await releaseDisplay(page, app.releaseDisplayed)
      await expect(confirm).toBeDisabled()
      await expect(page.getByRole('textbox', { name: '未提交病历', exact: true })).toHaveValue('合成未提交病历保持原文。')
      expect(app.sessions).toHaveLength(3)
      await expect.poll(() => app.closed.length).toBe(3)
    } finally { await app.close() }
  })

  test('长中文窄容器中全屏与退出可达且不溢出宿主', async ({ page }) => {
    test.setTimeout(120_000)
    const app = await startFixture(version)
    try {
      await page.setViewportSize({ width: 826, height: 900 })
      await page.goto(`${app.origin}/fixture?surface=${surface ? '1' : '0'}`)
      const viewer = page.getByRole('region', { name: '病理切片阅片', exact: true })
      await expect(page.frameLocator('iframe').getByText('已收到当前会话启动', { exact: true })).toBeVisible()
      expect(await viewer.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(surface)
      await page.evaluate(() => { document.getElementById('pathology-reading-host')!.style.width = '390px' })
      await expect(viewer.getByRole('button', { name: '全屏阅片', exact: true })).toBeInViewport()
      expect(await viewer.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      await viewer.getByRole('button', { name: '全屏阅片', exact: true }).click()
      await expect(viewer.getByRole('button', { name: '退出全屏', exact: true })).toBeInViewport()
      expect(await viewer.evaluate(element => element.matches(':fullscreen'))).toBe(true)
      await viewer.getByRole('button', { name: '退出全屏', exact: true }).click()
      await expect(viewer.getByRole('button', { name: '全屏阅片', exact: true })).toBeInViewport()
      expect(await viewer.evaluate(element => element.matches(':fullscreen'))).toBe(false)
      await page.getByRole('button', { name: '关闭阅片窗口', exact: true }).click()
      await expect(page.locator('iframe')).toHaveCount(0)
      expect(await page.locator('main').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    } finally { await app.close() }
  })
})
