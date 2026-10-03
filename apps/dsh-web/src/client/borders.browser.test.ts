import { expect, test } from '@playwright/test'
import { z } from 'zod'
import { readJsonFromBrowser } from '../../../../scripts/browser-contract.ts'
import { buildSurfaceStyles } from '../surface-styles.ts'

test('renders Surface borders without changing host borders', async ({ page }) => {
  const css = JSON.stringify(await buildSurfaceStyles()).replaceAll('<', '\\u003c')
  const metrics = z.array(z.object({ width: z.string(), style: z.string() })).parse(
    await readJsonFromBrowser(page, `<!doctype html><html><body>
      <div id="host" class="border"></div>
      <script>
        const host = document.querySelector('#host')
        const root = host.attachShadow({ mode: 'open' })
        const style = document.createElement('style')
        style.textContent = ${css}
        root.append(style)
        const app = document.createElement('div')
        app.className = 'clinmesh-web-root'
        app.innerHTML = '<div class="border"></div><div class="border-t"></div><div class="border-b"></div>'
        root.append(app)
        const metrics = [...app.children, host].map((element, index) => {
          const style = getComputedStyle(element)
          return index === 2
            ? { width: style.borderBottomWidth, style: style.borderBottomStyle }
            : { width: style.borderTopWidth, style: style.borderTopStyle }
        })
        document.title = btoa(JSON.stringify(metrics))
      </script></body></html>`),
  )
  expect(metrics).toEqual([
    { width: '1px', style: 'solid' },
    { width: '1px', style: 'solid' },
    { width: '1px', style: 'solid' },
    { width: '0px', style: 'none' },
  ])
})
