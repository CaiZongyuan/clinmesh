import { z } from 'zod'
import { doctorCaseEvidenceSchema, doctorRecommendationKindSchema, guidelineEvidenceSchema } from '@clinmesh/contracts/doctor-recommendations'
import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'

// Recovery metadata is appended to old input snapshots after completion.
const savedInputSchema = z.object({
  context: z.record(z.string(), z.string()),
  encounter: doctorCaseDetailSchema.shape.encounter,
  kind: doctorRecommendationKindSchema,
  caseEvidence: z.array(doctorCaseEvidenceSchema),
  catalogs: z.record(z.string(), z.json()),
  guidelines: z.array(guidelineEvidenceSchema),
  sourceHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
  requiredCaseEvidenceIds: z.array(z.string()),
  historyEvidenceIds: z.array(z.string()),
  missingInformation: z.array(z.string()),
  contextPolicyVersion: z.string(), guidelineRevision: z.string(),
  referenceRevision: z.json().optional(), prescriptionConcluded: z.boolean(),
  historySelection: z.json().optional(), catalogSelection: z.json().optional(),
}).strict()

type ClinicalInput = {
  encounter: { id: string; versionId: string; status?: string | undefined }
  caseEvidence: Array<{ label: string }>
  historySelection?: unknown
  catalogSelection?: unknown
}

function originalInput<T extends ClinicalInput>(snapshot: T) {
  const { historySelection: _historySelection, catalogSelection: _catalogSelection, ...input } = snapshot
  return input
}

export function recommendationInputFingerprint<T extends ClinicalInput>(snapshot: T) {
  const input = originalInput(snapshot)
  const { versionId: _versionId, ...encounter } = input.encounter
  return canonicalJsonHash({ ...input, encounter, caseEvidence: input.caseEvidence.map(evidence => ({
    ...evidence,
    label: evidence.label.replace(/^当前病历草稿 v\d+ \/ (.+) \/ \d{4}-\d{2}-\d{2}T.+$/, '当前病历草稿 / $1'),
  })) })
}

/** Only an intact snapshot with its original fingerprint can acquire the new input identity. */
export function legacyRecommendationInput(inputJson: string, originalFingerprint: string) {
  try {
    const input = savedInputSchema.parse(JSON.parse(inputJson))
    if (canonicalJsonHash(originalInput(input)) !== originalFingerprint) return undefined
    return { input, fingerprint: recommendationInputFingerprint(input) }
  } catch { return undefined }
}
