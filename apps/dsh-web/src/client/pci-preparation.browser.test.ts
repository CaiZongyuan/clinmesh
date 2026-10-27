import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { inpatientListSchema } from '@clinmesh/contracts/inpatient'
import { pciCaseSourceResponseSchema } from '@clinmesh/contracts/inpatient-pci-data'
import { patientPersonaRevisionListSchema } from '@clinmesh/contracts/scenario'
import { expect, test } from '../../../web/e2e/fixtures.ts'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)

for (const version of ['18', '19']) test.describe(`PCI 页面准备 React ${version}`, () => {
  let artifact: { code: string; styles: string }
  test.beforeAll(async () => {
    test.setTimeout(120_000)
    const react = version === '18' ? 'react18' : 'react', reactDom = version === '18' ? 'react-dom18' : 'react-dom'
    const result = await build({ configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic', jsxDev: false },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      resolve: { alias: [{ find: /^react$/, replacement: require.resolve(react) },
        { find: 'react/jsx-runtime', replacement: require.resolve(`${react}/jsx-runtime`) },
        { find: 'react-dom/client', replacement: require.resolve(`${reactDom}/client`) },
        { find: /^react-dom$/, replacement: require.resolve(reactDom) }] },
      build: { write: false, lib: { entry: fileURLToPath(new URL('./pci-preparation.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'PciPreparation' } } })
    const chunk = (Array.isArray(result) ? result : [result]).flatMap(item => 'output' in item ? item.output : []).find(item => item.type === 'chunk')
    if (chunk?.type !== 'chunk') throw new Error('Missing PCI preparation fixture')
    artifact = { code: chunk.code, styles: await buildSurfaceStyles() }
  })

  test('管理员手工准备后登记员在 ShadowRoot 选择同一病例，恢复原回执不重复登记', async ({ page, browserApp }) => {
    test.setTimeout(60_000)
    const origin = browserApp.origin
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const login = async (role: string) => {
      await page.request.post(`${origin}/api/auth/sign-out`, { headers: { origin } })
      expect((await page.request.post(`${origin}/api/auth/sign-in/email`, {
        headers: { origin }, data: { email: `${role}@demo.clinmesh.local`, password: browserApp.password },
      })).status()).toBe(200)
    }
    await page.route(`${origin}/pci-preparation-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    const mount = async () => {
      await page.goto(`${origin}/pci-preparation-contract`)
      await page.setContent(`<!doctype html><html><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    }
    await login('registrar')
    await mount()
    await page.getByLabel('患者来源', { exact: true }).click()
    const sourceOption = page.getByRole('option', { name: '就绪合成病例', exact: true })
    expect(await sourceOption.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
    await sourceOption.click()
    await expect(page.getByText('暂无就绪病例，请管理员准备病例并创建、选择患者档案。', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '办理住院', exact: true })).toBeDisabled()
    await expect(page.getByLabel('预交金（元）', { exact: true })).toHaveCount(0)

    await login('admin')
    await mount()
    const preparation = page.getByRole('region', { name: 'PCI 演示准备', exact: true })
    await expect(preparation).toBeVisible()
    await preparation.getByRole('button', { name: '准备 PCI 目录', exact: true }).click()
    await expect(preparation.getByRole('status').filter({ hasText: '目录已安装' })).toContainText('5/5 药品')
    let sourcePosts = 0
    let sourceKey: string | undefined
    let prepared: ReturnType<typeof pciCaseSourceResponseSchema.parse> | undefined
    await page.route('**/api/sim/v1/synthetic-cases/pci/prepare', async route => {
      sourcePosts++
      sourceKey = route.request().headers()['idempotency-key']
      const response = await route.fetch()
      expect(response.status()).toBe(200)
      prepared = pciCaseSourceResponseSchema.parse(await response.json())
      await route.abort('failed')
    })
    await preparation.getByRole('button', { name: '准备固定 PCI 病例', exact: true }).click()
    await expect(preparation.getByRole('button', { name: '恢复原准备操作', exact: true })).toBeVisible()
    await mount()
    const recoveredSource = page.waitForRequest(request => request.url().includes('/command-receipts?'))
    await preparation.getByRole('button', { name: '恢复原准备操作', exact: true }).click()
    expect(new URL((await recoveredSource).url()).searchParams.get('idempotencyKey')).toBe(sourceKey)
    await expect(preparation.getByRole('status').filter({ hasText: '病例来源已准备' })).toBeVisible()
    expect(sourcePosts).toBe(1)
    if (prepared === undefined) throw new Error('Missing prepared source')
    const caseId = prepared.data.case.caseId

    await page.getByRole('button', { name: '手工创建患者档案', exact: true }).click()
    const editor = page.getByRole('form', { name: '编辑患者档案', exact: true })
    expect(await editor.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
    await expect(editor.getByLabel('主诉', { exact: true })).toBeEmpty()
    await editor.getByLabel('主诉', { exact: true }).fill('取消的临时草稿')
    await editor.getByRole('button', { name: '取消', exact: true }).click()
    await expect(editor).toHaveCount(0)
    await page.getByRole('button', { name: '手工创建患者档案', exact: true }).click()
    await expect(editor.getByLabel('主诉', { exact: true })).toBeEmpty()
    for (const [label, value] of [
      ['主诉', '活动后胸闷三个月，加重一周。'], ['开场陈述', '医生您好，我走路时胸口发闷，休息就会缓解。'],
      ['已知史', '没有已知药物过敏。'], ['症状体验', '走几百米会胸闷，停下休息几分钟可以缓解，没有晕厥。'],
      ['用药记忆', '近期没有自行增加药物。'], ['性格', '平和'], ['说话方式', '简短清楚'], ['健康素养', '普通'], ['就医态度', '愿意配合检查'],
    ]) await editor.getByLabel(label!, { exact: true }).fill(value!)
    await editor.getByRole('button', { name: '保存为新修订', exact: true }).click()
    await expect(editor).toHaveCount(0)
    await page.getByRole('button', { name: '设为当前', exact: true }).click()
    await expect(page.getByText('Active', { exact: true })).toBeVisible()
    const revisions = patientPersonaRevisionListSchema.parse(await (await page.request.get(`${origin}/api/sim/v1/synthetic-cases/${caseId}/patient-persona-revisions`)).json())
    expect(revisions.items).toMatchObject([{ revision: 1, model: 'administrator-manual' }])
    expect(revisions.activeRevision).toBe(1)

    await login('registrar')
    await mount()
    await page.getByLabel('患者来源', { exact: true }).click()
    await page.getByRole('option', { name: '就绪合成病例', exact: true }).click()
    await page.getByLabel('待住院合成病例', { exact: true }).click()
    const candidate = page.getByRole('option', { name: /合成冠脉病例甲/ })
    expect(await candidate.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(candidate).not.toBeVisible()
    await page.getByLabel('待住院合成病例', { exact: true }).click()
    await candidate.click()
    await expect(page.getByText(/Profile Revision 1 · Persona Revision 1/)).toBeVisible()
    await page.route('**/api/his/v1/synthetic-cases/*/actions/start-inpatient-visit', route => route.fulfill({
      status: 409, json: { error: { code: 'WORKFLOW_CONFLICT', message: 'Synthetic stale case revision' } },
    }), { times: 1 })
    await page.getByRole('button', { name: '办理住院', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('当前业务状态或前置条件不满足，请核对病例信息后重试。')
    await expect(page.getByRole('button', { name: '恢复原住院操作', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '刷新就绪病例', exact: true }).click()
    await page.getByLabel('待住院合成病例', { exact: true }).click()
    await candidate.click()
    let admissionPosts = 0
    let admissionKey: string | undefined
    await page.route('**/api/his/v1/synthetic-cases/*/actions/start-inpatient-visit', async route => {
      admissionPosts++
      admissionKey = route.request().headers()['idempotency-key']
      const response = await route.fetch()
      expect(response.status()).toBe(200)
      await route.abort('failed')
    })
    await page.getByRole('button', { name: '办理住院', exact: true }).click()
    await expect(page.getByRole('button', { name: '恢复原住院操作', exact: true })).toBeVisible()
    await expect(page.getByLabel('待住院合成病例', { exact: true })).toBeDisabled()
    await mount()
    const recoveredAdmission = page.waitForRequest(request => request.url().includes('/command-receipts?'))
    await page.getByRole('button', { name: '恢复原住院操作', exact: true }).click()
    expect(new URL((await recoveredAdmission).url()).searchParams.get('idempotencyKey')).toBe(admissionKey)
    await expect(page.getByRole('region', { name: '当前住院患者', exact: true })).toContainText('合成冠脉病例甲')
    expect(admissionPosts).toBe(1)
    const admissions = inpatientListSchema.parse(await (await page.request.get(`${origin}/api/his/v1/inpatient/admissions`)).json())
    expect(admissions.items).toMatchObject([{ status: 'registered', admissionRoute: 'direct', depositFen: 0, chargesFen: 0 }])
    expect(admissions.items).toHaveLength(1)
    expect(errors).toEqual([])
  })
})
