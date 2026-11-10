import { inpatientDrgPayerReviewListSchema, inpatientDrgPayerReviewPreviewSchema } from '@clinmesh/contracts/inpatient-drg-payer'
import { inpatientDepartureLabel } from '../src/app/inpatient-labels.ts'
import { expect, test } from './inpatient-drg.fixture.ts'
import { prepareInsurancePatient as prepare, selectInsurancePatient as select, assessInsurancePatient as assess, runInsuranceQueuePaginationJourney, runInsuranceQueueInvalidTargetJourney } from './inpatient-insurance-queue.journey.ts'

test('单病案核定丢回执恢复原意图，完成后保留当前且历史不重复提交', async ({ page, browserApp: app }) => {
  const record = await prepare(page, app, '合成单份医保核定')
  await record.api.login('medical-insurance')
  let posts = 0
  await page.route('**' + record.path + '/drg/payer-review', async route => {
    posts += 1
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    await route.abort('failed')
  })
  await page.goto(app.origin + '/inpatient')
  await assess(page, '合成单份原意图核定')
  await expect(page.getByRole('alert')).toContainText('无法连接科灵脉智服务')
  await page.reload()
  await page.getByRole('button', { name: '恢复原住院操作', exact: true }).click()
  await expect(page.getByRole('heading', { name: '本页核定已完成', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: '当前住院患者', exact: true })).toContainText(record.name)
  await select(page, record.name)
  await expect(page.getByRole('table')).toContainText('合成单份原意图核定')
  await expect(page.getByRole('button', { name: /^下一份：/ })).toHaveCount(0)
  expect(inpatientDrgPayerReviewListSchema.parse(await (await record.api.get(record.path + '/drg/payer-reviews')).json()).reviews).toHaveLength(1)
  expect(posts).toBe(1)
})

test('两病案连续核定并按病例绑定成功回执，头部只读许可摘要中的真实事实', async ({ page, browserApp: app }) => {
  const first = await prepare(page, app, '合成医保核定甲')
  const second = await prepare(page, app, '合成医保核定乙', 'bed-general-2')
  await first.api.login('medical-insurance')
  let posts = 0
  const forbidden: string[] = []
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (request.method() === 'POST' && path.endsWith('/drg/payer-review')) posts += 1
    if (path.includes('/fhir/') || path.endsWith('/inpatient/catalog')) forbidden.push(path)
  })
  await page.goto(app.origin + '/inpatient')
  await select(page, first.name)
  const projected = inpatientDrgPayerReviewPreviewSchema.parse(await (await first.api.get(first.path + '/drg/payer-review-preview')).json()).caseSummary.groupingInput
  const header = page.getByRole('region', { name: '当前住院患者', exact: true })
  await expect(header).toContainText('女 · ' + projected.ageYears + ' 岁')
  await expect(header).toContainText(inpatientDepartureLabel(projected.dischargeMode, 'zh-CN'))
  await expect(header).not.toContainText('住院 0 天')
  await assess(page, '合成甲核定')
  await expect(page.getByRole('button', { name: `下一份：${second.name}`, exact: true })).toBeVisible()
  await select(page, second.name)
  await expect(page.getByRole('button', { name: /^下一份：/ })).toHaveCount(0)
  await select(page, first.name)
  await page.getByRole('button', { name: `下一份：${second.name}`, exact: true }).click()
  await expect(header).toContainText(second.name)
  await expect(page.getByRole('button', { name: /^下一份：/ })).toHaveCount(0)
  await assess(page, '合成乙核定')
  await expect(page.getByRole('heading', { name: '本页核定已完成', exact: true })).toBeVisible()
  await expect(header).toContainText(second.name)
  await select(page, first.name)
  await expect(page.getByRole('table')).toContainText('合成甲核定')
  expect(posts).toBe(2)
  expect(forbidden).toEqual([])
})

test('十二份归档病案只读取当前十份核定状态，翻页与下一份不扫描或带入旧回执', async ({ page, browserApp: app }) => {
  test.setTimeout(120_000)
  await runInsuranceQueuePaginationJourney(page, app)
})

test('下一份读取失败留当前，固定目标被外窗核定后不补第三人', async ({ page, browserApp: app }) => {
  await runInsuranceQueueInvalidTargetJourney(page, app)
})
