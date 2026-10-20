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
  let first = true
  const login = async (name: string) => {
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
      await page.getByRole('tab', { name: '住院费用', exact: true }).click()
  }
  const post = (path: string, input: unknown) => page.request.post(`${browserApp.origin}${path}`, { headers: { origin: browserApp.origin, 'idempotency-key': randomUUID() }, data: { input } })
  const select = () => page.getByRole('button', { name: '查看合成病案患者', exact: true }).click()
  await page.goto(`${browserApp.origin}/registration`)
  await login('registrar')
  const patient = (await (await page.request.post(`${browserApp.origin}/api/his/v1/patients`, { headers: { origin: browserApp.origin, 'idempotency-key': randomUUID() }, data: { expectedVersions: {}, input: { name: '合成病案患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } } })).json()).data.patient
  const session = await (await page.request.get(`${browserApp.origin}/api/auth/context`)).json()
  const admission = (await (await post('/api/his/v1/inpatient/admissions', { expectedEpoch: session.actor.epoch, patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100000 })).json()).data.admission, path = `/api/his/v1/inpatient/admissions/${admission.id}`
  await login('ward-nurse')
  expect((await post(`${path}/receive`, { encounterVersion: admission.versionId, bedId: 'bed-general-1' })).status()).toBe(200)
  await login('inpatient-doctor')
  await select()
  await page.getByLabel('诊断目录检索', { exact: true }).fill('I10.x09')
  await page.getByRole('button', { name: '查询诊断', exact: true }).click()
  await page.getByLabel('住院诊断', { exact: true }).click()
  await page.getByRole('option', { name: '合成临床版高血压', exact: true }).click()
  await page.getByLabel('主诊断入院病情', { exact: true }).click()
  await page.getByRole('option', { name: '1 · 有', exact: true }).click()
  await page.getByRole('button', { name: '确认住院诊断', exact: true }).click()
  await expect(page.getByText('主诊断：合成临床版高血压', { exact: true })).toBeVisible()
  await page.getByLabel('出院处理说明', { exact: true }).fill('本次治疗完成')
  await page.getByRole('button', { name: '开出院医嘱', exact: true }).click()
  await expect(page.getByRole('button', { name: '开出院医嘱', exact: true })).toHaveCount(0)
  await login('ward-nurse')
  await select()
  await page.getByLabel('出院处理说明', { exact: true }).fill('出区核对完成')
  await page.getByLabel('离院方式', { exact: true }).click()
  await page.getByRole('option', { name: '医嘱离院', exact: true }).click()
  await page.getByRole('button', { name: '办理出区', exact: true }).click()
  await expect(page.getByRole('button', { name: '办理出区', exact: true })).toHaveCount(0)
  await login('cashier')
  await select()
  await page.getByRole('button', { name: '预览结算', exact: true }).click()
  await page.getByRole('button', { name: '确认结算', exact: true }).click()
  await expect(page.getByText('已结算，等待病区清床', { exact: true })).toBeVisible()
  await login('ward-nurse')
  await select()
  await page.getByLabel('出院处理说明', { exact: true }).fill('床单位清洁')
  await page.getByRole('button', { name: '清床', exact: true }).click()
  await expect(page.getByText('当前床位：未分床', { exact: true })).toBeVisible()
  await login('inpatient-doctor')
  await select()
  let submits = 0, key: string | undefined
  await page.route(`**${path}/record/submit`, async (route) => { submits++; key = route.request().headers()['idempotency-key']; expect((await route.fetch()).status()).toBe(200); await route.abort('failed'); })
  await page.getByRole('button', { name: '提交首页（本次无已实施操作）', exact: true }).click()
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
  await expect(page.getByText(/退回 · 修订 1/)).toBeVisible()
  await login('inpatient-doctor')
  await select()
  await page.getByRole('button', { name: '提交首页（本次无已实施操作）', exact: true }).click()
  await expect.poll(async () => inpatientRecordSchema.parse(await (await page.request.get(`${browserApp.origin}${path}/record`)).json()).revision?.revision).toBe(2)
  await login('medical-records')
  await select()
  await page.getByRole('button', { name: '编码审核通过', exact: true }).click()
  await expect(page.getByRole('button', { name: '归档病案', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '归档病案', exact: true }).click()
  await expect(page.getByText(/病案已归档，只读可查/)).toBeVisible()
  const archived = inpatientRecordSchema.parse(await (await page.request.get(`${browserApp.origin}${path}/record`)).json()).archive
  browserApp.runtime.database.driver.prepare("UPDATE scenario_run SET status='completed' WHERE scenario_run_id='scenario-run-1'").run()
  await page.reload()
  await select()
  await expect(page.getByText(/病案已归档，只读可查/)).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '归档病案', exact: true })).toHaveCount(0)
  expect(inpatientRecordSchema.parse(await (await page.request.get(`${browserApp.origin}${path}/record`)).json()).archive).toEqual(archived)
})
