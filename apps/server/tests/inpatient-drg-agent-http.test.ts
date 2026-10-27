import { afterEach, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { inpatientDrgAgentSchema } from '@clinmesh/contracts/inpatient-drg-agent'
import { createPciPaymentDrgFixture, preparePciPaymentDrgFixture } from './fixtures/pci-payment-drg.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

it('未开启跟进时住院医生可以读取建议状态，读取不发起模型请求', async () => {
  const prepared = await preparePciPaymentDrgFixture()
  cleanups.push(() => rm(prepared.directory, { recursive: true, force: true }))
  const fixture = await createPciPaymentDrgFixture(prepared)
  cleanups.push(() => fixture.runtime.close())
  const stay = await fixture.admitSyntheticCase(['I25.103'], 'bed-general-1')
  const response = await fixture.request('inpatient-doctor', `${stay.path}/drg/agent`)
  expect(response.status).toBe(200)
  expect(inpatientDrgAgentSchema.parse(await response.json())).toMatchObject({ admissionId: stay.admissionId, taskId: null,
    status: 'inactive', analysis: null, confirmedPlan: null })
  expect(prepared.modelCalls).toBe(0)
})
