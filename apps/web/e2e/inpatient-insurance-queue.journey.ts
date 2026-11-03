import { expect, type Page } from '@playwright/test'
import { inpatientDrgPayerReviewPreviewSchema } from '@clinmesh/contracts/inpatient-drg-payer'
import { inpatientListSchema } from '@clinmesh/contracts/inpatient'
import { archiveDrgBrowserPatient, createDrgBrowserPatient } from './inpatient-drg.fixture.ts'

export async function prepareInsurancePatient(page: Page, app: { origin: string; password: string }, name: string, bed = 'bed-general-1') {
  const record = await createDrgBrowserPatient(page, app, name, bed)
  await archiveDrgBrowserPatient(record)
  return record
}
export async function selectInsurancePatient(page: Page, name: string) {
  await page.getByRole('button', { name: new RegExp(name) }).click()
  await expect(page.getByRole('region', { name: '当前住院患者', exact: true })).toContainText(name)
}
export async function assessInsurancePatient(page: Page, note: string) {
  await page.getByLabel('核定说明', { exact: true }).fill(note)
  await page.getByRole('button', { name: '审阅模拟核定', exact: true }).click()
  await page.getByRole('button', { name: '提交模拟核定', exact: true }).click()
}

export async function runInsuranceQueuePaginationJourney(page: Page, app: { origin: string; password: string }, openWorkspace?: () => Promise<void>) {
  const records = []
  for (let index = 1; index <= 12; index++) records.push(await prepareInsurancePatient(page, app, `合成分页医保${String(index).padStart(2, '0')}`))
  const api = records[0]!.api
  await api.login('medical-insurance')
  const ordered = inpatientListSchema.parse(await (await api.get('/api/his/v1/inpatient/admissions')).json()).items
  expect(ordered).toHaveLength(12)
  const first = ordered[0]!, second = ordered[1]!, last = ordered[11]!
  const pending = new Set([first.id, second.id, last.id])
  for (const item of ordered.filter(item => !pending.has(item.id))) {
    const path = `/api/his/v1/inpatient/admissions/${item.id}/drg`
    const preview = inpatientDrgPayerReviewPreviewSchema.parse(await (await api.get(path + '/payer-review-preview')).json())
    expect((await api.post(path + '/payer-review', { encounterVersion: preview.encounterVersion, expectedFingerprint: preview.fingerprint, reason: '合成已有核定历史' })).status()).toBe(200)
  }
  const reads: string[] = [], posts: string[] = []
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (path.endsWith('/drg/payer-reviews')) reads.push(path.split('/').at(-3)!)
    if (request.method() === 'POST' && path.endsWith('/drg/payer-review')) posts.push(path)
  })
  if (openWorkspace) await openWorkspace()
  else await page.goto(app.origin + '/inpatient')
  const queue = page.getByRole('region', { name: '核定队列', exact: true })
  await expect(queue.getByRole('button', { name: new RegExp(ordered[9]!.patientName) })).toBeVisible()
  await expect(queue.getByRole('button', { name: /^合成分页医保/ })).toHaveCount(10)
  expect(reads).toHaveLength(10)
  expect(new Set(reads)).toEqual(new Set(ordered.slice(0, 10).map(item => item.id)))
  await expect(queue).toContainText('核定分组与计数仅限本页病案')
  await selectInsurancePatient(page, first.patientName)

  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let holdReads = true, reached = false
  await page.route(`**/admissions/${second.id}/drg/payer-reviews`, async route => {
    if (holdReads) { reached = true; await held }
    await route.continue()
  })
  try {
    await assessInsurancePatient(page, '合成第一页首份核定')
    await expect.poll(() => reached).toBe(true)
    await expect(page.getByRole('button', { name: '下一份', exact: true })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: '本页核定已完成', exact: true })).toHaveCount(0)
    holdReads = false; release()
    await expect(page.getByRole('button', { name: '下一份', exact: true })).toBeVisible()
  } finally { holdReads = false; release() }

  await queue.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(queue.getByRole('button', { name: /^合成分页医保/ })).toHaveCount(2)
  await expect(page.getByRole('region', { name: '当前住院患者', exact: true })).toContainText(ordered[10]!.patientName)
  await expect(page.getByRole('button', { name: '下一份', exact: true })).toHaveCount(0)
  expect(new Set(reads)).toEqual(new Set(ordered.map(item => item.id)))
  await queue.getByRole('button', { name: '上一页', exact: true }).click()
  await selectInsurancePatient(page, first.patientName)
  await page.getByRole('button', { name: '下一份', exact: true }).click()
  await expect(page.getByRole('region', { name: '当前住院患者', exact: true })).toContainText(second.patientName)
  await expect(page.getByRole('button', { name: '下一份', exact: true })).toHaveCount(0)
  await assessInsurancePatient(page, '合成第一页末份核定')
  await page.getByRole('button', { name: '下一份', exact: true }).click()
  await expect(page.getByRole('heading', { name: '本页核定已完成', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '本次核定已完成', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '继续下一页', exact: true }).click()
  await expect(page.getByRole('region', { name: '当前住院患者', exact: true })).toContainText(last.patientName)
  await expect(page.getByRole('button', { name: '下一份', exact: true })).toHaveCount(0)
  await assessInsurancePatient(page, '合成跨页末份核定')
  await expect(page.getByRole('region', { name: '当前住院患者', exact: true })).toContainText(last.patientName)
  await expect(page.getByRole('button', { name: '下一份', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '下一份', exact: true }).click()
  await expect(page.getByRole('heading', { name: '本页核定已完成', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '继续下一页', exact: true })).toHaveCount(0)
  expect(posts).toHaveLength(3)

  const failedStatus = `**/admissions/${ordered[10]!.id}/drg/payer-reviews`
  await page.route(failedStatus, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_READ_FAILURE', message: '合成核定状态读取失败' } }) }))
  await queue.getByRole('button', { name: '刷新', exact: true }).click()
  await expect(page.getByRole('heading', { name: '本页核定状态待确认', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '本页核定已完成', exact: true })).toHaveCount(0)
  await page.unroute(failedStatus)
  await queue.getByRole('button', { name: '重试核定状态', exact: true }).click()
  await expect(page.getByRole('heading', { name: '本页核定已完成', exact: true })).toBeVisible()

  // 新的显式复核意图用于验证继续到已全核定的页，不把历史首项误选成待办。
  await queue.getByRole('button', { name: '上一页', exact: true }).click()
  await selectInsurancePatient(page, first.patientName)
  await assessInsurancePatient(page, '合成再次显式核对归档依据')
  await page.getByRole('button', { name: '下一份', exact: true }).click()
  await page.getByRole('button', { name: '继续下一页', exact: true }).click()
  await expect(page.getByRole('heading', { name: '本页暂无待核定病案', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: '当前住院患者', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '下一份', exact: true })).toHaveCount(0)
  expect(posts).toHaveLength(4)
}
