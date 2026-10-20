import type { ClinicalDocumentContent, DoctorCaseDetail } from '@clinmesh/contracts/his'
import { emptyAuxiliaryExamination } from './imaging-report-summary.ts'

export function createWorkingClinicalDocument(detail: DoctorCaseDetail): ClinicalDocumentContent {
  const vitals = detail.presentation?.vitalSigns
  const prefill: ClinicalDocumentContent = {
    allergyHistory: '',
    assessment: '',
    auxiliaryExamination: detail.report === undefined
      ? emptyAuxiliaryExamination
      : detail.report.results.map(result => `${result.code} ${String(result.value)}`).join('；'),
    chiefComplaint: detail.presentation?.chiefComplaint ?? '',
    disposition: '',
    followUp: '',
    familyHistory: '',
    historyOfPresentIllness: detail.presentation?.summary ?? '',
    physicalExamination: vitals === undefined ? '' : `T ${vitals.temperatureC} °C，P ${vitals.pulseBpm} 次/分，R ${vitals.respirationBpm} 次/分，BP ${vitals.bloodPressure.systolicMmHg}/${vitals.bloodPressure.diastolicMmHg} mmHg，SpO₂ ${vitals.oxygenSaturationPct}%。`,
    priorMedicalHistory: detail.priorFacts.length === 0
      ? '系统未记录既往病史。'
      : detail.priorFacts.map(fact => fact.display || fact.code).join('；'),
  }
  const persisted = detail.clinicalDocument?.draft
    ?? detail.clinicalDocument?.signed.at(-1)?.content
  if (persisted !== undefined) {
    const document: ClinicalDocumentContent = {
      allergyHistory: persisted.allergyHistory,
      assessment: persisted.assessment,
      auxiliaryExamination: persisted.auxiliaryExamination,
      chiefComplaint: persisted.chiefComplaint,
      disposition: persisted.disposition,
      followUp: persisted.followUp,
      familyHistory: persisted.familyHistory,
      historyOfPresentIllness: persisted.historyOfPresentIllness,
      physicalExamination: persisted.physicalExamination,
      priorMedicalHistory: persisted.priorMedicalHistory,
    }
    // Automatic writes can precede the first explicit save and leave prefilled fields empty in storage.
    if (detail.clinicalDocument?.draft !== undefined && detail.consultationRecording?.hasSavedDraft === false) {
      const automaticFields = new Set<keyof ClinicalDocumentContent>(detail.consultationRecording.additions
        .filter(addition => addition.status === 'applied').map(addition => addition.field))
      for (const field of Object.keys(document) as Array<keyof ClinicalDocumentContent>) {
        if (!automaticFields.has(field) && !document[field]) document[field] = prefill[field] ?? ''
      }
    }
    return document
  }
  return prefill
}
