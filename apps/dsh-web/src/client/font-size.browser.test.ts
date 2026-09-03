import { beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { readJsonFromHeadlessChrome } from '../../../../scripts/headless-browser.ts'
import { buildSurfaceStyles } from '../surface-styles.ts'

const surfaceMetricsSchema = z.object({
  application: z.string(),
  host: z.string(),
  iconWidth: z.string(),
  paddingLeft: z.string(),
  textSm: z.string(),
  textXs: z.string(),
})
type SurfaceMetrics = z.infer<typeof surfaceMetricsSchema>

function testDocument(surfaceStyles: string): string {
  const styleSource = JSON.stringify(surfaceStyles).replaceAll('<', '\\u003c')
  return `<!doctype html>
<html>
  <head><meta charset="UTF-8"></head>
  <body style="font-size: 17px">
    <div id="surface-host"></div>
    <script>
      const host = document.querySelector('#surface-host')
      const shadowRoot = host.attachShadow({ mode: 'open' })
      const style = document.createElement('style')
      style.textContent = ${styleSource}
      const applicationRoot = document.createElement('div')
      applicationRoot.className = 'clinmesh-web-root'
      applicationRoot.dataset.clinmeshApp = 'web'
      applicationRoot.dataset.fontSize = 'large'
      applicationRoot.innerHTML = [
        '<span id="text-xs" class="text-xs">Small</span>',
        '<span id="text-sm" class="text-sm">Base</span>',
        '<span id="icon" class="size-4"></span>',
        '<span id="spacing" class="block p-4"></span>',
      ].join('')
      shadowRoot.append(style, applicationRoot)
      document.title = btoa(JSON.stringify({
        application: getComputedStyle(applicationRoot).fontSize,
        host: getComputedStyle(host).fontSize,
        iconWidth: getComputedStyle(shadowRoot.querySelector('#icon')).width,
        paddingLeft: getComputedStyle(shadowRoot.querySelector('#spacing')).paddingLeft,
        textSm: getComputedStyle(shadowRoot.querySelector('#text-sm')).fontSize,
        textXs: getComputedStyle(shadowRoot.querySelector('#text-xs')).fontSize,
      }))
    </script>
  </body>
</html>`
}

async function readSurfaceMetrics(): Promise<SurfaceMetrics> {
  return surfaceMetricsSchema.parse(await readJsonFromHeadlessChrome(
    testDocument(await buildSurfaceStyles()),
  ))
}

describe('DSH Surface font-size browser contract', () => {
  let metrics: SurfaceMetrics

  beforeAll(async () => {
    metrics = await readSurfaceMetrics()
  }, 30_000)

  it('scales ClinMesh typography inside ShadowRoot without scaling the host', () => {
    expect(metrics).toEqual({
      application: '16.25px',
      host: '17px',
      iconWidth: '16px',
      paddingLeft: '16px',
      textSm: '16.25px',
      textXs: '15px',
    })
  })
})
