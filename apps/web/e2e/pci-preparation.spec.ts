import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { inpatientListSchema } from '@clinmesh/contracts/inpatient'
import { inpatientPciDataSchema, pciCaseSourceResponseSchema, startSyntheticInpatientCaseResponseSchema } from '@clinmesh/contracts/inpatient-pci-data'
import { commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations'
import { registrationQueueSchema } from '@clinmesh/contracts/his'
import { patientPersonaRevisionListSchema, syntheticCaseInstanceSchema, syntheticCaseRegistrationListSchema, syntheticPatientProfileDetailSchema, syntheticPatientProfileListSchema } from '@clinmesh/contracts/scenario'

async function login(page: Page, password: string, role: string) {
  await page.getByLabel('账户邮箱').fill(`${role}@demo.clinmesh.local`)
  await page.getByLabel('账户密码').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('button', { name: '用户菜单' })).toBeVisible()
}

async function logout(page: Page) {
  await page.getByRole('button', { name: '用户菜单' }).click()
  await page.getByRole('menuitem', { name: '退出登录' }).click()
  await expect(page.getByLabel('账户邮箱')).toBeVisible()
}

test('从零页面准备固定PCI和手工Persona，原回执恢复直接入院并交给护士，无模型或隐式门诊费用', async ({ page, browserApp }) => {
  test.setTimeout(120_000)
  const modelRequests: string[] = []
  page.on('request', request => {
    if (request.method() === 'POST' && /\/(patient-persona-jobs|generation-jobs)$/.test(new URL(request.url()).pathname)) modelRequests.push(request.url())
  })
  await page.goto(`${browserApp.origin}/registration`)
  await login(page, browserApp.password, 'registrar')
  await page.getByRole('tab', { name: '住院登记', exact: true }).click()
  await page.getByLabel('患者来源', { exact: true }).click()
  await page.getByRole('option', { name: '就绪合成病例', exact: true }).click()
  await expect(page.getByText('暂无就绪病例，请管理员准备病例并创建、选择患者档案。', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '办理住院', exact: true })).toBeDisabled()
  await expect(page.getByLabel('预交金（元）')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '准备固定 PCI 病例', exact: true })).toHaveCount(0)
  await logout(page)

  await login(page, browserApp.password, 'admin')
  await page.goto(`${browserApp.origin}/scenario-data`)
  const preparation = page.getByRole('region', { name: 'PCI 演示准备', exact: true })
  await preparation.getByRole('button', { name: '准备 PCI 目录', exact: true }).click()
  await expect(preparation).toContainText('目录已准备')
  const directory = inpatientPciDataSchema.parse(await (await page.request.get(`${browserApp.origin}/api/his/v1/inpatient/pci-data`)).json())
  await preparation.getByRole('button', { name: '准备 PCI 目录', exact: true }).click()
  await expect(preparation.getByRole('button', { name: '准备 PCI 目录', exact: true })).toBeEnabled()
  expect(inpatientPciDataSchema.parse(await (await page.request.get(`${browserApp.origin}/api/his/v1/inpatient/pci-data`)).json()).installed).toEqual(directory.installed)

  let prepared: ReturnType<typeof pciCaseSourceResponseSchema.parse> | undefined
  let preparationPosts = 0
  let preparationKey = ''
  await page.route('**/api/sim/v1/synthetic-cases/pci/prepare', async route => {
    preparationPosts++
    preparationKey = route.request().headers()['idempotency-key']!
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    prepared = pciCaseSourceResponseSchema.parse(await response.json())
    await route.abort('failed')
  })
  await preparation.getByRole('button', { name: '准备固定 PCI 病例', exact: true }).click()
  await expect(preparation.getByRole('alert')).toContainText('无法连接')
  await page.reload()
  await preparation.getByRole('button', { name: '恢复原准备操作', exact: true }).click()
  await expect(page.getByRole('button', { name: '手工创建患者档案', exact: true })).toBeVisible()
  expect(preparationPosts).toBe(1)
  expect(prepared).toBeDefined()
  const source = prepared!.data
  const receiptQuery = new URLSearchParams({ operationId: 'admin.pci-case.prepare', idempotencyKey: preparationKey })
  const preparedReceipt = commandReceiptLookupSchema.parse(await (await page.request.get(`${browserApp.origin}/api/his/v1/command-receipts?${receiptQuery}`)).json())
  expect(preparedReceipt.response).toEqual(prepared)
  const profiles = syntheticPatientProfileListSchema.parse(await (await page.request.get(`${browserApp.origin}/api/sim/v1/synthetic-patients`)).json())
  expect(profiles.items).toHaveLength(1)

  await page.getByRole('button', { name: '手工创建患者档案', exact: true }).click()
  for (const [label, value] of Object.entries({
    主诉: '活动后胸闷一月', 开场陈述: '医生，我走路后会胸闷，休息后好转。', 已知史: '既往有高血压。',
    症状体验: '走路几百米后胸口发闷，休息几分钟缓解。', 用药记忆: '每天吃降压药。',
    性格: '平和', 说话方式: '简短清楚', 健康素养: '普通', 就医态度: '愿意配合检查',
  })) await page.getByLabel(label, { exact: true }).fill(value)
  await page.getByRole('button', { name: '保存为新修订', exact: true }).click()
  const selectionPosts: Array<{ key: string | undefined; input: unknown }> = []
  await page.route('**/patient-persona-revisions/active', async route => {
    selectionPosts.push({ key: route.request().headers()['idempotency-key'], input: route.request().postDataJSON() })
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    if (selectionPosts.length === 1) await route.abort('failed')
    else await route.fulfill({ response })
  })
  await page.getByRole('button', { name: '设为当前', exact: true }).click()
  await expect(page.getByRole('button', { name: '恢复原档案选择', exact: true })).toBeVisible()
  await page.reload()
  const selectedBeforeRecovery = syntheticCaseInstanceSchema.parse(await (await page.request.get(`${browserApp.origin}/api/sim/v1/synthetic-cases/${source.case.caseId}`)).json())
  const recoveredSelection = page.waitForResponse(response => response.url().endsWith('/patient-persona-revisions/active') && response.request().method() === 'PUT' && response.status() === 200)
  await page.getByRole('button', { name: '恢复原档案选择', exact: true }).click()
  await recoveredSelection
  await expect(page.getByRole('button', { name: '恢复原档案选择', exact: true })).toHaveCount(0)
  expect(selectionPosts).toHaveLength(2)
  expect(selectionPosts[0]?.key).toBeTruthy()
  expect(selectionPosts[1]).toEqual(selectionPosts[0])
  await expect(page.getByText('Active', { exact: true })).toBeVisible()
  const ready = syntheticCaseInstanceSchema.parse(await (await page.request.get(`${browserApp.origin}/api/sim/v1/synthetic-cases/${source.case.caseId}`)).json())
  expect(ready.revision).toBe(selectedBeforeRecovery.revision)
  const persona = patientPersonaRevisionListSchema.parse(await (await page.request.get(`${browserApp.origin}/api/sim/v1/synthetic-cases/${ready.caseId}/patient-persona-revisions`)).json())
  expect(persona.items).toHaveLength(1)
  expect(persona.items[0]).toMatchObject({ revision: 1, model: 'administrator-manual' })
  expect(ready).toMatchObject({ status: 'brief-ready', activeBriefRevision: 1, profileId: source.profileId })
  const profile = syntheticPatientProfileDetailSchema.parse(await (await page.request.get(`${browserApp.origin}/api/sim/v1/synthetic-patients/${source.profileId}`)).json())
  expect(profile.source).toMatchObject({ providerId: 'clinmesh-authored', hash: source.sourceHash })
  expect(ready.profileRevision).toBe(profile.revision)
  await logout(page)

  await login(page, browserApp.password, 'registrar')
  await page.goto(`${browserApp.origin}/registration`)
  await page.getByRole('tab', { name: '住院登记', exact: true }).click()
  await page.getByLabel('患者来源', { exact: true }).click()
  await page.getByRole('option', { name: '就绪合成病例', exact: true }).click()
  await page.getByLabel('待住院合成病例', { exact: true }).click()
  await page.getByRole('option', { name: new RegExp(profile.identity.displayName) }).click()
  await expect(page.getByText(`病例 ${ready.caseId} · Profile Revision ${ready.profileRevision} · Persona Revision 1`, { exact: true })).toBeVisible()
  await expect(page.getByLabel('入院病区')).toHaveValue('住院病区')
  let admissionPosts = 0
  let admissionKey = ''
  let started: ReturnType<typeof startSyntheticInpatientCaseResponseSchema.parse> | undefined
  await page.route('**/actions/start-inpatient-visit', async route => {
    admissionPosts++
    admissionKey = route.request().headers()['idempotency-key']!
    expect(route.request().postDataJSON()).toEqual({ activeBriefRevision: 1, expectedCaseRevision: ready.revision, expectedEpoch: 'epoch-1', wardId: 'ward-general' })
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    started = startSyntheticInpatientCaseResponseSchema.parse(await response.json())
    await route.abort('failed')
  })
  await page.getByRole('button', { name: '办理住院', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('无法连接')
  await page.reload()
  await page.getByRole('tab', { name: '住院登记', exact: true }).click()
  await page.getByRole('button', { name: '恢复原住院操作', exact: true }).click()
  await expect(page.getByRole('region', { name: '当前住院患者', exact: true })).toContainText(profile.identity.displayName)
  expect(admissionPosts).toBe(1)
  expect(started?.data.syntheticCaseId).toBe(ready.caseId)
  const admissionReceipt = commandReceiptLookupSchema.parse(await (await page.request.get(`${browserApp.origin}/api/his/v1/command-receipts?${new URLSearchParams({ operationId: 'registration.synthetic-case.start-inpatient', idempotencyKey: admissionKey })}`)).json())
  expect(admissionReceipt.response).toEqual(started)
  const admissions = inpatientListSchema.parse(await (await page.request.get(`${browserApp.origin}/api/his/v1/inpatient/admissions`)).json())
  expect(admissions.items).toEqual([expect.objectContaining({ id: started!.data.admissionId, patientId: started!.data.patientId, status: 'registered', admissionRoute: 'direct', depositFen: 0, chargesFen: 0 })])
  const outpatient = registrationQueueSchema.parse(await (await page.request.get(`${browserApp.origin}/api/his/v1/registrations`)).json())
  expect(outpatient.items).toHaveLength(0)
  const waiting = syntheticCaseRegistrationListSchema.parse(await (await page.request.get(`${browserApp.origin}/api/his/v1/registration/synthetic-cases`)).json())
  expect(waiting.items).toHaveLength(0)
  const patient = await (await page.request.get(`${browserApp.origin}/fhir/R5/Patient/${started!.data.patientId}`)).json()
  expect(patient.extension).toEqual(expect.arrayContaining([
    { url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/synthetic-profile', valueString: source.profileId },
    { url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/synthetic-case', valueString: ready.caseId },
  ]))
  expect((await page.request.get(`${browserApp.origin}/api/sim/v1/admin/synthetic-cases/${ready.caseId}/truth`)).status()).toBe(403)
  await logout(page)
  await login(page, browserApp.password, 'ward-nurse')
  await page.getByRole('button', { name: `查看${profile.identity.displayName}`, exact: true }).click()
  await page.getByLabel('目标床位').click()
  await page.getByRole('option', { name: /1床/ }).click()
  await page.getByRole('button', { name: '接诊并分床', exact: true }).click()
  await expect(page.getByText('住院病区 · 1床', { exact: true })).toBeVisible()
  const received = inpatientListSchema.parse(await (await page.request.get(`${browserApp.origin}/api/his/v1/inpatient/admissions`)).json())
  expect(received.items).toEqual([expect.objectContaining({ id: started!.data.admissionId, status: 'admitted', depositFen: 0, chargesFen: 0 })])
  expect(modelRequests).toEqual([])
})
