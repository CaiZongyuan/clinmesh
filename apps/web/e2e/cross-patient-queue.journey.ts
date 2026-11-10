import type { Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { registrationCatalogSchema } from '@clinmesh/contracts/his'
import { inpatientListSchema } from '@clinmesh/contracts/inpatient'
import { inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
import { syntheticCaseInstanceSchema, syntheticPatientProfileDetailSchema } from '@clinmesh/contracts/scenario'
import { createDrgBrowserPatient, drgBrowserApi, expect, submitDrgBrowserPatient } from './inpatient-drg.fixture.ts'
import { observeQueuePage, preparePatientLibraryQueue } from './cross-patient-queue.fixture.ts'

type App = Parameters<typeof preparePatientLibraryQueue>[1]
export type QueueJourneyOptions = {
  open?: () => Promise<void>
  stage?: (name: string) => Promise<void>
  loseReviewResponse?: boolean
}

export async function prepareRecordQueue(page: Page, app: App, count = 2) {
  const records = []
  for (const name of ['合成连续病案甲', '合成连续病案乙', '合成连续病案丙'].slice(0, count)) {
    const record = await createDrgBrowserPatient(page, app, name)
    await submitDrgBrowserPatient(record)
    records.push(record)
  }
  const api = drgBrowserApi(page, app)
  await api.login('medical-records')
  const ordered = inpatientListSchema.parse(await (await api.get('/api/his/v1/inpatient/admissions')).json()).items
  expect(ordered).toHaveLength(count)
  for (const item of ordered) {
    const record = inpatientRecordSchema.parse(await (await api.get(`/api/his/v1/inpatient/admissions/${item.id}/record`)).json())
    expect(record.revision?.revision).toBe(1)
    expect(record.revision?.sourcesHash).toBe(record.sourcesHash)
    expect(record.reviews).toEqual([])
    expect(record.reviewCurrent).toBe(false)
    expect(record.archive).toBeUndefined()
    expect(item.recordStatus).toBe('open')
    expect(item.financialStatus).toBe('settled')
    expect(item.status).toBe('cleared')
  }
  return { api, ordered }
}

export async function runRecordQueueInvalidTargetJourney(page: Page, app: App, options: QueueJourneyOptions = {}) {
  const observer = await observeQueuePage(page)
  const { api, ordered: [first, second, third] } = await prepareRecordQueue(page, app, 3)
  if (!first || !second || !third) throw new Error('Expected three submitted synthetic records')
  if (options.open) await options.open(); else await page.goto(app.origin + '/inpatient')
  await page.getByRole('button', { name: `查看${first.patientName}`, exact: true }).click()
  await page.getByRole('button', { name: '编码审核通过', exact: true }).click()
  const next = page.getByRole('button', { name: `下一份：${second.patientName}`, exact: true })
  await expect(next).toBeVisible()
  const path = `/api/his/v1/inpatient/admissions/${second.id}/record`
  const secondRecord = inpatientRecordSchema.parse(await (await api.get(path)).json())
  expect((await api.post(path + '/review', { expectedRevision: secondRecord.revision!.revision, expectedSourcesHash: secondRecord.sourcesHash, outcome: 'approved', reason: '合成其他窗口先行审核' })).status()).toBe(200)
  await next.click()
  await expect(page.getByRole('status').filter({ hasText: '目标病案状态已变化' })).toBeVisible()
  await expect(page.getByRole('region', { name: '当前住院患者', exact: true })).toContainText(first.patientName)
  await expect(page.getByRole('button', { name: `下一份：${third.patientName}`, exact: true })).toHaveCount(0)
  expect(inpatientRecordSchema.parse(await (await api.get(`/api/his/v1/inpatient/admissions/${third.id}/record`)).json()).reviews).toEqual([])
  observer.assertClean()
}

export async function runRecordQueueJourney(page: Page, app: App, options: QueueJourneyOptions = {}) {
  const observer = await observeQueuePage(page)
  const { api, ordered: [first, second] } = await prepareRecordQueue(page, app)
  if (!first || !second) throw new Error('Expected two submitted synthetic records')
  const writes: string[] = []
  page.on('request', request => { if (request.method() === 'POST' && /\/record\/(review|archive)$/.test(new URL(request.url()).pathname)) writes.push(new URL(request.url()).pathname.replace('/clinmesh-api', '/api')) })
  if (options.open) await options.open(); else await page.goto(app.origin + '/inpatient')
  await page.getByRole('button', { name: `查看${first.patientName}`, exact: true }).click()
  const current = page.getByRole('region', { name: '当前住院患者', exact: true })
  let originalKey: string | undefined
  if (options.loseReviewResponse) await page.route(`**/admissions/${first.id}/record/review`, async route => {
    originalKey = route.request().headers()['idempotency-key']
    expect((await route.fetch({ url: route.request().url().replace('/clinmesh-api', '/api') })).status()).toBe(200)
    await route.abort('failed')
  })
  await options.stage?.('病案：分别审核与归档，办理后保留当前病例')
  await page.getByRole('button', { name: '编码审核通过', exact: true }).click()
  if (options.loseReviewResponse) {
    await expect(page.getByRole('button', { name: '恢复原住院操作', exact: true })).toBeVisible()
    await expect(current).toContainText(first.patientName)
    await page.reload()
    await expect(current).toContainText(first.patientName)
    const receipt = page.waitForRequest(request => request.url().includes('/command-receipts?'))
    await page.getByRole('button', { name: '恢复原住院操作', exact: true }).click()
    const lookup = new URL((await receipt).url())
    expect(lookup.searchParams.get('operationId')).toBe('inpatient.record.review')
    expect(lookup.searchParams.get('idempotencyKey')).toBe(originalKey)
    await page.unroute(`**/admissions/${first.id}/record/review`)
  }
  const next = page.getByRole('button', { name: `下一份：${second.patientName}`, exact: true })
  await expect(next).toBeVisible()
  await expect(current).toContainText(first.patientName)
  expect(writes).toEqual([`/api/his/v1/inpatient/admissions/${first.id}/record/review`])
  await page.getByRole('button', { name: '归档病案', exact: true }).click()
  await expect(page.getByRole('region', { name: '当前操作', exact: true })).toContainText('病案已归档')
  await expect(current).toContainText(first.patientName)
  await expect(next).toBeVisible()
  const secondBefore = inpatientRecordSchema.parse(await (await api.get(`/api/his/v1/inpatient/admissions/${second.id}/record`)).json())
  expect(secondBefore.reviews).toEqual([])
  expect(secondBefore.archive).toBeUndefined()
  await options.stage?.('病案：明确点击具名下一份，只切换，不自动审核')
  await next.click()
  await expect(current).toContainText(second.patientName)
  expect(writes).toHaveLength(2)
  await expect(page.getByRole('button', { name: '编码审核通过', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '编码审核通过', exact: true }).click()
  await page.getByRole('button', { name: '归档病案', exact: true }).click()
  await expect(page.getByRole('region', { name: '当前操作', exact: true })).toContainText('病案已归档')
  await expect(current).toContainText(second.patientName)
  await expect(page.getByRole('button', { name: /^下一份：/ })).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: '本次待审核队列已完成' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: '本次待归档队列已完成' })).toBeVisible()
  expect(writes).toEqual([first, second].flatMap(item => ['review', 'archive'].map(action => `/api/his/v1/inpatient/admissions/${item.id}/record/${action}`)))
  observer.assertClean()
  return { first, second, writes }
}

export async function openPatientLibrary(page: Page, app: App, options: QueueJourneyOptions) {
  if (options.open) await options.open(); else await page.goto(app.origin + '/scenario-data')
  await page.getByRole('tab', { name: '患者库', exact: true }).click()
}

export async function confirmLibraryVisit(page: Page) {
  await page.getByRole('button', { name: '开始门诊就诊', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '开始门诊就诊', exact: true })
  await expect(dialog.getByLabel('就诊科室', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '开始门诊就诊', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

export async function runPatientLibraryQueueJourney(page: Page, app: App, options: QueueJourneyOptions = {}) {
  const observer = await observeQueuePage(page)
  const prepared = await preparePatientLibraryQueue(page, app)
  const [first, second, third] = prepared.ordered
  if (!first || !second || !third) throw new Error('Expected three brief-ready synthetic patients')
  const posts: string[] = []
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/actions/start-outpatient-visit')) posts.push(new URL(request.url()).pathname) })
  await openPatientLibrary(page, app, options)
  const queue = page.getByRole('region', { name: '患者库队列', exact: true })
  await queue.getByRole('button', { name: new RegExp(first.name) }).click()
  await options.stage?.('患者库：逐患者核对后开始门诊，不批量起诊')
  await confirmLibraryVisit(page)
  const continuation = page.getByRole('region', { name: '连续开始门诊', exact: true })
  await expect(continuation).toContainText('当前患者门诊已开始')
  await expect(page.getByRole('heading', { name: first.name, exact: true })).toBeVisible()
  await expect(continuation.getByRole('button', { name: `下一位：${second.name}`, exact: true })).toBeVisible()
  expect(posts).toHaveLength(1)
  for (const target of [second, third]) {
    await options.stage?.(`患者库：显式选择${target.name}，再次人工确认`)
    await continuation.getByRole('button', { name: `下一位：${target.name}`, exact: true }).click()
    await expect(page.getByRole('heading', { name: target.name, exact: true })).toBeVisible()
    expect(posts).toHaveLength(target.profileId === second.profileId ? 1 : 2)
    await confirmLibraryVisit(page)
    await expect(continuation).toContainText('当前患者门诊已开始')
    await expect(page.getByRole('heading', { name: target.name, exact: true })).toBeVisible()
  }
  await expect(continuation).toContainText('当前队列已完成')
  await expect(continuation.getByRole('button', { name: /^下一位：/ })).toHaveCount(0)
  expect(posts).toHaveLength(3)
  for (const item of prepared.ordered) {
    const detail = syntheticPatientProfileDetailSchema.parse(await (await prepared.api.get(`/api/sim/v1/synthetic-patients/${item.profileId}`)).json())
    expect(detail.case?.status).toBe('started')
  }
  observer.assertClean()
  return { ...prepared, posts }
}

export async function runPatientLibraryRecoveryJourney(page: Page, app: App, options: QueueJourneyOptions = {}) {
  const observer = await observeQueuePage(page)
  const prepared = await preparePatientLibraryQueue(page, app)
  const [first, second, third] = prepared.ordered
  if (!first || !second || !third) throw new Error('Expected three brief-ready synthetic patients')
  const firstCase = prepared.details.find(detail => detail.profileId === first.profileId)!.case!
  const targetCase = prepared.details.find(detail => detail.profileId === second.profileId)!.case!
  let posts = 0, originalKey: string | undefined
  await openPatientLibrary(page, app, options)
  await page.route(`**/synthetic-cases/${firstCase.caseId}/actions/start-outpatient-visit`, async route => {
    posts++
    originalKey = route.request().headers()['idempotency-key']
    const response = await route.fetch({ url: route.request().url().replace('/clinmesh-api', '/api') })
    expect(response.status()).toBe(200)
    await route.abort('failed')
  })
  await page.getByRole('region', { name: '患者库队列', exact: true }).getByRole('button', { name: new RegExp(first.name) }).click()
  await page.getByRole('button', { name: '开始门诊就诊', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '开始门诊就诊', exact: true })
  await dialog.getByRole('button', { name: '开始门诊就诊', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: '无法连接' })).toBeVisible()
  expect(syntheticCaseInstanceSchema.parse(await (await prepared.api.get(`/api/sim/v1/synthetic-cases/${firstCase.caseId}`)).json()).status).toBe('started')
  await page.reload()
  await page.getByRole('tab', { name: '患者库', exact: true }).click()
  const receipt = page.waitForRequest(request => request.url().includes('/command-receipts?'))
  await page.getByRole('button', { name: '查询原门诊开始结果', exact: true }).click()
  const lookup = new URL((await receipt).url())
  expect(lookup.searchParams.get('operationId')).toBe('registration.synthetic-case.start')
  expect(lookup.searchParams.get('idempotencyKey')).toBe(originalKey)
  const continuation = page.getByRole('region', { name: '连续开始门诊', exact: true })
  const next = continuation.getByRole('button', { name: `下一位：${second.name}`, exact: true })
  await expect(next).toBeVisible()
  expect(posts).toBe(1)
  await expect(page.getByRole('heading', { name: first.name, exact: true })).toBeVisible()
  const catalog = registrationCatalogSchema.parse(await (await prepared.api.get('/api/his/v1/catalogs/registration')).json())
  const currentTarget = syntheticCaseInstanceSchema.parse(await (await prepared.api.get(`/api/sim/v1/synthetic-cases/${targetCase.caseId}`)).json())
  const external = await page.request.post(`${app.origin}/api/his/v1/synthetic-cases/${targetCase.caseId}/actions/start-outpatient-visit`, {
    headers: { origin: app.origin, 'idempotency-key': randomUUID() }, data: {
      activeBriefRevision: currentTarget.activeBriefRevision, expectedCaseRevision: currentTarget.revision,
      departmentId: catalog.departments[0]!.id, locationId: catalog.locations[0]!.id,
      visitTypeId: catalog.visitTypes[0]!.id, visitDate: catalog.virtualDate,
    },
  })
  expect(external.status()).toBe(200)
  await next.click()
  await expect(page.getByRole('alert').filter({ hasText: '下一位患者已不符合开始条件' })).toBeVisible()
  await expect(page.getByRole('heading', { name: first.name, exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: `下一位：${third.name}`, exact: true })).toHaveCount(0)
  expect(posts).toBe(1)
  const untouched = syntheticPatientProfileDetailSchema.parse(await (await prepared.api.get(`/api/sim/v1/synthetic-patients/${third.profileId}`)).json())
  expect(untouched.case?.status).toBe('brief-ready')
  observer.assertClean()
}
