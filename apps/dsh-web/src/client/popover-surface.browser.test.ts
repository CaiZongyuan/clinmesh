import { expect, test } from '@playwright/test'
import { z } from 'zod'
import { readJsonFromBrowser } from '../../../../scripts/browser-contract.ts'
import { buildSurfaceStyles } from '../surface-styles.ts'

// The DSH host paints its own menus with a translucent fill plus backdrop blur; Surface overlays must stay opaque.
test('keeps Surface overlays opaque under translucent host menu tokens', async ({ page }) => {
  const css = JSON.stringify(await buildSurfaceStyles()).replaceAll('<', '\\u003c')
  const colors = z.array(z.string()).parse(
    await readJsonFromBrowser(page, `<!doctype html><html><body>
      <style>:root { --dsw-specific-menu: #f8f9fa94; } .host-dark { --dsw-specific-menu: #43454a73; }</style>
      <div id="light"></div><div id="dark" class="host-dark"></div>
      <script>
        const colors = [['#light', ''], ['#dark', ' dark']].map(([selector, theme]) => {
          const root = document.querySelector(selector).attachShadow({ mode: 'open' })
          const style = document.createElement('style')
          style.textContent = ${css}
          root.append(style)
          const app = document.createElement('div')
          app.className = 'clinmesh-web-root' + theme
          app.innerHTML = '<div class="bg-popover"></div>'
          root.append(app)
          return getComputedStyle(app.firstElementChild).backgroundColor
        })
        document.title = btoa(JSON.stringify(colors))
      </script></body></html>`),
  )
  expect(colors).toEqual(['rgb(255, 255, 255)', 'rgb(53, 54, 56)'])
})
