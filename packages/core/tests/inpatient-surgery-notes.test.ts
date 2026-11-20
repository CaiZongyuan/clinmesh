import { inpatientMaterialPlanBasisSchema } from '@clinmesh/contracts/inpatient-material-plan'
import { expect, it } from 'vitest'
import {
  DEFAULT_ROUTINE_START_NOTE,
  evaluateCompletionNoteRequirement,
  evaluateExecuteNoteRequirement,
  isSamePlannedProcedure,
  mergeExecutionCompletionNote,
} from '../src/inpatient-surgery-notes.ts'

const planned = { id: 'proc-1', coding: { code: '36.0700' } }
const confirmedPlanBasis = inpatientMaterialPlanBasisSchema.parse({
  requestId: 'req-1',
  status: 'confirmed',
  effectiveReference: 'InpatientMaterialPlan/plan-1',
  history: [{
    reference: 'InpatientMaterialPlan/plan-1',
    requestId: 'req-1',
    source: 'material-estimate',
    sourceId: 'est-1',
    sourceVersion: 1,
    basisFingerprint: 'a'.repeat(64),
    sources: { requestId: 'req-1', evidencePackageId: 'pkg-1', evidencePackageVersion: '1', materialEvidence: [] },
    confirmedBy: 'doctor',
    confirmedAt: '2026-11-20T09:00:00+08:00',
    supersedes: null,
    reservationIds: ['res-1'],
    items: [{ materialId: 'mat-1', catalogVersion: 1, display: '合成导丝', specification: '0.014', quantity: 1, unit: '根', unitPriceFen: 20000, estimatedFen: 20000, reason: '按计划', quantityBasis: '单病变', evidenceIds: ['ev-1'] }],
  }],
})

it('同时核对院内术式 ID 与临床分类编码以判定术式偏离', () => {
  expect(isSamePlannedProcedure(planned, { id: 'proc-1', coding: { code: '36.0700' } })).toBe(true)
  expect(isSamePlannedProcedure(planned, { id: 'proc-2', coding: { code: '36.0700' } })).toBe(false)
  expect(isSamePlannedProcedure(planned, { id: 'proc-1', coding: { code: '00.6600' } })).toBe(false)
})

it('整台补录在术式一致、完整绑定本台预留且与确认清单一致时免填说明，任一偏离要求说明', () => {
  expect(evaluateExecuteNoteRequirement({
    actual: planned,
    planned,
    materials: [{ materialId: 'mat-1', catalogVersion: 1, quantity: 1, reservationId: 'res-1' }],
    activeRequestReservations: [{ id: 'res-1', quantity: 1 }],
    planBasis: confirmedPlanBasis,
  })).toEqual({ noteRequired: false, procedureChanged: false })

  expect(evaluateExecuteNoteRequirement({
    actual: planned,
    planned,
    materials: [],
    activeRequestReservations: [],
    planBasis: confirmedPlanBasis,
  }).noteRequired).toBe(true)
})

it('完成核实区分无计划额外使用、术式变更开始记录与缺项拦截，且完术免填不抹除开始说明', () => {
  expect(evaluateCompletionNoteRequirement({
    finalMaterials: [{ materialId: 'suture', catalogVersion: 1, quantity: 2, deltaQuantity: 0, reservationId: null }],
    requestReservationIds: new Set(),
    hasUnusedReservation: false,
    samePlannedProcedure: true,
  })).toEqual({
    noteRequired: false,
    hasExplainedExtraUse: true,
    defaultNote: '最终用量按术中已登记量核实，偏离原因已在术中登记',
  })

  expect(evaluateCompletionNoteRequirement({
    finalMaterials: [],
    requestReservationIds: new Set(),
    hasUnusedReservation: false,
    samePlannedProcedure: false,
  }).defaultNote).toBe('最终耗材经核实无差额，按术中调整术式完成手术')

  expect(evaluateCompletionNoteRequirement({
    finalMaterials: [],
    requestReservationIds: new Set(),
    hasUnusedReservation: false,
    planBasis: confirmedPlanBasis,
    samePlannedProcedure: true,
  }).noteRequired).toBe(true)

  expect(mergeExecutionCompletionNote(DEFAULT_ROUTINE_START_NOTE, '最终耗材经核实无差额，按计划完成手术', false))
    .toBe('最终耗材经核实无差额，按计划完成手术')
  expect(mergeExecutionCompletionNote('术中探查改行胆囊切除', '最终耗材经核实无差额，按术中调整术式完成手术', false))
    .toBe('术中探查改行胆囊切除；最终耗材经核实无差额，按术中调整术式完成手术')
  expect(mergeExecutionCompletionNote('术中探查改行胆囊切除', '医生显式完术说明', true))
    .toBe('医生显式完术说明')
})
