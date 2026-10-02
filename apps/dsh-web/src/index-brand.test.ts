// @vitest-environment jsdom
import { expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from './index.ts'

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
