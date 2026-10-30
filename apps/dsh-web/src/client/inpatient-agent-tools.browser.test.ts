import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test } from '../../../web/e2e/fixtures.ts'
import { buildSurfaceStyles } from '../surface-styles.ts'
import type { Page } from '@playwright/test'

async function bindingSubject(page: Page, app: { origin: string; password: string }, role: string) {
  const { origin, password } = app
  const login = async (name: string) => expect((await page.request.post(`${origin}/api/auth/sign-in/email`, {
    headers: { origin }, data: { email: `${name}@demo.clinmesh.local`, password },
  })).status()).toBe(200)
  const post = (path: string, input: unknown) => page.request.post(`${origin}${path}`, { headers: { origin, 'idempotency-key': randomUUID() }, data: { input } })
  await login('registrar')
  const patientResponse = await page.request.post(`${origin}/api/his/v1/patients`, { headers: { origin, 'idempotency-key': randomUUID() },
    data: { expectedVersions: {}, input: { name: '合成上下文绑定患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } } })
  expect(patientResponse.status()).toBe(200)
  const patient = (await patientResponse.json()).data.patient
  const registered = await post('/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 0 })
  expect(registered.status()).toBe(200)
  const admission = (await registered.json()).data.admission, path = `/api/his/v1/inpatient/admissions/${admission.id}`
  await login('ward-nurse')
  const received = await post(`${path}/receive`, { encounterVersion: admission.versionId, bedId: 'bed-general-1' })
  expect(received.status()).toBe(200)
  const current = (await received.json()).data.admission
  await login('inpatient-doctor')
  const issued = await post(`${path}/orders/issue`, { encounterVersion: current.versionId, duration: 'temporary', selection: { kind: 'service', serviceId: 'hospital-service-diabetes-education', serviceVersion: 1, quantity: 1 } })
  expect(issued.status()).toBe(200)
  const order = (await issued.json()).data.orders[0]
  await login(role)
  return { admission: current, path, order }
}

function reportedImage(admissionId: string) {
  return { admissionId, laboratoryRequests: [], sent: [], imagingRequests: [{ id: 'synthetic-imaging-request', version: 3, status: 'reported',
    indication: '合成门禁核对', serviceRequestId: 'synthetic-service', serviceRequestVersion: '2', taskId: 'synthetic-task', taskVersion: '3',
    service: { id: 'synthetic-imaging', version: 1, applicability: '合成成人', bodySite: '胸部', code: 'SYN', department: '放射科', examCode: 'chest-radiograph', method: '正位', modality: 'DX', name: '合成胸片', reportSections: ['findings', 'impression', 'technique'] },
    previousReports: [], report: { diagnosticReportId: 'synthetic-imaging-report', diagnosticReportVersion: '1', revisionNumber: 1,
      examinedAt: '2026-08-24T09:00:00+08:00', issuedAt: '2026-08-24T09:00:00+08:00', status: 'final', studyId: 'synthetic-study', findings: '合成所见', impression: '合成印象', technique: '合成检查方法' } }] }
}

const require = createRequire(import.meta.url)
for (const version of ['18', '19']) test.describe(`inpatient Agent React ${version}`, () => {
  let code: string, styles: string
  test.beforeAll(async () => {
    const react = version === '18' ? 'react18' : 'react', dom = version === '18' ? 'react-dom18' : 'react-dom'
    const result = await build({ configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic', jsxDev: false },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') }, resolve: { alias: [
        { find: /^react$/, replacement: require.resolve(react) }, { find: 'react/jsx-runtime', replacement: require.resolve(`${react}/jsx-runtime`) },
        { find: 'react-dom/client', replacement: require.resolve(`${dom}/client`) }, { find: /^react-dom$/, replacement: require.resolve(dom) },
      ] }, build: { write: false, lib: { entry: fileURLToPath(new URL('./inpatient-agent-tools.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'InpatientAgent' } } })
    const chunk = (Array.isArray(result) ? result : [result]).flatMap(result => 'output' in result ? result.output : []).find(item => item.type === 'chunk')
    if (chunk?.type !== 'chunk') throw new Error('Missing inpatient Agent fixture')
    code = chunk.code
    styles = await buildSurfaceStyles()
  })
  test('护士助手在医嘱行准备校对，由人工确认；中止不会提交', async ({ page, browserApp }) => {
    const { origin, password } = browserApp
    const login = async (role: string) => expect((await page.request.post(`${origin}/api/auth/sign-in/email`, {
      headers: { origin }, data: { email: `${role}@demo.clinmesh.local`, password },
    })).status()).toBe(200)
    const post = (path: string, input: unknown) => page.request.post(`${origin}${path}`, { headers: { origin, 'idempotency-key': randomUUID() }, data: { input } })
    await login('registrar')
    const patient = (await (await page.request.post(`${origin}/api/his/v1/patients`, { headers: { origin, 'idempotency-key': randomUUID() },
      data: { expectedVersions: {}, input: { name: '合成助手校对患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } } })).json()).data.patient
    const admission = (await (await post('/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 0 })).json()).data.admission
    const path = `/api/his/v1/inpatient/admissions/${admission.id}`
    await login('ward-nurse')
    const received = (await (await post(`${path}/receive`, { encounterVersion: admission.versionId, bedId: 'bed-general-1' })).json()).data.admission
    await login('inpatient-doctor')
    const issued = await post(`${path}/orders/issue`, { encounterVersion: received.versionId, duration: 'temporary', selection: { kind: 'service', serviceId: 'hospital-service-diabetes-education', serviceVersion: 1, quantity: 1 } })
    expect(issued.status()).toBe(200)
    const order = (await issued.json()).data.orders[0]
    await login('ward-nurse')
    await page.route(`${origin}/inpatient-agent-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await page.goto(`${origin}/inpatient-agent-contract`)
    await page.setContent(`<!doctype html><html data-order-id="${order.id}"><head><style>${styles}</style></head><body><script>${code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    await page.getByRole('button', { name: /1床 合成助手校对患者/ }).click()
    await expect(page.getByLabel('当前上下文')).toContainText(order.id)
    await page.getByRole('button', { name: '助手准备校对', exact: true }).click()
    const review = page.getByRole('region', { name: '校对医嘱', exact: true })
    await expect(review).toBeVisible()
    expect(await review.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
    await expect(page.getByRole('article').filter({ hasText: order.display }).getByRole('region', { name: '校对医嘱', exact: true })).toBeVisible()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await page.getByRole('button', { name: '中止助手', exact: true }).click()
    await expect(review).toHaveCount(0)
    expect((await (await page.request.get(`${origin}${path}/clinical`)).json()).orders[0].state).toBe('signed')
    await page.getByRole('button', { name: '助手准备校对', exact: true }).click()
    await review.getByRole('button', { name: '确认校对', exact: true }).click()
    await expect(page.getByLabel('助手结果')).toHaveText('人工已确认')
    expect((await (await page.request.get(`${origin}${path}/clinical`)).json()).orders[0].state).toBe('verified')
  })
  test('收费助手只填写和预览，人工原位收款结算后仍可进入财务更正', async ({ page, browserApp }) => {
    const { origin, password } = browserApp
    const login = async (role: string) => expect((await page.request.post(`${origin}/api/auth/sign-in/email`, {
      headers: { origin }, data: { email: `${role}@demo.clinmesh.local`, password },
    })).status()).toBe(200)
    const post = (path: string, input: unknown) => page.request.post(`${origin}${path}`, { headers: { origin, 'idempotency-key': randomUUID() }, data: { input } })
    await login('registrar')
    const patient = (await (await page.request.post(`${origin}/api/his/v1/patients`, { headers: { origin, 'idempotency-key': randomUUID() },
      data: { expectedVersions: {}, input: { name: '合成助手补交患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } } })).json()).data.patient
    const admission = (await (await post('/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 0 })).json()).data.admission
    const path = `/api/his/v1/inpatient/admissions/${admission.id}`
    await login('ward-nurse')
    const received = (await (await post(`${path}/receive`, { encounterVersion: admission.versionId, bedId: 'bed-general-1' })).json()).data.admission
    await login('admin')
    expect((await post('/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', { expectedVirtualTime: '2026-08-24T09:00:00+08:00', targetVirtualTime: '2026-08-25T00:00:00+08:00' })).status()).toBe(200)
    await login('inpatient-doctor')
    const issued = (await (await post(`${path}/discharge/issue`, { encounterVersion: received.versionId, reason: '合成治疗结束' })).json()).data.admission
    await login('ward-nurse')
    expect((await post(`${path}/discharge/depart`, { encounterVersion: issued.versionId, reason: '合成交接完成', departureMethod: 'home' })).status()).toBe(200)
    await login('cashier')
    await page.route(`${origin}/inpatient-agent-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await page.goto(`${origin}/inpatient-agent-contract`)
    await page.setContent(`<!doctype html><html><head><style>${styles}</style></head><body><script>${code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    await page.getByRole('button', { name: '查看合成助手补交患者', exact: true }).click()
    await page.getByRole('button', { name: '助手填写补交', exact: true }).click()
    const cash = page.getByRole('textbox', { name: '现金金额（元）', exact: true })
    await expect(cash).toHaveValue('50.00')
    await expect(cash).toHaveCSS('border-style', 'dashed')
    await cash.fill('40.00')
    await expect(cash).toHaveCSS('border-style', 'solid')
    await page.getByRole('button', { name: '助手填写补交', exact: true }).click()
    await page.getByRole('button', { name: '助手预览收款', exact: true }).click()
    const bar = page.getByRole('region', { name: '当前操作', exact: true })
    await expect(bar.getByRole('button', { name: '确认收款', exact: true })).toBeVisible()
    expect((await (await page.request.get(`${origin}${path}/payments`)).json()).payments).toEqual([])
    await bar.getByRole('button', { name: '确认收款', exact: true }).click()
    await expect(page.getByTestId('inpatient-funding-balance')).toContainText('0.00')
    await page.getByRole('button', { name: '助手预览结算', exact: true }).click()
    await expect(bar.getByRole('button', { name: '确认结算', exact: true })).toBeVisible()
    expect((await (await page.request.get(`${origin}${path}`)).json()).admission.financialStatus).toBe('open')
    await bar.getByRole('button', { name: '确认结算', exact: true }).click()
    await expect(page.getByRole('region', { name: '后续财务更正', exact: true })).toBeVisible()
    await expect(page.getByRole('tab', { name: '病案', exact: true })).toHaveCount(0)
    expect((await (await page.request.get(`${origin}${path}`)).json()).admission.financialStatus).toBe('settled')
  })
  test('影像尚未实际显示时，医生助手不能准备已阅或发出确认请求', async ({ page, browserApp }) => {
    const { origin, password } = browserApp
    const login = async (role: string) => expect((await page.request.post(`${origin}/api/auth/sign-in/email`, {
      headers: { origin }, data: { email: `${role}@demo.clinmesh.local`, password },
    })).status()).toBe(200)
    const post = (path: string, input: unknown) => page.request.post(`${origin}${path}`, { headers: { origin, 'idempotency-key': randomUUID() }, data: { input } })
    await login('registrar')
    const patient = (await (await page.request.post(`${origin}/api/his/v1/patients`, { headers: { origin, 'idempotency-key': randomUUID() },
      data: { expectedVersions: {}, input: { name: '合成报告门禁患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } } })).json()).data.patient
    const admission = (await (await post('/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 0 })).json()).data.admission
    const path = `/api/his/v1/inpatient/admissions/${admission.id}`
    await login('ward-nurse')
    expect((await post(`${path}/receive`, { encounterVersion: admission.versionId, bedId: 'bed-general-1' })).status()).toBe(200)
    await login('inpatient-doctor')
    await page.route(`${origin}${path}/investigations`, route => route.fulfill({ json: { admissionId: admission.id,
      laboratoryRequests: [], sent: [], imagingRequests: [{ id: 'synthetic-imaging-request', version: 3, status: 'reported',
        indication: '合成门禁核对', serviceRequestId: 'synthetic-service', serviceRequestVersion: '2', taskId: 'synthetic-task', taskVersion: '3',
        service: { id: 'synthetic-imaging', version: 1, applicability: '合成成人', bodySite: '胸部', code: 'SYN', department: '放射科',
          examCode: 'chest-radiograph', method: '正位', modality: 'DX', name: '合成胸片', reportSections: ['findings', 'impression', 'technique'] },
        previousReports: [], report: { diagnosticReportId: 'synthetic-imaging-report', diagnosticReportVersion: '1', revisionNumber: 1,
          examinedAt: '2026-08-24T09:00:00+08:00', issuedAt: '2026-08-24T09:00:00+08:00', status: 'final', studyId: 'synthetic-study',
          findings: '合成所见', impression: '合成印象', technique: '合成检查方法' } }],
    } }))
    let acknowledgements = 0
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/investigations/acknowledge')) acknowledgements++ })
    await page.route(`${origin}/inpatient-agent-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await page.goto(`${origin}/inpatient-agent-contract`)
    await page.setContent(`<!doctype html><html><head><style>${styles}</style></head><body><script>${code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    await page.getByRole('button', { name: '查看合成报告门禁患者', exact: true }).click()
    await page.getByRole('button', { name: '助手切到检查检验', exact: true }).click()
    await expect(page.getByRole('tab', { name: '检查检验', exact: true })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('button', { name: '助手准备已阅', exact: true }).click()
    await expect(page.getByLabel('助手结果')).toContainText('请先实际查看该报告的影像')
    await expect(page.getByRole('region', { name: '已阅报告', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '已阅', exact: true })).toBeDisabled()
    expect(acknowledgements).toBe(0)
  })
  for (const part of ['actor', 'workspace', 'epoch', 'account', 'scenario', 'role', 'roleCode', 'organization', 'ward', 'practitioner']) test(`原${part}任务不能在相同住院ID与修订的新上下文打开校对确认`, async ({ page, browserApp }) => {
    const subject = await bindingSubject(page, browserApp, 'ward-nurse'), { origin } = browserApp
    await page.route(`${origin}/inpatient-agent-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await page.goto(`${origin}/inpatient-agent-contract`)
    let writes = 0
    page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/api/his/v1/inpatient/')) writes++ })
    await page.setContent(`<!doctype html><html data-binding-mode="namespace" data-admission-id="${subject.admission.id}" data-order-id="${subject.order.id}"><head><style>${styles}</style></head><body><script>${code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    await expect(page.getByLabel('当前上下文')).toContainText(subject.order.id)
    await page.getByRole('button', { name: '捕获当前校对任务', exact: true }).click()
    await page.getByRole('button', { name: `切换 ${part}`, exact: true }).click()
    await expect(page.getByLabel('当前身份范围')).toContainText(part === 'roleCode' ? 'inpatient-doctor' : `${part}-collision`)
    await page.getByRole('button', { name: '执行旧校对任务', exact: true }).click()
    await expect(page.getByLabel('助手结果')).toContainText('当前岗位或患者资料已变化')
    await expect(page.getByRole('region', { name: '校对医嘱', exact: true })).toHaveCount(0)
    expect(writes).toBe(0)
    expect((await (await page.request.get(`${origin}${subject.path}/clinical`)).json()).orders[0].state).toBe('signed')
  })
  test('旧报告影像的显示证明不能用于相同version1的新报告ID', async ({ page, browserApp }) => {
    const subject = await bindingSubject(page, browserApp, 'inpatient-doctor'), { origin } = browserApp
    await page.route(`${origin}${subject.path}/investigations`, route => route.fulfill({ json: reportedImage(subject.admission.id) }))
    await page.route(`${origin}/api/his/v1/imaging-studies/synthetic-study`, route => route.fulfill({ json: {
      studyId: 'synthetic-study', available: true, examCode: 'chest-radiograph', series: [{ kind: 'frame-stack', modality: 'DX', pixelFormat: 'uint16', valueUnit: 'stored',
        frames: [{ blocks: [{ length: 8, rowCount: 2, rowStart: 0 }], columns: 2, rows: 2, pixelSpacingMm: null, view: 'frontal', window: { center: 2048, width: 4096 } }] }],
    } }))
    await page.route(`${origin}/api/his/v1/imaging-studies/synthetic-study/series/0/frames/0/blocks/0`, route => route.fulfill({ contentType: 'application/octet-stream', body: Buffer.alloc(8) }))
    await page.route(`${origin}/inpatient-agent-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await page.goto(`${origin}/inpatient-agent-contract`)
    let writes = 0
    page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/api/his/v1/inpatient/')) writes++ })
    await page.setContent(`<!doctype html><html data-binding-mode="report" data-admission-id="${subject.admission.id}"><head><style>${styles}</style></head><body><script>${code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    await page.getByRole('button', { name: '查看影像', exact: true }).click()
    await expect(page.getByRole('button', { name: '已阅', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '准备当前报告已阅', exact: true }).click()
    const review = page.getByRole('region', { name: '已阅报告', exact: true })
    await expect(review).toBeVisible()
    await review.getByRole('button', { name: '不采用', exact: true }).click()
    await expect(page.getByLabel('助手结果')).toHaveText('人工未采用')
    await page.getByRole('button', { name: '接收新报告上下文', exact: true }).click()
    await expect(page.getByLabel('当前上下文')).toContainText('synthetic-imaging-report-new')
    await expect(page.getByText('合成所见', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '准备当前报告已阅', exact: true }).click()
    await expect(page.getByLabel('助手结果')).toContainText('请先实际查看该报告的影像')
    await expect(review).toHaveCount(0)
    expect(writes).toBe(0)
  })
})
