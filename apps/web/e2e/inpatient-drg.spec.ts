import { selectInpatientStage } from './inpatient-ui.ts'
import { randomUUID } from 'node:crypto'
import { createPatientResponseSchema } from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { expect, test } from './fixtures.ts'

test('真实住院医生入口显示 DRG 缺配置并保留临床医嘱入口', async ({ page, browserApp }) => {
  const { origin, password } = browserApp
  const login = async (role: string) => {
    expect((await page.request.post(`${origin}/api/auth/sign-in/email`, { headers: { origin },
      data: { email: `${role}@demo.clinmesh.local`, password } })).status()).toBe(200)
  }
  const post = (path: string, input: unknown, expectedVersions?: object) => page.request.post(origin + path, {
    headers: { origin, 'idempotency-key': randomUUID() }, data: { input, ...(expectedVersions ? { expectedVersions } : {}) },
  })
  await login('registrar')
  const patient = createPatientResponseSchema.parse(await (await post('/api/his/v1/patients', {
    name: '合成DRG页面患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}`,
  }, {})).json()).data.patient
  const admission = inpatientCommandResponseSchema.parse(await (await post('/api/his/v1/inpatient/admissions', {
    expectedEpoch: 'epoch-1', patientId: patient.id, patientVersion: patient.versionId,
    admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100000,
  })).json()).data.admission
  await login('ward-nurse')
  expect((await post(`/api/his/v1/inpatient/admissions/${admission.id}/receive`, {
    encounterVersion: admission.versionId, bedId: 'bed-general-1',
  })).status()).toBe(200)
  await login('inpatient-doctor')
  await page.goto(`${origin}/inpatient`)
  await page.getByRole('button', { name: '查看合成DRG页面患者', exact: true }).click()
  await selectInpatientStage(page, "DRG 预分组")
  await expect(page.getByRole('region', { name: "DRG 预分组", exact: true })).toContainText('尚未配置分组规则')
  await selectInpatientStage(page, "诊断医嘱")
  await expect(page.getByRole('button', { name: "开立医嘱", exact: true })).toBeVisible()
})
