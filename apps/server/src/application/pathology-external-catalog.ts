import { externalPathologyAssetOutputSchema, pathologySpecimenTypeSchema, type ExternalPathologyAssetOutput, type PathologyExamCode, type PathologySpecimenType } from '@clinmesh/contracts/pathology'
import { z } from 'zod'
import type { SourceResource } from './imaging-preparation.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'

const reportSchema = z.object({
  diagnosis: z.string().trim().min(1).max(4000),
  immunohistochemistry: z.string().trim().min(1).max(4000),
  microscopy: z.string().trim().min(1).max(8000),
  note: z.string().trim().min(1).max(4000),
  revision: z.number().int().positive(),
  review: z.object({
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    conclusion: z.enum(['approved', 'rejected']),
    reviewedAt: z.iso.datetime({ offset: true }),
    reviewer: z.string().trim().min(1).max(128),
  }).strict(),
}).strict()

/** 已预登记、许可核验且由维护者复核的外部原片和报告；不接受运行时任意路径或上传。 */
export const externalPathologyAssetSchema = z.object({
  assetId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/),
  diagnosis: z.object({ code: z.string().min(1), system: z.string().min(1) }).strict(),
  examCode: z.enum(['colorectal-slide-consultation', 'thyroid-slide-consultation']),
  license: z.object({
    attribution: z.string().trim().min(1),
    deidentified: z.literal(true),
    identifier: z.string().trim().min(1),
    source: z.url(),
    synthetic: z.boolean(),
  }).strict(),
  output: externalPathologyAssetOutputSchema,
  reports: z.array(reportSchema).min(1),
  sourceSpecimenType: pathologySpecimenTypeSchema,
}).strict().superRefine((asset, context) => {
  const expectedOrgan = asset.examCode === 'thyroid-slide-consultation' ? 'thyroid' : 'colorectal'
  if (asset.output.organ !== expectedOrgan) context.addIssue({ code: 'custom', message: 'The slide organ must match its consultation', path: ['output', 'organ'] })
  if (asset.examCode === 'thyroid-slide-consultation' && asset.sourceSpecimenType !== 'prior-thyroid-surgical-specimen') {
    context.addIssue({ code: 'custom', message: 'Thyroid consultations only accept prior surgical specimens', path: ['sourceSpecimenType'] })
  }
  if (asset.examCode === 'colorectal-slide-consultation' && !['prior-colorectal-biopsy', 'prior-colorectal-polypectomy'].includes(asset.sourceSpecimenType)) {
    context.addIssue({ code: 'custom', message: 'Colorectal consultations only accept prior biopsy or polypectomy specimens', path: ['sourceSpecimenType'] })
  }
  if (new Set(asset.reports.map(report => report.revision)).size !== asset.reports.length) {
    context.addIssue({ code: 'custom', message: 'Report revisions must be unique', path: ['reports'] })
  }
})
export type ExternalPathologyAsset = z.infer<typeof externalPathologyAssetSchema>

export const externalPathologyCatalogSchema = z.object({
  assets: z.array(externalPathologyAssetSchema),
  packId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/),
  ruleVersion: z.number().int().positive(),
}).strict().superRefine((catalog, context) => {
  if (new Set(catalog.assets.map(asset => asset.assetId)).size !== catalog.assets.length) {
    context.addIssue({ code: 'custom', message: 'Asset identities must be unique', path: ['assets'] })
  }
})
export type ExternalPathologyCatalog = z.infer<typeof externalPathologyCatalogSchema>

export interface PathologyExternalAssetSource {
  catalog(): Promise<ExternalPathologyCatalog | undefined>
  available(asset: ExternalPathologyAsset): Promise<boolean>
}

const sourceProcedureRules: ReadonlyArray<{ examCode: PathologyExamCode; specimenType: PathologySpecimenType; coding: { system: string; code: string } }> = [
  { examCode: 'colorectal-slide-consultation', specimenType: 'prior-colorectal-biopsy', coding: { system: 'http://snomed.info/sct', code: '76164006' } },
  { examCode: 'colorectal-slide-consultation', specimenType: 'prior-colorectal-polypectomy', coding: { system: 'http://snomed.info/sct', code: '274025005' } },
  { examCode: 'thyroid-slide-consultation', specimenType: 'prior-thyroid-surgical-specimen', coding: { system: 'http://snomed.info/sct', code: '13619001' } },
  { examCode: 'thyroid-slide-consultation', specimenType: 'prior-thyroid-surgical-specimen', coding: { system: 'http://snomed.info/sct', code: '179251002' } },
]

const historicalResourceSchema = z.object({
  code: z.object({ coding: z.array(z.object({ code: z.string(), display: z.string().optional(), system: z.string() }).passthrough()).default([]) }).passthrough().optional(),
  performedDateTime: z.string().optional(),
  performedPeriod: z.object({ start: z.string() }).passthrough().optional(),
  resourceType: z.string(),
}).passthrough()

/** 仅从医生本来可读的既往来源记录取得相容标本；没有时间或本次/未来的操作不能送检。 */
export function externalPathologySourceProcedures(input: {
  examCode: PathologyExamCode
  historyResources: SourceResource[]
  visitStart: string | undefined
}) {
  if (input.visitStart === undefined || !Number.isFinite(Date.parse(input.visitStart))) return []
  const visitTime = Date.parse(input.visitStart)
  return input.historyResources.flatMap(({ resource, sourceReference }) => {
    const parsed = historicalResourceSchema.safeParse(resource)
    if (!parsed.success || parsed.data.resourceType !== 'Procedure') return []
    const time = parsed.data.performedPeriod?.start ?? parsed.data.performedDateTime
    if (time === undefined || !Number.isFinite(Date.parse(time)) || Date.parse(time) >= visitTime) return []
    const rule = sourceProcedureRules.find(rule => rule.examCode === input.examCode
      && parsed.data.code?.coding.some(coding => coding.code === rule.coding.code && coding.system === rule.coding.system))
    if (rule === undefined) return []
    const coding = parsed.data.code!.coding.find(coding => coding.code === rule.coding.code && coding.system === rule.coding.system)!
    return [{ code: coding.code, ...(coding.display === undefined ? {} : { display: coding.display }), performedAt: time, sourceReference, specimenType: rule.specimenType }]
  }).toSorted((left, right) => Date.parse(left.performedAt) - Date.parse(right.performedAt) || left.sourceReference.localeCompare(right.sourceReference))
}

export function externalPathologyReportHash(asset: Pick<ExternalPathologyAsset, 'output'>, report: Pick<z.infer<typeof reportSchema>, 'diagnosis' | 'immunohistochemistry' | 'microscopy' | 'note' | 'revision'>): string {
  return canonicalJsonHash({ output: asset.output, report: { diagnosis: report.diagnosis, immunohistochemistry: report.immunohistochemistry, microscopy: report.microscopy, note: report.note, revision: report.revision, specimen: { slideCount: 1, stain: 'HE' } } })
}

export function externalPathologyPublishedReport(asset: ExternalPathologyAsset, revision?: number) {
  return asset.reports.filter(report => report.review.conclusion === 'approved' && report.review.contentHash === externalPathologyReportHash(asset, report))
    .filter(report => revision === undefined || report.revision === revision).toSorted((left, right) => left.revision - right.revision).at(-1)
}

export function externalPathologySourceHasDiagnosis(asset: ExternalPathologyAsset, historyResources: SourceResource[]): boolean {
  return historyResources.some(({ resource }) => {
    const parsed = historicalResourceSchema.safeParse(resource)
    return parsed.success && parsed.data.resourceType === 'Condition'
      && parsed.data.code?.coding.some(coding => coding.system === asset.diagnosis.system && coding.code === asset.diagnosis.code) === true
  })
}

export const externalPathologyExamCodes = ['colorectal-slide-consultation', 'thyroid-slide-consultation'] as const
export type { ExternalPathologyAssetOutput }
