import { randomUUID } from 'node:crypto'
import { expect } from '@playwright/test'
import { billingCaseSchema, paymentPreviewResponseSchema, paymentResponseSchema } from '@clinmesh/contracts/his'
import type { createClinMeshRuntime } from '../../server/src/runtime.ts'
import { signIn } from '../../server/tests/fixtures/consultation.ts'

type BillingServer = { runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>; origin: string; password: string }

/** 临床浏览器回归经收费员公共 HTTP 合同缴清原费用，医生会话保持原权限。 */
export async function collectOutpatientInvestigation(server: BillingServer, input: {
  caseId: string; category: 'laboratory' | 'imaging' | 'pathology'; chargeItemId: string
}) {
  const cookie = await signIn(server.runtime, 'cashier@demo.clinmesh.local', server.password, server.origin)
  const response = await server.runtime.app.request(`/api/his/v1/billing/cases/${input.caseId}`, { headers: { cookie } })
  expect(response.status).toBe(200)
  const charge = billingCaseSchema.parse(await response.json()).charges.find(item => item.chargeItemId === input.chargeItemId)
  if (charge === undefined) throw new Error('Expected the original investigation ChargeItem')
  expect(charge.category).toBe(input.category)
  const expectedVersions = { [`ChargeItem/${charge.chargeItemId}`]: String(charge.chargeVersion) }
  const write = (body: object) => ({
    method: 'POST', headers: { cookie, origin: server.origin, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify(body),
  })
  const previewResponse = await server.runtime.app.request('/api/his/v1/payments/actions/preview', write({
    expectedVersions, input: { ...input, simulatorRule: 'success' },
  }))
  expect(previewResponse.status).toBe(200)
  const preview = paymentPreviewResponseSchema.parse(await previewResponse.json()).data
  const confirmed = await server.runtime.app.request(`/api/his/v1/payments/${preview.previewId}/actions/confirm`, write({
    expectedVersions, input: { commitToken: preview.commitToken },
  }))
  expect(confirmed.status).toBe(200)
  expect(paymentResponseSchema.parse(await confirmed.json()).data.outcome).toBe('success')
}
