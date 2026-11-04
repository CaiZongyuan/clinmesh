import { expectInpatientBedCleared } from './inpatient-clearance.fixture.ts'
import { selectWorkspaceMode, selectInpatientStage } from './inpatient-ui.ts'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test as base } from './fixtures.ts'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { runReferenceDatabaseCli } from '../../server/src/reference-database-cli.ts'
import { syntheticNhsaMedicationProductSnapshot } from '../../server/src/application/scenario-data/medication-product-snapshot.ts'
import { syntheticNhcMedicalServiceSnapshot, syntheticWstValueSetSnapshot } from '../../server/src/application/scenario-data/medical-service-snapshot.ts'
import { inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
const test = base.extend({ browserApp: async ({ webRoot }, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-record-reference-')), database = join(directory, 'reference.sqlite')
    const artifact = JSON.stringify({ schemaVersion: '1', concepts: [{ id: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09', domain: 'diagnosis', system: 'urn:clinmesh:reference:nhsa-diagnosis', version: '2022', code: 'I10.x09', display: '合成临床版高血压', status: 'active', sourceLocator: 'cn-health:nhc-icd10-clinical@2022.r4:diagnosis:12457' }], medicationProducts: syntheticNhsaMedicationProductSnapshot, services: syntheticNhcMedicalServiceSnapshot, valueSetEntries: syntheticWstValueSetSnapshot })
    await writeFile(join(directory, 'reference.json'), artifact)
    await writeFile(join(directory, 'release.json'), JSON.stringify({ releaseId: 'synthetic-record-reference', schemaVersion: '1', createdAt: '2026-08-28T00:00:00.000Z', sources: [{ sourceId: 'synthetic-clinical', artifactPath: 'reference.json', acquisitionMethod: 'generated', checksum: createHash('sha256').update(artifact).digest('hex'), licenseId: 'CC0-1.0', retrievedAt: '2026-08-28T00:00:00.000Z', sourceUrl: 'https://example.test/clinical', upstreamVersion: '2022' }] }))
    await runReferenceDatabaseCli(['migrate', '--database', database])
    await runReferenceDatabaseCli(['import', '--database', database, '--manifest', join(directory, 'release.json')])
    const app = await startBrowserServer(webRoot, { referenceDatabasePath: database, activeReferenceReleaseId: 'synthetic-record-reference' })
    try {
      await use(app)
    }
    finally {
      await app.close()
      await rm(directory, { recursive: true, force: true })
    }
  } })
test('真实首页提交丢回执恢复、编码退回修订与归档，Scenario完成后仍可读固定首页', async ({ page, browserApp }) => {
  let first = true, activeRole = ''
  const login = async (name: string) => {
    activeRole = name
    if (!first) {
      await page.getByRole('button', { name: '用户菜单' }).click()
      await page.getByRole('menuitem', { name: '退出登录' }).click()
    }
    first = false
    await page.getByLabel('账户邮箱').fill(`${name}@demo.clinmesh.local`)
    await page.getByLabel('账户密码').fill(browserApp.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(page.getByRole('button', { name: '用户菜单' })).toBeVisible()
    if (name === 'cashier')
      await selectWorkspaceMode(page, '住院')
  }
  const post = (path: string, input: unknown) => page.request.post(`${browserApp.origin}${path}`, { headers: { origin: browserApp.origin, 'idempotency-key': randomUUID() }, data: { input } })
  const select = async () => {
    if (activeRole !== 'ward-nurse') return page.getByRole('button', { name: '查看合成病案患者', exact: true }).click()
    const records = page.locator('summary').filter({ hasText: '出院后病历' })
    await expect(records).toBeVisible()
    const patient = page.getByRole('button', { name: /合成病案患者/ })
    if (!await patient.isVisible()) await records.click()
    await patient.click()
  }
  await page.goto(`${browserApp.origin}/registration`)
  await login('registrar')
  const patient = (await (await page.request.post(`${browserApp.origin}/api/his/v1/patients`, { headers: { origin: browserApp.origin, 'idempotency-key': randomUUID() }, data: { expectedVersions: {}, input: { name: '合成病案患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } } })).json()).data.patient
  const session = await (await page.request.get(`${browserApp.origin}/api/auth/context`)).json()
  const admission = (await (await post('/api/his/v1/inpatient/admissions', { expectedEpoch: session.actor.epoch, patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100000 })).json()).data.admission, path = `/api/his/v1/inpatient/admissions/${admission.id}`
  await login('ward-nurse')
  expect((await post(`${path}/receive`, { encounterVersion: admission.versionId, bedId: 'bed-general-1' })).status()).toBe(200)
  await login('inpatient-doctor')
  await select()
  await page.getByRole('button', { name: '添加诊断', exact: true }).click()
  const diagnosisDialog = page.getByRole('dialog', { name: '确认住院诊断', exact: true })
  await diagnosisDialog.getByLabel('搜索诊断名称或编码', { exact: true }).fill('I10.x09')
  await diagnosisDialog.getByRole('button', { name: '加入合成临床版高血压', exact: true }).click()
  await diagnosisDialog.getByRole('group', { name: '合成临床版高血压 入院病情', exact: true }).getByRole('button', { name: '有', exact: true }).click()
  await diagnosisDialog.getByRole('button', { name: '确认住院诊断', exact: true }).click()
  await expect(page.getByRole('region', { name: '住院诊断摘要', exact: true }).locator('.clinmesh-inpatient-diagnosis-line').filter({ hasText: '合成临床版高血压' })).toBeVisible()
  await selectInpatientStage(page, "出院")
  await page.getByLabel('出院处理说明', { exact: true }).fill('本次治疗完成')
  await page.getByRole('button', { name: '开出院医嘱', exact: true }).click()
  await expect(page.getByRole('button', { name: '开出院医嘱', exact: true })).toHaveCount(0)
  await login('ward-nurse')
  await select()
  await page.getByLabel('出院处理说明', { exact: true }).fill('出区核对完成')
  await page.getByLabel('离院方式', { exact: true }).click()
  await page.getByRole('option', { name: '医嘱离院', exact: true }).click()
  await page.getByRole('button', { name: "办理出院", exact: true }).click()
  await expect(page.getByRole('button', { name: "办理出院", exact: true })).toHaveCount(0)
  await login('cashier')
  await select()
  await page.getByRole('button', { name: '预览结算', exact: true }).click()
  await page.getByRole('button', { name: '确认结算', exact: true }).click()
  await expect(page.getByText('已结算，等待病区清床', { exact: true })).toBeVisible()
  await login('ward-nurse')
  await select()
  await page.getByLabel('出院处理说明', { exact: true }).fill('床单位清洁')
  await page.getByRole('button', { name: '清床', exact: true }).click()
  await expectInpatientBedCleared(page, browserApp.origin, path)
  await login('inpatient-doctor')
  await select()
  let submits = 0, key: string | undefined
  await selectInpatientStage(page, '病案')
  await page.route(`**${path}/record/submit`, async (route) => { submits++; key = route.request().headers()['idempotency-key']; expect((await route.fetch()).status()).toBe(200); await route.abort('failed'); })
  await page.getByRole('button', { name: '提交病案首页', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('无法连接科灵脉智服务')
  await page.reload()
  await select()
  const lookup = page.waitForRequest(request => request.url().includes('/command-receipts?'))
  await page.getByRole('button', { name: '恢复原住院操作', exact: true }).click()
  expect(new URL((await lookup).url()).searchParams.get('idempotencyKey')).toBe(key)
  expect(submits).toBe(1)
  await page.unroute(`**${path}/record/submit`)
  await login('medical-records')
  await select()
  await page.getByLabel('编码审核说明', { exact: true }).fill('请主管医生再次核对')
  await page.getByRole('button', { name: '退回医生修订', exact: true }).click()
  await expect(page.getByText('退回', { exact: true })).toBeVisible()
  await login('inpatient-doctor')
  await select()
  await selectInpatientStage(page, '病案')
  await expect(page.getByRole('status').filter({ hasText: '病案人员退回' })).toContainText('请主管医生再次核对')
  await page.getByRole('button', { name: '重新提交病案首页', exact: true }).click()
  await expect.poll(async () => inpatientRecordSchema.parse(await (await page.request.get(`${browserApp.origin}${path}/record`)).json()).revision?.revision).toBe(2)
  await login('medical-records')
  await select()
  // 筛选停在「待整理」时，审核通过和归档后跟随到病案所在分类，当前病案留在列表中。
  const recordFilter = page.getByRole('group', { name: '病案整理状态', exact: true })
  await recordFilter.getByRole('button', { name: '待整理', exact: true }).click()
  await page.getByRole('button', { name: '编码审核通过', exact: true }).click()
  await expect(recordFilter.getByRole('button', { name: '审核通过', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: '查看合成病案患者', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '归档病案', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '归档病案', exact: true }).click()
  await expect(page.getByRole('region', { name: '住院病案首页核心字段集', exact: true }).getByText('病案已归档，只读可查', { exact: true })).toBeVisible()
  await expect(recordFilter.getByRole('button', { name: '已归档', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const archived = inpatientRecordSchema.parse(await (await page.request.get(`${browserApp.origin}${path}/record`)).json()).archive
  browserApp.runtime.database.driver.prepare("UPDATE scenario_run SET status='completed' WHERE scenario_run_id='scenario-run-1'").run()
  await page.reload()
  await select()
  await expect(page.getByRole('region', { name: '住院病案首页核心字段集', exact: true }).getByText('病案已归档，只读可查', { exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '归档病案', exact: true })).toHaveCount(0)
  expect(inpatientRecordSchema.parse(await (await page.request.get(`${browserApp.origin}${path}/record`)).json()).archive).toEqual(archived)
  await login('ward-nurse')
  await select()
  await expect(page.getByRole('region', { name: '住院病案首页核心字段集', exact: true }).getByText('病案已归档，只读可查', { exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: '待接收转科', exact: true })).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await login('registrar')
  const referralsRead = page.waitForResponse(response => response.url().endsWith('/inpatient/referrals') && response.request().method() === 'GET')
  await selectWorkspaceMode(page, '住院')
  const referralsResponse = await referralsRead
  expect.soft(referralsResponse.status()).toBe(200)
  await select()
  if (referralsResponse.ok()) await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('region', { name: '住院病案首页核心字段集', exact: true })).toHaveCount(0)
  await login('cashier')
  const chargesRead = page.waitForResponse(response => response.url().endsWith(`${path}/charges`) && response.request().method() === 'GET')
  await select()
  await expect(page.getByText('已结算并清床', { exact: true })).toBeVisible()
  await selectInpatientStage(page, "费用")
  const chargesResponse = await chargesRead
  expect.soft(chargesResponse.status()).toBe(200)
  if (chargesResponse.ok()) {
    await expect(page.getByRole('heading', { name: '费用明细', exact: true })).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
  }
  await expect(page.getByRole('region', { name: '住院病案首页核心字段集', exact: true })).toHaveCount(0)
  await login('pharmacist')
  const pharmacyRead = page.waitForResponse(response => response.url().endsWith('/inpatient/pharmacy/admissions') && response.request().method() === 'GET')
  await selectWorkspaceMode(page, '住院')
  const pharmacyResponse = await pharmacyRead
  expect.soft(pharmacyResponse.status()).toBe(200)
  if (pharmacyResponse.ok()) {
    await expect(page.getByText('暂无待发药品', { exact: true })).toBeVisible()
    await expect(page.getByRole('group', { name: '住院发药状态', exact: true })).toContainText('待发药 0')
    await expect(page.getByRole('alert')).toHaveCount(0)
  }
  await expect(page.getByRole('region', { name: '住院病案首页核心字段集', exact: true })).toHaveCount(0)
})

test('提交中主操作不可编辑，修订被其他请求推进后原选择不会被静默改成新意图', async ({ page, playwright, browserApp }) => {
  let first = true
  const login = async (name: string) => {
    if (!first) { await page.getByRole('button', { name: '用户菜单' }).click(); await page.getByRole('menuitem', { name: '退出登录' }).click() }
    first = false
    await page.getByLabel('账户邮箱').fill(`${name}@demo.clinmesh.local`)
    await page.getByLabel('账户密码').fill(browserApp.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(page.getByRole('button', { name: '用户菜单' })).toBeVisible()
  }
  const post = (path: string, input: unknown) => page.request.post(`${browserApp.origin}${path}`, { headers: { origin: browserApp.origin, 'idempotency-key': randomUUID() }, data: { input } })
  await page.goto(`${browserApp.origin}/registration`)
  await login('registrar')
  const patient = (await (await page.request.post(`${browserApp.origin}/api/his/v1/patients`, { headers: { origin: browserApp.origin, 'idempotency-key': randomUUID() }, data: { expectedVersions: {}, input: { name: '合成主操作草稿患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } } })).json()).data.patient
  const admission = (await (await post('/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100000 })).json()).data.admission
  const path = `/api/his/v1/inpatient/admissions/${admission.id}`
  await login('ward-nurse')
  expect((await post(`${path}/receive`, { encounterVersion: admission.versionId, bedId: 'bed-general-1' })).status()).toBe(200)
  await login('inpatient-doctor')
  const version = (await (await page.request.get(`${browserApp.origin}${path}`)).json()).admission.versionId
  const catalog = (await (await page.request.get(`${browserApp.origin}/api/his/v1/inpatient/surgery-catalog`)).json())
  const requests: Array<{ id: string; version: number; procedureId: string }> = []
  for (const procedure of catalog.procedures.slice(0, 2)) {
    const requested = await post(`${path}/surgeries/request`, { encounterVersion: version, procedureId: procedure.id, catalogVersion: procedure.version, plannedFor: '2026-08-24T09:00:00+08:00', reason: '合成主操作选择示教' })
    expect(requested.status()).toBe(200)
    const current = (await requested.json()).data.requests.find((request: { status: string; plannedProcedure: { id: string } }) => request.status === 'requested' && request.plannedProcedure.id === procedure.id)
    const consented = await post(`${path}/surgeries/confirm-consent`, { requestId: current.id, expectedRequestVersion: current.version, note: '已核签署同意' })
    expect(consented.status()).toBe(200)
    const consent = (await consented.json()).data.requests.find((request: { id: string }) => request.id === current.id)
    requests.push({ id: consent.id, version: consent.version, procedureId: procedure.id })
  }
  await login('ward-nurse')
  for (const request of requests) {
    const prepared = await post(`${path}/surgeries/check-preop`, { requestId: request.id, expectedRequestVersion: request.version, note: '术前核对完成' })
    expect(prepared.status()).toBe(200)
    request.version = (await prepared.json()).data.requests.find((item: { id: string }) => item.id === request.id).version
  }
  await login('inpatient-doctor')
  for (const request of requests) expect((await post(`${path}/surgeries/execute`, { requestId: request.id, expectedRequestVersion: request.version, procedureId: request.procedureId, catalogVersion: 1, note: '实际完成合成操作', materials: [] })).status()).toBe(200)
  await page.getByRole('button', { name: /合成主操作草稿患者/ }).click()
  await selectInpatientStage(page, "病案")
  const record = page.getByRole('region', { name: '住院病案首页核心字段集', exact: true })
  const before = inpatientRecordSchema.parse(await (await page.request.get(`${browserApp.origin}${path}/record`)).json())
  const [a, b] = before.snapshot.clinical.operations
  expect(a).toBeDefined(); expect(b).toBeDefined()
  const radio = (operation: NonNullable<typeof a>) => record.getByRole('radio', { name: `${operation.actualProcedure.coding.code} ${operation.actualProcedure.coding.display}` })
  const coder = await playwright.request.newContext({ baseURL: browserApp.origin, extraHTTPHeaders: { origin: browserApp.origin } })
  expect((await coder.post('/api/auth/sign-in/email', { data: { email: `${'medical-records'}@demo.clinmesh.local`, password: browserApp.password } })).status()).toBe(200)
  const returnRevision = async (revision: number) => expect((await coder.post(`${path}/record/review`, { headers: { 'idempotency-key': randomUUID() },
    data: { input: { expectedRevision: revision, expectedSourcesHash: before.sourcesHash, outcome: 'returned', reason: '合成退回：请核对主操作' } } })).status()).toBe(200)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const sent: Array<{ expectedRevision: number; expectedSourcesHash: string; mainProcedureExecutionId: string }> = []
  await page.route(`**${path}/record/submit`, async route => {
    sent.push(route.request().postDataJSON().input)
    if (sent.length === 1) { const response = await route.fetch(); expect(response.status()).toBe(200); await held; await route.fulfill({ response }) }
    else await route.continue()
  })
  const action = page.getByRole('region', { name: '当前操作', exact: true })
  // 在院已有实施操作时允许提交主操作供 DRG 预分组。
  await radio(a!).check()
  await action.getByRole('button', { name: '提交病案首页', exact: true }).click()
  await expect.poll(() => sent.length).toBe(1)
  // 提交进行中主卡内容不可编辑，操作栏写明正在提交。
  expect(await radio(a!).evaluate(element => element.closest('[inert]') !== null)).toBe(true)
  await expect(action.getByRole('status')).toHaveText('正在提交')
  release()
  await expect(record.getByText(/第 1 次提交/)).toBeVisible()
  await expect(action).toContainText('等病案人员编码审核')
  await expect(action.getByRole('button', { name: /提交病案首页/ })).toHaveCount(0)
  const afterA = inpatientRecordSchema.parse(await (await page.request.get(`${browserApp.origin}${path}/record`)).json())
  expect(afterA.sourcesHash).toBe(before.sourcesHash)
  await returnRevision(1)
  await page.reload()
  await page.getByRole('button', { name: /合成主操作草稿患者/ }).click()
  await selectInpatientStage(page, '病案')
  const resubmit = action.getByRole('button', { name: '重新提交病案首页', exact: true })
  await expect(resubmit).toBeVisible()
  await expect(radio(a!)).toBeChecked()
  await radio(b!).check()
  // 用户选好 B 后，另一请求把修订推进到 2 并再次退回；B 仍以修订 1 的指纹提交并被拒绝，不会被静默改写成基于新修订的意图。
  expect((await post(`${path}/record/submit`, { expectedRevision: 1, expectedSourcesHash: before.sourcesHash, mainProcedureExecutionId: a!.id })).status()).toBe(200)
  await returnRevision(2)
  await resubmit.click()
  await expect.poll(() => sent.length).toBe(2)
  expect(sent[1]).toEqual({ expectedRevision: 1, expectedSourcesHash: before.sourcesHash, mainProcedureExecutionId: b!.id })
  await expect(page.getByRole('alert')).toContainText('首页来源或修订已变化')
  const discard = action.getByRole('button', { name: '放弃原主操作选择，重新审阅来源', exact: true })
  await expect(discard).toBeVisible()
  await discard.click()
  await expect(radio(b!)).not.toBeChecked()
  await radio(b!).check()
  await resubmit.click()
  await expect.poll(() => sent.length).toBe(3)
  expect(sent[2]).toEqual({ expectedRevision: 2, expectedSourcesHash: before.sourcesHash, mainProcedureExecutionId: b!.id })
  await expect(record.getByText(/第 3 次提交/)).toBeVisible()
  await coder.dispose()
  const recovered = inpatientRecordSchema.parse(await (await page.request.get(`${browserApp.origin}${path}/record`)).json())
  expect(recovered.revision?.snapshot.clinical.mainProcedureExecutionId).toBe(b!.id)
  expect(recovered.sourcesHash).toBe(before.sourcesHash)
})
