import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { fhirBundleSchema, fhirResourceSchema } from '@clinmesh/contracts/fhir'
import { apiErrorSchema, commandResponseSchema, scenarioStateSchema } from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema, inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import {
  inpatientAngiographyReportSchema,
  inpatientAngiographyReportsSchema,
} from '@clinmesh/contracts/inpatient-angiography'
import {
  inpatientFullClinicalResponseSchema,
  inpatientFullClinicalSchema,
} from '@clinmesh/contracts/inpatient-clinical'
import {
  inpatientDischargeResponseSchema,
  inpatientSettlementPreviewSchema,
  inpatientSettlementResponseSchema,
} from '@clinmesh/contracts/inpatient-discharge'
import { inpatientDrgPregroupResultSchema } from '@clinmesh/contracts/inpatient-drg'
import { inpatientDrgReviewSchema } from '@clinmesh/contracts/inpatient-drg-review'
import {
  inpatientDrgSimulationSchema,
  inpatientMaterialReservationListSchema,
} from '@clinmesh/contracts/inpatient-drg-simulation'
import {
  inpatientMaterialEstimateResponseSchema,
  inpatientMaterialEstimatesSchema,
} from '@clinmesh/contracts/inpatient-material-estimate'
import {
  inpatientPciDataResponseSchema,
  pciCaseSourceResponseSchema,
  startSyntheticInpatientCaseResponseSchema,
} from '@clinmesh/contracts/inpatient-pci-data'
import { inpatientPciSelectionSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientRecordResponseSchema, inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
import {
  inpatientSurgeryCatalogSchema,
  inpatientSurgeryCompletionPreviewSchema,
  inpatientSurgeryResponseSchema,
} from '@clinmesh/contracts/inpatient-surgery'
import { applyMigrations, openClinMeshDatabase } from '../src/infrastructure/sqlite/database.ts'
import { WorkspaceRepository } from '../src/infrastructure/sqlite/workspace-repository.ts'
import {
  createPciPaymentDrgFixture,
  parsePciResponse,
  preparePciPaymentDrgFixture,
  type PciPaymentDrgFixture,
} from './fixtures/pci-payment-drg.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function admitCleanPciStay(fixture: PciPaymentDrgFixture) {
  const scenario = await fixture.read('admin', '/api/sim/v1/scenario-runs/current', scenarioStateSchema)
  await parsePciResponse(
    inpatientPciDataResponseSchema,
    await fixture.request('admin', '/api/his/v1/inpatient/pci-data/prepare', { expectedEpoch: scenario.epoch }),
  )
  const source = (
    await parsePciResponse(
      pciCaseSourceResponseSchema,
      await fixture.request('admin', '/api/sim/v1/synthetic-cases/pci/prepare', { expectedEpoch: scenario.epoch }),
    )
  ).data
  const cookie = await fixture.login('registrar')
  const startRes = await fixture.runtime.app.request(
    `/api/his/v1/synthetic-cases/${source.case.caseId}/actions/start-inpatient-visit`,
    {
      method: 'POST',
      headers: {
        cookie,
        origin: 'http://localhost',
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({
        activeBriefRevision: source.case.activeBriefRevision,
        expectedCaseRevision: source.case.revision,
        expectedEpoch: scenario.epoch,
        wardId: 'ward-general',
      }),
    },
  )
  const started = (await parsePciResponse(startSyntheticInpatientCaseResponseSchema, startRes)).data
  const path = `/api/his/v1/inpatient/admissions/${started.admissionId}`
  const registered = await fixture.read('registrar', path, inpatientDetailSchema)
  const admission = (
    await parsePciResponse(
      inpatientCommandResponseSchema,
      await fixture.request('ward-nurse', `${path}/receive`, {
        encounterVersion: registered.admission.versionId,
        bedId: 'bed-general-1',
      }),
    )
  ).data.admission
  await parsePciResponse(
    inpatientFullClinicalResponseSchema,
    await fixture.request('inpatient-doctor', `${path}/diagnoses/confirm`, {
      encounterVersion: admission.versionId,
      expectedRevision: 0,
      entries: [
        {
          catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I25.103',
          role: 'primary',
          admissionCondition: '1',
          note: '本院医生确认固定合成冠心病（同台造影转 PCI 验收）',
        },
      ],
    }),
  )
  const catalog = await fixture.read('inpatient-doctor', '/api/his/v1/inpatient/surgery-catalog', inpatientSurgeryCatalogSchema)
  return { admissionId: started.admissionId, patientId: started.patientId, path, catalog, scenario }
}

describe('同台冠脉造影直接转 PCI（Ad-hoc PCI）HTTP 与真实 SQLite 闭环', () => {
  it('完成单申请联合知情同意、单次术前核对、造影转 standby-pci、台内转 PCI、单次专科护理计费、零误报核查与显式主操作 FM39 归档', async () => {
    const prepared = await preparePciPaymentDrgFixture()
    const fixture = await createPciPaymentDrgFixture(prepared)
    cleanups.push(() => fixture.close())
    const stay = await admitCleanPciStay(fixture)
    const angioProc = stay.catalog.procedures.find(item => item.coding.code === '88.5500')!
    const pciProc = stay.catalog.procedures.find(item => item.coding.code === '36.0700')!

    // 1. 开立单份带 standbyAdHocPci: true 的冠脉造影申请
    const detail = await fixture.read('inpatient-doctor', stay.path, inpatientDetailSchema)
    const requested = (
      await parsePciResponse(
        inpatientSurgeryResponseSchema,
        await fixture.request('inpatient-doctor', `${stay.path}/surgeries/request`, {
          encounterVersion: detail.admission.versionId,
          surgeryType: 'elective',
          procedureId: angioProc.id,
          catalogVersion: angioProc.version,
          plannedFor: '2026-08-24T15:00:00+08:00',
          locationId: 'location-catheterization-lab',
          surgeonPractitionerId: 'practitioner-inpatient-doctor',
          anesthesiaMethod: 'local-infiltration',
          preopOrderPolicy: 'continue-active',
          standbyAdHocPci: true,
          reason: '冠状动脉造影并备选同台介入治疗（必要时行 PCI）',
        }),
      )
    ).data
    expect(requested.requests).toHaveLength(1)
    const req = requested.requests[0]!
    expect(req.standbyAdHocPci).toBe(true)
    expect(req.status).toBe('requested')

    // 校验 FHIR ServiceRequest.orderDetail 投影 standby-ad-hoc-pci
    const sr = fhirResourceSchema.parse(
      await (await fixture.request('inpatient-doctor', `/fhir/R5/ServiceRequest/${req.id}`)).json(),
    )
    expect(sr.status).toBe('active')
    expect(JSON.stringify(sr.orderDetail)).toContain('standby-ad-hoc-pci')

    // 为阶段 1 造影创建 1 根造影导管预留（用于验证阶段隔离：阶段 2 禁止消耗阶段 1 预留）
    const catheterMat = stay.catalog.materials.find(item => item.id === 'hospital-material-catheter')!
    const encForRes = await fixture.read('inpatient-doctor', stay.path, inpatientDetailSchema)
    const cagResList = (
      await parsePciResponse(
        commandResponseSchema(inpatientMaterialReservationListSchema),
        await fixture.request('inpatient-doctor', `${stay.path}/drg/reservations`, {
          encounterVersion: encForRes.admission.versionId,
          materialId: catheterMat.id,
          catalogVersion: catheterMat.version,
          quantity: 1,
          requestId: req.id,
          reason: '造影导管阶段 1 预留',
        }),
      )
    ).data
    const cagCatheterRes = cagResList.reservations.find(item => item.requestId === req.id)!
    expect(cagCatheterRes.surgeryStage).toBeUndefined()

    // 2. 仅一次护士术前核对 + 仅一次联合知情同意书签署
    const preop = (
      await parsePciResponse(
        inpatientSurgeryResponseSchema,
        await fixture.request('ward-nurse', `${stay.path}/surgeries/check-preop`, {
          requestId: req.id,
          expectedRequestVersion: req.version,
          note: '同台造影及备选 PCI 术前核对完成',
        }),
      )
    ).data.requests[0]!
    const clinical = await fixture.read('inpatient-doctor', `${stay.path}/clinical`, inpatientFullClinicalSchema)
    const consented = (
      await parsePciResponse(
        inpatientSurgeryResponseSchema,
        await fixture.request('inpatient-doctor', `${stay.path}/surgeries/confirm-consent`, {
          requestId: req.id,
          expectedRequestVersion: preop.version,
          expectedDiagnosisRevision: clinical.diagnosis.revision,
          signerRole: 'patient',
          signerName: '合成冠脉病例甲',
          patientChoice: 'agree',
          note: '已签署冠脉造影及必要时同台 PCI 联合知情同意书',
        }),
      )
    ).data.requests[0]!
    expect(consented.status).toBe('ready')
    expect(consented.consentConfirmation?.document?.templateId).toBe('coronary-angiography-ad-hoc-pci')
    expect(consented.consentConfirmation?.document?.title).toBe(
      '冠状动脉造影及必要时同台经皮冠状动脉介入治疗（PCI）知情同意书',
    )
    expect(consented.consentConfirmation?.document?.surgeryNotice.standbyAdHocPci).toBe(true)

    // 3. 阶段 1：实施冠脉造影（带对比剂/肝素/利多卡因套餐），不消耗造影导管预留以验证阶段 2 无法借用阶段 1 预留
    const pkg = stay.catalog.medicationPackages.find(item => item.id === 'catheterization-contrast-anticoagulation')!
    const cagDone = (
      await parsePciResponse(
        inpatientSurgeryResponseSchema,
        await fixture.request('inpatient-doctor', `${stay.path}/surgeries/execute`, {
          requestId: req.id,
          expectedRequestVersion: consented.version,
          procedureId: angioProc.id,
          catalogVersion: angioProc.version,
          note: '造影顺利完成，导管未拆封预留另处理',
          materials: [],
          medications: pkg.items.map(item => ({
            medicationId: item.medicationId,
            catalogVersion: item.catalogVersion!,
            doseText: item.doseText,
            quantity: item.quantity,
            routeCode: item.routeCode,
          })),
        }),
      )
    ).data
    const standbyReq = cagDone.requests[0]!
    expect(standbyReq.status).toBe('standby-pci')
    expect(cagDone.executions).toHaveLength(1)
    const cagExec = cagDone.executions[0]!
    expect(cagExec.executionStage).toBeUndefined()
    expect(cagExec.linkedNursing).toMatchObject({ amountFen: 8000, display: '术中介入专科护理' })
    expect(cagExec.sameSessionNursingIncluded).toBeUndefined()

    // standby-pci 期间 FHIR ServiceRequest 仍为 active
    const srStandby = fhirResourceSchema.parse(
      await (await fixture.request('inpatient-doctor', `/fhir/R5/ServiceRequest/${req.id}`)).json(),
    )
    expect(srStandby.status).toBe('active')

    // standby-pci 阻断出院医嘱
    const encStandby = await fixture.read('inpatient-doctor', stay.path, inpatientDetailSchema)
    const dischargeBlocked = await fixture.request('inpatient-doctor', `${stay.path}/discharge/issue`, {
      encounterVersion: encStandby.admission.versionId,
      reason: '尝试在待同台决策期间开出院',
    })
    expect(dischargeBlocked.status).toBe(409)
    expect(apiErrorSchema.parse(await dischargeBlocked.json()).error.code).toBe('INPATIENT_SURGERY_PENDING')

    // 造影报告尚未出结果（processing）时禁止转 PCI
    const convertWhileProcessing = await fixture.request('inpatient-doctor', `${stay.path}/surgeries/convert-to-pci`, {
      requestId: req.id,
      expectedRequestVersion: standbyReq.version,
      procedureId: pciProc.id,
      catalogVersion: pciProc.version,
      note: '报告尚未出结果即尝试转 PCI',
    })
    expect(convertWhileProcessing.status).toBe(409)
    expect(apiErrorSchema.parse(await convertWhileProcessing.json()).error.code).toBe('INPATIENT_SURGERY_CONFLICT')

    // 4. 派发确定性冠脉造影报告 -> final
    await fixture.runtime.dispatchPending()
    const reports = await fixture.read('inpatient-doctor', `${stay.path}/angiography-reports`, inpatientAngiographyReportsSchema)
    expect(reports.reports.some(item => item.procedureId === cagExec.id && item.status === 'final')).toBe(true)

    // 5. 同台直接转行 PCI（免二次手术申请、免二次知情同意、免二次术前核对）
    const converted = (
      await parsePciResponse(
        inpatientSurgeryResponseSchema,
        await fixture.request('inpatient-doctor', `${stay.path}/surgeries/convert-to-pci`, {
          requestId: req.id,
          expectedRequestVersion: standbyReq.version,
          procedureId: pciProc.id,
          catalogVersion: pciProc.version,
          note: '造影示 LAD 近段 90% 狭窄，同台直接转行药物洗脱支架置入术',
        }),
      )
    ).data
    expect(converted.requests).toHaveLength(1)
    const convertedReq = converted.requests[0]!
    expect(convertedReq.status).toBe('standby-pci')
    expect(convertedReq.adHocPci).toMatchObject({
      status: 'converted',
      procedure: expect.objectContaining({ id: pciProc.id }),
      note: '造影示 LAD 近段 90% 狭窄，同台直接转行药物洗脱支架置入术',
    })

    // 自动为同台 PCI 准备 QCA 选型草稿与 ad-hoc-pci 阶段单次耗材预计（派发队列使预计出队完成）
    await fixture.runtime.dispatchPending()
    const pciSelection = await fixture.read('inpatient-doctor', `${stay.path}/pci-selection`, inpatientPciSelectionSchema)
    const pciDraft = pciSelection.drafts?.find(item => item.requestId === req.id)
    expect(pciDraft).toBeDefined()
    expect(pciDraft?.parameters.targetSite).toBeTruthy()

    const estimatesBefore = await fixture.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)
    const adHocEstimate = estimatesBefore.estimates.find(item => item.requestId === req.id && item.surgeryStage === 'ad-hoc-pci')
    expect(adHocEstimate).toBeDefined()

    // DRG 模拟推演包含转 PCI 后的 FM39，且 committed 不重复计入第 2 笔 80 元介入专科护理费
    const simAfterConvert = await parsePciResponse(
      inpatientDrgSimulationSchema,
      await fixture.request('inpatient-doctor', `${stay.path}/drg/simulation`, { medications: [], services: [] }),
    )
    expect(simAfterConvert.grouping.projected?.drgCode).toBe('FM39')
    expect(simAfterConvert.committed.items.filter(item => item.display.includes('术中介入专科护理'))).toHaveLength(0)
    expect(simAfterConvert.committed.items.some(item => item.display.includes('支架') && item.estimatedFen === 180000)).toBe(true)

    // 6. 在 ad-hoc-pci 阶段确认 4 项 PCI 耗材预计并整批预留
    const pciMaterialIds = [
      'hospital-material-pci-stent',
      'hospital-material-pci-balloon',
      'hospital-material-pci-guidewire',
      'hospital-material-pci-guiding-catheter',
    ]
    const savedEstimate = (
      await parsePciResponse(
        inpatientMaterialEstimateResponseSchema,
        await fixture.request('inpatient-doctor', `${stay.path}/material-estimates/save`, {
          requestId: req.id,
          expectedVersion: adHocEstimate!.version,
          expectedDraftRevision: adHocEstimate!.draft?.revision ?? 0,
          expectedBasisFingerprint: adHocEstimate!.basisFingerprint,
          analysisId: null,
          items: pciMaterialIds.map(materialId => {
            const mat = stay.catalog.materials.find(item => item.id === materialId)!
            return { materialId: mat.id, catalogVersion: mat.version, quantity: 1, reason: '同台 PCI 按造影测量选型' }
          }),
          note: '同台 PCI 支架球囊导丝指引导管预留清单',
        }),
      )
    ).data
    const resListBeforeConfirm = await fixture.read('inpatient-doctor', `${stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)
    const resSetFp = resListBeforeConfirm.reservationSets.find(item => item.requestId === req.id)!.fingerprint
    await parsePciResponse(
      inpatientMaterialEstimateResponseSchema,
      await fixture.request('inpatient-doctor', `${stay.path}/material-estimates/confirm`, {
        requestId: req.id,
        expectedVersion: savedEstimate.version,
        expectedDraftRevision: savedEstimate.draft!.revision,
        expectedBasisFingerprint: savedEstimate.basisFingerprint,
        expectedRequestVersion: savedEstimate.requestVersion,
        encounterVersion: resListBeforeConfirm.encounterVersion,
        expectedReservationFingerprint: resSetFp,
        reason: '医生核对同台 PCI 耗材并预留',
      }),
    )
    const resAfterConfirm = await fixture.read('inpatient-doctor', `${stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)
    const adHocReservations = resAfterConfirm.reservations.filter(
      item => item.requestId === req.id && item.surgeryStage === 'ad-hoc-pci' && item.status === 'reserved',
    )
    expect(adHocReservations).toHaveLength(4)
    // 阶段 1 造影导管预留完好无损，未被同台 PCI 整批替换误释放
    expect(resAfterConfirm.reservations.find(item => item.id === cagCatheterRes.id)?.status).toBe('reserved')

    // 7. 阶段 2：分步实施同台 PCI（start -> 拒绝跨阶段预留 -> record-material -> record-medication -> preview-completion -> complete）
    const startedPci = (
      await parsePciResponse(
        inpatientSurgeryResponseSchema,
        await fixture.request('inpatient-doctor', `${stay.path}/surgeries/start`, {
          requestId: req.id,
          expectedRequestVersion: convertedReq.version,
          procedureId: pciProc.id,
          catalogVersion: pciProc.version,
        }),
      )
    ).data
    expect(startedPci.inProgress).toHaveLength(1)
    const pciExecInProgress = startedPci.inProgress[0]!
    expect(pciExecInProgress.executionStage).toBe('ad-hoc-pci')

    // 校验 FHIR Procedure.partOf 指向造影 Procedure
    const pciFhirProc = fhirResourceSchema.parse(
      await (await fixture.request('inpatient-doctor', `/fhir/R5/Procedure/${pciExecInProgress.id}`)).json(),
    )
    expect(pciFhirProc.partOf).toEqual([{ reference: `Procedure/${cagExec.id}` }])

    // 阶段隔离守卫：同台 PCI 禁止消耗阶段 1 造影预留
    const crossStageConsume = await fixture.request('inpatient-doctor', `${stay.path}/surgeries/record-material`, {
      requestId: req.id,
      expectedRequestVersion: startedPci.requests[0]!.version,
      executionId: pciExecInProgress.id,
      material: {
        materialId: catheterMat.id,
        catalogVersion: catheterMat.version,
        quantity: 1,
        reservationId: cagCatheterRes.id,
        expectedReservationVersion: cagCatheterRes.version,
      },
      note: '尝试跨阶段消耗阶段 1 预留',
    })
    expect(crossStageConsume.status).toBe(409)

    // 逐笔登记 4 项同台 PCI 预留耗材
    let latestReqVersion = startedPci.requests[0]!.version
    for (const reservation of adHocReservations) {
      const rec = (
        await parsePciResponse(
          inpatientSurgeryResponseSchema,
          await fixture.request('inpatient-doctor', `${stay.path}/surgeries/record-material`, {
            requestId: req.id,
            expectedRequestVersion: latestReqVersion,
            executionId: pciExecInProgress.id,
            material: {
              materialId: reservation.materialId,
              catalogVersion: reservation.catalogVersion!,
              quantity: reservation.quantity,
              reservationId: reservation.id,
              expectedReservationVersion: reservation.version,
            },
          }),
        )
      ).data
      latestReqVersion = rec.requests[0]!.version
    }

    // 同台 PCI 阶段追加台内基数药（肝素钠），绑定至阶段 2 Procedure
    const heparin = stay.catalog.baseStockMedications.find(item => item.id === 'medication-pci-heparin')!
    const medRecorded = (
      await parsePciResponse(
        inpatientSurgeryResponseSchema,
        await fixture.request('inpatient-doctor', `${stay.path}/surgeries/record-medication`, {
          requestId: req.id,
          expectedRequestVersion: latestReqVersion,
          executionId: pciExecInProgress.id,
          medication: {
            medicationId: heparin.id,
            catalogVersion: heparin.version,
            doseText: '1 mL',
            quantity: 1,
            routeCode: 'IV',
          },
          note: 'PCI 术中追加抗凝',
        }),
      )
    ).data
    latestReqVersion = medRecorded.requests[0]!.version
    const pciLiveExec = medRecorded.inProgress[0]!
    expect(pciLiveExec.medications).toHaveLength(1)

    // 校验 MedicationAdministration.partOf 指向 PCI Procedure
    const medAdminBundle = fhirBundleSchema.parse(
      await (await fixture.request('inpatient-doctor', `/fhir/R5/MedicationAdministration?encounter=Encounter/${stay.admissionId}`)).json(),
    )
    const pciMedAdmin = (medAdminBundle.entry ?? [])
      .map(entry => entry.resource)
      .find(res => res.id === pciLiveExec.medications![0]!.administrationId)
    expect(pciMedAdmin?.partOf).toEqual([{ reference: `Procedure/${pciExecInProgress.id}` }])

    // 预览完术：验证单次术中专科护理去重（nursingAmountFen === 0, linkedNursing === null, sameSessionNursingIncluded === true）
    const finalMaterials = pciLiveExec.materialHistory
      .filter(use => use.correction === null)
      .map(use => ({
        materialId: use.item.id,
        catalogVersion: use.item.version,
        quantity: use.quantity,
        materialUseIds: [use.id],
        ...(use.reservationId ? { reservationId: use.reservationId, expectedReservationVersion: 2 } : {}),
      }))
    const preview = await parsePciResponse(
      inpatientSurgeryCompletionPreviewSchema,
      await fixture.request('inpatient-doctor', `${stay.path}/surgeries/preview-completion`, {
        requestId: req.id,
        expectedRequestVersion: latestReqVersion,
        executionId: pciExecInProgress.id,
        finalMaterials,
        releaseReservations: [],
      }),
    )
    expect(preview.procedureAmountFen).toBe(180000)
    expect(preview.nursingAmountFen).toBe(0)
    expect(preview.linkedNursing).toBeNull()
    expect(preview.sameSessionNursingIncluded).toBe(true)
    expect(preview.totalDeltaFen).toBe(180000)

    // 完成同台 PCI
    const pciCompleted = (
      await parsePciResponse(
        inpatientSurgeryResponseSchema,
        await fixture.request('inpatient-doctor', `${stay.path}/surgeries/complete`, {
          requestId: req.id,
          expectedRequestVersion: latestReqVersion,
          executionId: pciExecInProgress.id,
          reconciliation: {
            finalMaterials,
            releaseReservations: [],
            expectedFingerprint: preview.fingerprint,
          },
        }),
      )
    ).data
    expect(pciCompleted.requests[0]!.status).toBe('completed')
    expect(pciCompleted.inProgress).toHaveLength(0)
    expect(pciCompleted.executions).toHaveLength(2)
    const pciExecDone = pciCompleted.executions.find(item => item.executionStage === 'ad-hoc-pci')!
    expect(pciExecDone.linkedNursing).toBeUndefined()
    expect(pciExecDone.sameSessionNursingIncluded).toBe(true)

    // FHIR ServiceRequest 已推进为 completed
    const srDone = fhirResourceSchema.parse(
      await (await fixture.request('inpatient-doctor', `/fhir/R5/ServiceRequest/${req.id}`)).json(),
    )
    expect(srDone.status).toBe('completed')

    // 校验整次住院费用：2 笔术式费（800 + 1800 元）、仅 1 笔术中介入专科护理费（80 元）、4 笔 PCI 耗材费、全部台内用药费
    const finalClinical = await fixture.read('inpatient-doctor', `${stay.path}/clinical`, inpatientFullClinicalSchema)
    const surgeryCharges = finalClinical.charges.filter(item => item.kind === 'surgery')
    const nursingCharges = finalClinical.charges.filter(item => item.kind === 'service' && item.label.includes('术中介入专科护理'))
    expect(surgeryCharges.map(item => item.amountFen).sort((a, b) => a - b)).toEqual([80000, 180000])
    expect(nursingCharges).toHaveLength(1)
    expect(nursingCharges[0]!.amountFen).toBe(8000)
    expect(finalClinical.charges.filter(item => item.kind === 'material')).toHaveLength(4)

    // 8. 术后 DRG 核查零误报（PCI 阶段无计划/耗材差异，不误报缺第二笔专科护理费）
    const drgReview = await fixture.read('inpatient-doctor', `${stay.path}/drg/review`, inpatientDrgReviewSchema)
    expect(drgReview.todos.filter(item => item.executionId === pciExecDone.id)).toEqual([])

    // 9. 绝不自动改写病案主操作 -> 显式确认 36.0700 为在院主操作 -> DRG 预分组 FM39
    const recordBefore = await fixture.read('inpatient-doctor', `${stay.path}/record`, inpatientRecordSchema)
    expect(recordBefore.snapshot.clinical.mainProcedureExecutionId).toBeNull()
    expect(recordBefore.snapshot.clinical.operations).toHaveLength(2)

    await parsePciResponse(
      inpatientRecordResponseSchema,
      await fixture.request('inpatient-doctor', `${stay.path}/record/submit`, {
        expectedRevision: recordBefore.revision?.revision ?? 0,
        expectedSourcesHash: recordBefore.sourcesHash,
        mainProcedureExecutionId: pciExecDone.id,
      }),
    )
    const pregroup = await fixture.read('inpatient-doctor', `${stay.path}/drg/pregroup`, inpatientDrgPregroupResultSchema)
    expect(pregroup.result).toMatchObject({ status: 'grouped', drgCode: 'FM39' })

    // 10. 完整出院、结算、清床、病案审核与不可变归档（FM39 冻结）
    await fixture.depart(stay)
    const settlementPreview = await fixture.read('cashier', `${stay.path}/discharge/preview`, inpatientSettlementPreviewSchema)
    const settleRes = await parsePciResponse(
      inpatientSettlementResponseSchema,
      await fixture.request('cashier', `${stay.path}/discharge/settle`, {
        encounterVersion: settlementPreview.encounterVersion,
        expectedChargesFen: settlementPreview.chargesFen,
        expectedBalanceFen: settlementPreview.balanceFen,
        fingerprint: settlementPreview.fingerprint,
      }),
    )
    const cleared = (
      await parsePciResponse(
        inpatientDischargeResponseSchema,
        await fixture.request('ward-nurse', `${stay.path}/discharge/clear`, {
          encounterVersion: settleRes.data.encounterVersion,
          reason: '清床完成',
        }),
      )
    ).data.admission
    expect(cleared.status).toBe('cleared')

    await fixture.confirmMainProcedure(stay, pciExecDone.id)
    const recToReview = await fixture.read('medical-records', `${stay.path}/record`, inpatientRecordSchema)
    const reviewed = (
      await parsePciResponse(
        inpatientRecordResponseSchema,
        await fixture.request('medical-records', `${stay.path}/record/review`, {
          expectedRevision: recToReview.revision!.revision,
          expectedSourcesHash: recToReview.sourcesHash,
          outcome: 'approved',
          reason: '同台造影转 PCI 编码审核通过',
        }),
      )
    ).data
    const archived = (
      await parsePciResponse(
        inpatientRecordResponseSchema,
        await fixture.request('medical-records', `${stay.path}/record/archive`, {
          expectedRevision: reviewed.revision!.revision,
          expectedSourcesHash: reviewed.sourcesHash,
        }),
      )
    ).data
    expect(archived.archive).toBeDefined()
    expect(archived.snapshot.clinical.mainProcedureExecutionId).toBe(pciExecDone.id)
    expect(prepared.modelCalls).toBe(0)
  }, 60_000)

  it('校验非造影拒绝 standbyAdHocPci、非备选造影直结、仅造影结束 FM59、放弃已转 PCI 释放预留与 FFR>0.80 质控越权', async () => {
    const prepared = await preparePciPaymentDrgFixture()
    const fixture = await createPciPaymentDrgFixture(prepared)
    cleanups.push(() => fixture.close())
    const stay = await admitCleanPciStay(fixture)
    const angioProc = stay.catalog.procedures.find(item => item.coding.code === '88.5500')!
    const pciProc = stay.catalog.procedures.find(item => item.coding.code === '36.0700')!

    // Guardrail 1: 非冠脉造影术式传 standbyAdHocPci: true -> 400
    const detail1 = await fixture.read('inpatient-doctor', stay.path, inpatientDetailSchema)
    const invalidStandby = await fixture.request('inpatient-doctor', `${stay.path}/surgeries/request`, {
      encounterVersion: detail1.admission.versionId,
      surgeryType: 'elective',
      procedureId: pciProc.id,
      catalogVersion: pciProc.version,
      plannedFor: '2026-08-24T15:00:00+08:00',
      locationId: 'location-catheterization-lab',
      surgeonPractitionerId: 'practitioner-inpatient-doctor',
      anesthesiaMethod: 'local-infiltration',
      preopOrderPolicy: 'continue-active',
      standbyAdHocPci: true,
      reason: '非造影术式错误开启同台备选',
    })
    expect(invalidStandby.status).toBe(400)

    // Guardrail 2: 普通冠脉造影（无 standbyAdHocPci）完成后直接进入 completed，不可 convert-to-pci
    const normalReq = (
      await parsePciResponse(
        inpatientSurgeryResponseSchema,
        await fixture.request('inpatient-doctor', `${stay.path}/surgeries/request`, {
          encounterVersion: detail1.admission.versionId,
          surgeryType: 'elective',
          procedureId: angioProc.id,
          catalogVersion: angioProc.version,
          plannedFor: '2026-08-24T15:00:00+08:00',
          locationId: 'location-catheterization-lab',
          surgeonPractitionerId: 'practitioner-inpatient-doctor',
          anesthesiaMethod: 'local-infiltration',
          preopOrderPolicy: 'continue-active',
          reason: '单纯诊断性冠脉造影',
        }),
      )
    ).data.requests[0]!
    expect(normalReq.standbyAdHocPci).toBeUndefined()
    const clin1 = await fixture.read('inpatient-doctor', `${stay.path}/clinical`, inpatientFullClinicalSchema)
    const nPreop = (
      await parsePciResponse(
        inpatientSurgeryResponseSchema,
        await fixture.request('ward-nurse', `${stay.path}/surgeries/check-preop`, {
          requestId: normalReq.id,
          expectedRequestVersion: normalReq.version,
          note: '术前核对完成',
        }),
      )
    ).data.requests.find(item => item.id === normalReq.id)!
    const nConsent = (
      await parsePciResponse(
        inpatientSurgeryResponseSchema,
        await fixture.request('inpatient-doctor', `${stay.path}/surgeries/confirm-consent`, {
          requestId: normalReq.id,
          expectedRequestVersion: nPreop.version,
          expectedDiagnosisRevision: clin1.diagnosis.revision,
          signerRole: 'patient',
          signerName: '合成冠脉病例甲',
          patientChoice: 'agree',
          note: '单纯造影知情同意',
        }),
      )
    ).data.requests.find(item => item.id === normalReq.id)!
    expect(nConsent.consentConfirmation?.document?.templateId).toBe('coronary-angiography')
    const normalDone = (
      await parsePciResponse(
        inpatientSurgeryResponseSchema,
        await fixture.request('inpatient-doctor', `${stay.path}/surgeries/execute`, {
          requestId: normalReq.id,
          expectedRequestVersion: nConsent.version,
          procedureId: angioProc.id,
          catalogVersion: angioProc.version,
          note: '单纯造影实施完成',
          materials: [],
        }),
      )
    ).data
    const completedNormalReq = normalDone.requests.find(item => item.id === normalReq.id)!
    expect(completedNormalReq.status).toBe('completed')
    const convertNormal = await fixture.request('inpatient-doctor', `${stay.path}/surgeries/convert-to-pci`, {
      requestId: normalReq.id,
      expectedRequestVersion: completedNormalReq.version,
      procedureId: pciProc.id,
      catalogVersion: pciProc.version,
    })
    expect(convertNormal.status).toBe(409)

    // Guardrail 3: 备选同台造影完成后选择「仅完成造影，结束本台手术」（finalize-standby 无理由可直接收口）-> FM59
    const detail2 = await fixture.read('inpatient-doctor', stay.path, inpatientDetailSchema)
    const cagOnlyReq = (
      await parsePciResponse(
        inpatientSurgeryResponseSchema,
        await fixture.request('inpatient-doctor', `${stay.path}/surgeries/request`, {
          encounterVersion: detail2.admission.versionId,
          surgeryType: 'elective',
          procedureId: angioProc.id,
          catalogVersion: angioProc.version,
          plannedFor: '2026-08-24T16:00:00+08:00',
          locationId: 'location-catheterization-lab',
          surgeonPractitionerId: 'practitioner-inpatient-doctor',
          anesthesiaMethod: 'local-infiltration',
          preopOrderPolicy: 'continue-active',
          standbyAdHocPci: true,
          reason: '备选同台造影后仅保留造影分支验证',
        }),
      )
    ).data.requests.find(item => item.reason === '备选同台造影后仅保留造影分支验证')!
    const p2 = (
      await parsePciResponse(
        inpatientSurgeryResponseSchema,
        await fixture.request('ward-nurse', `${stay.path}/surgeries/check-preop`, {
          requestId: cagOnlyReq.id,
          expectedRequestVersion: cagOnlyReq.version,
          note: '核对完成',
        }),
      )
    ).data.requests.find(item => item.id === cagOnlyReq.id)!
    const c2 = (
      await parsePciResponse(
        inpatientSurgeryResponseSchema,
        await fixture.request('inpatient-doctor', `${stay.path}/surgeries/confirm-consent`, {
          requestId: cagOnlyReq.id,
          expectedRequestVersion: p2.version,
          expectedDiagnosisRevision: clin1.diagnosis.revision,
          signerRole: 'patient',
          signerName: '合成冠脉病例甲',
          patientChoice: 'agree',
        }),
      )
    ).data.requests.find(item => item.id === cagOnlyReq.id)!
    const d2 = (
      await parsePciResponse(
        inpatientSurgeryResponseSchema,
        await fixture.request('inpatient-doctor', `${stay.path}/surgeries/execute`, {
          requestId: cagOnlyReq.id,
          expectedRequestVersion: c2.version,
          procedureId: angioProc.id,
          catalogVersion: angioProc.version,
          note: '造影示病变轻，无需 PCI',
          materials: [],
        }),
      )
    ).data
    const cagOnlyStandby = d2.requests.find(item => item.id === cagOnlyReq.id)!
    expect(cagOnlyStandby.status).toBe('standby-pci')
    const cagOnlyExecId = d2.executions.find(item => item.requestId === cagOnlyReq.id)!.id
    // 造影报告为 unavailable 或无有效临床所见的 partial 时必须拒绝同台转 PCI（避免绕过造影依据与 FFR 质控）
    await fixture.runtime.dispatchPending()
    const cagOnlyReport = (
      await fixture.read('inpatient-doctor', `${stay.path}/angiography-reports`, inpatientAngiographyReportsSchema)
    ).reports.find(item => item.procedureId === cagOnlyExecId)!
    for (const unusable of [
      { ...cagOnlyReport, status: 'unavailable' as const, targetSite: null, measurements: [], vessels: [], conclusion: null, missing: ['无造影真值来源'] },
      { ...cagOnlyReport, status: 'partial' as const, targetSite: null, measurements: [], vessels: [], conclusion: null, missing: ['造影节段解析缺项'] },
    ]) {
      const updated = fixture.runtime.database.driver
        .prepare('UPDATE inpatient_angiography_report SET report_json=? WHERE workspace_id=? AND epoch=? AND procedure_id=?')
        .run(JSON.stringify(unusable), stay.scenario.workspaceId, stay.scenario.epoch, cagOnlyExecId)
      expect(updated.changes).toBe(1)
      const rejectedUnusable = await fixture.request('inpatient-doctor', `${stay.path}/surgeries/convert-to-pci`, {
        requestId: cagOnlyReq.id,
        expectedRequestVersion: cagOnlyStandby.version,
        procedureId: pciProc.id,
        catalogVersion: pciProc.version,
        note: '尝试在无有效造影报告时转行 PCI',
      })
      expect(rejectedUnusable.status).toBe(409)
      expect(apiErrorSchema.parse(await rejectedUnusable.json()).error.code).toBe('INPATIENT_SURGERY_CONFLICT')
    }
    const finalizedCagOnly = (
      await parsePciResponse(
        inpatientSurgeryResponseSchema,
        await fixture.request('inpatient-doctor', `${stay.path}/surgeries/finalize-standby`, {
          requestId: cagOnlyReq.id,
          expectedRequestVersion: cagOnlyStandby.version,
        }),
      )
    ).data
    const closedCagOnly = finalizedCagOnly.requests.find(item => item.id === cagOnlyReq.id)!
    expect(closedCagOnly.status).toBe('completed')
    expect(closedCagOnly.standbyFinalization).toBeDefined()
    const cagOnlyExec = finalizedCagOnly.executions.find(item => item.requestId === cagOnlyReq.id)!
    const recMid = await fixture.read('inpatient-doctor', `${stay.path}/record`, inpatientRecordSchema)
    await parsePciResponse(
      inpatientRecordResponseSchema,
      await fixture.request('inpatient-doctor', `${stay.path}/record/submit`, {
        expectedRevision: recMid.revision?.revision ?? 0,
        expectedSourcesHash: recMid.sourcesHash,
        mainProcedureExecutionId: cagOnlyExec.id,
      }),
    )
    const fm59 = await fixture.read('inpatient-doctor', `${stay.path}/drg/pregroup`, inpatientDrgPregroupResultSchema)
    expect(fm59.result).toMatchObject({ status: 'grouped', drgCode: 'FM59' })

    // Guardrail 4: FFR > 0.80 触发 convert-to-pci CLINICAL_QUALITY_ALERT，越权通过后放弃同台 PCI（须必填理由并释放 ad-hoc-pci 预留）
    const detail3 = await fixture.read('inpatient-doctor', stay.path, inpatientDetailSchema)
    const ffrReq = (
      await parsePciResponse(
        inpatientSurgeryResponseSchema,
        await fixture.request('inpatient-doctor', `${stay.path}/surgeries/request`, {
          encounterVersion: detail3.admission.versionId,
          surgeryType: 'elective',
          procedureId: angioProc.id,
          catalogVersion: angioProc.version,
          plannedFor: '2026-08-24T17:00:00+08:00',
          locationId: 'location-catheterization-lab',
          surgeonPractitionerId: 'practitioner-inpatient-doctor',
          anesthesiaMethod: 'local-infiltration',
          preopOrderPolicy: 'continue-active',
          standbyAdHocPci: true,
          reason: '临界病变 FFR>0.80 同台转 PCI 质控与放弃分支验证',
        }),
      )
    ).data.requests.find(item => item.reason === '临界病变 FFR>0.80 同台转 PCI 质控与放弃分支验证')!
    const p3 = (
      await parsePciResponse(
        inpatientSurgeryResponseSchema,
        await fixture.request('ward-nurse', `${stay.path}/surgeries/check-preop`, {
          requestId: ffrReq.id,
          expectedRequestVersion: ffrReq.version,
          note: '核对完成',
        }),
      )
    ).data.requests.find(item => item.id === ffrReq.id)!
    const c3 = (
      await parsePciResponse(
        inpatientSurgeryResponseSchema,
        await fixture.request('inpatient-doctor', `${stay.path}/surgeries/confirm-consent`, {
          requestId: ffrReq.id,
          expectedRequestVersion: p3.version,
          expectedDiagnosisRevision: clin1.diagnosis.revision,
          signerRole: 'patient',
          signerName: '合成冠脉病例甲',
          patientChoice: 'agree',
        }),
      )
    ).data.requests.find(item => item.id === ffrReq.id)!
    const d3 = (
      await parsePciResponse(
        inpatientSurgeryResponseSchema,
        await fixture.request('inpatient-doctor', `${stay.path}/surgeries/execute`, {
          requestId: ffrReq.id,
          expectedRequestVersion: c3.version,
          procedureId: angioProc.id,
          catalogVersion: angioProc.version,
          note: '造影完成待评估 FFR',
          materials: [],
        }),
      )
    ).data
    const ffrExec = d3.executions.find(item => item.requestId === ffrReq.id)!
    const ffrStandby = d3.requests.find(item => item.id === ffrReq.id)!
    await fixture.runtime.dispatchPending()

    // 将该造影报告覆写为功能学非缺血临界病变（FFR = 0.86 > 0.80）
    const scheduled = z.object({ report_id: z.string() }).parse(
      fixture.runtime.database.driver
        .prepare('SELECT report_id FROM inpatient_angiography_report WHERE workspace_id=? AND epoch=? AND admission_id=? AND procedure_id=?')
        .get(stay.scenario.workspaceId, stay.scenario.epoch, stay.admissionId, ffrExec.id),
    )
    const nonIschemic = inpatientAngiographyReportSchema.parse({
      id: scheduled.report_id,
      version: 1,
      admissionId: stay.admissionId,
      procedureId: ffrExec.id,
      status: 'final',
      synthetic: true,
      targetSite: '前降支中段',
      measurements: [
        { kind: 'lesion-length', object: 'lesion', site: '前降支中段', value: 12, unit: 'mm', method: 'QCA', source: { reference: `DiagnosticReport/${scheduled.report_id}`, version: '1', note: '合成QCA', synthetic: true } },
        { kind: 'proximal-reference-diameter', object: 'reference-lumen', site: '前降支中段', value: 3, unit: 'mm', method: 'QCA', source: { reference: `DiagnosticReport/${scheduled.report_id}`, version: '1', note: '合成QCA', synthetic: true } },
        { kind: 'distal-reference-diameter', object: 'reference-lumen', site: '前降支中段', value: 3, unit: 'mm', method: 'QCA', source: { reference: `DiagnosticReport/${scheduled.report_id}`, version: '1', note: '合成QCA', synthetic: true } },
      ],
      vessels: [{ vessel: 'LAD', segment: '前降支中段', stenosisPercent: 60, timiFlow: 3, lesionCharacteristics: '临界病变', ffr: 0.86 }],
      conclusion: '前降支中段临界狭窄，FFR 0.86 功能学非缺血。',
      missing: [],
      issuedAt: '2026-08-24T17:10:00+08:00',
    })
    fixture.runtime.database.driver
      .prepare('UPDATE inpatient_angiography_report SET report_json=? WHERE workspace_id=? AND epoch=? AND admission_id=? AND procedure_id=?')
      .run(JSON.stringify(nonIschemic), stay.scenario.workspaceId, stay.scenario.epoch, stay.admissionId, ffrExec.id)

    // 无 clinicalOverride 拦截 409 CLINICAL_QUALITY_ALERT (PCI_NON_ISCHEMIC_LESION)
    const ffrBlocked = await fixture.request('inpatient-doctor', `${stay.path}/surgeries/convert-to-pci`, {
      requestId: ffrReq.id,
      expectedRequestVersion: ffrStandby.version,
      procedureId: pciProc.id,
      catalogVersion: pciProc.version,
      note: '尝试对非缺血病变直接转 PCI',
    })
    expect(ffrBlocked.status).toBe(409)
    expect(apiErrorSchema.parse(await ffrBlocked.json()).error).toMatchObject({
      code: 'CLINICAL_QUALITY_ALERT',
      clinicalQuality: {
        alerts: [expect.objectContaining({ code: 'PCI_NON_ISCHEMIC_LESION', tier: 'alert' })],
      },
    })

    // 带受审计 clinicalOverride 通过转 PCI
    const ffrConverted = (
      await parsePciResponse(
        inpatientSurgeryResponseSchema,
        await fixture.request('inpatient-doctor', `${stay.path}/surgeries/convert-to-pci`, {
          requestId: ffrReq.id,
          expectedRequestVersion: ffrStandby.version,
          procedureId: pciProc.id,
          catalogVersion: pciProc.version,
          note: '结合反复典型心绞痛症状个体化拟行介入',
          clinicalOverride: {
            reasonCode: 'clinical-judgement',
            note: '患者静息心绞痛频发伴高危斑块形态，经专科讨论拟同台 PCI',
            acknowledgedAlerts: ['PCI_NON_ISCHEMIC_LESION'],
          },
        }),
      )
    ).data.requests.find(item => item.id === ffrReq.id)!
    expect(ffrConverted.adHocPci?.status).toBe('converted')

    // 验证 clinical_quality_override 持久化记录
    const overrideCount = z.object({ c: z.number() }).parse(
      fixture.runtime.database.driver
        .prepare("SELECT COUNT(*) AS c FROM clinical_quality_override WHERE workspace_id=? AND epoch=? AND operation='inpatient.surgery.convert-to-pci'")
        .get(stay.scenario.workspaceId, stay.scenario.epoch),
    )
    expect(overrideCount.c).toBe(1)

    // 创建 1 项 ad-hoc-pci 预留，然后尝试不填理由放弃 -> 400 INPATIENT_SURGERY_NOTE_REQUIRED
    const stentMat = stay.catalog.materials.find(item => item.id === 'hospital-material-pci-stent')!
    const encFfr = await fixture.read('inpatient-doctor', stay.path, inpatientDetailSchema)
    const ffrRes = (
      await parsePciResponse(
        commandResponseSchema(inpatientMaterialReservationListSchema),
        await fixture.request('inpatient-doctor', `${stay.path}/drg/reservations`, {
          encounterVersion: encFfr.admission.versionId,
          materialId: stentMat.id,
          catalogVersion: stentMat.version,
          quantity: 1,
          requestId: ffrReq.id,
          reason: '拟同台支架预留',
        }),
      )
    ).data.reservations.find(item => item.requestId === ffrReq.id && item.surgeryStage === 'ad-hoc-pci')!
    expect(ffrRes.status).toBe('reserved')

    const abandonWithoutNote = await fixture.request('inpatient-doctor', `${stay.path}/surgeries/finalize-standby`, {
      requestId: ffrReq.id,
      expectedRequestVersion: ffrConverted.version,
    })
    expect(abandonWithoutNote.status).toBe(400)
    expect(apiErrorSchema.parse(await abandonWithoutNote.json()).error.code).toBe('INPATIENT_SURGERY_NOTE_REQUIRED')

    // 填写理由放弃同台 PCI -> 释放 ad-hoc-pci 预留、取消 ad-hoc-pci 耗材预计，保留造影执行与计费
    const abandoned = (
      await parsePciResponse(
        inpatientSurgeryResponseSchema,
        await fixture.request('inpatient-doctor', `${stay.path}/surgeries/finalize-standby`, {
          requestId: ffrReq.id,
          expectedRequestVersion: ffrConverted.version,
          note: '复评 FFR 0.86 及斑块稳定性，改行强化药物保守治疗',
        }),
      )
    ).data
    const closedFfrReq = abandoned.requests.find(item => item.id === ffrReq.id)!
    expect(closedFfrReq.status).toBe('completed')
    expect(closedFfrReq.adHocPci?.status).toBe('cancelled')
    expect(closedFfrReq.standbyFinalization?.note).toBe('复评 FFR 0.86 及斑块稳定性，改行强化药物保守治疗')
    const afterAbandonRes = await fixture.read('inpatient-doctor', `${stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)
    expect(afterAbandonRes.reservations.find(item => item.id === ffrRes.id)?.status).toBe('released')
    const afterAbandonEst = await fixture.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)
    expect(
      afterAbandonEst.estimates.find(item => item.requestId === ffrReq.id && item.surgeryStage === 'ad-hoc-pci')?.status,
    ).toBe('cancelled')
    expect(abandoned.executions.some(item => item.id === ffrExec.id)).toBe(true)
  }, 60_000)

  it('0122 迁移从旧版数据库升级保留历史行默认值、外键完整且支持同申请双阶段执行隔离', async () => {
    const migrationFile = '0122_surgery-ad-hoc-pci.sql'
    const migrationDir = await mkdtemp(join(tmpdir(), 'clinmesh-0122-migration-'))
    const preMigrations = join(migrationDir, 'pre')
    await mkdir(preMigrations, { recursive: true })
    const db = openClinMeshDatabase({ databasePath: join(migrationDir, 'upgrade.sqlite'), busyTimeoutMs: 5000 })
    try {
      await Promise.all(
        (await readdir('drizzle'))
          .filter(file => file.endsWith('.sql') && file < migrationFile)
          .map(file => copyFile(join('drizzle', file), join(preMigrations, file))),
      )
      applyMigrations(db, preMigrations)
      const scope = { workspaceId: 'synthetic-0122', epoch: 'epoch-1', scenarioRunId: 'run-1' }
      const now = '2026-11-25T09:00:00.000Z'
      new WorkspaceRepository(db).install({ ...scope, scenarioId: 'synthetic-0122', workspaceName: '合成0122迁移验证' })
      db.driver
        .prepare("INSERT INTO scenario_definition(scenario_id,version,kind,schema_version) VALUES('synthetic-0122','1','candidate','1')")
        .run()
      db.driver
        .prepare(
          "INSERT INTO scenario_epoch_state(workspace_id,epoch,scenario_run_id,scenario_id,deterministic_seed,virtual_time,initial_state_hash) VALUES(?,?,'run-1','synthetic-0122',1,?,?)",
        )
        .run(scope.workspaceId, scope.epoch, now, '0'.repeat(64))
      db.driver
        .prepare("INSERT INTO inpatient_ward(workspace_id,epoch,ward_id,organization_id,name) VALUES(?,?,'ward-1','org-1','合成病区')")
        .run(scope.workspaceId, scope.epoch)
      db.driver
        .prepare(
          `INSERT INTO inpatient_admission(workspace_id,epoch,admission_id,patient_id,inpatient_number,admission_route,ward_id,organization_id,status,financial_status,record_status,registered_at,admitted_at)
           VALUES(?,?,'adm-1','pat-1','ZY-0122','direct','ward-1','org-1','admitted','open','open',?,?)`,
        )
        .run(scope.workspaceId, scope.epoch, now, now)
      const procJson = JSON.stringify({
        id: 'hospital-surgery-7',
        version: 1,
        coding: {
          system: 'urn:clinmesh:classification:icd-9-cm-3-clinical',
          version: '3.0',
          code: '88.5500',
          display: '单根导管的冠状动脉造影术',
          category: '诊断性操作',
          releaseId: 'clinmesh-surgery-subset-2026-10-20',
          sourceUrl: 'https://example.com/s',
          sourceSha256: 'a'.repeat(64),
          sourceLocator: 's',
        },
        chargeDefinition: { id: 'c-7', priceFen: 80000, unit: '次', synthetic: true, trigger: 'execution' },
      })
      db.driver
        .prepare(
          `INSERT INTO inpatient_surgery_request(workspace_id,epoch,request_id,admission_id,version,status,planned_procedure_json,planned_for,reason,requested_at,requested_by,organization_id)
           VALUES(?,?,'req-legacy','adm-1',3,'completed',?,?,'升级前造影',?,'doctor','org-1')`,
        )
        .run(scope.workspaceId, scope.epoch, procJson, now, now)
      db.driver
        .prepare(
          `INSERT INTO inpatient_surgery_execution(workspace_id,epoch,execution_id,request_id,admission_id,actual_procedure_json,performed_at,performed_by,practitioner_role_id,organization_id,note,status,completed_at)
           VALUES(?,?,'exec-legacy','req-legacy','adm-1',?,?,'doctor','role-doctor','org-1','旧版执行','completed',?)`,
        )
        .run(scope.workspaceId, scope.epoch, procJson, now, now)
      db.driver
        .prepare(
          `INSERT INTO inpatient_material_estimate(workspace_id,epoch,task_id,admission_id,request_id,version,context_json,authorization_operation,basis_json,basis_fingerprint,status,automatic_pending,created_at)
           VALUES(?,?,'est-legacy','adm-1','req-legacy',1,'{}','inpatient.surgery.request','{}','fp','active',0,?)`,
        )
        .run(scope.workspaceId, scope.epoch, now)
      db.driver
        .prepare(
          `INSERT INTO inpatient_material_reservation(workspace_id,epoch,reservation_id,admission_id,request_id,material_id,catalog_version,material_display,price_fen,quantity,status,reason,actor_id,practitioner_role_id,created_at)
           VALUES(?,?,'res-legacy','adm-1','req-legacy','mat-1',1,'导管',1000,1,'reserved','旧预留','doctor','role-doctor',?)`,
        )
        .run(scope.workspaceId, scope.epoch, now)

      expect(applyMigrations(db).applied).toEqual([migrationFile, '0123_surgery-preop-policy-and-postop-investigations.sql', '0124_clinical-fact-verification.sql', '0125_local-source-ingestion.sql', '0126_disease-pack-runtime.sql', '0127_bedside-questionnaire-answers.sql', '0128_clinical-prompt-cards.sql', '0129_pack-exit-state.sql', '0130_disease-pack-activation.sql'])
      expect(db.driver.pragma('foreign_key_check')).toEqual([])

      expect(
        db.driver.prepare('SELECT standby_ad_hoc_pci, ad_hoc_pci_json, standby_finalization_json FROM inpatient_surgery_request WHERE request_id=?').get('req-legacy'),
      ).toEqual({ standby_ad_hoc_pci: 0, ad_hoc_pci_json: null, standby_finalization_json: null })
      expect(
        db.driver.prepare('SELECT execution_stage, linked_nursing_json, same_session_nursing_included FROM inpatient_surgery_execution WHERE execution_id=?').get('exec-legacy'),
      ).toEqual({ execution_stage: 'primary', linked_nursing_json: null, same_session_nursing_included: 0 })
      expect(
        db.driver.prepare('SELECT surgery_stage FROM inpatient_material_estimate WHERE task_id=?').get('est-legacy'),
      ).toEqual({ surgery_stage: 'primary' })
      expect(
        db.driver.prepare('SELECT surgery_stage FROM inpatient_material_reservation WHERE reservation_id=?').get('res-legacy'),
      ).toEqual({ surgery_stage: 'primary' })

      // 同 request_id 允许追加唯一 ad-hoc-pci 阶段执行，但禁止重复 primary 执行
      db.driver
        .prepare(
          `INSERT INTO inpatient_surgery_execution(workspace_id,epoch,execution_id,request_id,admission_id,execution_stage,actual_procedure_json,performed_at,performed_by,practitioner_role_id,organization_id,note,status,completed_at,linked_nursing_json,same_session_nursing_included)
           VALUES(?,?,'exec-adhoc','req-legacy','adm-1','ad-hoc-pci',?,?,'doctor','role-doctor','org-1','同台PCI','completed',?,NULL,1)`,
        )
        .run(scope.workspaceId, scope.epoch, procJson, now, now)
      expect(() =>
        db.driver
          .prepare(
            `INSERT INTO inpatient_surgery_execution(workspace_id,epoch,execution_id,request_id,admission_id,execution_stage,actual_procedure_json,performed_at,performed_by,practitioner_role_id,organization_id,note,status,completed_at)
             VALUES(?,?,'exec-dup-primary','req-legacy','adm-1','primary',?,?,'doctor','role-doctor','org-1','重复造影','completed',?)`,
          )
          .run(scope.workspaceId, scope.epoch, procJson, now, now),
      ).toThrow()
    } finally {
      db.close()
      await rm(migrationDir, { recursive: true, force: true })
    }
  })
})
