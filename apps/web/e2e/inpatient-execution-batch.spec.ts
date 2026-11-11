import { expect, test } from './inpatient-pci.fixture.ts'
import { sessionContextSchema } from '@clinmesh/contracts/his'
import { inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { openExecutionBatch, openInpatientExecutionWorkspace, prepareInpatientExecutionBatch, runInpatientExecutionBatchJourney, runInpatientExecutionRecoveryJourney } from './inpatient-execution-batch.journey.ts'

test('护士从三类真实待办进入独立给药窗口，未核实实际发生时不可选择且无全选', async ({ page, pciApp }) => {
  test.setTimeout(120_000)
  await prepareInpatientExecutionBatch(page, pciApp)
  await page.getByRole('button', { name: '集中记录给药', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '集中记录给药', exact: true })
  await expect(dialog).toBeVisible()
  const choices = dialog.getByRole('checkbox', { name: /^选择给药：/ })
  await expect(choices).toHaveCount(2)
  for (const choice of await choices.all()) { await expect(choice).not.toBeChecked(); await expect(choice).toBeDisabled() }
  await expect(dialog.getByRole('button', { name: /全选/ })).toHaveCount(0)
})

test('护士分别确认实际给药、实际教育与不同最终理由的 PRN，原执行和费用各保存一次', async ({ page, pciApp }) => {
  test.setTimeout(120_000)
  const subject = await prepareInpatientExecutionBatch(page, pciApp)
  await runInpatientExecutionBatchJourney(page, subject)
})

test('教育第二项真实保存后丢响应即停止，刷新只查原回执，余项重新核对确认', async ({ page, pciApp }) => {
  test.setTimeout(120_000)
  const subject = await prepareInpatientExecutionBatch(page, pciApp, { educationCount: 3 })
  await runInpatientExecutionRecoveryJourney(page, subject)
})

test('执行清单存储枚举或删除受限时真实退出仍成功，恢复存储后同账号不恢复原未提交输入', async ({ page, pciApp }) => {
  test.setTimeout(120_000)
  const subject = await prepareInpatientExecutionBatch(page, pciApp)
  const execution = subject.before.executions.find(row => row.status === 'dispensed')!
  const errors: string[] = [], writes: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    if (request.method() === 'POST' && /\/executions\/(administer|complete|request-prn)$/.test(new URL(request.url()).pathname)) writes.push(request.url())
  })
  for (const restriction of ['enumeration', 'removal'] as const) {
    const dialog = await openExecutionBatch(page, 'administer')
    const row = dialog.getByRole('article', { name: `给药项目：${execution.id}`, exact: true })
    await row.getByRole('checkbox', { name: /^已核实实际给药：/ }).check()
    await row.getByRole('checkbox', { name: /^选择给药：/ }).check()
    await expect(dialog.getByRole('region', { name: '给药待办清单', exact: true }).getByRole('article')).toHaveCount(1)
    await dialog.getByRole('button', { name: '关闭办理窗口', exact: true }).click()
    const originalDrafts = await page.evaluate(kind => {
      const descriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage'), storage = sessionStorage
      if (!descriptor) throw new Error('Missing the native storage descriptor')
      const keys = Object.keys(storage).filter(key => key.startsWith('clinmesh.execution-batch:'))
      const original = keys.map(key => storage.getItem(key))
      const evidence = { enumeration: 0, removal: 0, retained: () => keys.map(key => storage.getItem(key)) }
      const limited = new Proxy(storage, {
        ownKeys(target) {
          if (kind === 'enumeration') { evidence.enumeration += 1; throw new DOMException('合成存储枚举被禁止', 'SecurityError') }
          return Reflect.ownKeys(target)
        },
        get(target, key) {
          if (kind === 'removal' && key === 'removeItem') return () => { evidence.removal += 1; throw new DOMException('合成存储删除被禁止', 'SecurityError') }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      Reflect.set(window, '__issue425StorageRestriction', evidence)
      Reflect.set(window, '__issue425RestoreStorage', () => Object.defineProperty(window, 'sessionStorage', descriptor))
      Object.defineProperty(window, 'sessionStorage', { configurable: true, get: () => limited })
      return original
    }, restriction)
    expect(originalDrafts).toHaveLength(1)
    try {
      const signedOut = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/sign-out' && response.request().method() === 'POST')
      await page.getByRole('button', { name: '用户菜单', exact: true }).click()
      await page.getByRole('menuitem', { name: '退出登录', exact: true }).click()
      expect((await signedOut).status()).toBe(200)
      await expect(page.getByRole('heading', { name: '登录科灵脉智', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '登录', exact: true })).toBeEnabled()
      await expect(page.getByText(/退出(?:登录)?失败|Sign.?out failed/i)).toHaveCount(0)
      expect((await page.request.get(pciApp.origin + '/api/auth/context')).status()).toBe(401)
      const evidence = await page.evaluate(() => {
        const evidence = Reflect.get(window, '__issue425StorageRestriction')
        return { enumeration: evidence.enumeration, removal: evidence.removal, retained: evidence.retained() }
      })
      expect(evidence[restriction]).toBeGreaterThan(0)
      // 清理确实失败、旧私稿仍在存储中；不能把“本来已删干净”误判为防恢复成功。
      expect(evidence.retained).toEqual(originalDrafts)
    } finally {
      await page.evaluate(() => {
        const restore = Reflect.get(window, '__issue425RestoreStorage')
        if (typeof restore !== 'function') throw new Error('Missing the storage restoration')
        restore()
        Reflect.deleteProperty(window, '__issue425StorageRestriction')
        Reflect.deleteProperty(window, '__issue425RestoreStorage')
      })
    }
    // 保持同一真实页面运行时；经过真实登录入口触发待丢弃草稿的清理。
    await page.getByLabel('账户邮箱').fill('ward-nurse@demo.clinmesh.local')
    await page.getByLabel('账户密码').fill(pciApp.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(page.getByRole('button', { name: '用户菜单', exact: true })).toBeVisible()
    const session = sessionContextSchema.parse(await (await page.request.get(pciApp.origin + '/api/auth/context')).json())
    expect(session.user.id).toBe(subject.context.user.id)
    expect(session.actor).toEqual(subject.context.actor)
    await openInpatientExecutionWorkspace(page, subject, async () => {})
    const restored = await openExecutionBatch(page, 'administer')
    await expect(restored.getByRole('region', { name: '给药待办清单', exact: true }).getByRole('article')).toHaveCount(0)
    const candidate = restored.getByRole('article', { name: `给药项目：${execution.id}`, exact: true })
    await expect(candidate.getByRole('checkbox', { name: /^已核实实际给药：/ })).not.toBeChecked()
    await expect(candidate.getByRole('checkbox', { name: /^已核实实际给药：/ })).toBeEnabled()
    await expect(candidate.getByRole('checkbox', { name: /^选择给药：/ })).toBeDisabled()
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('clinmesh.execution-batch:')))).toEqual([])
    await restored.getByRole('button', { name: '关闭办理窗口', exact: true }).click()
  }
  expect(inpatientFullClinicalSchema.parse(await (await page.request.get(pciApp.origin + subject.path + '/clinical')).json())).toEqual(subject.before)
  expect(writes).toEqual([])
  expect(errors).toEqual([])
  expect(pciApp.modelCalls).toBe(0)
})
