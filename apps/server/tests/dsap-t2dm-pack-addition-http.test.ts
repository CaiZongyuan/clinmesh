import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { clinicalPromptBundleSchema } from '@clinmesh/contracts/clinical-prompt-cards'
import { diseasePackCatalogListSchema, diseasePackRuntimeBundleSchema } from '@clinmesh/contracts/disease-pack'
import { dsapExamRunResponseSchema } from '@clinmesh/contracts/disease-pack-exam'
import { orderSetDraftBundleSchema, orderSetTemplateListSchema } from '@clinmesh/contracts/order-set-templates'
import {
  createPatientResponseSchema,
  doctorCaseDetailSchema,
  doctorQueueSchema,
  registrationCatalogSchema,
  registrationResponseSchema,
  startVisitResponseSchema,
  triageResponseSchema,
} from '@clinmesh/contracts/his'
import { computeDiseasePackFingerprint } from '../src/application/disease-pack-runtime-service.ts'
import { listHospitalGeneralLabPanels } from '../src/application/order-set-template-registry.ts'
import {
  createPciPaymentDrgFixture,
  parsePciResponse,
  preparePciPaymentDrgFixture,
  type PciPaymentDrgFixture,
} from './fixtures/pci-payment-drg.ts'

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

function currentScope(fixture: PciPaymentDrgFixture) {
  const row = fixture.runtime.database.driver.prepare(`
    SELECT workspace_id, epoch FROM scenario_run
    WHERE status = 'active'
    ORDER BY started_at DESC LIMIT 1
  `).get() as { epoch: string; workspace_id: string }
  const timeRow = fixture.runtime.database.driver.prepare(`
    SELECT virtual_time FROM scenario_epoch_state
    WHERE workspace_id = ? AND epoch = ?
  `).get(row.workspace_id, row.epoch) as { virtual_time: string }
  return { epoch: row.epoch, virtualTime: timeRow.virtual_time, workspaceId: row.workspace_id }
}

async function createOutpatientPatient(fixture: PciPaymentDrgFixture, label = '糖尿病肾病评估患者') {
  return (await parsePciResponse(
    createPatientResponseSchema,
    await fixture.request('registrar', '/api/his/v1/patients', {
      birthDate: '1966-05-12',
      gender: 'male',
      identifier: `SYN-DM-${randomUUID()}`,
      name: `${label}-${randomUUID().slice(0, 6)}`,
    }, randomUUID(), {}),
  )).data.patient
}

async function startOutpatientVisitForPatient(
  fixture: PciPaymentDrgFixture,
  patient: { id: string; versionId: string },
  chiefComplaint: string,
) {
  const catalog = await fixture.read('registrar', '/api/his/v1/catalogs/registration', registrationCatalogSchema)
  const registered = (await parsePciResponse(
    registrationResponseSchema,
    await fixture.request('registrar', '/api/his/v1/registrations/actions/register', {
      departmentId: catalog.departments[0]!.id,
      locationId: catalog.locations[0]!.id,
      patientId: patient.id,
      visitDate: catalog.virtualDate,
      visitTypeId: catalog.visitTypes[0]!.id,
    }, randomUUID(), {
      [`Patient/${patient.id}`]: patient.versionId,
    }),
  )).data

  const triaged = await parsePciResponse(
    triageResponseSchema,
    await fixture.request('triage', `/api/his/v1/encounters/${registered.encounterId}/actions/record-triage`, {
      acuityCode: 'level-3',
      bloodPressure: { diastolicMmHg: 78, systolicMmHg: 132 },
      chiefComplaint,
      heightCm: 170,
      oxygenSaturationPct: 98,
      pulseBpm: 76,
      respirationBpm: 18,
      temperatureC: 36.6,
      weightKg: 70,
    }, randomUUID(), {
      [`Encounter/${registered.encounterId}`]: '1',
      [`Task/${registered.queueTaskId}`]: '1',
    }),
  )

  await parsePciResponse(
    startVisitResponseSchema,
    await fixture.request('doctor', `/api/his/v1/encounters/${registered.encounterId}/actions/start-first-visit`, {}, randomUUID(), {
      [`Encounter/${registered.encounterId}`]: triaged.data.encounterVersion,
      [`Task/${triaged.data.doctorTaskId}`]: '1',
    }),
  )

  const queue = await fixture.read('doctor', '/api/his/v1/doctor/queue', doctorQueueSchema)
  const item = queue.items.find(row => row.encounterId === registered.encounterId)!
  const detail = await fixture.read('doctor', `/api/his/v1/doctor/cases/${item.caseId}`, doctorCaseDetailSchema)
  return { caseId: item.caseId, detail, encounterId: registered.encounterId, patientId: registered.patientId }
}

function insertCondition(
  fixture: PciPaymentDrgFixture,
  input: { code: string; display: string; encounterId: string; patientId: string },
) {
  const scope = currentScope(fixture)
  fixture.runtime.fhir.create({ epoch: scope.epoch, workspaceId: scope.workspaceId }, {
    clinicalStatus: { coding: [{ code: 'active', system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }] },
    code: { coding: [{ code: input.code, display: input.display, system: 'http://hl7.org/fhir/sid/icd-10' }], text: input.display },
    encounter: { reference: `Encounter/${input.encounterId}` },
    id: `cond-${randomUUID()}`,
    recordedDate: scope.virtualTime,
    resourceType: 'Condition',
    subject: { reference: `Patient/${input.patientId}` },
    verificationStatus: { coding: [{ code: 'confirmed', system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status' }] },
  })
}

function insertSerumCreatinineObservation(
  fixture: PciPaymentDrgFixture,
  input: { encounterId: string; patientId: string; valueUmolL: number },
) {
  const scope = currentScope(fixture)
  fixture.runtime.fhir.create({ epoch: scope.epoch, workspaceId: scope.workspaceId }, {
    category: [{ coding: [{ code: 'laboratory', system: 'http://terminology.hl7.org/CodeSystem/observation-category' }] }],
    code: { coding: [{ code: '2160-0', display: '血清肌酐', system: 'http://loinc.org' }], text: '血清肌酐' },
    effectiveDateTime: scope.virtualTime,
    encounter: { reference: `Encounter/${input.encounterId}` },
    id: `obs-scr-${randomUUID()}`,
    interpretation: [{ coding: [{ code: input.valueUmolL >= 133 ? 'H' : 'N', system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation' }] }],
    issued: scope.virtualTime,
    resourceType: 'Observation',
    status: 'final',
    subject: { reference: `Patient/${input.patientId}` },
    valueQuantity: { code: 'umol/L', system: 'http://unitsofmeasure.org', unit: 'umol/L', value: input.valueUmolL },
  })
}

describe('DSAP Slice S13: Standalone Pure-JSON T2DM Renal Care Pack Addition (#566)', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!()
    }
  })

  it('AC12: proves Commit 1 diff adding t2dm-renal-care contains ONLY the new pack folder and removal of hardcoded t2dm-renal-medication baseline entry', () => {
    const commitHash = execFileSync(
      'git',
      ['log', '--diff-filter=A', '-n', '1', '--pretty=format:%H', '--', 'apps/server/disease-packs/t2dm-renal-care/manifest.json'],
      { cwd: REPOSITORY_ROOT, encoding: 'utf8' },
    ).trim()
    expect(commitHash).toMatch(/^[0-9a-f]{40}$/)

    const changedFiles = execFileSync(
      'git',
      ['show', '--name-only', '--pretty=format:', commitHash],
      { cwd: REPOSITORY_ROOT, encoding: 'utf8' },
    )
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)

    expect(changedFiles.length).toBeGreaterThanOrEqual(8)
    for (const filePath of changedFiles) {
      const allowed = filePath.startsWith('apps/server/disease-packs/t2dm-renal-care/')
        || filePath === 'apps/server/src/application/guideline-topic-registry.ts'
      expect(allowed, `Unexpected file changed in AC12 S13 pack-addition commit: ${filePath}`).toBe(true)
    }
    expect(changedFiles.some(f => f.startsWith('packages/contracts/'))).toBe(false)
    expect(changedFiles.some(f => f.startsWith('packages/core/'))).toBe(false)
  })

  it('AC3b, AC10, AC13 & AC15: activates T2DM pack without CAD, shows side-by-side multi-pack cards for CAD+T2DM, keeps ortho at 0 packs with general panels, and passes all exams with 0 LLM calls', async () => {
    const prepared = await preparePciPaymentDrgFixture()
    cleanups.push(() => rm(prepared.directory, { recursive: true, force: true }))
    const fixture = await createPciPaymentDrgFixture(prepared)
    cleanups.push(() => fixture.runtime.close())

    // Auto-discovered pure-JSON t2dm-renal-care has valid SHA-256 fingerprint
    const catalog = await fixture.read('doctor', '/api/his/v1/catalogs/disease-packs', diseasePackCatalogListSchema)
    const t2dmMeta = catalog.items.find(item => item.id === 't2dm-renal-care')
    expect(t2dmMeta).toBeDefined()
    expect(t2dmMeta?.status).toBe('active')
    const t2dmEffective = fixture.runtime.workflow.diseasePacks.registry.getEffective('t2dm-renal-care')
    expect(computeDiseasePackFingerprint(t2dmEffective.pack)).toBe(t2dmEffective.pack.manifest.fingerprint)

    // 1. AC3b: T2DM-only CKD patient (no CAD) activates t2dm-renal-care (coronary-cad inactive) and displays glucose-lowering renal knowledge card
    const t2dmPatient = await createOutpatientPatient(fixture, '单纯糖肾')
    const t2dmVisit = await startOutpatientVisitForPatient(fixture, t2dmPatient, '2 型糖尿病伴肾功能异常门诊随诊')
    insertCondition(fixture, { code: 'E11.2', display: '2 型糖尿病伴肾病并发症', encounterId: t2dmVisit.encounterId, patientId: t2dmPatient.id })
    insertCondition(fixture, { code: 'N18.3', display: '慢性肾脏病 3 期', encounterId: t2dmVisit.encounterId, patientId: t2dmPatient.id })
    insertSerumCreatinineObservation(fixture, { encounterId: t2dmVisit.encounterId, patientId: t2dmPatient.id, valueUmolL: 168 })

    const t2dmBundle = await fixture.read(
      'doctor',
      `/api/his/v1/outpatient/cases/${t2dmVisit.caseId}/disease-packs`,
      diseasePackRuntimeBundleSchema,
    )
    expect(t2dmBundle.packs.find(p => p.packId === 't2dm-renal-care')?.activationStatus).toBe('active')
    expect(t2dmBundle.packs.find(p => p.packId === 'coronary-cad')?.activationStatus).toBe('inactive')

    const t2dmPrompts = await fixture.read(
      'doctor',
      `/api/his/v1/doctor/cases/${t2dmVisit.caseId}/clinical-prompts?timing=encounter-open`,
      clinicalPromptBundleSchema,
    )
    const t2dmKnowledgeCards = t2dmPrompts.cards.filter(c => c.packId === 't2dm-renal-care')
    expect(t2dmKnowledgeCards.length).toBeGreaterThanOrEqual(1)
    expect(t2dmKnowledgeCards.some(c => c.summary.includes('二甲双胍') || c.detail.includes('降糖') || c.detail.includes('eGFR'))).toBe(true)

    // 2. AC3b: Stable CAD without chest pain activates ONLY coronary-cad; orthopedic control activates 0 packs yet keeps hospital general lab panels & templates
    const stableCadPatient = await createOutpatientPatient(fixture, '无胸痛稳定冠心病')
    const stableCadVisit = await startOutpatientVisitForPatient(fixture, stableCadPatient, '择期拟行 PCI，目前无胸痛')
    insertCondition(fixture, { code: 'I25.103', display: '冠状动脉粥样硬化性心脏病', encounterId: stableCadVisit.encounterId, patientId: stableCadPatient.id })
    const stableCadBundle = await fixture.read(
      'doctor',
      `/api/his/v1/outpatient/cases/${stableCadVisit.caseId}/disease-packs`,
      diseasePackRuntimeBundleSchema,
    )
    expect(stableCadBundle.packs.find(p => p.packId === 'coronary-cad')?.activationStatus).toBe('active')
    expect(stableCadBundle.packs.find(p => p.packId === 't2dm-renal-care')?.activationStatus).toBe('inactive')

    const orthoStay = await fixture.admitSyntheticCase(['I10.x09'], 'bed-general-1')
    insertCondition(fixture, { code: 'S72.0', display: '股骨颈骨折', encounterId: orthoStay.admissionId, patientId: orthoStay.patientId })
    const orthoPacks = await fixture.read('inpatient-doctor', `${orthoStay.path}/disease-packs`, diseasePackRuntimeBundleSchema)
    expect(orthoPacks.packs.every(p => p.activationStatus !== 'active')).toBe(true)

    const hospitalTemplates = await fixture.read('inpatient-doctor', '/api/his/v1/catalogs/order-set-templates?scope=inpatient', orderSetTemplateListSchema)
    expect(hospitalTemplates.items.map(t => t.id)).toContain('general-surgery-postop-standard')
    const orthoDrafts = await fixture.read('inpatient-doctor', `${orthoStay.path}/order-set-drafts`, orderSetDraftBundleSchema)
    expect(orthoDrafts.packId).toBeUndefined()
    expect(listHospitalGeneralLabPanels().map(p => p.code)).toEqual([
      'CN-LAB-CBC',
      'CN-LAB-CBC-5DIFF',
      'CN-LAB-LIVER',
      'CN-LAB-RENAL',
      'CN-LAB-ELECTROLYTES',
      'CN-LAB-COAGULATION',
    ])

    // 3. AC13: CAD + T2DM comorbidity activates BOTH coronary-cad and t2dm-renal-care and renders side-by-side cards with packId & riskTags
    const dualPatient = await createOutpatientPatient(fixture, '冠心病合并糖肾')
    const dualVisit = await startOutpatientVisitForPatient(fixture, dualPatient, '稳定性冠心病合并 2 型糖尿病肾病复查')
    insertCondition(fixture, { code: 'I25.103', display: '冠状动脉粥样硬化性心脏病', encounterId: dualVisit.encounterId, patientId: dualPatient.id })
    insertCondition(fixture, { code: 'E11.9', display: '2 型糖尿病', encounterId: dualVisit.encounterId, patientId: dualPatient.id })
    insertSerumCreatinineObservation(fixture, { encounterId: dualVisit.encounterId, patientId: dualPatient.id, valueUmolL: 165 })

    const dualBundle = await fixture.read(
      'doctor',
      `/api/his/v1/outpatient/cases/${dualVisit.caseId}/disease-packs`,
      diseasePackRuntimeBundleSchema,
    )
    expect(dualBundle.packs.find(p => p.packId === 'coronary-cad')?.activationStatus).toBe('active')
    expect(dualBundle.packs.find(p => p.packId === 't2dm-renal-care')?.activationStatus).toBe('active')

    const dualPrompts = await fixture.read(
      'doctor',
      `/api/his/v1/doctor/cases/${dualVisit.caseId}/clinical-prompts?timing=encounter-open`,
      clinicalPromptBundleSchema,
    )
    const cadCards = dualPrompts.cards.filter(c => c.packId === 'coronary-cad')
    const dmCards = dualPrompts.cards.filter(c => c.packId === 't2dm-renal-care')
    expect(cadCards.length).toBeGreaterThanOrEqual(1)
    expect(dmCards.length).toBeGreaterThanOrEqual(1)
    expect(cadCards.some(c => c.riskTags.length > 0)).toBe(true)
    expect(dmCards.some(c => c.riskTags.length > 0)).toBe(true)
    expect(cadCards.some(c => c.sideBySideGroupKey !== null)).toBe(true)
    expect(dmCards.some(c => c.sideBySideGroupKey !== null)).toBe(true)

    // 4. AC10: Full exam suite & 7 public traps pass across all active packs with 0 coronary regression and 0 LLM calls
    const adminCookie = await fixture.login('admin')
    const examRes = await fixture.runtime.app.request('/api/his/v1/admin/disease-packs/exam/run', {
      body: JSON.stringify({}),
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect(examRes.status, await examRes.clone().text()).toBe(200)
    const examData = dsapExamRunResponseSchema.parse(await examRes.json())
    expect(examData.passed).toBe(true)
    expect(examData.llmInvocationCount).toBe(0)
    expect(prepared.modelCalls).toBe(0)
    expect(examData.report.coronaryRegressionPassed).toBe(true)
    expect(examData.report.publicTrapRun.passedTraps).toBe(7)
    expect(examData.report.packAdditionAudit.platformChangesZero).toBe(true)

    const t2dmExamRun = examData.report.packRuns.find(r => r.packId === 't2dm-renal-care')
    expect(t2dmExamRun?.passed).toBe(true)
    expect(t2dmExamRun?.categoriesCovered).toEqual(expect.arrayContaining([
      'missing-critical-data',
      'standard-mild',
      'inpatient-severe',
      'red-line-violation',
      'multi-disease-conflict',
      'over-testing-mild',
    ]))
  }, 60_000)
})
