import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { guidelineTopicIds } from '@clinmesh/contracts/guideline-topics'
import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { confirmDoctorPreparationResponseSchema, doctorRecommendationStateSchema,
  generateDoctorRecommendationsResponseSchema, type DoctorPreparationSelection, type DoctorRecommendationKind } from '@clinmesh/contracts/doctor-recommendations'
import type { GuidelineDocument } from '../src/application/guideline-corpus.ts'
import { getGuidelineTopicDefinition } from '../src/application/guideline-topic-registry.ts'
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

it('门诊诊疗建议复用共享 Guideline Topic 注册表，对派生副本按正文去重并严格遵守 8 段／48 KiB 预算', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-coronary-topics-'))
  const data = await createCoronaryData(directory)
  const writer = new GuidelineCorpus({ databasePath: data.guidelineDatabasePath })
  try {
    const bySource = new Map<string, { pages: Map<number, string[]>; sha256: string; specialty: 'cardiology' | 'endocrinology'; title: string; version: string }>()
    for (const topicId of guidelineTopicIds) {
      const def = getGuidelineTopicDefinition(topicId)
      for (const ref of def.references) {
        let entry = bySource.get(ref.sourceId)
        if (!entry) {
          entry = { pages: new Map(), sha256: ref.sha256, specialty: def.specialty, title: ref.title, version: ref.version }
          bySource.set(ref.sourceId, entry)
        }
        const list = entry.pages.get(ref.page) ?? []
        for (const frag of ref.fragments) if (!list.includes(frag)) list.push(frag)
        entry.pages.set(ref.page, list)
      }
    }
    const topicDocs: GuidelineDocument[] = [...bySource.entries()].map(([sourceId, entry]) => ({
      passages: [...entry.pages.entries()].sort(([a], [b]) => a - b).map(([page, fragments]) => ({
        locator: `PDF 物理第 ${page} 页`,
        text: `${fragments.join('。 ')}（合成专题注册表测试段落 ${sourceId}#${page}）`,
      })),
      source: {
        documentType: 'guideline',
        format: 'pdf',
        id: sourceId,
        license: { id: 'CC0', url: 'https://example.test/license', usage: 'open' },
        population: 'adult',
        publisher: '合成专题核验机构',
        scope: '仅供合成回归',
        sha256: entry.sha256,
        specialty: entry.specialty,
        status: 'active',
        title: entry.title,
        topics: [],
        url: `https://example.test/${sourceId}`,
        version: entry.version,
      },
    }))
    // Also import a local-evaluation-* derived copy with a distinct sha256 but identical text to coronary-31-2019 p2
    const acsDoc = topicDocs.find(d => d.source.id === 'coronary-31-2019')!
    writer.importDocuments([
      ...topicDocs,
      {
        passages: [acsDoc.passages[0]!],
        source: {
          ...acsDoc.source,
          derivedFromSourceId: 'coronary-31-2019',
          id: 'local-evaluation-acs-copy',
          sha256: 'd'.repeat(64),
        },
      },
    ])
  } finally {
    writer.close()
  }

  const { provider } = createCoronaryProvider()
  const runtime = await createClinMeshRuntime({
    activeReferenceReleaseId: coronaryReferenceRelease,
    authBaseUrl: 'http://localhost',
    authSecret: 'synthetic-coronary-auth-secret-at-least-32',
    chatCompletionsProvider: provider,
    cursorSecret: 'synthetic-coronary-cursor-secret-at-least-32',
    databasePath: join(directory, 'hospital.sqlite'),
    demoPassword: 'Synthetic-Demo-Password-2026!',
    guidelineDatabasePath: data.guidelineDatabasePath,
    guidelineLocalEvaluation: true,
    imagingAssetDirectory: join(directory, 'imaging'),
    imagingCatalogDirectory: join(directory, 'imaging-catalog'),
    migrationMode: 'apply',
    pathologyAssetDirectory: join(directory, 'pathology'),
    pathologyCatalogDirectory: join(directory, 'pathology-catalog'),
    patientPersonaModel: 'synthetic-coronary',
    referenceDatabasePath: data.referenceDatabasePath,
    syntheaProvider: new CoronarySyntheaProvider(),
    trustedOrigins: ['http://localhost'],
  })
  try {
    const started = await startCoronaryCase(runtime)
    const cookie = await signIn(runtime, 'doctor@demo.clinmesh.local')
    const headers = () => ({ cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() })
    const claim = await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/actions/start-first-visit`, {
      body: JSON.stringify({
        expectedVersions: { [`Encounter/${started.encounterId}`]: started.encounterVersion, [`Task/${started.doctorTaskId}`]: '1' },
        input: {},
      }),
      headers: headers(),
      method: 'POST',
    })
    expect(claim.status).toBe(200)
    const current = doctorCaseDetailSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.outpatientCaseId}`,
      { headers: { cookie } },
    )).json())
    // Document matches ALL 6 Guideline Topics simultaneously to verify 8-passage / 48 KiB budget enforcement
    const multiTopicDoc = {
      ...coronaryDocument,
      chiefComplaint: '急性胸痛 NSTE-ACS 血运重建 FFR 支架选型 对比剂水化 双抗二级预防 2型糖尿病合并慢性肾脏病达格列净',
    }
    const saved = await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/clinical-document/draft`, {
      body: JSON.stringify({
        expectedVersions: { [`Encounter/${started.encounterId}`]: current.encounter.versionId },
        input: { document: multiTopicDoc, expectedDraftVersion: current.clinicalDocument?.draft?.version ?? 0 },
      }),
      headers: headers(),
      method: 'PUT',
    })
    expect(saved.status).toBe(200)

    const idleState = doctorRecommendationStateSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.outpatientCaseId}/recommendations/diagnosis`,
      { headers: { cookie } },
    )).json())
    const genRes = await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.outpatientCaseId}/recommendations/diagnosis/actions/generate`,
      {
        body: JSON.stringify({
          expectedVersions: { [`Encounter/${idleState.encounterId}`]: idleState.encounterVersion },
          input: { expectedInputFingerprint: idleState.inputFingerprint, refresh: true },
        }),
        headers: headers(),
        method: 'POST',
      },
    )
    expect(genRes.status).toBe(200)
    await runtime.dispatchPending()
    const state = doctorRecommendationStateSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${started.outpatientCaseId}/recommendations/diagnosis`,
      { headers: { cookie } },
    )).json())
    const fullTextGuidelines = state.guidelines.filter(g => g.locator.startsWith('PDF 物理第'))
    expect(fullTextGuidelines.length).toBeLessThanOrEqual(8)
    const totalBytes = fullTextGuidelines.reduce((sum, g) => sum + Buffer.byteLength(JSON.stringify(g), 'utf8'), 0)
    expect(totalBytes).toBeLessThanOrEqual(48 * 1024)
    // Reused acute-chest-pain-acs topic passages first and deduplicated local-evaluation-acs-copy
    expect(fullTextGuidelines.some(g => g.sourceHash === getGuidelineTopicDefinition('acute-chest-pain-acs').references[0]!.sha256)).toBe(true)
    const p2Matches = fullTextGuidelines.filter(g => g.text.includes('10 min 内行标准 12 导联'))
    expect(p2Matches).toHaveLength(1)
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})
