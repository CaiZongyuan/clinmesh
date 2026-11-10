import { selectWorkspaceMode, selectInpatientStage } from './inpatient-ui.ts'
import { randomUUID } from 'node:crypto'
import { expect, test } from './fixtures.ts'
import { inpatientFullClinicalSchema, inpatientPharmacySchema, inpatientPharmacyResponseSchema, inpatientChargesResponseSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { createPatientResponseSchema, sessionContextSchema } from '@clinmesh/contracts/his'
import { fhirBundleSchema } from '@clinmesh/contracts/fhir'

test('住院有序诊断、医嘱执行与冲正在版本冲突及丢回执后保留事实', async ({ page, browserApp }) => {
  const login = async (name: string, first = false) => {
    if (!first) { await page.getByRole('button', { name: '用户菜单' }).click(); await page.getByRole('menuitem', { name: '退出登录' }).click() }
    await page.getByLabel('账户邮箱').fill(`${name}@demo.clinmesh.local`)
    await page.getByLabel('账户密码').fill(browserApp.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(page.getByRole('button', { name: '用户菜单' })).toBeVisible()
  }
  await page.goto(`${browserApp.origin}/registration`)
  await login('registrar', true)
  const request = async (path: string, input: unknown) => page.request.post(`${browserApp.origin}${path}`, { headers: { origin: browserApp.origin, 'idempotency-key': randomUUID() }, data: { input } })
  const patient = createPatientResponseSchema.parse(await (await page.request.post(`${browserApp.origin}/api/his/v1/patients`, {
    headers: { origin: browserApp.origin, 'idempotency-key': randomUUID() }, data: { expectedVersions: {}, input: { name: '合成住院用药患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } },
  })).json()).data.patient
  const session = sessionContextSchema.parse(await (await page.request.get(`${browserApp.origin}/api/auth/context`)).json())
  const admission = inpatientCommandResponseSchema.parse(await (await request('/api/his/v1/inpatient/admissions', { expectedEpoch: session.actor.epoch,
    patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100000 })).json()).data.admission
  await login('ward-nurse')
  expect((await request(`/api/his/v1/inpatient/admissions/${admission.id}/receive`, { encounterVersion: admission.versionId, bedId: 'bed-general-1' })).status()).toBe(200)
  await login('inpatient-doctor')
  const syntheticDiagnoses = [
    { id: 'diagnosis-type-2-diabetes-hyperglycemia', code: 'E11.65', display: '2型糖尿病伴高血糖', domain: 'diagnosis', sourceLocator: 'synthetic', status: 'active', system: 'http://hl7.org/fhir/sid/icd-10', version: '1' },
    { id: 'diagnosis-hypertension', code: 'I10', display: '高血压', domain: 'diagnosis', sourceLocator: 'synthetic', status: 'active', system: 'http://hl7.org/fhir/sid/icd-10', version: '1' },
    { id: 'diagnosis-fever', code: 'R50.9', display: '发热，未特指', domain: 'diagnosis', sourceLocator: 'synthetic', status: 'active', system: 'http://hl7.org/fhir/sid/icd-10', version: '1' },
  ]
  // Only the external reference page is synthetic; confirmation and the clinical journey use the real server.
  await page.route('**/api/his/v1/reference-catalogs/diagnoses?**', async route => {
    const url = new URL(route.request().url())
    const pageNumber = Number(url.searchParams.get('page') ?? '1')
    const query = url.searchParams.get('query') ?? ''
    const items = pageNumber === 1 ? syntheticDiagnoses.filter(item => item.display.includes(query) || item.code.includes(query)) : []
    await route.fulfill({ json: { items, page: pageNumber, pageSize: 20, total: query === '糖尿病' ? 40 : items.length, releaseId: 'synthetic-ui-paging' } })
  })
  await page.getByRole('button', { name: /合成住院用药患者/ }).click()
  await page.getByRole('button', { name: '添加诊断', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: '确认住院诊断', exact: true })
  await dialog.getByLabel('搜索诊断名称或编码', { exact: true }).fill('糖尿病')
  await dialog.getByRole('button', { name: '加入2型糖尿病伴高血糖', exact: true }).click()
  await dialog.getByRole('group', { name: '2型糖尿病伴高血糖 入院病情', exact: true }).getByRole('button', { name: '有', exact: true }).click()
  await dialog.getByLabel('搜索诊断名称或编码', { exact: true }).fill('高血压')
  await dialog.getByRole('button', { name: '加入高血压', exact: true }).click()
  await dialog.getByRole('group', { name: '高血压 入院病情', exact: true }).getByRole('button', { name: '临床未确定', exact: true }).click()
  await dialog.getByRole('button', { name: '加备注：高血压', exact: true }).click()
  await dialog.getByLabel('高血压 备注', { exact: true }).fill('合成入院待确认备注')
  await dialog.getByLabel('搜索诊断名称或编码', { exact: true }).fill('发热')
  await dialog.getByRole('button', { name: '加入发热，未特指', exact: true }).click()
  await dialog.getByRole('group', { name: '发热，未特指 入院病情', exact: true }).getByRole('button', { name: '情况不明', exact: true }).click()
  await dialog.getByRole('button', { name: '上移发热，未特指', exact: true }).click()
  await dialog.getByLabel('搜索诊断名称或编码', { exact: true }).fill('糖尿病')
  await dialog.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(dialog.getByText('2 / 2', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('region', { name: '本次住院诊断', exact: true })).toContainText(/2型糖尿病伴高血糖.*发热，未特指.*高血压/)
  await dialog.getByRole('button', { name: '确认住院诊断', exact: true }).click()
  await expect(page.getByRole('region', { name: '住院诊断摘要', exact: true }).locator('.clinmesh-inpatient-diagnosis-line').filter({ hasText: '2型糖尿病伴高血糖' })).toBeVisible()
  await expect(page.getByRole('region', { name: '住院诊断摘要', exact: true }).locator('.clinmesh-inpatient-diagnosis-line').filter({ hasText: '发热，未特指' })).toBeVisible()
  await expect(page.getByRole('region', { name: '住院诊断摘要', exact: true }).locator('.clinmesh-inpatient-diagnosis-line').filter({ hasText: '高血压' })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: /合成住院用药患者/ }).click()
  await page.getByRole('button', { name: '修改诊断', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '修改住院诊断', exact: true })
  await expect(dialog.getByLabel('高血压 备注', { exact: true })).toHaveValue('合成入院待确认备注')
  await expect(dialog.getByRole('group', { name: '发热，未特指 入院病情', exact: true }).getByRole('button', { name: '情况不明', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(dialog.getByRole('group', { name: '高血压 入院病情', exact: true }).getByRole('button', { name: '临床未确定', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const repeatedDiagnosis = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/diagnoses/confirm'))
  await dialog.getByRole('button', { name: '确认住院诊断', exact: true }).click()
  expect((await repeatedDiagnosis).status()).toBe(200)
  await expect(page.getByRole('region', { name: '住院诊断摘要', exact: true }).locator('.clinmesh-inpatient-diagnosis-line').filter({ hasText: '发热，未特指' })).toBeVisible()
  await expect(page.getByRole('region', { name: '住院诊断摘要', exact: true }).locator('.clinmesh-inpatient-diagnosis-line').filter({ hasText: '高血压' })).toBeVisible()

  const beforeConcurrentEdit = inpatientFullClinicalSchema.parse(await (await page.request.get(`${browserApp.origin}/api/his/v1/inpatient/admissions/${admission.id}/clinical`)).json())
  expect(beforeConcurrentEdit.diagnosis.entries.map(entry => entry.coding.id)).toEqual(['diagnosis-type-2-diabetes-hyperglycemia', 'diagnosis-fever', 'diagnosis-hypertension'])
  await page.getByRole('button', { name: '修改诊断', exact: true }).click()
  await dialog.getByLabel('高血压 备注', { exact: true }).fill('合成未保存备注')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  expect((await request(`/api/his/v1/inpatient/admissions/${admission.id}/diagnoses/confirm`, {
    encounterVersion: beforeConcurrentEdit.encounterVersion, expectedRevision: beforeConcurrentEdit.diagnosis.revision,
    entries: beforeConcurrentEdit.diagnosis.entries.map(entry => ({ catalogItemId: entry.coding.id, role: entry.role, admissionCondition: entry.admissionCondition,
      ...(entry.role === 'primary' ? {} : { note: '合成外部新备注' }) })),
  })).status()).toBe(200)
  const refreshed = page.waitForResponse(response => response.url().endsWith(`/inpatient/admissions/${admission.id}/clinical`))
  await page.getByRole('button', { name: "刷新", exact: true }).click()
  await refreshed
  await page.getByRole('button', { name: '修改诊断', exact: true }).click()
  await expect(dialog.getByLabel('高血压 备注', { exact: true })).toHaveValue('合成未保存备注')
  const conflict = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/inpatient/admissions/${admission.id}/diagnoses/confirm`))
  await dialog.getByRole('button', { name: '确认住院诊断', exact: true }).click()
  expect((await conflict).status()).toBe(409)
  await expect(dialog.getByLabel('高血压 备注', { exact: true })).toHaveValue('合成未保存备注')
  await dialog.getByRole('button', { name: '放弃编辑，载入已确认诊断', exact: true }).click()
  await expect(dialog.getByLabel('高血压 备注', { exact: true })).toHaveValue('合成外部新备注')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByLabel('医嘱项目', { exact: true }).fill('盐酸二甲双胍片')
  await page.getByRole('region', { name: '医嘱项目候选', exact: true }).getByRole('button', { name: /盐酸二甲双胍片/ }).click()
  await page.getByRole('group', { name: '医嘱时效', exact: true }).getByRole('button', { name: '临时', exact: true }).click()
  await page.getByRole('button', { name: "开立医嘱", exact: true }).click()
  await expect(page.locator('article').filter({ hasText: '盐酸二甲双胍片' }).filter({ hasText: '待校对' })).toBeVisible()
  const banner = page.getByRole('region', { name: '当前住院患者', exact: true })
  const panel = page.getByRole('tabpanel', { name: '诊断医嘱', exact: true })
  expect(await panel.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  await panel.evaluate(element => { element.scrollTop = 0 })
  const beforeScroll = await banner.boundingBox()
  expect(beforeScroll).not.toBeNull()
  await panel.evaluate(element => { element.scrollTop = element.scrollHeight })
  expect(await panel.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  const afterScroll = await banner.boundingBox()
  expect(afterScroll?.y).toBe(beforeScroll?.y)
  expect(afterScroll!.y).toBeGreaterThanOrEqual(0)
  expect(afterScroll!.y + afterScroll!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  await login('ward-nurse')
  await page.getByRole('button', { name: /合成住院用药患者/ }).click()
  await page.getByRole('button', { name: '校对医嘱', exact: true }).click()
  await expect(page.locator('article').filter({ hasText: '盐酸二甲双胍片' }).filter({ hasText: '待执行' })).toBeVisible()
  await login('pharmacist')
  await selectWorkspaceMode(page, '住院')
  await page.getByRole('button', { name: /合成住院用药患者/ }).click()
  let dispensePosts=0
  let originalKey:string|undefined
  await page.route(`**/api/his/v1/inpatient/admissions/${admission.id}/executions/dispense`,async route=>{
    dispensePosts+=1;originalKey=route.request().headers()['idempotency-key']
    const response=await route.fetch();expect(response.status()).toBe(200);inpatientPharmacyResponseSchema.parse(await response.json());await route.abort('failed')
  })
  const pharmacyPath = `${browserApp.origin}/api/his/v1/inpatient/admissions/${admission.id}/pharmacy`
  const beforeCancel = inpatientPharmacySchema.parse(await (await page.request.get(pharmacyPath)).json())
  await page.getByRole('button', { name: '全选本页可发药执行单', exact: true }).click()
  const dispenseTrigger = page.getByRole('button', { name: '集中发药', exact: true })
  const dispenseConfirm = page.getByRole('dialog', { name: '集中发药核对', exact: true }).getByRole('button', { name: '确认发药', exact: true })
  await dispenseTrigger.click()
  await expect(dispenseConfirm).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(dispenseConfirm).toHaveCount(0)
  await expect(dispenseTrigger).toBeFocused()
  expect(dispensePosts).toBe(0)
  const afterCancel = inpatientPharmacySchema.parse(await (await page.request.get(pharmacyPath)).json())
  expect(afterCancel.medications).toEqual(beforeCancel.medications)
  expect(afterCancel.dispenses).toEqual(beforeCancel.dispenses)
  await dispenseTrigger.click()
  await expect(dispenseConfirm).toBeEnabled()
  await dispenseConfirm.click()
  await expect(page.getByRole('alert')).toContainText('无法连接科灵脉智服务')
  await page.reload()
  await selectWorkspaceMode(page, '住院')
  const receipt=page.waitForRequest(request=>request.url().includes('/command-receipts?'))
  await page.getByRole('button',{name:'恢复原住院操作',exact:true}).click()
  expect(new URL((await receipt).url()).searchParams.get('idempotencyKey')).toBe(originalKey)
  await expect(page.getByRole('status')).toContainText('已完成发药')
  expect(dispensePosts).toBe(1)

  await page.getByRole('group', { name: '住院发药状态', exact: true }).getByRole('button', { name: /^已发药/ }).click()
  await page.getByRole('button', { name: /合成住院用药患者/ }).click()
  await expect(page.getByRole('region', { name: '当前住院患者', exact: true })).toContainText('已发药')
  await expect(page.locator('article').filter({ hasText: '盐酸二甲双胍片' })).toBeVisible()
  await expect(page.getByRole('combobox', { name: '发药批次', exact: true })).toHaveCount(0)
  await login('ward-nurse')
  await page.getByRole('button', { name: /合成住院用药患者/ }).click()
  await page.getByRole('button', { name: '给药', exact: true }).click()
  await expect(page.locator('article').filter({ hasText: '盐酸二甲双胍片' }).filter({ hasText: '已完成' })).toBeVisible()
  const administrations = fhirBundleSchema.parse(await (await page.request.get(`${browserApp.origin}/fhir/R5/MedicationAdministration?encounter=Encounter/${admission.id}&_total=accurate`)).json())
  expect(administrations.total).toBe(1)
  expect(administrations.entry![0]!.resource).toMatchObject({ status: 'completed', medication: { reference: { reference: 'Medication/medication-metformin' } } })
  await login('cashier')
  await selectWorkspaceMode(page, '住院')
  await page.getByRole('button', { name: /合成住院用药患者/ }).click()
  await selectInpatientStage(page, "费用")
  await expect(page.getByLabel('住院费用明细')).toContainText('盐酸二甲双胍片 1片')
  await expect(page.getByLabel('住院诊疗', { exact: true })).toHaveCount(0)
  await page.getByLabel("退费理由", { exact: true }).fill('合成费用纠错')
  let reversalPosts = 0
  let reversalKey: string | undefined
  await page.route(`**/api/his/v1/inpatient/admissions/${admission.id}/charges/reverse`, async route => {
    reversalPosts += 1; reversalKey = route.request().headers()['idempotency-key']
    const response = await route.fetch(); expect(response.status()).toBe(200); inpatientChargesResponseSchema.parse(await response.json()); await route.abort('failed')
  })
  await page.getByRole('button', { name: "退费", exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('无法连接科灵脉智服务')
  await page.reload()
  await selectWorkspaceMode(page, '住院')
  await page.getByRole('button', { name: /合成住院用药患者/ }).click()
  const reversalReceipt = page.waitForRequest(request => request.url().includes('/command-receipts?'))
  await page.getByRole('button', { name: '恢复原住院操作', exact: true }).click()
  expect(new URL((await reversalReceipt).url()).searchParams.get('idempotencyKey')).toBe(reversalKey)
  await expect(page.getByRole('status')).toContainText('已完成本次操作')
  await selectInpatientStage(page, "费用")
  await expect(page.getByLabel('住院费用明细')).toContainText("关联退费")
  expect(reversalPosts).toBe(1)

})

test('诊断提交成功但回读失败后，新编辑不会被旧成功状态清除', async ({ page, browserApp }) => {
  const origin = browserApp.origin
  const login = async (actor: string) => expect((await page.request.post(`${origin}/api/auth/sign-in/email`, {
    headers: { origin }, data: { email: `${actor}@demo.clinmesh.local`, password: browserApp.password },
  })).status()).toBe(200)
  const post = async (path: string, input: unknown) => page.request.post(`${origin}${path}`, {
    headers: { origin, 'idempotency-key': randomUUID() }, data: { input },
  })
  await login('registrar')
  const patient = createPatientResponseSchema.parse(await (await page.request.post(`${origin}/api/his/v1/patients`, {
    headers: { origin, 'idempotency-key': randomUUID() }, data: { expectedVersions: {}, input: { name: '合成诊断回读故障患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } },
  })).json()).data.patient
  const session = sessionContextSchema.parse(await (await page.request.get(`${origin}/api/auth/context`)).json())
  const admission = inpatientCommandResponseSchema.parse(await (await post('/api/his/v1/inpatient/admissions', {
    expectedEpoch: session.actor.epoch, patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 0,
  })).json()).data.admission
  await login('ward-nurse')
  expect((await post(`/api/his/v1/inpatient/admissions/${admission.id}/receive`, { encounterVersion: admission.versionId, bedId: 'bed-general-1' })).status()).toBe(200)
  await login('inpatient-doctor')
  await page.route('**/api/his/v1/reference-catalogs/diagnoses?**', route => route.fulfill({ json: {
    items: [{ id: 'diagnosis-hypertension', code: 'I10', display: '高血压', domain: 'diagnosis', sourceLocator: 'synthetic', status: 'active', system: 'http://hl7.org/fhir/sid/icd-10', version: '1' }],
    page: 1, pageSize: 20, total: 1, releaseId: 'synthetic-readback-fault',
  } }))
  await page.goto(`${origin}/inpatient`)
  await page.getByRole('button', { name: /合成诊断回读故障患者/ }).click()
  await page.getByRole('button', { name: '添加诊断', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /住院诊断/ })
  await dialog.getByLabel('搜索诊断名称或编码', { exact: true }).fill('高血压')
  await dialog.getByRole('button', { name: '加入高血压', exact: true }).click()
  await dialog.getByRole('group', { name: '高血压 入院病情', exact: true }).getByRole('button', { name: '有', exact: true }).click()
  await dialog.getByRole('button', { name: '加备注：高血压', exact: true }).click()
  await dialog.getByLabel('高血压 备注', { exact: true }).fill('合成提交A')
  const clinicalPath = `/api/his/v1/inpatient/admissions/${admission.id}/clinical`
  let failClinical = false, failedReads = 0, committedRevision = 0
  await page.route(`**${clinicalPath}`, async route => {
    if (failClinical) { failedReads += 1; await route.abort('failed') }
    else await route.continue()
  })
  await page.route(`**/api/his/v1/inpatient/admissions/${admission.id}/diagnoses/confirm`, async route => {
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    committedRevision = inpatientFullClinicalSchema.parse((await response.json()).data).diagnosis.revision
    failClinical = true
    await route.fulfill({ response })
  })
  await dialog.getByRole('button', { name: '确认住院诊断', exact: true }).click()
  await expect.poll(() => committedRevision).toBe(1)
  await expect.poll(() => failedReads).toBeGreaterThan(0)
  await expect(page.getByRole('region', { name: '住院诊疗', exact: true }).getByRole('alert')).toContainText('无法连接科灵脉智服务')
  await page.getByRole('button', { name: '添加诊断', exact: true }).click()
  await dialog.getByLabel('高血压 备注', { exact: true }).fill('合成新编辑B')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  failClinical = false
  const refreshed = page.waitForResponse(response => response.url().endsWith(clinicalPath) && response.status() === 200)
  await page.getByRole('button', { name: "刷新", exact: true }).click()
  const refreshedClinical = inpatientFullClinicalSchema.parse(await (await refreshed).json())
  expect(refreshedClinical.diagnosis.revision).toBe(1)
  expect(refreshedClinical.diagnosis.entries[0]?.note).toBe('合成提交A')
  await page.getByRole('button', { name: '修改诊断', exact: true }).click()
  await expect(dialog.getByLabel('高血压 备注', { exact: true })).toHaveValue('合成新编辑B')
  await page.unroute(`**/api/his/v1/inpatient/admissions/${admission.id}/diagnoses/confirm`)
  const conflict = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/diagnoses/confirm'))
  await dialog.getByRole('button', { name: '确认住院诊断', exact: true }).click()
  const staleSubmit = await conflict
  expect(staleSubmit.status()).toBe(409)
  expect(staleSubmit.request().postDataJSON().input.expectedRevision).toBe(0)
  await expect(dialog.getByLabel('高血压 备注', { exact: true })).toHaveValue('合成新编辑B')
  await dialog.getByRole('button', { name: '放弃编辑，载入已确认诊断', exact: true }).click()
  await expect(dialog.getByLabel('高血压 备注', { exact: true })).toHaveValue('合成提交A')
  await dialog.getByLabel('高血压 备注', { exact: true }).fill('合成新提交C')
  const savedDiagnosis = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/diagnoses/confirm'))
  await dialog.getByRole('button', { name: '确认住院诊断', exact: true }).click()
  const savedResponse = await savedDiagnosis
  expect(savedResponse.status()).toBe(200)
  expect(inpatientFullClinicalSchema.parse((await savedResponse.json()).data).diagnosis.entries[0]?.note).toBe('合成新提交C')
  await page.getByRole('button', { name: '修改诊断', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '放弃编辑，载入已确认诊断', exact: true })).toHaveCount(0)
  await expect(dialog.getByLabel('高血压 备注', { exact: true })).toHaveValue('合成新提交C')
})
