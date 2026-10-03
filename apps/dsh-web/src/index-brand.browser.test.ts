import { expect, test } from '@playwright/test'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from './index.ts'

test('keeps the title branded before host startup and across reloads', async ({ browser, page }) => {
  let transform = (html: string) => html
  apply({
    effect: (effect: () => unknown) => effect(),
    webServer: {
      register: () => () => {},
      tapIndex: (tap: typeof transform) => { transform = tap; return () => {} },
    },
  } as unknown as Context, { upstreamOrigin: 'http://127.0.0.1:51868' })
  const html = transform(`<html><head><title>DeepSeek Harness</title><script>
    window.observedTitles = [];
    document.title = 'DeepSeek Harness';
    window.observedTitles.push(document.title);
    requestAnimationFrame(() => {
      window.observedTitles.push(document.title);
      setTimeout(() => {
        document.title = 'Session - DeepSeek Harness';
        window.observedTitles.push(document.title);
        requestAnimationFrame(() => window.observedTitles.push(document.title));
      }, 100);
    });
  </script></head><body></body></html>`)
  const browserSession = await browser.newBrowserCDPSession()
  const tabTitles: string[] = []
  browserSession.on('Target.targetInfoChanged', ({ targetInfo }) => {
    if (targetInfo.type === 'page') tabTitles.push(targetInfo.title)
  })
  try {
    await browserSession.send('Target.setDiscoverTargets', { discover: true })
    await page.route('http://clinmesh.test/**', route => route.fulfill({ contentType: 'text/html', body: html }))
    await page.goto('http://clinmesh.test/')
    for (let reload = 0; reload < 3; reload++) {
      await page.waitForFunction('window.observedTitles.length === 4')
      expect(await page.evaluate('window.observedTitles')).toEqual(['ClinMesh', 'ClinMesh', 'ClinMesh', 'ClinMesh'])
      if (reload < 2) await page.reload()
    }
    expect(tabTitles.filter(title => title.includes('DeepSeek Harness'))).toEqual([])
  } finally {
    await browserSession.detach()
  }
})
