import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import {
  doctorCaseDetailSchema,
  imagingRequestDraftResponseSchema,
  issueImagingRequestResponseSchema,
  sessionContextSchema,
} from '@clinmesh/contracts/his'
import { describe, expect, it } from 'vitest'
import { installSyntheticImagingAssets } from './fixtures/imaging-catalog.ts'
import { payOutpatientInvestigation } from './fixtures/pay-outpatient-investigation.ts'
import {
  caseBundle, createImagingRuntime, generateCase, lungCancer,
  mutation, prepareImaging, signIn, snomed, startConsultation,
} from './fixtures/imaging-scenario.ts'

describe('门诊独立检查的应收与执行门禁', () => {
  it('正式开立生成原申请应收，未收款不受理且缺少放行快照不执行', async () => {
    const created = await createImagingRuntime([caseBundle({
      gender: 'male', index: [{ ...lungCancer, resourceType: 'Condition' }], name: '门诊收费合成病例',
    })], { persona: true })
    const { runtime } = created
    try {
      await installSyntheticImagingAssets({
        assetDirectory: created.assetDirectory,
        assets: [{ assetId: 'billing-synthetic-radiograph', examCode: 'chest-radiograph' }],
        catalogDirectory: created.catalogDirectory,
        matching: {
          codeSystem: snomed,
          profiles: [{
            ageRange: [18, 89], assets: { 'chest-radiograph': 'billing-synthetic-radiograph' },
            conditionCodes: [lungCancer.code], finding: 'positive', id: 'billing-lung-mass',
            label: '门诊收费合成胸片', sex: 'male',
          }],
          ruleVersion: 1, schemaVersion: 1, sourceExamCodes: {}, uncoveredConditions: [],
        },
      })
      const administrator = await signIn(runtime)
      const caseId = await generateCase(runtime, administrator)
      await prepareImaging(runtime, administrator, [caseId])
      const visit = await startConsultation(runtime, administrator, caseId)
      const expectedVersions = { [`Encounter/${visit.encounterId}`]: '3' }
      const saved = await runtime.app.request(`/api/his/v1/encounters/${visit.encounterId}/imaging-request/draft`, mutation(visit.doctor, {
        expectedVersions,
        input: { expectedDraftVersion: 0, indication: '咳嗽两周，排查肺部病变', serviceId: 'imaging-chest-radiograph' },
      }, 'PUT'))
      expect(saved.status).toBe(200)
      const draft = imagingRequestDraftResponseSchema.parse(await saved.json()).data
      const response = await runtime.app.request(`/api/his/v1/encounters/${visit.encounterId}/imaging-request/actions/issue`, mutation(visit.doctor, {
        expectedVersions, input: { expectedDraftVersion: draft.draftVersion },
      }))
      expect(response.status).toBe(200)
      const issued = issueImagingRequestResponseSchema.parse(await response.json()).data.request
      expect(issued.billing).toMatchObject({
        status: 'pending', paidFen: 0, remainingFen: 8000,
        price: { priceFen: 8000, currency: 'CNY', unit: '次检查', source: 'synthetic-outpatient-investigation-2026-10-26-v1' },
      })
      const authenticated = await runtime.app.request('/api/auth/context', { headers: { cookie: visit.doctor } })
      expect(authenticated.status).toBe(200)
      const { actor } = sessionContextSchema.parse(await authenticated.json())
      const context = {
        actorId: 'actor-ris-system', roleCode: 'ris-system', epoch: actor.epoch,
        scenarioRunId: actor.scenarioRunId, workspaceId: actor.workspaceId,
      }
      expect(() => runtime.workflow.imaging.accept({
        context, eventId: randomUUID(), requestId: issued.id,
      })).toThrow('原检查申请尚未收齐费用')
      while (await runtime.dispatcher.dispatchOnce() !== undefined) { /* 只处理受控 outbox。 */ }
      const detailResponse = await runtime.app.request(`/api/his/v1/doctor/cases/${visit.outpatientCaseId}`, { headers: { cookie: visit.doctor } })
      expect(detailResponse.status).toBe(200)
      const detail = doctorCaseDetailSchema.parse(await detailResponse.json())
      expect(detail.imagingRequests?.requests.find(request => request.id === issued.id)).toMatchObject({ status: 'issued', billing: { status: 'pending' } })

      await payOutpatientInvestigation(runtime, {
        caseId: visit.outpatientCaseId, category: 'imaging', chargeItemId: issued.billing!.chargeItemId,
      })
      expect(runtime.workflow.imaging.accept({ context, eventId: randomUUID(), requestId: issued.id }).data.status).toBe('accepted')
      const acceptedResponse = await runtime.app.request(`/api/his/v1/doctor/cases/${visit.outpatientCaseId}`, { headers: { cookie: visit.doctor } })
      expect(acceptedResponse.status).toBe(200)
      expect(doctorCaseDetailSchema.parse(await acceptedResponse.json()).imagingRequests?.requests.find(request => request.id === issued.id))
        .toMatchObject({ status: 'accepted', billing: { status: 'paid', releasedAt: expect.any(String) } })
      // 仅在 arrange 阶段破坏合成持久化记录，独立证明 start 的快照守卫。
      runtime.database.driver.prepare(`UPDATE outpatient_investigation_billing SET release_json=NULL,released_at=NULL
        WHERE workspace_id=? AND epoch=? AND request_id=?`).run(actor.workspaceId, actor.epoch, issued.id)
      expect(() => runtime.workflow.imaging.start({ context, eventId: randomUUID(), requestId: issued.id }))
        .toThrow('原检查申请尚未取得财务放行许可')
    } finally {
      await runtime.close()
      await rm(created.directory, { recursive: true, force: true })
    }
  })
})
