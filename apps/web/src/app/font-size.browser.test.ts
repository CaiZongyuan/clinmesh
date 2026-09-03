import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { build } from 'vite'
import { beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { renderInHeadlessChrome } from '../../../../scripts/headless-browser.ts'

const fontMetricsSchema = z.object({
  application: z.string(),
  controlSm: z.string(),
  documentRoot: z.string(),
  iconWidth: z.string(),
  paddingLeft: z.string(),
  text2Xs: z.string(),
  textSm: z.string(),
  textXs: z.string(),
})
const browserMetricsSchema = z.object({
  desktopBrand: z.string(),
  desktopControlSm: z.string(),
  desktopPlatform: z.string(),
  modes: z.object({
    large: fontMetricsSchema,
    larger: fontMetricsSchema,
    standard: fontMetricsSchema,
  }),
})
type BrowserMetrics = z.infer<typeof browserMetricsSchema>

async function buildClinmeshStyles(): Promise<string> {
  const result = await build({
    build: {
      cssCodeSplit: false,
      lib: {
        entry: fileURLToPath(new URL('./font-size.browser.fixture.ts', import.meta.url)),
        fileName: 'font-size-browser',
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
  if (cssAssets.length !== 1) throw new Error('Font-size browser test requires exactly one CSS asset.')
  const asset = cssAssets[0]
  if (asset === undefined || asset.type !== 'asset') throw new Error('Missing built ClinMesh stylesheet.')
  return typeof asset.source === 'string' ? asset.source : Buffer.from(asset.source).toString()
}

function testDocument(clinmeshStyles: string): string {
  return `<!doctype html>
<html data-clinmesh-app="web">
  <head>
    <meta charset="UTF-8">
    <style>${clinmeshStyles}</style>
  </head>
  <body>
    <div id="standalone" class="clinmesh-web-root" data-clinmesh-app="web" data-font-size="standard">
      <span id="text-2xs" class="text-[length:var(--text-2xs)]">Extra small</span>
      <span id="text-xs" class="text-xs">Small</span>
      <span id="text-sm" class="text-sm">Base</span>
      <span id="control-sm" class="text-[length:var(--text-control-sm)]">Control small</span>
      <span id="icon" class="size-4"></span>
      <span id="spacing" class="block p-4"></span>
    </div>
    <div id="desktop">
      <span id="desktop-brand" class="cm-brand">Desktop</span>
      <span id="desktop-control-sm" class="text-[length:var(--text-control-sm)]">Control</span>
      <span id="desktop-platform" class="cm-platform">Platform</span>
    </div>
    <script>
      const applicationRoot = document.querySelector('#standalone')
      const read = () => ({
        application: getComputedStyle(applicationRoot).fontSize,
        controlSm: getComputedStyle(document.querySelector('#control-sm')).fontSize,
        documentRoot: getComputedStyle(document.documentElement).fontSize,
        iconWidth: getComputedStyle(document.querySelector('#icon')).width,
        paddingLeft: getComputedStyle(document.querySelector('#spacing')).paddingLeft,
        text2Xs: getComputedStyle(document.querySelector('#text-2xs')).fontSize,
        textSm: getComputedStyle(document.querySelector('#text-sm')).fontSize,
        textXs: getComputedStyle(document.querySelector('#text-xs')).fontSize,
      })
      const modes = {}
      for (const fontSize of ['standard', 'larger', 'large']) {
        applicationRoot.dataset.fontSize = fontSize
        modes[fontSize] = read()
      }
      document.documentElement.removeAttribute('data-clinmesh-app')
      document.title = btoa(JSON.stringify({
        desktopBrand: getComputedStyle(document.querySelector('#desktop-brand')).fontSize,
        desktopControlSm: getComputedStyle(document.querySelector('#desktop-control-sm')).fontSize,
        desktopPlatform: getComputedStyle(document.querySelector('#desktop-platform')).fontSize,
        modes,
      }))
    </script>
  </body>
</html>`
}

async function readBrowserMetrics(): Promise<BrowserMetrics> {
  const rendered = await renderInHeadlessChrome(testDocument(await buildClinmeshStyles()))
  const encodedMetrics = /<title>([^<]+)<\/title>/.exec(rendered)?.[1]
  if (encodedMetrics === undefined) throw new Error('Chrome did not return font-size metrics.')
  return browserMetricsSchema.parse(JSON.parse(
    Buffer.from(encodedMetrics, 'base64').toString('utf8'),
  ))
}

describe('Web font-size browser contract', () => {
  let metrics: BrowserMetrics

  beforeAll(async () => {
    metrics = await readBrowserMetrics()
  }, 30_000)

  it('scales Web typography without changing layout tokens or shared Desktop defaults', () => {
    expect(metrics.desktopBrand).toBe('18px')
    expect(metrics.desktopControlSm).toBe('12.8px')
    expect(metrics.desktopPlatform).toBe('13px')
    expect(metrics.modes.standard).toEqual({
      application: '13px',
      controlSm: '12.8px',
      documentRoot: '16px',
      iconWidth: '16px',
      paddingLeft: '16px',
      text2Xs: '10px',
      textSm: '13px',
      textXs: '12px',
    })
    expect(metrics.modes.larger).toEqual({
      application: '14.625px',
      controlSm: '14.4px',
      documentRoot: '16px',
      iconWidth: '16px',
      paddingLeft: '16px',
      text2Xs: '11.25px',
      textSm: '14.625px',
      textXs: '13.5px',
    })
    expect(metrics.modes.large).toEqual({
      application: '16.25px',
      controlSm: '16px',
      documentRoot: '16px',
      iconWidth: '16px',
      paddingLeft: '16px',
      text2Xs: '12.5px',
      textSm: '16.25px',
      textXs: '15px',
    })
  })
})
