import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { z } from 'zod'
import type { GuidelineDocument, GuidelinePassage } from '../../src/application/guideline-corpus.ts'
import { applyGuidelineReleaseOverlay, defaultGuidelineReleaseOverlay } from '../../src/infrastructure/guidelines/guideline-release-overlay.ts'
import { guidelineSourceDefinitionSchema } from '../../src/infrastructure/sqlite/guideline-corpus.ts'

export const syntheticGuidelineParagraph = 'Synthetic diabetes guidance. Review current glucose and previous treatment in adults with established type 2 diabetes. An isolated symptom does not establish diabetes; confirm the diagnosis before treatment.'
export const syntheticGuidelineMarker = '合成新增糖尿病主题：医生已核实糖尿病病史，仍需核对本次血糖。'
export const syntheticGuidelineDocument: GuidelineDocument = {
  source: {
    id: 'synthetic-free-diabetes', title: '合成免费糖尿病指南', publisher: '合成指南发布机构',
    documentType: 'guideline', version: 'synthetic-1', url: 'https://www.who.int/synthetic-diabetes',
    downloadUrl: 'https://iris.who.int/synthetic-diabetes.txt', format: 'text',
    sha256: createHash('sha256').update(syntheticGuidelineParagraph).digest('hex'), scope: '仅供合成集成测试，非临床建议。',
    status: 'active', license: { id: 'CC0-1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/', usage: 'open' },
    topics: [{ terms: ['糖尿病', 'diabetes'], diagnosisQueries: ['糖尿病'] }],
  },
  passages: [{ locator: '合成第3节第1段', text: syntheticGuidelineParagraph }],
}

const coronary20Figure1Garble = "\u0006\u0006 \u0006H*)5J\u0007\u000e3&\u0010$.,\u0004\u0004\u0005\n\u001f\u0016\u0013\u0003PO\u0002PLQ\u0010\u0014\n\u0002\u0014\u0011\u001a\u0016\u0003P\u0010\u0015 \u0016\u0013a\u0017\u0017\u0003PO\u0002PLQ\u0010\u0014\n\u0002\u0014\u0011\u001a\u0016\u0003P\u0010\u0015 I\u0017\u0018\u0003PO\u0002PLQ\u0010\u0014\n\u0002\u0014\u0011\u001a\u0016\u0003P\u0010\u0015\n\u0004\u0015\u0017\u0003K\u0004 16$,'\u0004\u0005\u0004\n\u0012 \u0005 \u0005J\b \u0004\u0017\u001b\u0003K\n\u0007\u0004\u0005 \u0005aJ\u0007\u0005\u0003\u0004/\n\u0006\u0010\u0013\n?\u0003\u0005\b\n?\u0003\u0005\u0012 \b\u0005 \u0003\u0014\n?\u0003\u0005\u0004 \u0006\u0005\u0004 \u000e\u0007\u0007\n?\u0003\u0005\u0004\u0011 \u0004H*)5\u0003\u0016\u0013a\u0017\u0017\u0003\u0003\n\u0003\u0003\u0003PO\u0002PLQ\u0010\u0014\n\u0002\u0014\u0011\u001a\u0016\u0003P\u0010\u0015\u0003 \u0006\n?\u0003\u0007\u0006\u0004\u0004\u000e\b\u0004\u0004\u0006\n?\u0003\b\u0006\u0004\u0005\u0013\u0004\u0005\n?\u0003\u0007 \u0004\u000e \u0005\n?\u0003\u0007\u0006\u0004\u0004\u000e\b\u0004\u0004\u0006\n?\u0003\b\u0006\u0004\u0005\u0013\u0004\u0005\n\u000e\bV&U\u0004\u0004\u0006\u0006J\u0006\u0006H*)5 \u0007\u0006\u0004\u000e\bV&UJ\u0006\u0006H*)5 \u0007\u0006\u0004\u000e\bV&UJ\u0006\u0006H*)5"

export function buildOverlaidReleaseDocuments(
  manifest: {
    packageId: string
    releaseId: string
    sources: Array<{ source: Record<string, unknown> & { id: string; sha256: string } }>
  },
  extraPassagesFor?: (sourceId: string, index: number) => GuidelinePassage[],
): GuidelineDocument[] {
  const erratum = defaultGuidelineReleaseOverlay.errata.find(item => item.sourceId === 'coronary-20-2021')!
  const beforeText = erratum.afterText.replace(
    '鼓励术中尽可能减少对比剂的用量。近\neGFR',
    `鼓励术中尽可能减少对比剂的用量。近${coronary20Figure1Garble}\neGFR`,
  )
  const rawDocuments: GuidelineDocument[] = manifest.sources.map((entry, index) => {
    const source = guidelineSourceDefinitionSchema.parse({
      ...entry.source,
      distribution: {
        packageId: manifest.packageId,
        releaseId: manifest.releaseId,
        textStatus: 'verified',
        verificationRecord: `verification/${entry.source.id}.json`,
      },
    })
    const extra = extraPassagesFor?.(source.id, index) ?? [
      { locator: `PDF 物理第 1 页（#${index + 1}）`, text: `临床指南测试段落 ${source.id}：白血病 淋巴瘤 发热 冠心病 高血压 评估。` },
    ]
    return {
      source,
      passages: source.id === 'coronary-20-2021'
        ? [{ locator: erratum.originalLocator, text: beforeText }, ...extra]
        : extra,
    }
  })
  return applyGuidelineReleaseOverlay({ manifest, documents: rawDocuments }, defaultGuidelineReleaseOverlay).documents
}

export function setHospitalPatientBirthDate(databasePath: string, patientId: string, birthDate: string | undefined) {
  const database = new Database(databasePath)
  try {
    const row = z.object({ content_json: z.string() }).parse(
      database.prepare("SELECT content_json FROM fhir_resource WHERE resource_type = 'Patient' AND resource_id = ?")
        .get(patientId),
    )
    const { birthDate: _existing, ...rest } = JSON.parse(row.content_json) as Record<string, unknown>
    const updated = birthDate === undefined ? rest : { ...rest, birthDate }
    database.prepare("UPDATE fhir_resource SET content_json = ? WHERE resource_type = 'Patient' AND resource_id = ?")
      .run(JSON.stringify(updated), patientId)
  } finally {
    database.close()
  }
}
