import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { build } from 'vite'
import { expect, test } from '@playwright/test'
import { z } from 'zod'
import { readJsonFromBrowser } from '../../../../scripts/browser-contract.ts'

const themeMetricsSchema = z.object({
  appBackground: z.string(),
  appPainted: z.string(),
  appColorScheme: z.string(),
  htmlBackground: z.string(),
})
const browserMetricsSchema = z.object({
  dark: themeMetricsSchema,
  light: themeMetricsSchema,
  surfaceDarkDiv: themeMetricsSchema,
})

async function buildClinmeshStyles(): Promise<string> {
  const result = await build({
    build: {
      cssCodeSplit: false,
      lib: {
        entry: fileURLToPath(new URL('./font-size.browser.fixture.ts', import.meta.url)),
        fileName: 'web-theme-browser',
        formats: ['es'],
      },
      minify: true,
      write: false,
    },
    configFile: false,
    logLevel: 'silent',
    plugins: [tailwindcss()],
    root: fileURLToPath(new URL('../../../../', import.meta.url)),
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => {
    if (!('output' in output)) throw new Error('Unexpected Vite watcher while building styles.')
    return output.output
  })
  const cssAssets = outputs.filter(output => output.type === 'asset' && output.fileName.endsWith('.css'))
  if (cssAssets.length !== 1) throw new Error('Web-theme browser test requires exactly one CSS asset.')
  const asset = cssAssets[0]
  if (asset === undefined || asset.type !== 'asset') throw new Error('Missing built ClinMesh stylesheet.')
  return typeof asset.source === 'string' ? asset.source : Buffer.from(asset.source).toString()
}

function testDocument(clinmeshStyles: string): string {
  return `<!doctype html>
<html data-clinmesh-app="web" class="dark" data-theme="dark" style="color-scheme: dark">
  <head>
    <meta charset="UTF-8">
    <style>${clinmeshStyles}</style>
  </head>
  <body>
    <div id="app" class="clinmesh-web-root dark" data-clinmesh-app="web" data-font-size="standard" data-theme="dark" style="color-scheme: dark">
      <span id="probe">Probe</span>
    </div>
    <script>
      const app = document.querySelector('#app')
      const html = document.documentElement
      const read = () => ({
        appBackground: getComputedStyle(app).getPropertyValue('--background').trim(),
        appPainted: getComputedStyle(app).backgroundColor,
        appColorScheme: getComputedStyle(app).colorScheme,
        htmlBackground: getComputedStyle(html).getPropertyValue('--background').trim(),
      })
      const dark = read()
      html.classList.remove('dark')
      html.dataset.theme = 'light'
      html.style.colorScheme = 'light'
      app.classList.remove('dark')
      app.dataset.theme = 'light'
      app.style.colorScheme = 'light'
      const light = read()
      html.dataset.theme = 'light'
      html.style.colorScheme = 'light'
      app.classList.add('dark')
      app.dataset.theme = 'dark'
      app.style.colorScheme = 'dark'
      const surfaceDarkDiv = read()
      document.title = btoa(JSON.stringify({ dark, light, surfaceDarkDiv }))
    </script>
  </body>
</html>`
}

test('applies standalone dark tokens to the application subtree across themes', async ({ page }) => {
  const metrics = browserMetricsSchema.parse(await readJsonFromBrowser(
    page, testDocument(await buildClinmeshStyles()),
  ))

  expect(metrics.dark.htmlBackground).not.toBe('#ffffff')
  expect(metrics.dark.appBackground).toBe(metrics.dark.htmlBackground)
  expect(metrics.dark.appPainted).not.toBe('rgb(255, 255, 255)')
  expect(metrics.dark.appColorScheme).toBe('dark')

  expect(metrics.light.htmlBackground).not.toBe(metrics.dark.htmlBackground)
  expect(metrics.light.appBackground).toBe(metrics.light.htmlBackground)
  expect(metrics.light.appPainted).toBe('rgb(245, 246, 247)')
  expect(metrics.light.appColorScheme).toBe('light')

  expect(metrics.surfaceDarkDiv.htmlBackground).toBe(metrics.light.htmlBackground)
  expect(metrics.surfaceDarkDiv.appBackground).toBe(metrics.dark.htmlBackground)
  expect(metrics.surfaceDarkDiv.appPainted).not.toBe('rgb(255, 255, 255)')

})
