import { confirmDoctorPreparationResponseSchema } from '@clinmesh/contracts/doctor-recommendations'
import { test as base, expect } from './fixtures.ts'
import { openDoctorFirstVisit, readDoctorBillingCase, startInvestigationBillingServer } from './investigation-billing.fixture.ts'
import { openWorkspaceTab } from './workspace-tabs.fixture.ts'

const test = base.extend<{ imagingServer: Awaited<ReturnType<typeof startInvestigationBillingServer>> }>({
  imagingServer: async ({ webRoot }, use) => {
    const server = await startInvestigationBillingServer(webRoot, true)
    try { await use(server) } finally { await server.close() }
  },
})

for (const outcome of ['success', 'failure'] as const) {
  test(`protects the imaging discard confirmation while deleting and allows exit after ${outcome}`, async ({ page, imagingServer: server }) => {
    await openDoctorFirstVisit(page, server)
    const initial = await readDoctorBillingCase(page, server)
    const saved = await page.request.put(`${server.origin}/api/his/v1/encounters/${initial.encounter.id}/imaging-request/draft`, {
      headers: { 'idempotency-key': `synthetic-discard-${outcome}`, origin: server.origin },
      data: { expectedVersions: { [`Encounter/${initial.encounter.id}`]: initial.encounter.versionId },
        input: { expectedDraftVersion: initial.imagingRequests!.draftVersion, serviceId: 'imaging-chest-ct-plain', indication: '合成检查指征' } },
    })
    expect(saved.status()).toBe(200)
    await page.reload()
    await openWorkspaceTab(page, '检验检查')
    await page.getByRole('tab', { name: /^放射检查 \d+$/ }).click()
    const pending = page.getByRole('region', { name: '待开具放射检查', exact: true })
    await expect(pending.getByRole('checkbox', { name: '选择胸部 CT 平扫', exact: true })).toBeVisible()
    let releaseDelete: () => void = () => { throw new Error('Deletion is not pending') }
    const deletion = new Promise<void>(resolve => { releaseDelete = resolve })
    let deletes = 0
    await page.route('**/imaging-request/draft', async route => {
      if (route.request().method() !== 'DELETE') return route.continue()
      deletes += 1
      await deletion
      if (outcome === 'failure') return route.fulfill({ status: 409, json: {
        error: { code: 'WORKFLOW_CONFLICT', message: '合成草稿删除失败' },
      } })
      return route.continue()
    })
    try {
      const trigger = page.getByRole('button', { name: '清空待开清单', exact: true })
      await trigger.click()
      const confirmation = page.getByRole('alertdialog', { name: '丢弃全部手动待开放射检查？', exact: true })
      await confirmation.getByRole('button', { name: '确认清空', exact: true }).click()
      await expect.poll(() => deletes).toBe(1)
      await expect(confirmation.getByRole('button', { name: '取消', exact: true })).toBeDisabled()
      await page.keyboard.press('Escape')
      await expect(confirmation).toBeVisible()
      releaseDelete()
      if (outcome === 'failure') {
        await expect(confirmation.getByRole('alert')).toBeVisible()
        await expect(confirmation.getByRole('button', { name: '取消', exact: true })).toBeEnabled()
        await page.keyboard.press('Escape')
        await expect(pending.getByRole('checkbox', { name: '选择胸部 CT 平扫', exact: true })).toBeVisible()
      } else {
        await expect(pending.getByRole('checkbox')).toHaveCount(0)
      }
      await expect(confirmation).toBeHidden()
      const current = await readDoctorBillingCase(page, server)
      if (outcome === 'failure') expect(current.imagingRequests?.draft?.indication).toBe('合成检查指征')
      else expect(current.imagingRequests?.draft).toBeUndefined()
      expect(current.imagingRequests?.requests).toHaveLength(0)
      expect(deletes).toBe(1)
    } finally { releaseDelete() }
  })
}

test('restores two manual imaging drafts and recovers a partial confirmation without repeating its successful request or charge', async ({ page, imagingServer: server }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const pixels: string[] = []
  await page.route('**/api/his/v1/imaging-studies/**', async route => { pixels.push(route.request().url()); await route.abort() })
  await openDoctorFirstVisit(page, server)
  const enter = async () => {
    await openWorkspaceTab(page, '检验检查')
    await page.getByRole('tab', { name: /^放射检查 \d+$/ }).click()
  }
  await enter()
  const pending = page.getByRole('region', { name: '待开具放射检查', exact: true })
  await pending.getByRole('button', { name: '添加放射检查', exact: true }).click()
  const composer = page.getByRole('dialog', { name: '选择放射检查', exact: true })
  for (const [name, indication] of [['胸部 CT 平扫', '持续咳嗽，合成 CT 指征。'], ['胸片', '胸痛，合成胸片独立指征。']]) {
    await composer.getByRole('button', { name: new RegExp(`^${name}`) }).click()
    await composer.getByLabel('检查指征', { exact: true }).fill(indication!)
    await composer.getByRole('button', { name: '加入放射检查', exact: true }).click()
    await expect(composer).toBeVisible()
  }
  await composer.getByRole('button', { name: '关闭', exact: true }).click()
  await page.reload()
  await enter()
  await expect(pending.getByRole('checkbox')).toHaveCount(2)
  await expect(pending.getByText('持续咳嗽，合成 CT 指征。', { exact: true })).toBeVisible()
  await expect(pending.getByText('胸痛，合成胸片独立指征。', { exact: true })).toBeVisible()
  expect((await readDoctorBillingCase(page, server)).imagingRequests?.requests).toHaveLength(0)
  const changed = server.runtime.database.driver.prepare(`UPDATE hospital_service_catalog SET version=version+1,
    config_json=json_set(config_json, '$.imagingService.version', version+1,
      '$.imagingService.outpatientBilling.version', 2, '$.imagingService.outpatientBilling.priceFen', 9000)
    WHERE service_id='imaging-chest-radiograph'`).run()
  expect(changed.changes).toBe(1)
  const posts: Array<{ key: string | undefined; body: unknown }> = []
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/recommendations/imaging/actions/confirm')) {
      posts.push({ key: request.headers()['idempotency-key'], body: request.postDataJSON() })
    }
  })
  await page.route('**/recommendations/imaging/actions/confirm', async route => {
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    await route.abort('failed')
  }, { times: 1 })
  await pending.getByRole('button', { name: '开具选中项目（2）', exact: true }).click()
  await expect(pending.getByRole('button', { name: '恢复原开立', exact: true })).toBeVisible()
  await expect(pending.getByRole('button', { name: '恢复原开立', exact: true })).toBeEnabled()
  expect((await readDoctorBillingCase(page, server)).imagingRequests?.requests).toHaveLength(1)
  await page.reload()
  await enter()
  const receipt = page.waitForResponse(response => response.url().includes('/recommendations/imaging/confirmations/'))
  await pending.getByRole('button', { name: '恢复原开立', exact: true }).click()
  const result = confirmDoctorPreparationResponseSchema.parse(await (await receipt).json()).data
  expect(result.results?.map(item => item.status)).toEqual(['succeeded', 'failed'])
  expect((await receipt).url()).toContain(posts[0]!.key!)
  expect(posts).toHaveLength(1)
  await expect(pending.getByText('成功 1 项，失败 1 项。失败输入已保留。', { exact: true })).toBeVisible()
  await expect(pending.getByRole('checkbox')).toHaveCount(1)
  await expect(pending.getByRole('checkbox', { name: '选择胸片', exact: true })).toBeChecked()
  await pending.getByRole('button', { name: '添加放射检查', exact: true }).click()
  await composer.getByRole('button', { name: /^胸片/ }).click()
  await expect(composer.getByText('¥90.00 / 次检查 × 1', { exact: true })).toBeVisible()
  await composer.getByLabel('检查指征', { exact: true }).fill('胸痛，合成胸片独立指征。')
  await composer.getByRole('button', { name: '加入放射检查', exact: true }).click()
  await composer.getByRole('button', { name: '关闭', exact: true }).click()
  await pending.getByRole('button', { name: '开具选中项目（1）', exact: true }).click()
  await expect.poll(async () => (await readDoctorBillingCase(page, server)).imagingRequests?.requests.length).toBe(2)
  expect(posts).toHaveLength(2)
  expect(posts[1]!.key).not.toBe(posts[0]!.key)
  const records = (await readDoctorBillingCase(page, server)).imagingRequests!.requests
  expect(new Set(records.map(item => item.service.id)).size).toBe(2)
  expect(new Set(records.map(item => item.billing?.chargeItemId)).size).toBe(2)
  expect(records.map(item => item.billing?.remainingFen).sort()).toEqual([9000, 30000].sort())
  await page.reload()
  await enter()
  await expect(pending.getByRole('checkbox')).toHaveCount(0)
  expect((await readDoctorBillingCase(page, server)).imagingRequests?.requests).toHaveLength(2)
  expect(pixels).toEqual([])
})
