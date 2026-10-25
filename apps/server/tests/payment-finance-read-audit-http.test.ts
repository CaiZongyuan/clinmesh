import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { fhirBundleSchema } from '@clinmesh/contracts/fhir'
import { apiErrorSchema, createPatientResponseSchema, registrationResponseSchema, registrationQueueSchema } from '@clinmesh/contracts/his'
import { refundCaseSchema } from '@clinmesh/contracts/refunds'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { inpatientPaymentsSchema, inpatientSettlementPreviewSchema } from '@clinmesh/contracts/inpatient-discharge'
import { inpatientFinancialSchema } from '@clinmesh/contracts/inpatient-finance'
import { insuranceStateSchema } from '@clinmesh/contracts/insurance'
import { createClinMeshRuntime } from '../src/runtime.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-finance-read-audit-'))
  const password = `Test-${randomUUID()}-Aa1!`
  const runtime = await createClinMeshRuntime({ authBaseUrl: 'http://localhost', trustedOrigins: ['http://localhost'], demoPassword: password,
    authSecret: 'test-auth-secret-with-at-least-32-characters', cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
    databasePath: join(directory, 'hospital.sqlite'), migrationMode: 'apply' })
  cleanups.push(async () => { await runtime.close(); await rm(directory, { recursive: true }) })
  async function login(name: string) {
    const response = await runtime.app.request('/api/auth/sign-in/email', { method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' }, body: JSON.stringify({ email: `${name}@demo.clinmesh.local`, password }) })
    expect(response.status).toBe(200)
    return response.headers.get('set-cookie')!.split(';', 1)[0]!
  }
  async function request(cookie: string, path: string, input?: unknown, expectedVersions?: Record<string, string>) {
    return runtime.app.request(path, { method: input === undefined ? 'GET' : 'POST', headers: { cookie, origin: 'http://localhost',
      'content-type': 'application/json', 'idempotency-key': randomUUID() },
    ...(input === undefined ? {} : { body: JSON.stringify({ input, ...(expectedVersions === undefined ? {} : { expectedVersions }) }) }) })
  }
  const registrar = await login('registrar'), cashier = await login('cashier'), doctor = await login('inpatient-doctor'), admin = await login('admin')
  const created = await request(registrar, '/api/his/v1/patients', {
    name: '合成财务读取患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` }, {})
  expect(created.status).toBe(200)
  const patient = createPatientResponseSchema.parse(await created.json()).data.patient
  const audits = async (operation: string) => {
    const response = await request(admin, '/fhir/R5/AuditEvent?_count=100')
    expect(response.status).toBe(200)
    const bundle = fhirBundleSchema.parse(await response.json())
    const schema = z.object({ action: z.string(), code: z.object({ text: z.string() }),
      outcome: z.object({ code: z.object({ code: z.string() }) }) })
    return bundle.entry?.map(entry => schema.parse(entry.resource)).filter(audit => audit.code.text === operation) ?? []
  }
  return { runtime, request, login, patient, registrar, cashier, doctor, audits }
}

describe('财务读取公共 HTTP 审计', () => {
  it.each(['outpatient', 'inpatient'] as const)('%s 医保读取和越岗拒绝保留审计且不改变待遇余额', async kind => {
    const s = await setup()
    let targetId: string
    if (kind === 'inpatient') {
      const response = await s.request(s.registrar, '/api/his/v1/inpatient/admissions', {
        expectedEpoch: 'epoch-1', patientId: s.patient.id, patientVersion: s.patient.versionId,
        admissionRoute: 'direct', wardId: 'ward-general', depositFen: 0,
      })
      expect(response.status).toBe(200)
      targetId = inpatientCommandResponseSchema.parse(await response.json()).data.admission.id
    } else {
      const response = await s.request(s.registrar, '/api/his/v1/registrations/actions/register', {
        departmentId: 'department-general-medicine', locationId: 'location-outpatient', patientId: s.patient.id,
        visitDate: '2026-08-24', visitTypeId: 'visit-general',
      }, { [`Patient/${s.patient.id}`]: s.patient.versionId })
      expect(response.status).toBe(200)
      const registration = registrationResponseSchema.parse(await response.json()).data
      const queue = registrationQueueSchema.parse(await (await s.request(s.registrar, '/api/his/v1/registrations?pageSize=20')).json())
      targetId = queue.items.find(item => item.encounterId === registration.encounterId)!.caseId
    }
    const path = `/api/his/v1/insurance/${kind}/${targetId}`
    const response = await s.request(s.cashier, path)
    expect(response.status).toBe(200)
    const before = insuranceStateSchema.parse(await response.json())
    expect(before.history).toEqual([])
    const denied = await s.request(s.doctor, path)
    expect(denied.status).toBe(403)
    expect(apiErrorSchema.parse(await denied.json()).error.code).toBe('INSURANCE_ROLE_FORBIDDEN')
    expect(await s.audits('insurance.get')).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'R', outcome: { code: { code: '0' } } }),
      expect.objectContaining({ action: 'R', outcome: { code: { code: '8' } } }),
    ]))
    expect(insuranceStateSchema.parse(await (await s.request(s.cashier, path)).json())).toEqual(before)
  })

  it('门诊退款读取成功和越岗拒绝均可审计，读取不更改账目', async () => {
    const s = await setup()
    const registered = await s.request(s.registrar, '/api/his/v1/registrations/actions/register', {
      departmentId: 'department-general-medicine', locationId: 'location-outpatient', patientId: s.patient.id,
      visitDate: '2026-08-24', visitTypeId: 'visit-general' }, { [`Patient/${s.patient.id}`]: s.patient.versionId })
    expect(registered.status).toBe(200)
    const registration = registrationResponseSchema.parse(await registered.json()).data
    const queue = registrationQueueSchema.parse(await (await s.request(s.registrar, '/api/his/v1/registrations?pageSize=20')).json())
    const caseId = queue.items.find(item => item.encounterId === registration.encounterId)!.caseId
    const path = `/api/his/v1/billing/cases/${caseId}/refunds`
    const response = await s.request(s.cashier, path)
    expect(response.status).toBe(200)
    const before = refundCaseSchema.parse(await response.json())
    expect(before).toMatchObject({ adjustments: [], refunds: [], adjustedFen: 0, refundedFen: 0, reservedFen: 0 })
    const denied = await s.request(s.doctor, path)
    expect(denied.status).toBe(403)
    expect(apiErrorSchema.parse(await denied.json()).error.code).toBe('ROLE_NOT_ALLOWED')
    expect(await s.audits('billing.refunds.get')).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'R', outcome: { code: { code: '0' } } }),
      expect.objectContaining({ action: 'R', outcome: { code: { code: '8' } } }),
    ]))
    expect(refundCaseSchema.parse(await (await s.request(s.cashier, path)).json())).toEqual(before)
  })

  it('住院资金读取成功和越岗拒绝均可审计，读取不创建收退款', async () => {
    const s = await setup()
    const registered = await s.request(s.registrar, '/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: s.patient.id,
      patientVersion: s.patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 1000 })
    expect(registered.status).toBe(200)
    const admission = inpatientCommandResponseSchema.parse(await registered.json()).data.admission
    const path = `/api/his/v1/inpatient/admissions/${admission.id}/payments`
    const response = await s.request(s.cashier, path)
    expect(response.status).toBe(200)
    const before = inpatientPaymentsSchema.parse(await response.json())
    expect(before).toMatchObject({ payments: [], refunds: [], depositFen: 1000, refundedFen: 0, pendingCount: 0 })
    const denied = await s.request(s.doctor, path)
    expect(denied.status).toBe(403)
    expect(apiErrorSchema.parse(await denied.json()).error.code).toBe('INPATIENT_ROLE_FORBIDDEN')
    expect(await s.audits('inpatient.payment.read')).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'R', outcome: { code: { code: '0' } } }),
      expect.objectContaining({ action: 'R', outcome: { code: { code: '8' } } }),
    ]))
    expect(inpatientPaymentsSchema.parse(await (await s.request(s.cashier, path)).json())).toEqual(before)
  })

  it('后续财务差异读取保留成功和拒绝审计，不改变冻结账与当前指纹', async () => {
    const s = await setup(), nurse = await s.login('ward-nurse')
    const registered = await s.request(s.registrar, '/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: s.patient.id,
      patientVersion: s.patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 1000 })
    expect(registered.status).toBe(200)
    const admission = inpatientCommandResponseSchema.parse(await registered.json()).data.admission
    const path = `/api/his/v1/inpatient/admissions/${admission.id}`
    const received = await s.request(nurse, `${path}/receive`, { encounterVersion: admission.versionId, bedId: 'bed-general-1' })
    expect(received.status).toBe(200)
    const receivedAdmission = inpatientCommandResponseSchema.parse(await received.json()).data.admission
    const issued = await s.request(s.doctor, `${path}/discharge/issue`, { encounterVersion: receivedAdmission.versionId, reason: '合成治疗完成' })
    expect(issued.status).toBe(200)
    const issuedAdmission = inpatientCommandResponseSchema.parse(await issued.json()).data.admission
    expect((await s.request(nurse, `${path}/discharge/depart`, { encounterVersion: issuedAdmission.versionId, reason: '合成出区核对', departureMethod: 'home' })).status).toBe(200)
    const preview = inpatientSettlementPreviewSchema.parse(await (await s.request(s.cashier, `${path}/discharge/preview`)).json())
    const settled = await s.request(s.cashier, `${path}/discharge/settle`, { encounterVersion: preview.encounterVersion,
      fingerprint: preview.fingerprint, expectedChargesFen: preview.chargesFen, expectedBalanceFen: preview.balanceFen })
    expect(settled.status).toBe(200)
    // 内部 Command 计算不产生另一项外部读取，也不拆开结算事务。
    expect(await s.audits('inpatient.payment.read')).toEqual([])
    const frozen = inpatientSettlementPreviewSchema.parse(await (await s.request(s.cashier, `${path}/discharge/preview`)).json())
    const response = await s.request(s.cashier, `${path}/financial-adjustments`)
    expect(response.status).toBe(200)
    const before = inpatientFinancialSchema.parse(await response.json())
    expect(before).toMatchObject({ adjustments: [], payments: [], refunds: [], currentChargesFen: 0, currentFundsFen: 0 })
    const denied = await s.request(s.doctor, `${path}/financial-adjustments`)
    expect(denied.status).toBe(403)
    expect(apiErrorSchema.parse(await denied.json()).error.code).toBe('INPATIENT_ROLE_FORBIDDEN')
    expect(await s.audits('inpatient.financial.read')).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'R', outcome: { code: { code: '0' } } }),
      expect.objectContaining({ action: 'R', outcome: { code: { code: '8' } } }),
    ]))
    expect(inpatientFinancialSchema.parse(await (await s.request(s.cashier, `${path}/financial-adjustments`)).json())).toEqual(before)
    expect(inpatientSettlementPreviewSchema.parse(await (await s.request(s.cashier, `${path}/discharge/preview`)).json())).toEqual(frozen)
  })

  it('失败读取的审计无法写入时仍返回原岗位拒绝', async () => {
    const s = await setup()
    // 只注入审计存储故障；认证、owner 授权和 HTTP 错误映射继续使用真实实现。
    s.runtime.database.driver.exec(`CREATE TEMP TRIGGER reject_finance_read_audit BEFORE INSERT ON audit_log
      WHEN NEW.operation IN ('billing.refunds.get','inpatient.payment.read','inpatient.financial.read','insurance.get')
      BEGIN SELECT RAISE(ABORT,'synthetic read audit unavailable'); END`)
    const reads = [
      { path: '/api/his/v1/billing/cases/nonexistent/refunds', code: 'ROLE_NOT_ALLOWED' },
      { path: '/api/his/v1/inpatient/admissions/nonexistent/payments', code: 'INPATIENT_ROLE_FORBIDDEN' },
      { path: '/api/his/v1/inpatient/admissions/nonexistent/financial-adjustments', code: 'INPATIENT_ROLE_FORBIDDEN' },
      { path: '/api/his/v1/insurance/inpatient/nonexistent', code: 'INSURANCE_ROLE_FORBIDDEN' },
    ]
    for (const { path, code } of reads) {
      const response = await s.request(s.doctor, path)
      expect(response.status).toBe(403)
      expect(apiErrorSchema.parse(await response.json()).error.code).toBe(code)
    }
  })
})
