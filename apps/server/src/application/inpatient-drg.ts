import { groupDrgCase } from './drg-grouping.ts'
import type { DrgRules } from '@clinmesh/contracts/drg'
import { inpatientDrgPregroupResultSchema, type InpatientDrgPregroupResult } from '@clinmesh/contracts/inpatient-drg'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import type { ActorContext } from './command-executor.ts'

const clinicalCodingNote = '病案首页为临床版编码（nhc-icd10-clinical@2022.r4），分组规则字典为医保版口径；'
  + '两套码同码直通，未同码的诊断/操作如实报告为无法入组，不做名称模糊映射。'

/** 年龄：以离院时点（无离院用入院时点）计算整岁与天龄余数。 */
function ageAt(birthDate: string, at: string | undefined): { ageYears: number, ageDays: number | null } {
  const birth = new Date(birthDate)
  const reference = at === undefined ? new Date() : new Date(at)
  if (Number.isNaN(birth.getTime())) return { ageYears: 0, ageDays: null }
  const days = Math.max(0, Math.floor((reference.getTime() - birth.getTime()) / 86_400_000))
  return { ageYears: Math.min(150, Math.floor(days / 365.25)), ageDays: days < 365 ? days : null }
}

/**
 * DRG 预分组：从已提交病案首页修订快照（临床版编码）推导分组输入，调用 CHS-DRG 3.0 内核。
 * 只读计算，不落库、不改变病案状态；首页快照冻结的编码经同码直通进入医保版口径的规则集。
 */
export class InpatientDrg {
  constructor(private readonly owner: InpatientService, private readonly rules: DrgRules | null) {}

  pregroup(context: ActorContext, admissionId: string): InpatientDrgPregroupResult {
    if (this.rules === null) throw new InpatientError('DRG_RULES_NOT_CONFIGURED', '分组规则数据包未配置，无法预分组', 409)
    const record = this.owner.records.read(context, admissionId)
    if (record.revision === undefined) throw new InpatientError('DRG_RECORD_NOT_SUBMITTED', '病案首页尚未提交修订，无法预分组', 409)
    const snapshot = record.revision.snapshot
    const { patient, stay, clinical } = snapshot
    const input = {
      diagnoses: clinical.diagnosis.entries.map(entry => ({
        code: entry.coding.code, role: entry.role === 'primary' ? 'main' as const : 'secondary' as const })),
      operations: clinical.operations.map(operation => ({
        code: operation.actualProcedure.coding.code, primary: operation.primary })),
      gender: patient.gender === 'male' ? 'male' as const : patient.gender === 'female' ? 'female' as const : 'unknown' as const,
      ...ageAt(patient.birthDate, stay.departedAt ?? stay.admittedAt),
      birthWeightGrams: null,
      dischargeMode: stay.departureMethod ?? 'unknown',
      inpatientDays: stay.admittedAt === undefined || stay.departedAt === undefined ? 0
        : Math.min(3650, Math.max(0, Math.floor((new Date(stay.departedAt).getTime()
          - new Date(stay.admittedAt).getTime()) / 86_400_000))),
    }
    return inpatientDrgPregroupResultSchema.parse({
      admissionId,
      recordRevision: record.revision.revision,
      rulesId: this.rules.rulesId,
      rulesVersion: this.rules.version,
      inputCoding: 'nhc-icd10-clinical@2022.r4',
      codingNote: clinicalCodingNote,
      result: groupDrgCase(this.rules, input),
    })
  }
}
