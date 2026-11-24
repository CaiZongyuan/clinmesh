import { rm } from 'node:fs/promises'
import {
  acknowledgeExaminationReportResponseSchema,
  acknowledgeImagingReportResponseSchema,
  acknowledgeLaboratoryReportResponseSchema,
  acknowledgePathologyReportResponseSchema,
  apiErrorSchema,
  billingCaseSchema,
  caseImagingServiceCatalogSchema,
  casePathologyServiceCatalogSchema,
  clinicalDocumentDraftResponseSchema,
  clinicalDocumentRevisionResponseSchema,
  clinicalCatalogSchema,
  confirmNoMedicationResponseSchema,
  createPatientResponseSchema,
  diagnosisDraftResponseSchema,
  doctorCaseDetailSchema,
  doctorCompletedCaseDetailSchema,
  encounterCompletionPreviewSchema,
  encounterCompletionResponseSchema,
  examinationRequestDraftResponseSchema,
  firstVisitDraftResponseSchema,
  imagingRequestDraftResponseSchema,
  issueExaminationRequestResponseSchema,
  issueImagingRequestResponseSchema,
  issueLaboratoryRequestResponseSchema,
  issuePathologyRequestResponseSchema,
  issuePrescriptionResponseSchema,
  laboratoryOrderResponseSchema,
  laboratoryRequestDraftResponseSchema,
  pathologyRequestDraftResponseSchema,
  prescriptionDraftResponseSchema,
  registrationCatalogSchema,
  registrationResponseSchema,
  startVisitResponseSchema,
  triageResponseSchema,
} from '@clinmesh/contracts/his'
import { afterEach, describe, expect, it } from 'vitest'
import { EXAMINATION_ECG_SYSTEM } from '../src/application/scenario-data/truth-stage.ts'
import type { createClinMeshRuntime } from '../src/runtime.ts'
import { useSyntheticLaboratoryCatalog } from './fixtures/consultation.ts'
import { installSyntheticImagingAssets } from './fixtures/imaging-catalog.ts'
import {
  createImagingRuntime,
  generateCase,
  mutation,
  prepareImaging,
  signIn,
  snomed,
  startConsultation,
} from './fixtures/imaging-scenario.ts'
import {
  confirmPrimaryOutpatientDiagnosis,
  defaultOutpatientGateDocument,
  signInitialOutpatientDocument,
} from './fixtures/outpatient-order-gate.ts'
import { installSyntheticPathologySlides } from './fixtures/pathology-catalog.ts'
import {
  breastCaseBundle,
  lumpectomy,
  preparePathology,
} from './fixtures/pathology-scenario.ts'
import { payOutpatientInvestigation } from './fixtures/pay-outpatient-investigation.ts'

type Runtime = Awaited<ReturnType<typeof createClinMeshRuntime>>

describe('Outpatient initial clinical document signing & diagnosis order gate (#515)', () => {
  const runtimes: Runtime[] = []
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map(runtime => runtime.close()))
    await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
  })

  async function setupBreastAndChestConsultation() {
    const bundle = breastCaseBundle({
      name: '合成门禁闭环患者',
      procedures: [lumpectomy],
    })
    bundle.entry.push(
      {
        fullUrl: 'urn:uuid:index-bronchitis',
        resource: {
          code: { coding: [{ code: '10509002', display: '急性支气管炎', system: snomed }] },
          encounter: { reference: 'urn:uuid:index-encounter' },
          id: 'ibronch',
          recordedDate: '2026-06-01T10:05:00+08:00',
          resourceType: 'Condition',
          subject: { reference: 'urn:uuid:patient' },
        } as never,
      },
      {
        fullUrl: 'urn:uuid:index-wbc',
        resource: {
          code: { coding: [{ code: '6690-2', display: '白细胞计数', system: 'http://loinc.org' }] },
          effectiveDateTime: '2026-06-01T10:15:00+08:00',
          encounter: { reference: 'urn:uuid:index-encounter' },
          id: 'iwtest',
          interpretation: [{ coding: [{ code: 'N', system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation' }] }],
          issued: '2026-06-01T10:20:00+08:00',
          referenceRange: [{ high: { unit: '10*9/L', value: 9.5 }, low: { unit: '10*9/L', value: 3.5 }, text: '3.5-9.5 x10^9/L' }],
          resourceType: 'Observation',
          status: 'final',
          subject: { reference: 'urn:uuid:patient' },
          valueQuantity: { system: 'http://unitsofmeasure.org', unit: '10*9/L', value: 6.8 },
        } as never,
      },
      {
        fullUrl: 'urn:uuid:index-hgb',
        resource: {
          code: { coding: [{ code: '718-7', display: '血红蛋白', system: 'http://loinc.org' }] },
          effectiveDateTime: '2026-06-01T10:15:00+08:00',
          encounter: { reference: 'urn:uuid:index-encounter' },
          id: 'ihtest',
          interpretation: [{ coding: [{ code: 'N', system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation' }] }],
          issued: '2026-06-01T10:20:00+08:00',
          referenceRange: [{ high: { unit: 'g/L', value: 150 }, low: { unit: 'g/L', value: 115 }, text: '115-150 g/L' }],
          resourceType: 'Observation',
          status: 'final',
          subject: { reference: 'urn:uuid:patient' },
          valueQuantity: { system: 'http://unitsofmeasure.org', unit: 'g/L', value: 132 },
        } as never,
      },
      {
        fullUrl: 'urn:uuid:index-plt',
        resource: {
          code: { coding: [{ code: '777-3', display: '血小板计数', system: 'http://loinc.org' }] },
          effectiveDateTime: '2026-06-01T10:15:00+08:00',
          encounter: { reference: 'urn:uuid:index-encounter' },
          id: 'iptest',
          interpretation: [{ coding: [{ code: 'N', system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation' }] }],
          issued: '2026-06-01T10:20:00+08:00',
          referenceRange: [{ high: { unit: '10*9/L', value: 350 }, low: { unit: '10*9/L', value: 125 }, text: '125-350 x10^9/L' }],
          resourceType: 'Observation',
          status: 'final',
          subject: { reference: 'urn:uuid:patient' },
          valueQuantity: { system: 'http://unitsofmeasure.org', unit: '10*9/L', value: 210 },
        } as never,
      },
      ...([
        ['rhythm', { valueString: '窦性心律' }],
        ['ventricular-rate', { valueQuantity: { code: '/min', system: 'http://unitsofmeasure.org', unit: '/min', value: 72 } }],
        ['pr-interval', { valueQuantity: { code: 'ms', system: 'http://unitsofmeasure.org', unit: 'ms', value: 160 } }],
        ['qrs-duration', { valueQuantity: { code: 'ms', system: 'http://unitsofmeasure.org', unit: 'ms', value: 90 } }],
        ['qtc-interval', { valueQuantity: { code: 'ms', system: 'http://unitsofmeasure.org', unit: 'ms', value: 410 } }],
        ['st-t-anterior', { valueString: '未见明显异常' }],
        ['st-t-inferior', { valueString: '未见明显异常' }],
        ['st-t-lateral', { valueString: '未见明显异常' }],
      ] as const).map(([code, val], index) => ({
        fullUrl: `urn:uuid:index-ecg-${index}`,
        resource: {
          code: { coding: [{ code, system: EXAMINATION_ECG_SYSTEM }] },
          effectiveDateTime: '2026-06-01T10:16:00+08:00',
          encounter: { reference: 'urn:uuid:index-encounter' },
          id: `iecg-${index}`,
          issued: '2026-06-01T10:20:00+08:00',
          resourceType: 'Observation',
          status: 'final',
          subject: { reference: 'urn:uuid:patient' },
          ...val,
        } as never,
      })),
    )
    const created = await createImagingRuntime([bundle], { persona: true })
    directories.push(created.directory)
    runtimes.push(created.runtime)
    useSyntheticLaboratoryCatalog(created.runtime)
    created.runtime.database.driver.prepare("UPDATE outpatient_catalog SET price_fen = 1800 WHERE item_id = 'lab-cbc'").run()

    await installSyntheticImagingAssets({
      assetDirectory: created.assetDirectory,
      assets: [{ assetId: 'synthetic-chest-normal', examCode: 'chest-radiograph' }],
      catalogDirectory: created.catalogDirectory,
      matching: {
        codeSystem: snomed,
        profiles: [{
          ageRange: [18, 89],
          assets: { 'chest-radiograph': 'synthetic-chest-normal' },
          finding: 'negative',
          id: 'breast-followup-chest-normal',
          indexConditionCodes: ['10509002'],
          label: '乳腺术后随访胸片未见结节',
        }],
        ruleVersion: 1,
        schemaVersion: 1,
        sourceExamCodes: {},
        uncoveredConditions: [],
      },
    })
    await installSyntheticPathologySlides({
      assetDirectory: created.pathologyAssetDirectory,
      catalogDirectory: created.pathologyCatalogDirectory,
      slides: [{ assetId: 'synthetic-slide-luminal' }],
    })

    const admin = await signIn(created.runtime)
    const syntheticCaseId = await generateCase(created.runtime, admin)
    await prepareImaging(created.runtime, admin, [syntheticCaseId])
    await preparePathology(created.runtime, admin, [syntheticCaseId])

    const visit = await startConsultation(created.runtime, admin, syntheticCaseId)
    return { ...created, ...visit, admin }
  }

  async function dispatchAll(runtime: Runtime) {
    while ((await runtime.dispatcher.dispatchOnce()) !== undefined) {
      // drain synthetic outbox
    }
  }

  it('rejects all 6 outpatient issuance commands and batch confirmations before signing & diagnosis confirmation, preserves drafts, keeps eligibility during post-sign revision drafting, and enforces revision draft completion gate', async () => {
    const visit = await setupBreastAndChestConsultation()
    const { runtime, doctor, encounterId, outpatientCaseId } = visit
    const cashier = await signIn(runtime, 'cashier@demo.clinmesh.local')
    const encounterPath = `/api/his/v1/encounters/${encounterId}`

    const clinicalCatalog = clinicalCatalogSchema.parse(
      await (await runtime.app.request('/api/his/v1/catalogs/clinical', { headers: { cookie: doctor } })).json(),
    )
    expect(clinicalCatalog.medications.length).toBeGreaterThan(0)
    const labService = clinicalCatalog.laboratory.find(item => item.id === 'lab-cbc')!
    expect(labService).toBeDefined()
    const imagingCatalog = caseImagingServiceCatalogSchema.parse(
      await (await runtime.app.request(
        `/api/his/v1/doctor/cases/${outpatientCaseId}/imaging-services`,
        { headers: { cookie: doctor } },
      )).json(),
    )
    const imagingService = imagingCatalog.items.find(item => item.available)!.service
    const pathologyCatalog = casePathologyServiceCatalogSchema.parse(
      await (await runtime.app.request(
        `/api/his/v1/doctor/cases/${outpatientCaseId}/pathology-services`,
        { headers: { cookie: doctor } },
      )).json(),
    )
    const pathologyOffering = pathologyCatalog.items.find(item => item.available)!
    const pathologyProcedure = pathologyOffering.sourceProcedures[0]!

    // 1. Pre-gate draft saving & read-only order-set / clinical-quality preflight remain allowed
    const orderSetsPreflight = await runtime.app.request(
      `/api/his/v1/doctor/cases/${outpatientCaseId}/order-set-drafts`,
      { headers: { cookie: doctor } },
    )
    expect(orderSetsPreflight.status).toBe(200)
    const qualityPreflight = await runtime.app.request(
      `${encounterPath}/clinical-quality?gate=outpatient-prescription`,
      { headers: { cookie: doctor } },
    )
    expect(qualityPreflight.status).toBe(200)

    const initialDocDraftRes = await runtime.app.request(
      `${encounterPath}/clinical-document/draft`,
      mutation(doctor, {
        expectedVersions: { [`Encounter/${encounterId}`]: '3' },
        input: { document: defaultOutpatientGateDocument, expectedDraftVersion: 0 },
      }, 'PUT'),
    )
    expect(initialDocDraftRes.status).toBe(200)
    clinicalDocumentDraftResponseSchema.parse(await initialDocDraftRes.json())

    const labDraft = laboratoryRequestDraftResponseSchema.parse(await (await runtime.app.request(
      `${encounterPath}/laboratory-request/draft`,
      mutation(doctor, {
        expectedVersions: { [`Encounter/${encounterId}`]: '3' },
        input: {
          catalogItemId: labService.id,
          expectedDraftVersion: 0,
          indicationCode: labService.allowedIndicationCodes[0]!,
        },
      }, 'PUT'),
    )).json()).data

    const examDraft = examinationRequestDraftResponseSchema.parse(await (await runtime.app.request(
      `${encounterPath}/examination-request/draft`,
      mutation(doctor, {
        expectedVersions: { [`Encounter/${encounterId}`]: '3' },
        input: {
          expectedDraftVersion: 0,
          indication: '门诊初诊心律筛查',
          serviceId: 'examination-ecg-12-lead',
        },
      }, 'PUT'),
    )).json()).data

    const imagingDraft = imagingRequestDraftResponseSchema.parse(await (await runtime.app.request(
      `${encounterPath}/imaging-request/draft`,
      mutation(doctor, {
        expectedVersions: { [`Encounter/${encounterId}`]: '3' },
        input: {
          expectedDraftVersion: 0,
          indication: '门诊胸部影像学基线评估',
          serviceId: imagingService.id,
        },
      }, 'PUT'),
    )).json()).data

    const pathologyDraft = pathologyRequestDraftResponseSchema.parse(await (await runtime.app.request(
      `${encounterPath}/pathology-request/draft`,
      mutation(doctor, {
        expectedVersions: { [`Encounter/${encounterId}`]: '3' },
        input: {
          expectedDraftVersion: 0,
          purpose: '既往乳腺手术切片本院病理复核',
          serviceId: pathologyOffering.service.id,
          sourceProcedureReference: pathologyProcedure.sourceReference,
        },
      }, 'PUT'),
    )).json()).data

    const rxDraft = prescriptionDraftResponseSchema.parse(await (await runtime.app.request(
      `${encounterPath}/prescription/draft`,
      mutation(doctor, {
        expectedVersions: { [`Encounter/${encounterId}`]: '3' },
        input: {
          expectedDraftVersion: 0,
          items: [{
            catalogItemId: 'medication-oseltamivir',
            courseDays: 5,
            doseText: '75 mg',
            frequencyCode: 'BID',
            quantity: 10,
            routeCode: 'PO',
          }],
        },
      }, 'PUT'),
    )).json()).data

    // 2. Unsigned clinical document -> all 6 single commands + batch confirmations fail with 409 CLINICAL_DOCUMENT_UNSIGNED
    const assertGateBlocked = async (expectedCode: 'CLINICAL_DOCUMENT_UNSIGNED' | 'DIAGNOSIS_UNCONFIRMED', encounterVer: string) => {
      const expectedVersions = { [`Encounter/${encounterId}`]: encounterVer }
      const singleEndpoints = [
        [`${encounterPath}/laboratory-request/actions/issue`, { expectedDraftVersion: labDraft.draftVersion }],
        [`${encounterPath}/examination-request/actions/issue`, { expectedDraftVersion: examDraft.draftVersion }],
        [`${encounterPath}/imaging-request/actions/issue`, { expectedDraftVersion: imagingDraft.draftVersion }],
        [`${encounterPath}/pathology-request/actions/issue`, { expectedDraftVersion: pathologyDraft.draftVersion }],
        [`${encounterPath}/prescription/actions/issue`, { expectedDraftVersion: rxDraft.draftVersion }],
        [`${encounterPath}/medication-conclusion/actions/confirm-no-medication`, { expectedDraftVersion: rxDraft.draftVersion }],
      ] as const
      for (const [path, input] of singleEndpoints) {
        const res = await runtime.app.request(path, mutation(doctor, { expectedVersions, input }))
        expect(res.status, path).toBe(409)
        expect(apiErrorSchema.parse(await res.json()), path).toMatchObject({
          error: { code: expectedCode },
        })
      }

      const batchPayloads = [
        ['laboratory', {
          expectedDraftVersion: labDraft.draftVersion,
          resolveExistingDraft: true,
          selections: [{
            catalogItemId: labService.id,
            indicationCode: labService.allowedIndicationCodes[0]!,
            kind: 'laboratory',
            reviewedService: { id: labService.id, outpatientBilling: labService.outpatientBilling ?? null, version: labService.version },
            source: 'manual',
          }],
        }],
        ['imaging', {
          expectedDraftVersion: imagingDraft.draftVersion,
          resolveExistingDraft: true,
          selections: [{
            indication: '门诊胸部影像学基线评估',
            kind: 'imaging',
            reviewedService: { id: imagingService.id, outpatientBilling: imagingService.outpatientBilling ?? null, version: imagingService.version },
            serviceId: imagingService.id,
            source: 'manual',
          }],
        }],
        ['pathology', {
          expectedDraftVersion: pathologyDraft.draftVersion,
          resolveExistingDraft: true,
          selections: [{
            kind: 'pathology',
            purpose: '既往乳腺手术切片本院病理复核',
            reviewedService: {
              id: pathologyOffering.service.id,
              outpatientBilling: pathologyOffering.service.outpatientBilling ?? null,
              version: pathologyOffering.service.version,
            },
            serviceId: pathologyOffering.service.id,
            source: 'manual',
            sourceProcedureReference: pathologyProcedure.sourceReference,
          }],
        }],
        ['prescription', {
          expectedDraftVersion: rxDraft.draftVersion,
          resolveExistingDraft: true,
          selections: [{
            catalogItemId: 'medication-oseltamivir',
            courseDays: 5,
            doseText: '75 mg',
            frequencyCode: 'BID',
            kind: 'prescription',
            quantity: 10,
            routeCode: 'PO',
            source: 'manual',
          }],
        }],
      ] as const
      for (const [kind, input] of batchPayloads) {
        const res = await runtime.app.request(
          `/api/his/v1/doctor/cases/${outpatientCaseId}/recommendations/${kind}/actions/confirm`,
          mutation(doctor, { expectedVersions, input }),
        )
        expect(res.status, `batch:${kind}`).toBe(409)
        expect(apiErrorSchema.parse(await res.json()), `batch:${kind}`).toMatchObject({
          error: { code: expectedCode },
        })
      }
    }

    await assertGateBlocked('CLINICAL_DOCUMENT_UNSIGNED', '3')

    const billingBeforeGate = billingCaseSchema.parse(
      await (await runtime.app.request(`/api/his/v1/billing/cases/${outpatientCaseId}`, { headers: { cookie: cashier } })).json(),
    )
    expect(billingBeforeGate.charges.map(charge => charge.category)).toEqual(['registration'])

    // 3. Sign initial structured clinical document, save unconfirmed diagnosis draft -> still rejected with DIAGNOSIS_UNCONFIRMED
    const rootSigned = await signInitialOutpatientDocument(runtime, doctor, outpatientCaseId)
    const unconfirmedDiagDraft = await runtime.app.request(
      `${encounterPath}/diagnosis/draft`,
      mutation(doctor, {
        expectedVersions: { [`Encounter/${encounterId}`]: rootSigned.encounterVersion },
        input: {
          entries: [{ catalogItemId: 'diagnosis-influenza', role: 'primary' }],
          expectedDraftVersion: 0,
        },
      }, 'PUT'),
    )
    expect(unconfirmedDiagDraft.status).toBe(200)
    diagnosisDraftResponseSchema.parse(await unconfirmedDiagDraft.json())

    await assertGateBlocked('DIAGNOSIS_UNCONFIRMED', rootSigned.encounterVersion)

    // 4. Confirm primary diagnosis -> gate opens; subsequent revision drafts of document & diagnosis do NOT revoke eligibility
    const confirmed = await confirmPrimaryOutpatientDiagnosis(
      runtime,
      doctor,
      outpatientCaseId,
      'diagnosis-influenza',
    )
    const currentDetailAfterConfirm = doctorCaseDetailSchema.parse(
      await (await runtime.app.request(`/api/his/v1/doctor/cases/${outpatientCaseId}`, { headers: { cookie: doctor } })).json(),
    )
    const interimRevisionSave = await runtime.app.request(
      `${encounterPath}/clinical-document/draft`,
      mutation(doctor, {
        expectedVersions: { [`Encounter/${encounterId}`]: confirmed.encounterVersion },
        input: {
          document: {
            ...defaultOutpatientGateDocument,
            assessment: '首签后正在整理补充评估（尚未签署修订版）。',
          },
          expectedDraftVersion: currentDetailAfterConfirm.clinicalDocument!.draft!.version,
        },
      }, 'PUT'),
    )
    expect(interimRevisionSave.status).toBe(200)
    const interimRevisionDraft = clinicalDocumentDraftResponseSchema.parse(await interimRevisionSave.json()).data

    const secondDiagDraftRes = await runtime.app.request(
      `${encounterPath}/diagnosis/draft`,
      mutation(doctor, {
        expectedVersions: { [`Encounter/${encounterId}`]: confirmed.encounterVersion },
        input: {
          entries: [
            { catalogItemId: 'diagnosis-influenza', role: 'primary' },
            { catalogItemId: 'diagnosis-fever', role: 'secondary' },
          ],
          expectedDraftVersion: confirmed.diagnosisVersion,
        },
      }, 'PUT'),
    )
    expect(secondDiagDraftRes.status).toBe(200)
    const secondDiagDraft = diagnosisDraftResponseSchema.parse(await secondDiagDraftRes.json()).data

    // Issue all 4 investigation modalities + prescription while both revision drafts are active!
    const expectedAfterConfirm = { [`Encounter/${encounterId}`]: confirmed.encounterVersion }
    const issuedLab = issueLaboratoryRequestResponseSchema.parse(await (await runtime.app.request(
      `${encounterPath}/laboratory-request/actions/issue`,
      mutation(doctor, { expectedVersions: expectedAfterConfirm, input: { expectedDraftVersion: labDraft.draftVersion } }),
    )).json()).data.request
    const issuedExam = issueExaminationRequestResponseSchema.parse(await (await runtime.app.request(
      `${encounterPath}/examination-request/actions/issue`,
      mutation(doctor, { expectedVersions: expectedAfterConfirm, input: { expectedDraftVersion: examDraft.draftVersion } }),
    )).json()).data.request
    const issuedImaging = issueImagingRequestResponseSchema.parse(await (await runtime.app.request(
      `${encounterPath}/imaging-request/actions/issue`,
      mutation(doctor, { expectedVersions: expectedAfterConfirm, input: { expectedDraftVersion: imagingDraft.draftVersion } }),
    )).json()).data.request
    const issuedPathology = issuePathologyRequestResponseSchema.parse(await (await runtime.app.request(
      `${encounterPath}/pathology-request/actions/issue`,
      mutation(doctor, { expectedVersions: expectedAfterConfirm, input: { expectedDraftVersion: pathologyDraft.draftVersion } }),
    )).json()).data.request
    const issuedPrescription = issuePrescriptionResponseSchema.parse(await (await runtime.app.request(
      `${encounterPath}/prescription/actions/issue`,
      mutation(doctor, { expectedVersions: expectedAfterConfirm, input: { expectedDraftVersion: rxDraft.draftVersion } }),
    )).json()).data.prescription
    expect(issuedPrescription.status).toBe('signed')

    // Pay & dispatch all 4 investigations and acknowledge reports
    for (const [category, chargeItemId] of [
      ['laboratory', issuedLab.billing!.chargeItemId],
      ['examination', issuedExam.billing!.chargeItemId],
      ['imaging', issuedImaging.billing!.chargeItemId],
      ['pathology', issuedPathology.billing!.chargeItemId],
    ] as const) {
      await payOutpatientInvestigation(runtime, {
        caseId: outpatientCaseId,
        category,
        chargeItemId,
      })
    }
    await dispatchAll(runtime)

    const reportedDetail = doctorCaseDetailSchema.parse(
      await (await runtime.app.request(`/api/his/v1/doctor/cases/${outpatientCaseId}`, { headers: { cookie: doctor } })).json(),
    )
    const labReport = reportedDetail.laboratoryRequests!.requests[0]!
    const examReport = reportedDetail.examinationRequests!.requests[0]!
    const imagingReport = reportedDetail.imagingRequests!.requests[0]!
    const pathologyReport = reportedDetail.pathologyRequests!.requests[0]!

    acknowledgeLaboratoryReportResponseSchema.parse(await (await runtime.app.request(
      `/api/his/v1/laboratory-requests/${labReport.id}/reports/${labReport.report!.diagnosticReportId}/actions/acknowledge`,
      mutation(doctor, {
        expectedVersions: {
          [`DiagnosticReport/${labReport.report!.diagnosticReportId}`]: labReport.report!.diagnosticReportVersion,
          [`ServiceRequest/${labReport.serviceRequestId}`]: labReport.serviceRequestVersion,
          [`Task/${labReport.taskId}`]: labReport.taskVersion,
        },
        input: { expectedRequestVersion: labReport.version },
      }),
    )).json())
    acknowledgeExaminationReportResponseSchema.parse(await (await runtime.app.request(
      `/api/his/v1/examination-requests/${examReport.id}/reports/${examReport.report!.diagnosticReportId}/actions/acknowledge`,
      mutation(doctor, {
        expectedVersions: {
          [`DiagnosticReport/${examReport.report!.diagnosticReportId}`]: examReport.report!.diagnosticReportVersion,
          [`ServiceRequest/${examReport.serviceRequestId}`]: examReport.serviceRequestVersion,
          [`Task/${examReport.taskId}`]: examReport.taskVersion,
        },
        input: { expectedRequestVersion: examReport.version },
      }),
    )).json())
    acknowledgeImagingReportResponseSchema.parse(await (await runtime.app.request(
      `/api/his/v1/imaging-requests/${imagingReport.id}/reports/${imagingReport.report!.diagnosticReportId}/actions/acknowledge`,
      mutation(doctor, {
        expectedVersions: {
          [`DiagnosticReport/${imagingReport.report!.diagnosticReportId}`]: imagingReport.report!.diagnosticReportVersion,
          [`ServiceRequest/${imagingReport.serviceRequestId}`]: imagingReport.serviceRequestVersion,
          [`Task/${imagingReport.taskId}`]: imagingReport.taskVersion,
        },
        input: { expectedRequestVersion: imagingReport.version },
      }),
    )).json())
    acknowledgePathologyReportResponseSchema.parse(await (await runtime.app.request(
      `/api/his/v1/pathology-requests/${pathologyReport.id}/reports/${pathologyReport.report!.diagnosticReportId}/actions/acknowledge`,
      mutation(doctor, {
        expectedVersions: {
          [`DiagnosticReport/${pathologyReport.report!.diagnosticReportId}`]: pathologyReport.report!.diagnosticReportVersion,
          [`ServiceRequest/${pathologyReport.serviceRequestId}`]: pathologyReport.serviceRequestVersion,
          [`Task/${pathologyReport.taskId}`]: pathologyReport.taskVersion,
        },
        input: { expectedRequestVersion: pathologyReport.version },
      }),
    )).json())

    // Discard pending diagnosis draft so only the post-sign clinical document revision draft remains pending
    await runtime.app.request(
      `${encounterPath}/diagnosis/draft`,
      mutation(doctor, {
        expectedVersions: expectedAfterConfirm,
        input: { entries: [], expectedDraftVersion: secondDiagDraft.draftVersion },
      }, 'PUT'),
    )

    // 5. Post-sign clinical document revision draft blocks encounter.complete via no-pending-drafts
    const blockedPreview = encounterCompletionPreviewSchema.parse(
      await (await runtime.app.request(`${encounterPath}/completion`, { headers: { cookie: doctor } })).json(),
    )
    expect(blockedPreview.canComplete).toBe(false)
    expect(blockedPreview.items.find(item => item.code === 'no-pending-drafts')).toMatchObject({
      status: 'incomplete',
      target: 'clinical-document',
    })
    const blockedComplete = await runtime.app.request(
      `${encounterPath}/actions/complete`,
      mutation(doctor, { expectedVersions: expectedAfterConfirm, input: {} }),
    )
    expect(blockedComplete.status).toBe(409)
    expect(apiErrorSchema.parse(await blockedComplete.json())).toMatchObject({
      error: { code: 'ENCOUNTER_COMPLETION_BLOCKED' },
    })

    // Reverting post-sign revision draft back to root signed content clears no-pending-drafts
    const revertedDraft = clinicalDocumentDraftResponseSchema.parse(await (await runtime.app.request(
      `${encounterPath}/clinical-document/draft`,
      mutation(doctor, {
        expectedVersions: expectedAfterConfirm,
        input: {
          document: defaultOutpatientGateDocument,
          expectedDraftVersion: interimRevisionDraft.draftVersion,
        },
      }, 'PUT'),
    )).json()).data
    const clearedPreview = encounterCompletionPreviewSchema.parse(
      await (await runtime.app.request(`${encounterPath}/completion`, { headers: { cookie: doctor } })).json(),
    )
    expect(clearedPreview.items.find(item => item.code === 'no-pending-drafts')?.status).toBe('complete')

    // Insert imaging + pathology report summaries into revision draft, then sign Composition v2 via clinical-document.revise
    const revisedDocument = {
      ...defaultOutpatientGateDocument,
      assessment: '结合血常规、心电图、胸片及乳腺切片会诊结果更新临床评估。',
      auxiliaryExamination: `${imagingService.name}（放射报告第 1 版）：${imagingReport.report!.impression}\n${pathologyOffering.service.name}（病理会诊报告第 1 版）：${pathologyReport.report!.diagnosis}`,
      disposition: '予奥司他韦抗病毒治疗，乳腺术后随访管理。',
      followUp: '5 天后门诊复查，不适随诊。',
    }
    clinicalDocumentDraftResponseSchema.parse(await (await runtime.app.request(
      `${encounterPath}/clinical-document/draft`,
      mutation(doctor, {
        expectedVersions: expectedAfterConfirm,
        input: {
          document: revisedDocument,
          expectedDraftVersion: revertedDraft.draftVersion,
        },
      }, 'PUT'),
    )).json())
    const blockedAgain = encounterCompletionPreviewSchema.parse(
      await (await runtime.app.request(`${encounterPath}/completion`, { headers: { cookie: doctor } })).json(),
    )
    expect(blockedAgain.items.find(item => item.code === 'no-pending-drafts')?.status).toBe('incomplete')

    const reviseRes = await runtime.app.request(
      `/api/his/v1/clinical-documents/${rootSigned.compositionId}/actions/revise`,
      mutation(doctor, {
        expectedVersions: {
          [`Composition/${rootSigned.compositionId}`]: rootSigned.compositionVersion,
          [`Encounter/${encounterId}`]: confirmed.encounterVersion,
        },
        input: {
          document: revisedDocument,
          reason: '检验检查及病理会诊报告回传后补充辅助检查摘要与处置方案',
        },
      }),
    )
    expect(reviseRes.status, await reviseRes.clone().text()).toBe(200)
    const revised = clinicalDocumentRevisionResponseSchema.parse(await reviseRes.json()).data
    expect(revised.revisionNumber).toBe(2)
    expect(revised.revisionOfCompositionId).toBe(rootSigned.compositionId)

    const readyPreview = encounterCompletionPreviewSchema.parse(
      await (await runtime.app.request(`${encounterPath}/completion`, { headers: { cookie: doctor } })).json(),
    )
    expect(readyPreview.canComplete).toBe(true)

    const completedRes = await runtime.app.request(
      `${encounterPath}/actions/complete`,
      mutation(doctor, { expectedVersions: expectedAfterConfirm, input: {} }),
    )
    expect(completedRes.status).toBe(200)
    encounterCompletionResponseSchema.parse(await completedRes.json())

    const completedDetail = doctorCompletedCaseDetailSchema.parse(
      await (await runtime.app.request(`/api/his/v1/doctor/completed-cases/${outpatientCaseId}`, { headers: { cookie: doctor } })).json(),
    )
    expect(completedDetail.clinicalDocuments).toHaveLength(2)
    expect(completedDetail.clinicalDocuments.at(-1)?.content).toMatchObject({
      auxiliaryExamination: revisedDocument.auxiliaryExamination,
      disposition: revisedDocument.disposition,
    })
  })

  it('allows confirm-no-medication after signing & primary diagnosis confirmation and keeps legacy non-Consultation outpatient path unchanged', async () => {
    const visit = await setupBreastAndChestConsultation()
    const { runtime, doctor, encounterId, outpatientCaseId } = visit
    await signInitialOutpatientDocument(runtime, doctor, outpatientCaseId)
    const confirmed = await confirmPrimaryOutpatientDiagnosis(runtime, doctor, outpatientCaseId, 'diagnosis-influenza')
    const noMedRes = await runtime.app.request(
      `/api/his/v1/encounters/${encounterId}/medication-conclusion/actions/confirm-no-medication`,
      mutation(doctor, {
        expectedVersions: { [`Encounter/${encounterId}`]: confirmed.encounterVersion },
        input: { expectedDraftVersion: 0 },
      }),
    )
    expect(noMedRes.status).toBe(200)
    confirmNoMedicationResponseSchema.parse(await noMedRes.json())

    // Completed no-medication Encounter keeps outpatient_case.status='first-visit', and post-completion clinical-document.revise must NOT mutate clinical_document_draft
    const completedNoMedRes = await runtime.app.request(
      `/api/his/v1/encounters/${encounterId}/actions/complete`,
      mutation(doctor, {
        expectedVersions: { [`Encounter/${encounterId}`]: confirmed.encounterVersion },
        input: {},
      }),
    )
    expect(completedNoMedRes.status).toBe(200)
    const completedNoMed = encounterCompletionResponseSchema.parse(await completedNoMedRes.json()).data
    const draftRowBeforePostCompleteRevise = runtime.database.driver.prepare(
      'SELECT version, content_json FROM clinical_document_draft WHERE case_id = ?',
    ).get(outpatientCaseId)
    const completedNoMedDetail = doctorCompletedCaseDetailSchema.parse(
      await (await runtime.app.request(`/api/his/v1/doctor/completed-cases/${outpatientCaseId}`, { headers: { cookie: doctor } })).json(),
    )
    const rootDoc = completedNoMedDetail.clinicalDocuments.at(-1)!
    const postCompleteReviseRes = await runtime.app.request(
      `/api/his/v1/clinical-documents/${rootDoc.compositionId}/actions/revise`,
      mutation(doctor, {
        expectedVersions: {
          [`Composition/${rootDoc.compositionId}`]: rootDoc.compositionVersion,
          [`Encounter/${encounterId}`]: completedNoMed.encounterVersion,
        },
        input: {
          document: {
            ...rootDoc.content,
            followUp: '完诊后病历归档勘误补充随访说明。',
          },
          reason: '完诊后补充随访文字勘误。',
        },
      }),
    )
    expect(postCompleteReviseRes.status, await postCompleteReviseRes.clone().text()).toBe(200)
    clinicalDocumentRevisionResponseSchema.parse(await postCompleteReviseRes.json())
    const draftRowAfterPostCompleteRevise = runtime.database.driver.prepare(
      'SELECT version, content_json FROM clinical_document_draft WHERE case_id = ?',
    ).get(outpatientCaseId)
    expect(draftRowAfterPostCompleteRevise).toEqual(draftRowBeforePostCompleteRevise)

    // Legacy non-Consultation registration path remains compatible without structured clinical document or DiagnosisConfirmation
    const registrar = await signIn(runtime, 'registrar@demo.clinmesh.local')
    const triageNurse = await signIn(runtime, 'triage@demo.clinmesh.local')
    const createdPatient = createPatientResponseSchema.parse(await (await runtime.app.request(
      '/api/his/v1/patients',
      mutation(registrar, {
        expectedVersions: {},
        input: {
          birthDate: '1988-06-15',
          gender: 'male',
          identifier: 'CM-LEGACY-515',
          name: '合成兼容路径患者',
        },
      }),
    )).json()).data.patient
    const regCatalog = registrationCatalogSchema.parse(
      await (await runtime.app.request('/api/his/v1/catalogs/registration', { headers: { cookie: registrar } })).json(),
    )
    const registered = registrationResponseSchema.parse(await (await runtime.app.request(
      '/api/his/v1/registrations/actions/register',
      mutation(registrar, {
        expectedVersions: { [`Patient/${createdPatient.id}`]: createdPatient.versionId },
        input: {
          departmentId: regCatalog.departments[0]!.id,
          locationId: regCatalog.locations[0]!.id,
          patientId: createdPatient.id,
          visitDate: regCatalog.virtualDate,
          visitTypeId: regCatalog.visitTypes[0]!.id,
        },
      }),
    )).json()).data
    const triaged = triageResponseSchema.parse(await (await runtime.app.request(
      `/api/his/v1/encounters/${registered.encounterId}/actions/record-triage`,
      mutation(triageNurse, {
        expectedVersions: {
          [`Encounter/${registered.encounterId}`]: '1',
          [`Task/${registered.queueTaskId}`]: '1',
        },
        input: {
          acuityCode: 'level-3',
          bloodPressure: { diastolicMmHg: 78, systolicMmHg: 120 },
          chiefComplaint: '兼容路径咽痛两天',
          oxygenSaturationPct: 98,
          pulseBpm: 76,
          respirationBpm: 18,
          temperatureC: 37.8,
        },
      }),
    )).json()).data
    startVisitResponseSchema.parse(await (await runtime.app.request(
      `/api/his/v1/encounters/${registered.encounterId}/actions/start-first-visit`,
      mutation(doctor, {
        expectedVersions: {
          [`Encounter/${registered.encounterId}`]: '2',
          [`Task/${triaged.doctorTaskId}`]: '1',
        },
        input: {},
      }),
    )).json())
    firstVisitDraftResponseSchema.parse(await (await runtime.app.request(
      `/api/his/v1/encounters/${registered.encounterId}/drafts/first-visit`,
      mutation(doctor, {
        expectedVersions: { [`Encounter/${registered.encounterId}`]: '3' },
        input: {
          assessment: '首期兼容路径发热待查',
          expectedDraftVersion: 0,
          historyOfPresentIllness: '咽痛伴低热两天。',
        },
      }, 'PUT'),
    )).json())
    const legacyLabOrder = await runtime.app.request(
      `/api/his/v1/encounters/${registered.encounterId}/actions/issue-laboratory-order`,
      mutation(doctor, {
        expectedVersions: {
          [`Encounter/${registered.encounterId}`]: '3',
          [`Task/${triaged.doctorTaskId}`]: '2',
        },
        input: { catalogItemId: 'lab-cbc', expectedDraftVersion: 1, indicationCode: 'fever' },
      }),
    )
    expect(legacyLabOrder.status, await legacyLabOrder.clone().text()).toBe(200)
    laboratoryOrderResponseSchema.parse(await legacyLabOrder.json())
  })
})
