import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { confirmDoctorPreparationResponseSchema, doctorRecommendationStateSchema,
  generateDoctorRecommendationsResponseSchema, type DoctorPreparationSelection, type DoctorRecommendationKind } from '@clinmesh/contracts/doctor-recommendations'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { GuidelineCorpus } from '../src/infrastructure/sqlite/guideline-corpus.ts'
import { pciDataPackage } from '../src/application/scenario-data/pci-data.ts'
import { signIn } from './fixtures/consultation.ts'
import { coronaryDocument, coronaryGuidelineParagraph, coronaryGuidelineTitle, coronaryReferenceRelease,
  CoronarySyntheaProvider, createCoronaryData, createCoronaryProvider, startCoronaryCase } from './fixtures/coronary-guidelines.ts'

it('本地冠心病PDF只用纳入页生成三类建议，医生确认后关闭模式保留正式事实', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-coronary-workflow-'))
  const data = await createCoronaryData(directory)
  const { provider, seen } = createCoronaryProvider()
  const options = { databasePath: join(directory, 'hospital.sqlite'), referenceDatabasePath: data.referenceDatabasePath,
    activeReferenceReleaseId: coronaryReferenceRelease, guidelineDatabasePath: data.guidelineDatabasePath,
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-coronary-auth-secret-at-least-32',
    cursorSecret: 'synthetic-coronary-cursor-secret-at-least-32', demoPassword: 'Synthetic-Demo-Password-2026!',
    trustedOrigins: ['http://localhost'], syntheaProvider: new CoronarySyntheaProvider(),
    patientPersonaModel: 'synthetic-coronary', chatCompletionsProvider: provider,
    imagingAssetDirectory: join(directory, 'imaging'), imagingCatalogDirectory: join(directory, 'imaging-catalog'),
    pathologyAssetDirectory: join(directory, 'pathology'), pathologyCatalogDirectory: join(directory, 'pathology-catalog') }
  let runtime = await createClinMeshRuntime({ ...options, migrationMode: 'apply', guidelineLocalEvaluation: true })
  try {
    const corpus = new GuidelineCorpus({ databasePath: data.guidelineDatabasePath, readOnly: true, allowLocalEvaluation: true })
    try {
      const evidence = corpus.search('冠心病 coronary').guidelines
      expect(evidence).toHaveLength(1)
      expect(evidence[0]).toMatchObject({ text: coronaryGuidelineParagraph, sourceHash: data.sourceHash,
        locator: expect.stringContaining('PDF 物理第 1 页') })
      expect(corpus.sources()[0]?.source.license.usage).toBe('unverified')
    } finally { corpus.close() }
    const started = await startCoronaryCase(runtime)
    const cookie = await signIn(runtime, 'doctor@demo.clinmesh.local')
    const headers = () => ({ cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() })
    const readCase = async () => doctorCaseDetailSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.outpatientCaseId}`, { headers: { cookie } },
    )).json())
    const claim = await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/actions/start-first-visit`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ expectedVersions: {
        [`Encounter/${started.encounterId}`]: started.encounterVersion, [`Task/${started.doctorTaskId}`]: '1',
      }, input: {} }),
    })
    expect(claim.status).toBe(200)
    const current = await readCase()
    const saved = await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/clinical-document/draft`, {
      method: 'PUT', headers: headers(), body: JSON.stringify({ expectedVersions: { [`Encounter/${started.encounterId}`]: current.encounter.versionId },
        input: { expectedDraftVersion: current.clinicalDocument?.draft?.version ?? 0, document: coronaryDocument } }),
    })
    expect(saved.status).toBe(200)
    const path = (kind: DoctorRecommendationKind) => `/api/his/v1/doctor/cases/${started.outpatientCaseId}/recommendations/${kind}`
    const read = async (kind: DoctorRecommendationKind) => doctorRecommendationStateSchema.parse(await (await runtime.app.request(path(kind), { headers: { cookie } })).json())
    const generate = async (kind: DoctorRecommendationKind) => {
      const before = await readCase()
      const state = await read(kind)
      const response = await runtime.app.request(`${path(kind)}/actions/generate`, { method: 'POST', headers: headers(),
        body: JSON.stringify({ expectedVersions: { [`Encounter/${state.encounterId}`]: state.encounterVersion },
          input: { expectedInputFingerprint: state.inputFingerprint, refresh: true } }) })
      expect(response.status).toBe(200)
      expect(generateDoctorRecommendationsResponseSchema.parse(await response.json()).data.status).toBe('pending')
      await runtime.dispatchPending()
      const result = await read(kind)
      expect(result).toMatchObject({ status: 'ready', stale: false })
      expect(result.guidelines).toContainEqual(expect.objectContaining({ text: coronaryGuidelineParagraph, sourceHash: data.sourceHash }))
      const after = await readCase()
      expect(after.clinicalDocument).toEqual(before.clinicalDocument)
      expect(after.diagnosis).toEqual(before.diagnosis)
      expect(after.medicationConclusion).toEqual(before.medicationConclusion)
      expect(after.laboratoryRequests).toEqual(before.laboratoryRequests)
      return result
    }
    const confirm = async (state: Awaited<ReturnType<typeof read>>, selections: DoctorPreparationSelection[]) => {
      const current = await readCase()
      const draftVersion = state.kind === 'diagnosis' ? current.diagnosis?.draftVersion ?? 0
        : state.kind === 'prescription' ? current.medicationConclusion?.draftVersion ?? 0 : current.laboratoryRequests?.draftVersion ?? 0
      const response = await runtime.app.request(`${path(state.kind)}/actions/confirm`, { method: 'POST', headers: headers(),
        body: JSON.stringify({ expectedVersions: { [`Encounter/${state.encounterId}`]: current.encounter.versionId },
          input: { generation: state.generation, inputFingerprint: state.inputFingerprint, expectedDraftVersion: draftVersion, selections } }) })
      expect(response.status, await response.clone().text()).toBe(200)
      return confirmDoctorPreparationResponseSchema.parse(await response.json())
    }
    const diagnosis = await generate('diagnosis')
    expect(diagnosis.items).toMatchObject([{ kind: 'diagnosis', catalogItemId: pciDataPackage.diagnosis.id, role: 'primary' }])
    await confirm(diagnosis, [{ kind: 'diagnosis', source: 'agent', suggestionId: diagnosis.items[0]!.id,
      catalogItemId: pciDataPackage.diagnosis.id, role: 'primary' }])
    const laboratory = await generate('laboratory')
    expect(laboratory.items).toMatchObject([{ kind: 'laboratory', catalogItemId: 'hospital-lab-pci-creatinine', indicationCode: 'clinical-assessment' }])
    const service = laboratory.laboratoryServices!.find(item => item.id === 'hospital-lab-pci-creatinine')!
    expect(service.outpatientBilling).toBeDefined()
    expect(service.outpatientBilling).not.toBeNull()
    await confirm(laboratory, [{ kind: 'laboratory', source: 'agent', suggestionId: laboratory.items[0]!.id,
      catalogItemId: 'hospital-lab-pci-creatinine', indicationCode: 'clinical-assessment',
      reviewedService: { id: service.id, version: service.version, outpatientBilling: service.outpatientBilling ?? null } }])
    await runtime.dispatchPending()
    const prescription = await generate('prescription')
    expect(prescription.items).toMatchObject([{ kind: 'prescription', catalogItemId: 'medication-pci-aspirin', doseText: null, quantity: null }])
    await confirm(prescription, [{ kind: 'prescription', source: 'manual', catalogItemId: 'medication-pci-aspirin',
      doseText: '100 mg', frequencyCode: 'QD', courseDays: 1, quantity: 1 }])
    for (const kind of ['diagnosis', 'laboratory', 'prescription']) {
      for (const stage of ['generation', 'verification']) {
        const calls = seen.filter(call => call.kind === kind && call.stage === stage)
        expect(calls).toHaveLength(1)
        expect(calls[0]!.guidelines).toContainEqual(expect.objectContaining({ title: coronaryGuidelineTitle, text: coronaryGuidelineParagraph }))
      }
    }
    const final = await readCase()
    expect(final.diagnosis?.confirmation?.entries).toMatchObject([{ code: 'I25.103', role: 'primary' }])
    expect(final.laboratoryRequests?.requests).toMatchObject([{ catalogItemId: 'hospital-lab-pci-creatinine', status: 'issued', billing: { status: 'pending' } }])
    expect(final.medicationConclusion?.prescription?.items).toMatchObject([{ catalogItemId: 'medication-pci-aspirin', doseText: '100 mg', quantity: 1 }])
    await runtime.close()
    runtime = await createClinMeshRuntime({ ...options, migrationMode: 'verify', guidelineLocalEvaluation: false })
    expect(await read('diagnosis')).toMatchObject({ hidePreviousResults: true, items: [], guidelines: [] })
    const retained = await readCase()
    expect(retained.diagnosis?.confirmation).toEqual(final.diagnosis?.confirmation)
    expect(retained.laboratoryRequests?.requests).toEqual(final.laboratoryRequests?.requests)
    expect(retained.medicationConclusion?.prescription).toEqual(final.medicationConclusion?.prescription)
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})
