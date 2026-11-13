import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { test, expect } from '../../../web/e2e/fixtures.ts'
import {
  openDoctorFirstVisit,
  readDoctorBillingCase,
  startInvestigationBillingServer,
} from '../../../web/e2e/investigation-billing.fixture.ts'
import { openOutpatientReportReaderWorkspace } from '../../../web/e2e/outpatient-report-reader.journey.ts'
import { runInpatientExamination, runOutpatientExamination } from '../../../web/e2e/examination.journey.ts'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)
async function buildExaminationSurface(version: string) {
  const styles = await buildSurfaceStyles(),
    react = version === '18' ? 'react18' : 'react',
    reactDom = version === '18' ? 'react-dom18' : 'react-dom'
  const generatedStyles = '\0clinmesh-examination-styles'
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    esbuild: { jsx: 'automatic', jsxDev: false },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    plugins: [
      {
        name: 'examination-styles',
        resolveId(source) {
          if (source === './styles.generated.ts') return generatedStyles
        },
        load(id) {
          if (id === generatedStyles) return `export const clinMeshStyles = ${JSON.stringify(styles)}`
        },
      },
    ],
    resolve: {
      alias: [
        {
          find: '@clinmesh/web/application',
          replacement: fileURLToPath(new URL('../../../web/src/app/web-app.tsx', import.meta.url)),
        },
        {
          find: '@clinmesh/web/runtime',
          replacement: fileURLToPath(new URL('../../../web/src/app/web-runtime.tsx', import.meta.url)),
        },
        { find: /^react$/, replacement: require.resolve(react) },
        { find: 'react/jsx-runtime', replacement: require.resolve(`${react}/jsx-runtime`) },
        { find: 'react-dom/client', replacement: require.resolve(`${reactDom}/client`) },
        { find: /^react-dom$/, replacement: require.resolve(reactDom) },
        {
          find: '@deepseek-ai/dsh-client-ui-primitives',
          replacement: fileURLToPath(new URL('./dsh-ui-primitives.test-stub.tsx', import.meta.url)),
        },
        {
          find: 'dsh-react-surface/client',
          replacement: fileURLToPath(
            new URL('../../../../vendor/dsh-react-surface/packages/runtime/src/client/index.tsx', import.meta.url),
          ),
        },
      ],
    },
    build: {
      write: false,
      lib: {
        entry: fileURLToPath(new URL('./investigation-billing.browser.fixture.tsx', import.meta.url)),
        formats: ['iife'],
        name: 'ExaminationSurface',
      },
    },
  })
  const script = (Array.isArray(result) ? result : [result])
    .flatMap((output) => ('output' in output ? output.output : []))
    .find((output) => output.type === 'chunk')
  if (script?.type !== 'chunk') throw new Error('Missing examination Surface bundle')
  return script.code
}

for (const version of ['18', '19'])
  test.describe(`无像素功能检查 React ${version}`, () => {
    let script: string
    test.beforeAll(async () => {
      test.setTimeout(120_000)
      script = await buildExaminationSurface(version)
    })
    test('真实ShadowRoot完成门诊住院开立、护士送检与连续报告已阅', async ({ page, webRoot }, testInfo) => {
      test.setTimeout(120_000)
      const app = await startInvestigationBillingServer(webRoot, false, { normalCardiovascularBaseline: true })
      const errors: string[] = [],
        pixels: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.route(/\/blocks\/|\/tiles\//, async (route) => {
        pixels.push(route.request().url())
        await route.abort('blockedbyclient')
      })
      await page.route('**/examination-surface?*', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`,
        }),
      )
      await page.route('**/clinmesh-api/**', (route) => {
        const url = new URL(route.request().url())
        return route.continue({ url: `${app.origin}${url.pathname.replace('/clinmesh-api', '/api')}${url.search}` })
      })
      const open = async (view = '/consultation') => {
        await page.goto(`${app.origin}/examination-surface?view=${encodeURIComponent(view)}`)
        await expect(page.locator('.clinmesh-web-root')).toBeVisible()
      }
      try {
        await openDoctorFirstVisit(page, app)
        const before = await readDoctorBillingCase(page, app)
        await openOutpatientReportReaderWorkspace(page, { app, before }, () => open())
        await runOutpatientExamination(page, app, () => open())
        await runInpatientExamination(page, app, () => open('/inpatient'))
        expect(
          await page
            .getByRole('button', { name: '连续阅读住院报告', exact: true })
            .evaluate((element) => element.getRootNode() instanceof ShadowRoot),
        ).toBe(true)
        await page.screenshot({ path: testInfo.outputPath('examination-text.png') })
        expect(errors).toEqual([])
        expect(pixels).toEqual([])
      } finally {
        await app.close()
      }
    })
  })
