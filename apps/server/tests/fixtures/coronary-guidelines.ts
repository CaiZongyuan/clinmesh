import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { doctorCaseEvidenceSchema, doctorRecommendationKindSchema, doctorRecommendationSuggestionSchema, guidelineEvidenceSchema,
  type DoctorRecommendationKind, type GuidelineEvidence } from '@clinmesh/contracts/doctor-recommendations'
import { sessionContextSchema } from '@clinmesh/contracts/his'
import type { PatientPersonaContent } from '@clinmesh/contracts/scenario'
import type { JsonChatCompletionsProvider } from '../../src/infrastructure/ai/openai-chat-completions.ts'
import type { createClinMeshRuntime } from '../../src/runtime.ts'
import { runLocalGuidelineSync } from '../../src/guideline-local-sync.ts'
import { runReferenceDatabaseCli } from '../../src/reference-database-cli.ts'
import { pciDataPackage } from '../../src/application/scenario-data/pci-data.ts'
import { sourceArtifactHash } from '../../src/application/scenario-data/provider.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from './consultation.ts'
import { syntheticGuidelinePdf } from './synthetic-guideline-pdf.ts'

export const coronaryGuidelineTitle = '合成冠心病本地流程指南'
export const coronaryGuidelineParagraph = ['Coronary artery disease assessment requires symptom and prior evidence review.',
  'Check renal function before planned coronary angiography.', 'Aspirin plans require clinician review of the exact product and dose.'].join('\n')
export const excludedCoronaryParagraph = 'EXCLUDED-CORONARY-APPENDIX: Never send this unselected page.'
export const coronaryReferenceRelease = 'synthetic-coronary-workflow'
export const coronaryHistory = '既往外院已诊断冠心病，近三个月活动后胸闷，休息后缓解。本次择期造影前评估；静息无胸痛，无已知药物过敏。'
export const coronaryDocument = { assessment: '', chiefComplaint: '活动后胸闷三个月。', disposition: '检查和用药由医生核对后决定。',
  followUp: '', historyOfPresentIllness: coronaryHistory, physicalExamination: '' }
export const coronaryPersona: PatientPersonaContent = { ...persona,
  chiefComplaint: coronaryDocument.chiefComplaint, knownHistorySummary: '外院已诊断冠状动脉粥样硬化性心脏病，本次来评估活动后胸闷。',
  medicationMemory: '以前吃过心脏药，具体药名和用法需要核对。', openingStatement: '医生您好，我活动后胸口闷，歇一会儿能缓过来。',
  symptomExperience: '三个月来走快了胸口就闷，休息后缓解，安静坐着没有胸痛。' }

export class CoronarySyntheaProvider extends StubSyntheaProvider {
  override async generate() {
    const corpus = await super.generate()
    return { ...corpus, sources: corpus.sources.map(source => {
      const raw = z.object({ entry: z.array(z.object({ resource: z.record(z.string(), z.unknown()) }).passthrough()) }).passthrough().parse(source.raw)
      for (const { resource } of raw.entry) {
        if (resource.id === 'pc' || resource.id === 'ic') resource.code = { coding: [{
          code: '53741008', display: '冠状动脉粥样硬化性心脏病', system: 'http://snomed.info/sct',
        }] }
        if (resource.id === 'ie') resource.reasonCode = [{ text: '冠心病择期造影前评估' }]
        const quantity = z.object({ unit: z.string() }).passthrough().safeParse(resource.valueQuantity)
        if (quantity.success) resource.valueQuantity = { ...quantity.data, code: quantity.data.unit }
      }
      return { ...source, raw, hash: sourceArtifactHash(raw) }
    }) }
  }
}

export async function createCoronaryData(directory: string) {
  const sourceDirectory = join(directory, 'guideline-originals')
  await mkdir(sourceDirectory)
  const bytes = syntheticGuidelinePdf([coronaryGuidelineParagraph.split('\n'), [excludedCoronaryParagraph]])
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const source = { id: 'local-evaluation-synthetic-coronary-workflow', title: coronaryGuidelineTitle, publisher: 'ClinMesh 合成指南机构',
    documentType: 'guideline', version: 'synthetic-1', url: 'https://example.test/coronary-workflow', format: 'pdf', sha256,
    scope: '仅供本地合成流程验证；原始许可未核定。', status: 'active',
    license: { id: 'synthetic-unverified', url: 'https://example.test/coronary-workflow', usage: 'unverified' },
    topics: [{ terms: ['冠心病', 'coronary'], diagnosisQueries: ['冠状动脉粥样硬化性心脏病'] }] }
  await writeFile(join(sourceDirectory, `${sha256}.pdf`), bytes)
  const manifestPath = join(directory, 'local-guidelines.json')
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, sources: [{ source, pages: [[1, 1]] }] }))
  const guidelineDatabasePath = join(directory, 'guidelines.sqlite')
  const imported = await runLocalGuidelineSync(['--manifest', manifestPath, '--database', guidelineDatabasePath, '--source-dir', sourceDirectory],
    { allowLocalEvaluation: true })
  assert.equal(imported.failedSourceCount, 0)
  assert.equal(imported.passageCount, 1)
  const artifact = JSON.stringify({ schemaVersion: '1', concepts: [{ ...pciDataPackage.diagnosis, domain: 'diagnosis', status: 'active' }],
    medicationProducts: [], services: [], valueSetEntries: [] })
  await writeFile(join(directory, 'reference.json'), artifact)
  const referenceManifest = join(directory, 'reference-release.json')
  await writeFile(referenceManifest, JSON.stringify({ releaseId: coronaryReferenceRelease, schemaVersion: '1', createdAt: '2026-10-25T00:00:00.000Z', sources: [{
    sourceId: 'synthetic-coronary', artifactPath: 'reference.json', acquisitionMethod: 'generated',
    checksum: createHash('sha256').update(artifact).digest('hex'), licenseId: 'CC0-1.0', retrievedAt: '2026-10-25T00:00:00.000Z',
    sourceUrl: 'https://example.test/coronary-reference', upstreamVersion: '2022',
  }] }))
  const referenceDatabasePath = join(directory, 'reference.sqlite')
  await runReferenceDatabaseCli(['migrate', '--database', referenceDatabasePath])
  await runReferenceDatabaseCli(['import', '--database', referenceDatabasePath, '--manifest', referenceManifest])
  return { guidelineDatabasePath, referenceDatabasePath, sourceHash: sha256, sourceUrl: source.url }
}

export type CoronaryModelObservation = { stage: 'generation' | 'verification'; kind: DoctorRecommendationKind; guidelines: GuidelineEvidence[] }

export function createCoronaryProvider() {
  const seen: CoronaryModelObservation[] = []
  const provider: JsonChatCompletionsProvider = { async completeJson(input) {
    assert.ok(!JSON.stringify(input.userPayload).includes(excludedCoronaryParagraph), 'Unselected source page reached the model')
    let output: unknown
    if (input.schemaName === 'patient_persona') output = coronaryPersona
    else if (input.schemaName === 'patient_dialogue_reply') output = { reply: coronaryPersona.symptomExperience }
    else if (input.schemaName === 'clinical_document_quality' || input.schemaName === 'clinical_document_quality_verification') {
      const payload = z.object({ agentFacts: z.array(z.object({ id: z.string() })) }).parse(input.userPayload)
      output = { issues: [], agentFactChecks: payload.agentFacts.map(fact => ({ id: fact.id, supported: true })) }
    } else if (input.schemaName === 'doctor_recommendation_catalog_selection') {
      const payload = z.object({ catalogs: z.object({ laboratory: z.object({ items: z.array(z.object({ id: z.string() })) }) }) }).parse(input.userPayload)
      output = { complete: true, selectedCatalogItemIds: payload.catalogs.laboratory.items.filter(item => item.id === 'hospital-lab-pci-creatinine').map(item => item.id) }
    } else if (input.schemaName === 'doctor_recommendation_verification') {
      const payload = z.object({ kind: doctorRecommendationKindSchema, items: z.array(doctorRecommendationSuggestionSchema),
        guidelines: z.array(guidelineEvidenceSchema), caseEvidence: z.array(doctorCaseEvidenceSchema) }).parse(input.userPayload)
      seen.push({ stage: 'verification', kind: payload.kind, guidelines: payload.guidelines })
      for (const item of payload.items) {
        assert.ok(item.guidelineEvidenceIds.every(id => payload.guidelines.some(guideline => guideline.id === id)))
        assert.ok(item.caseEvidenceIds.every(id => payload.caseEvidence.some(fact => fact.id === id)))
      }
      output = { items: payload.items.map(item => ({ id: item.id, guidelineSupported: true, caseSupported: true, applicable: true, qualifiersPreserved: true,
        ...(item.kind === 'prescription' ? { prescriptionFields: { doseText: true, frequencyCode: true, courseDays: true, quantity: true } } : {}),
      })) }
    } else if (input.schemaName === 'doctor_recommendations') {
      const payload = z.object({ kind: doctorRecommendationKindSchema, guidelines: z.array(guidelineEvidenceSchema), caseEvidence: z.array(doctorCaseEvidenceSchema),
        catalogs: z.object({ diagnoses: z.object({ reference: z.array(z.object({ id: z.string() })) }).optional(),
          laboratory: z.object({ items: z.array(z.object({ id: z.string(), allowedIndicationCodes: z.array(z.string()) })) }).optional(),
          medications: z.array(z.object({ id: z.string() })).optional() }),
      }).parse(input.userPayload)
      seen.push({ stage: 'generation', kind: payload.kind, guidelines: payload.guidelines })
      const guideline = payload.guidelines.find(item => item.title === coronaryGuidelineTitle)
      const fact = payload.caseEvidence.find(item => /冠心病|冠状动脉/u.test(item.text))
      if (guideline === undefined || fact === undefined || payload.kind === 'imaging' || payload.kind === 'pathology') {
        output = { items: [], considerations: [], missingInformation: [] }
      } else {
        const common = { id: `synthetic-coronary-${payload.kind}`, label: '合成冠心病候选', rationale: '仅验证指南与当前可见冠心病资料进入诊疗建议链路。',
          supportingInformation: ['已公开冠心病病史及本次造影评估计划。'], opposingInformation: [], missingInformation: [],
          guidelineEvidenceIds: [guideline.id], caseEvidenceIds: [fact.id] }
        if (payload.kind === 'diagnosis') {
          assert.ok(payload.catalogs.diagnoses?.reference.some(item => item.id === pciDataPackage.diagnosis.id))
          output = { items: [{ ...common, kind: 'diagnosis', role: 'primary', catalogItemId: pciDataPackage.diagnosis.id }], considerations: [], missingInformation: [] }
        } else if (payload.kind === 'laboratory') {
          const item = payload.catalogs.laboratory?.items.find(item => item.id === 'hospital-lab-pci-creatinine')
          assert.ok(item)
          output = { items: [{ ...common, kind: 'laboratory', catalogItemId: item.id, indicationCode: item.allowedIndicationCodes[0] }], considerations: [], missingInformation: [] }
        } else {
          assert.ok(payload.catalogs.medications?.some(item => item.id === 'medication-pci-aspirin'))
          output = { items: [{ ...common, kind: 'prescription', catalogItemId: 'medication-pci-aspirin',
            doseText: '100 mg', frequencyCode: 'QD', courseDays: 1, quantity: 1 }], considerations: [], missingInformation: [] }
        }
      }
    } else throw new Error(`Unexpected coronary fixture request: ${input.schemaName}`)
    return { model: input.model, content: JSON.stringify(output) }
  } }
  return { provider, seen }
}

export async function startCoronaryCase(runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>, password = 'Synthetic-Demo-Password-2026!', origin = 'http://localhost') {
  const started = await startConsultationCase(runtime, password, origin)
  const context = sessionContextSchema.parse(await (await runtime.app.request('/api/auth/context', { headers: { cookie: started.adminCookie } })).json())
  const response = await runtime.app.request('/api/his/v1/inpatient/pci-data/prepare', { method: 'POST',
    headers: { cookie: started.adminCookie, origin, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ input: { expectedEpoch: context.actor.epoch } }),
  })
  assert.equal(response.status, 200, await response.clone().text())
  return started
}
