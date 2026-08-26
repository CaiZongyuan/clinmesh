import type {
  ScenarioDatasetContent,
  ScenarioDiagnostic,
} from '@clinmesh/contracts/scenario'

export function validateScenarioDataset(content: ScenarioDatasetContent): ScenarioDiagnostic[] {
  const diagnostics: ScenarioDiagnostic[] = []
  const diagnosisCodes = new Set(content.catalog.diagnoses.map(item => item.code))
  const investigationCatalog = new Map(content.catalog.investigations.map(item => [item.id, item]))
  const medicationIds = new Set(content.catalog.medications.map(item => item.id))
  const patientIds = new Set(content.patients.map(patient => patient.id))
  const hiddenFactCodes = new Set(content.hiddenFacts.map(fact => fact.code))

  const add = (diagnostic: ScenarioDiagnostic): void => {
    diagnostics.push(diagnostic)
  }

  for (const [index, lot] of content.inventory.entries()) {
    if (!medicationIds.has(lot.itemId)) {
      add({
        code: 'CATALOG_REFERENCE_MISSING',
        message: `Inventory item ${lot.itemId} does not reference a medication catalog item`,
        path: `inventory[${index}].itemId`,
        severity: 'error',
      })
    }
  }

  for (const [medicationIndex, medication] of content.catalog.medications.entries()) {
    const workflowPath = `catalog.medications[${medicationIndex}].workflow`
    for (const [combinationIndex, combinationId] of medication.workflow.allowedCombinationIds.entries()) {
      if (!medicationIds.has(combinationId)) {
        add({
          code: 'MEDICATION_COMBINATION_REFERENCE_MISSING',
          message: `Medication ${medication.id} allows an unknown combination medication`,
          path: `${workflowPath}.allowedCombinationIds[${combinationIndex}]`,
          severity: 'error',
        })
      }
    }
    for (const [diagnosisIndex, diagnosisCode] of medication.workflow.allowedDiagnosisCodes.entries()) {
      if (!diagnosisCodes.has(diagnosisCode)) {
        add({
          code: 'MEDICATION_DIAGNOSIS_REFERENCE_MISSING',
          message: `Medication ${medication.id} allows an unknown diagnosis code`,
          path: `${workflowPath}.allowedDiagnosisCodes[${diagnosisIndex}]`,
          severity: 'error',
        })
      }
    }
  }

  for (const [index, fact] of content.hiddenFacts.entries()) {
    if (fact.patientId !== undefined && !patientIds.has(fact.patientId)) {
      add({
        code: 'PATIENT_REFERENCE_MISSING',
        message: `Hidden Fact ${fact.code} references an unknown patient`,
        path: `hiddenFacts[${index}].patientId`,
        severity: 'error',
      })
    }
  }

  for (const [index, policy] of content.revealPolicies.entries()) {
    if (!hiddenFactCodes.has(policy.factCode)) {
      add({
        code: 'HIDDEN_FACT_REFERENCE_MISSING',
        message: `Reveal Policy ${policy.code} references an unknown Hidden Fact`,
        path: `revealPolicies[${index}].factCode`,
        severity: 'error',
      })
    }
    if (policy.patientId !== undefined && !patientIds.has(policy.patientId)) {
      add({
        code: 'PATIENT_REFERENCE_MISSING',
        message: `Reveal Policy ${policy.code} references an unknown patient`,
        path: `revealPolicies[${index}].patientId`,
        severity: 'error',
      })
    }
  }

  for (const [patientIndex, patient] of content.patients.entries()) {
    const patientPath = `patients[${patientIndex}]`
    const encounterIds = new Set(patient.fhirHistory.flatMap(resource => (
      resource.resourceType === 'Encounter' ? [resource.id] : []
    )))
    const diagnoses = [
      { diagnosis: patient.diagnosisSpace.primary, path: `${patientPath}.diagnosisSpace.primary.code` },
      ...patient.diagnosisSpace.comorbidities.map((diagnosis, index) => ({
        diagnosis,
        path: `${patientPath}.diagnosisSpace.comorbidities[${index}].code`,
      })),
      ...patient.diagnosisSpace.differentials.map((diagnosis, index) => ({
        diagnosis,
        path: `${patientPath}.diagnosisSpace.differentials[${index}].code`,
      })),
    ]
    for (const { diagnosis, path } of diagnoses) {
      if (diagnosis.code !== null && !diagnosisCodes.has(diagnosis.code)) {
        add({
          code: 'DIAGNOSIS_CATALOG_REFERENCE_MISSING',
          message: `Diagnosis ${diagnosis.id} has no diagnosis catalog entry`,
          path,
          severity: 'error',
        })
      }
    }

    for (const [historyIndex, event] of patient.longitudinalHistory.entries()) {
      const historyPath = `${patientPath}.longitudinalHistory[${historyIndex}]`
      if (event.mappedCode === null) {
        add({
          code: 'CLINICAL_CODE_UNMAPPED',
          message: `${event.sourceResourceType}/${event.sourceResourceId} has no ClinMesh mapping`,
          path: `${historyPath}.mappedCode`,
          severity: 'warning',
        })
      }
      if (event.endedAt !== undefined && event.endedAt < event.occurredAt) {
        add({
          code: 'CLINICAL_TIME_INVERTED',
          message: `History event ${event.id} ends before it starts`,
          path: `${historyPath}.endedAt`,
          severity: 'error',
        })
      }
    }

    for (const [historyIndex, resource] of patient.fhirHistory.entries()) {
      const historyPath = `${patientPath}.fhirHistory[${historyIndex}]`
      if ('encounterId' in resource
        && resource.encounterId !== undefined
        && !encounterIds.has(resource.encounterId)) {
        add({
          code: 'FHIR_HISTORY_REFERENCE_MISSING',
          message: `${resource.resourceType}/${resource.id} references an unknown Encounter`,
          path: `${historyPath}.encounterId`,
          severity: 'error',
        })
      }
      if (resource.resourceType === 'Encounter'
        && resource.period.end !== undefined
        && resource.period.end < resource.period.start) {
        add({
          code: 'CLINICAL_TIME_INVERTED',
          message: `Encounter/${resource.id} ends before it starts`,
          path: `${historyPath}.period.end`,
          severity: 'error',
        })
      }
    }

    for (const [investigationIndex, investigation] of patient.investigations.entries()) {
      const investigationPath = `${patientPath}.investigations[${investigationIndex}]`
      const catalogItem = investigationCatalog.get(investigation.catalogItemId)
      if (catalogItem === undefined) {
        add({
          code: 'CATALOG_REFERENCE_MISSING',
          message: `Investigation ${investigation.id} references an unknown catalog item`,
          path: `${investigationPath}.catalogItemId`,
          severity: 'error',
        })
        continue
      }
      if (investigation.result.outcome === 'catalog-boundary' && catalogItem.available) {
        add({
          code: 'INVESTIGATION_CATALOG_CONFLICT',
          message: `Available catalog item ${catalogItem.id} cannot return a catalog boundary`,
          path: `${investigationPath}.result.outcome`,
          severity: 'error',
        })
      }
      if (investigation.result.outcome !== 'reported' && investigation.critical) {
        add({
          code: 'INVESTIGATION_CRITICAL_CONFLICT',
          message: `Investigation ${investigation.id} cannot be critical without a reportable result`,
          path: `${investigationPath}.critical`,
          severity: 'error',
        })
      }
      if (investigation.sourceLevel === 'L3' && investigation.critical) {
        add({
          code: 'INVESTIGATION_L3_CRITICAL',
          message: `L3 investigation ${investigation.id} cannot produce a critical value`,
          path: `${investigationPath}.critical`,
          severity: 'error',
        })
      }
    }

    const [reasonableMinimum, reasonableMaximum] = patient.costBaseline.reasonableRangeFen
    if (reasonableMinimum > reasonableMaximum) {
      add({
        code: 'COST_RANGE_INVERTED',
        message: 'The reasonable cost minimum exceeds the maximum',
        path: `${patientPath}.costBaseline.reasonableRangeFen`,
        severity: 'error',
      })
    }
    const vitalSigns = patient.physiologyBaseline.vitalSigns
    if (vitalSigns.systolicMmHg !== undefined
      && vitalSigns.diastolicMmHg !== undefined
      && vitalSigns.systolicMmHg <= vitalSigns.diastolicMmHg) {
      add({
        code: 'PHYSIOLOGY_BLOOD_PRESSURE_INVALID',
        message: 'Systolic blood pressure must exceed diastolic blood pressure',
        path: `${patientPath}.physiologyBaseline.vitalSigns.systolicMmHg`,
        severity: 'error',
      })
    }
  }

  return diagnostics.sort((left, right) => (
    left.path.localeCompare(right.path) || left.code.localeCompare(right.code)
  ))
}
