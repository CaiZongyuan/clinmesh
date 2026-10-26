import { billingCaseSchema, paymentPreviewResponseSchema, paymentResponseSchema } from '@clinmesh/contracts/his'
import { expect } from 'vitest'
import type { createClinMeshRuntime } from '../../src/runtime.ts'
import { mutation, signIn } from './imaging-scenario.ts'

type Runtime = Awaited<ReturnType<typeof createClinMeshRuntime>>

/** 临床回归通过收费员公共入口缴清原申请，再由原有受控 dispatcher 推进执行。 */
export async function payOutpatientInvestigation(runtime: Runtime, input: {
  caseId: string; category: 'imaging' | 'pathology'; chargeItemId: string
}) {
  const cashier = await signIn(runtime, 'cashier@demo.clinmesh.local')
  const detail = await runtime.app.request(`/api/his/v1/billing/cases/${input.caseId}`, { headers: { cookie: cashier } })
  expect(detail.status, await detail.clone().text()).toBe(200)
  const charge = billingCaseSchema.parse(await detail.json()).charges.find(item => item.chargeItemId === input.chargeItemId)!
  expect(charge).toBeDefined()
  const expectedVersions = { [`ChargeItem/${charge.chargeItemId}`]: String(charge.chargeVersion) }
  const previewResponse = await runtime.app.request('/api/his/v1/payments/actions/preview', mutation(cashier, {
    expectedVersions, input: { ...input, simulatorRule: 'success' },
  }))
  expect(previewResponse.status, await previewResponse.clone().text()).toBe(200)
  const preview = paymentPreviewResponseSchema.parse(await previewResponse.json()).data
  const confirmed = await runtime.app.request(`/api/his/v1/payments/${preview.previewId}/actions/confirm`, mutation(cashier, {
    expectedVersions, input: { commitToken: preview.commitToken },
  }))
  expect(confirmed.status, await confirmed.clone().text()).toBe(200)
  expect(paymentResponseSchema.parse(await confirmed.json()).data.outcome).toBe('success')
}
