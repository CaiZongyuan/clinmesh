import type { DoctorCaseHistoryDetail } from '@clinmesh/contracts/agent'
import type { DoctorCaseEvidence } from '@clinmesh/contracts/doctor-recommendations'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'

type VisibleHistory = Extract<DoctorCaseHistoryDetail, { source: 'visible-source' }>
type CompletedHistory = Extract<DoctorCaseHistoryDetail, { source: 'local-completed' }>
type PackedEntry = {
  entryId: string
  clinicalDate?: string
  title?: string
  clinical?: VisibleHistory['clinical']
  record?: Partial<CompletedHistory['record']>
  fieldPath?: string
}
type HistoryGroup = {
  source: DoctorCaseHistoryDetail['source']
  resourceType: string
  required: boolean
  entries: PackedEntry[]
}

function abnormalOrUncertain(clinical: VisibleHistory['clinical']): boolean {
  const normal = (value: string | undefined) => value !== undefined && ['n', 'normal', '正常'].includes(value.trim().toLowerCase())
  return [clinical, ...clinical.component ?? []].some(observation => observation.interpretation?.some(concept => {
    if (concept.text !== undefined && !normal(concept.text)) return true
    if (concept.coding?.length) return concept.coding.some(coding =>
      !normal(coding.code ?? coding.display) || coding.display !== undefined && !normal(coding.display))
    return !normal(concept.text)
  }) === true)
}

export function packDoctorRecommendationHistory(caseId: string, history: DoctorCaseHistoryDetail[]): {
  required: DoctorCaseEvidence[]
  optional: DoctorCaseEvidence[]
  missingInformation: string[]
} {
  const result: { required: DoctorCaseEvidence[]; optional: DoctorCaseEvidence[]; missingInformation: string[] } = {
    required: [], optional: [], missingInformation: [],
  }
  const groups = new Map<string, HistoryGroup>()
  for (const item of history) {
    const resourceType = item.source === 'visible-source' ? item.resourceType : 'Encounter'
    const required = item.source === 'local-completed' || ['Condition', 'AllergyIntolerance', 'Device', 'Procedure'].includes(resourceType)
      || resourceType.startsWith('Medication')
      || item.source === 'visible-source' && resourceType === 'Observation' && abnormalOrUncertain(item.clinical)
    const key = `${item.source}:${resourceType}:${required}`
    const group = groups.get(key) ?? { source: item.source, resourceType, required, entries: [] }
    group.entries.push(item.source === 'visible-source'
      ? { entryId: item.entryId, clinicalDate: item.clinicalDate, title: item.title, clinical: item.clinical }
      : { entryId: item.entryId, record: item.record })
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    const serialize = (entries: PackedEntry[]) => JSON.stringify({
      source: group.source, resourceType: group.resourceType,
      ...(group.source === 'visible-source' ? { missingFieldMeaning: 'not-recorded' } : {}), entries,
    })
    const flush = (entries: PackedEntry[]) => {
      if (entries.length === 0) return
      result[group.required ? 'required' : 'optional'].push({
        id: `evidence:${canonicalJsonHash({ caseId, source: group.source, resourceType: group.resourceType,
          required: group.required, members: entries.map(entry => ({ entryId: entry.entryId, fieldPath: entry.fieldPath })) })}`,
        kind: 'history', label: `${group.source === 'visible-source' ? '外部可见历史' : '本院完诊记录'} / ${group.resourceType} / ${new Set(entries.map(entry => entry.entryId)).size}条`,
        text: serialize(entries),
      })
    }
    let entries: PackedEntry[] = []
    // 单包在既有 12,000 字符合同（证据 schema 上限）之上增加 UTF-8 字节预算：请求信封按字节约束，
    // 中文内容的字符计数会低估 3 倍体积；纯 ASCII 内容两者基本等价。
    const packByteLimit = 12 * 1024
    const withinBudget = (text: string) => text.length <= 12_000 && Buffer.byteLength(text) <= packByteLimit
    const completeEntries = group.entries.flatMap(entry => {
      if (withinBudget(serialize([entry]))) return [entry]
      if (group.required) {
        const { clinical, record, ...identity } = entry
        const parts = Object.entries(clinical ?? record ?? {}).map(([field, value]) => ({
          ...identity, fieldPath: `${clinical === undefined ? 'record' : 'clinical'}.${field}`,
          ...(clinical === undefined ? { record: { [field]: value } } : { clinical: { [field]: value } }),
        }))
        if (parts.every(part => withinBudget(serialize([part])))) return parts
      }
      if (result.missingInformation.length === 0) {
        result.missingInformation.push('一条完整历史记录或临床字段超过建议证据预算，无法安全拆分；请核查来源资料。')
      }
      return []
    })
    for (const entry of completeEntries) {
      const next = serialize([...entries, entry])
      if (entries.length > 0 && (next.length > 12_000 || Buffer.byteLength(next) > 16 * 1024)) {
        flush(entries)
        entries = []
      }
      entries.push(entry)
    }
    flush(entries)
  }
  return result
}
