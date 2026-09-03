import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import tailwindcss from '@tailwindcss/vite'
import { build } from 'vite'
import { beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

const execFileAsync = promisify(execFile)

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
  modes: z.object({
    large: fontMetricsSchema,
    larger: fontMetricsSchema,
    standard: fontMetricsSchema,
  }),
  surfaceApp: z.string(),
  surfaceHost: z.string(),
})
type BrowserMetrics = z.infer<typeof browserMetricsSchema>

function findChrome(): string {
  const configuredPath = process.env.CHROME_PATH
  const candidates = [
    configuredPath,
    ...(process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : [
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
          ]),
  ]
  const chromePath = candidates.find(candidate => candidate !== undefined && existsSync(candidate))
  if (chromePath === undefined) {
    throw new Error('Chrome is required for the Web font-size browser test; set CHROME_PATH.')
  }
  return chromePath
}

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
    <div id="surface-host" style="font-size: 17px">
      <div id="surface-app" class="clinmesh-web-root" data-clinmesh-app="web" data-font-size="large">Surface</div>
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
      document.title = btoa(JSON.stringify({
        modes,
        surfaceApp: getComputedStyle(document.querySelector('#surface-app')).fontSize,
        surfaceHost: getComputedStyle(document.querySelector('#surface-host')).fontSize,
      }))
    </script>
  </body>
</html>`
}

async function readBrowserMetrics(): Promise<BrowserMetrics> {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-font-size-'))
  const htmlPath = join(directory, 'index.html')
  const profilePath = join(directory, 'chrome-profile')
  try {
    await writeFile(htmlPath, testDocument(await buildClinmeshStyles()), 'utf8')
    const { stdout } = await execFileAsync(findChrome(), [
      '--headless=new',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      `--user-data-dir=${profilePath}`,
      '--dump-dom',
      pathToFileURL(htmlPath).href,
    ], { maxBuffer: 10 * 1024 * 1024, timeout: 20_000 })
    const encodedMetrics = /<title>([^<]+)<\/title>/.exec(stdout)?.[1]
    if (encodedMetrics === undefined) throw new Error('Chrome did not return font-size metrics.')
    return browserMetricsSchema.parse(JSON.parse(
      Buffer.from(encodedMetrics, 'base64').toString('utf8'),
    ))
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

describe('Web font-size browser contract', () => {
  let metrics: BrowserMetrics

  beforeAll(async () => {
    metrics = await readBrowserMetrics()
  }, 30_000)

  it('scales rendered typography without scaling the document, layout tokens, or Surface host', () => {
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
    expect(metrics.surfaceApp).toBe('16.25px')
    expect(metrics.surfaceHost).toBe('17px')
  })
})
