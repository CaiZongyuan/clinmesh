import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  simCaseSchema, simMappingSchema, simViewSchema,
  type SimAction, type SimCase, type SimClinical, type SimDraftLine, type SimMapping, type SimRules,
} from '@clinmesh/contracts/drg'
import { assessSimulation, quoteFen } from '@clinmesh/core/drg'
import { CommandExecutor, type ActorContext } from './command-executor.ts'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { ReferenceDatabase } from '../infrastructure/sqlite/reference-database.ts'
import { preparedSummary, readPreparedRecord, searchPreparedRecords } from '../infrastructure/reference-data/prepared-catalogues.ts'

// 院内映射和规则必须绑定具体来源版本，不跟随参考库最新版本自动升级。
export const simulationReferenceRelease = 'clinmesh-five-catalogues-2026-10-16.r3'
const mappingVersion = 'SIM-HOSPITAL-2026.r1'
const ruleVersion = 'SIM-GROUPER-2026.r1'
const paymentVersion = 'SIM-PAYMENT-2026.r1'
export const simulationRules: SimRules = {
  mainDiagnosisId: 'icd10-p1511-r04', complicationId: 'icd10-p1573-r03', completedProcedureId: 'icd9-p1014-r10',
  basePaymentFen: 1000000, complicationPaymentFen: 1800000, procedurePaymentFen: 2800000,
}
const mappingBase = {
  sourceReleaseId: simulationReferenceRelease, mappingVersion, priceVersion: 'SIM-PRICE-2026.r1',
  validFrom: '2026-01-01', validTo: '2026-12-31', synthetic: true,
} as const
export const simulationMappings: SimMapping[] = z.array(simMappingSchema).parse([
  { ...mappingBase, id: 'SIM-AMOX', name: '阿莫西林（模拟产品）', specification: '模拟规格 0.25g × 24 粒/盒', unit: '盒', category: 'drug',
    sourceDataset: 'drugs', sourceRecordId: 'drugs-p039-t0-r018', sourceCode: null, chargePrice: '12.50', costPrice: '8.20' },
  { ...mappingBase, id: 'SIM-CEFTRIAXONE', name: '头孢曲松（模拟产品）', specification: '模拟规格 1g/瓶', unit: '瓶', category: 'drug',
    sourceDataset: 'drugs', sourceRecordId: 'drugs-p041-t0-r006', sourceCode: null, chargePrice: '48.375', costPrice: '27.125' },
  { ...mappingBase, id: 'SIM-INFUSION', name: '住院静脉输液（模拟项目）', specification: '模拟床日计价，含输液器', unit: '床日', category: 'service',
    sourceDataset: 'services', sourceRecordId: 'services-p0026-t0-r010', sourceCode: '12040000601', chargePrice: '36.00', costPrice: '21.50' },
  { ...mappingBase, id: 'SIM-PENDING', name: '奥美拉唑（价格待补全示例）', specification: '模拟规格 20mg × 14 粒/盒', unit: '盒', category: 'drug',
    sourceDataset: 'drugs', sourceRecordId: 'drugs-p009-t0-r027', sourceCode: null, chargePrice: null, costPrice: null },
])

export class DrgSimulationError extends Error {
  constructor(readonly code: string, message: string, readonly status: 403 | 404 | 409 | 422 | 503 = 409) { super(message) }
}

export class DrgSimulationService {
  private referenceReady = false
  constructor(private database: ClinMeshDatabase, private commands: CommandExecutor, private reference?: ReferenceDatabase) {}

  private authorize(context: ActorContext) {
    if (!['outpatient-doctor', 'administrator'].includes(context.roleCode)) throw new DrgSimulationError('DRG_FORBIDDEN', '当前岗位不能操作住院模拟', 403)
  }
  private referenceDatabase() {
    if (this.reference === undefined || (!this.referenceReady && preparedSummary(this.reference, simulationReferenceRelease) === null)) {
      throw new DrgSimulationError('DRG_REFERENCE_UNAVAILABLE', '五类参考数据尚未发布，请先运行 reference:prepare 和 reference:sync', 503)
    }
    this.referenceReady = true
    return this.reference
  }
  catalog(context: ActorContext) {
    this.authorize(context)
    const reference = this.reference === undefined ? null : preparedSummary(this.reference, simulationReferenceRelease)
    const rows = z.array(z.object({ state_json: z.string() })).parse(this.database.driver.prepare(
      'SELECT state_json FROM drg_simulation_case WHERE workspace_id = ? AND epoch = ? ORDER BY case_id',
    ).all(context.workspaceId, context.epoch))
    return {
      reference,
      mappings: reference === null ? [] : simulationMappings,
      diagnoses: reference === null ? [] : [simulationRules.mainDiagnosisId, simulationRules.complicationId, 'icd10-p1310-r03'].map(id => this.requireReference('icd10', id)),
      procedures: reference === null ? [] : [this.requireReference('icd9', simulationRules.completedProcedureId)],
      cases: rows.map(row => { const state = simCaseSchema.parse(JSON.parse(row.state_json)); return { id: state.id, name: state.name, revision: state.revision } }),
    }
  }
  search(context: ActorContext, input: { dataset: string, table: string, query: string, page: number }) {
    this.authorize(context)
    return searchPreparedRecords(this.referenceDatabase(), simulationReferenceRelease, input)
  }
  private requireReference(dataset: string, id: string) {
    const record = readPreparedRecord(this.referenceDatabase(), simulationReferenceRelease, dataset, id)
    if (record === undefined) throw new DrgSimulationError('DRG_REFERENCE_NOT_FOUND', '参考记录不在固定版本中', 422)
    if (['icd10', 'icd9'].includes(dataset) && record.payload.kind !== 'leaf') {
      throw new DrgSimulationError('DRG_NON_LEAF_CODE', '层级记录不能当作末级临床编码', 422)
    }
    return record
  }
  private validateClinical(clinical: SimClinical) {
    if (clinical.secondaryDiagnosisIds.includes(clinical.mainDiagnosisId)
      || new Set(clinical.secondaryDiagnosisIds).size !== clinical.secondaryDiagnosisIds.length
      || new Set(clinical.completedProcedureIds).size !== clinical.completedProcedureIds.length) {
      throw new DrgSimulationError('DRG_DUPLICATE_CLINICAL', '主次诊断或操作不能重复', 422)
    }
    for (const id of [clinical.mainDiagnosisId, ...clinical.secondaryDiagnosisIds]) this.requireReference('icd10', id)
    for (const id of clinical.completedProcedureIds) this.requireReference('icd9', id)
  }
  private state(context: ActorContext, id: string) {
    this.authorize(context)
    const row = z.object({ state_json: z.string() }).optional().parse(this.database.driver.prepare(
      'SELECT state_json FROM drg_simulation_case WHERE workspace_id = ? AND epoch = ? AND case_id = ?',
    ).get(context.workspaceId, context.epoch, id))
    if (row === undefined) throw new DrgSimulationError('DRG_CASE_NOT_FOUND', '该模拟病例不存在或不在当前工作区', 404)
    const state = simCaseSchema.parse(JSON.parse(row.state_json))
    if (state.referenceReleaseId !== simulationReferenceRelease || state.ruleVersion !== ruleVersion
      || state.paymentVersion !== paymentVersion || state.mappingVersion !== mappingVersion) {
      throw new DrgSimulationError('DRG_VERSION_UNSUPPORTED', '该病例使用其他版本，请保留原记录并使用对应版本评估', 409)
    }
    return state
  }
  get(context: ActorContext, id: string) {
    const state = this.state(context, id)
    return { case: state, assessment: assessSimulation(state) }
  }
  preview(context: ActorContext, id: string, input: { expectedRevision: number, lines: SimDraftLine[], clinical?: SimClinical | undefined }) {
    const state = this.state(context, id)
    this.checkRevision(state, input.expectedRevision)
    if (input.clinical !== undefined) this.validateClinical(input.clinical)
    this.validateLines(input.lines, state.configuration.mappings)
    return { case: state, assessment: assessSimulation(state, input.lines, input.clinical ?? state.clinical) }
  }
  create(context: ActorContext, idempotencyKey: string) {
    this.authorize(context)
    this.referenceDatabase()
    for (const mapping of simulationMappings) this.requireReference(mapping.sourceDataset, mapping.sourceRecordId)
    return this.commands.execute({ context, contextRequirement: 'current', idempotencyKey,
      expectedVersions: {}, input: {}, operation: 'drg.simulation.create', dataSchema: simViewSchema }, () => {
      const id = randomUUID()
      const state: SimCase = {
        id, name: `合成肺炎住院病例 ${id.slice(0, 6)}`, synthetic: true, revision: 1, clinicalRevision: 1,
        clinical: { mainDiagnosisId: simulationRules.mainDiagnosisId, secondaryDiagnosisIds: [], completedProcedureIds: [] },
        referenceReleaseId: simulationReferenceRelease, mappingVersion, ruleVersion, paymentVersion,
        simulationDate: '2026-10-18', lines: [], baseChargeFen: 240000, baseCostFen: 160000,
        configuration: { rules: structuredClone(simulationRules), mappings: structuredClone(simulationMappings) },
        reserveChargeFen: 120000, reserveCostFen: 80000, history: [],
      }
      this.appendHistory(state, '创建合成住院病例')
      this.database.driver.prepare('INSERT INTO drg_simulation_case VALUES (?, ?, ?, ?, ?)')
        .run(context.workspaceId, context.epoch, id, state.revision, JSON.stringify(state))
      return { data: { case: state, assessment: assessSimulation(state) },
        effects: [{ kind: 'created', reference: `DrgSimulation/${id}`, versionId: '1' }] }
    })
  }
  command(context: ActorContext, id: string, idempotencyKey: string, expectedRevision: number, action: SimAction) {
    this.authorize(context)
    return this.commands.execute({ context, contextRequirement: 'current', idempotencyKey,
      expectedVersions: {}, input: { id, expectedRevision, action }, operation: 'drg.simulation.change', dataSchema: simViewSchema }, () => {
      const state = this.state(context, id)
      this.checkRevision(state, expectedRevision)
      if (action.kind === 'confirm-clinical') {
        this.validateClinical(action.clinical)
        state.clinical = action.clinical
        state.clinicalRevision++
      } else if (action.kind === 'issue') {
        this.validateLines(action.lines, state.configuration.mappings)
        const assessment = assessSimulation(state, action.lines)
        // 未知价格不以零写入正式费用；允许医生保留并开立带缺项的模拟承诺。
        if (assessment.missing.some(message => message.includes('适用日期'))) throw new DrgSimulationError('DRG_PRICE_EXPIRED', '价格已超出适用日期', 422)
        for (const draft of action.lines) {
          const mapping = state.configuration.mappings.find(item => item.id === draft.mappingId)!
          state.lines.push({ ...draft, id: randomUUID(), mapping: structuredClone(mapping),
            chargeFen: quoteFen(mapping.chargePrice, draft.quantity), costFen: quoteFen(mapping.costPrice, draft.quantity),
            chargeState: mapping.category === 'drug' && mapping.chargePrice !== null ? 'incurred' : 'committed', costState: 'committed', withdrawn: false })
        }
      } else {
        const line = state.lines.find(entry => entry.id === action.lineId)
        if (line === undefined) throw new DrgSimulationError('DRG_LINE_NOT_FOUND', '模拟医嘱不存在', 404)
        if (action.kind === 'record-charge') {
          if (line.withdrawn || line.chargeState !== 'committed') throw new DrgSimulationError('DRG_LINE_STATE', '仅未撤回的待记费医嘱可以记费')
          if (line.chargeFen === null) throw new DrgSimulationError('DRG_CHARGE_MISSING', '收费价待补全，不能按零元确认收费', 422)
          line.chargeState = 'incurred'
        } else if (action.kind === 'execute') {
          if (line.withdrawn || line.costState !== 'committed') throw new DrgSimulationError('DRG_LINE_STATE', '该项目不能重复执行或已撤回')
          line.costState = 'incurred'
        } else if (action.kind === 'withdraw') {
          if (line.withdrawn) throw new DrgSimulationError('DRG_LINE_STATE', '该医嘱已撤回')
          line.withdrawn = true
          // 临床撤回不代替正式收费冲销；已执行成本始终保留。
        } else {
          if (!line.withdrawn || line.costState === 'incurred' || line.chargeState === 'reversed') {
            throw new DrgSimulationError('DRG_REVERSAL_NOT_ALLOWED', '仅已撤回、未执行且未冲销的模拟项目可确认冲销')
          }
          line.chargeState = 'reversed'
          line.costState = 'released'
        }
      }
      state.revision++
      this.appendHistory(state, this.actionName(action))
      this.database.driver.prepare('UPDATE drg_simulation_case SET revision = ?, state_json = ? WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND revision = ?')
        .run(state.revision, JSON.stringify(state), context.workspaceId, context.epoch, id, expectedRevision)
      return { data: { case: state, assessment: assessSimulation(state) },
        effects: [{ kind: 'updated', reference: `DrgSimulation/${id}`, versionId: String(state.revision) }] }
    })
  }
  private validateLines(lines: SimDraftLine[], mappings: SimMapping[]) {
    for (const line of lines) {
      const mapping = mappings.find(item => item.id === line.mappingId)
      if (mapping === undefined) throw new DrgSimulationError('DRG_MAPPING_MISSING', '该院内模拟项目没有单位或价格映射', 422)
      this.requireReference(mapping.sourceDataset, mapping.sourceRecordId)
    }
  }
  private checkRevision(state: SimCase, expected: number) {
    if (state.revision !== expected) throw new DrgSimulationError('DRG_STALE_ASSESSMENT', '病例或费用已变化，请刷新后重新预览和确认')
  }
  private appendHistory(state: SimCase, action: string) {
    state.history.push({ revision: state.revision, clinicalRevision: state.clinicalRevision, at: new Date().toISOString(), action,
      clinical: structuredClone(state.clinical), assessment: assessSimulation(state),
      referenceReleaseId: state.referenceReleaseId, mappingVersion, ruleVersion, paymentVersion })
  }
  private actionName(action: SimAction) {
    return { 'confirm-clinical': '确认诊断或已完成操作并重新分组', issue: '模拟开具并冻结价格',
      'record-charge': '确认收费发生', execute: '确认执行及成本发生', withdraw: '临床撤回（保留费用）', reverse: '确认未执行项目冲销' }[action.kind]
  }
}
