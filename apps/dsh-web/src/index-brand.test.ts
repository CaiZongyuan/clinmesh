// @vitest-environment jsdom
import { expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from './index.ts'
import { chromium } from 'playwright-core'
import { findChrome } from '../../../scripts/headless-browser.ts'

it('serves ClinMesh tab branding before any client script executes', () => {
  let transform = (html: string) => html
  const ctx = {
    effect: (effect: () => unknown) => effect(),
    webServer: {
      register: () => () => {},
      tapIndex: (tap: typeof transform) => { transform = tap; return () => {} },
    },
  }
  apply(ctx as unknown as Context, { upstreamOrigin: 'http://127.0.0.1:51868' })
  const html = transform('<html><head><link rel="icon" type="image/svg+xml" href="./favicon.svg"><title>DeepSeek Harness</title><script src="./app.js"></script></head><body></body></html>')
  const page = new DOMParser().parseFromString(html, 'text/html')
  expect(page.title).toBe('ClinMesh')
  const icons = page.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')
  expect(icons).toHaveLength(1)
  expect(icons[0]!.type).toBe('image/webp')
  expect(icons[0]!.getAttribute('href')).toMatch(/^data:image\/webp;base64,UklGR/)
  expect(page.querySelector('script[src]')!.getAttribute('src')).toBe('./app.js')
})

it('keeps the title branded before host startup and across reloads', async () => {
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
        document.title = 'Session — DeepSeek Harness';
        window.observedTitles.push(document.title);
        requestAnimationFrame(() => window.observedTitles.push(document.title));
      }, 100);
    });
  </script></head><body></body></html>`)
  const browser = await chromium.launch({ executablePath: findChrome(), headless: true })
  try {
    const browserSession = await browser.newBrowserCDPSession()
    const tabTitles: string[] = []
    browserSession.on('Target.targetInfoChanged', ({ targetInfo }) => {
      if (targetInfo.type === 'page') tabTitles.push(targetInfo.title)
    })
    await browserSession.send('Target.setDiscoverTargets', { discover: true })
    const page = await browser.newPage()
    await page.route('http://clinmesh.test/**', route => route.fulfill({ contentType: 'text/html', body: html }))
    await page.goto('http://clinmesh.test/')
    for (let reload = 0; reload < 3; reload++) {
      await page.waitForFunction('window.observedTitles.length === 4')
      expect(await page.evaluate('window.observedTitles')).toEqual(['ClinMesh', 'ClinMesh', 'ClinMesh', 'ClinMesh'])
      if (reload < 2) await page.reload()
    }
    expect(tabTitles.filter(title => title.includes('DeepSeek Harness'))).toEqual([])
  } finally {
    await browser.close()
  }
})
