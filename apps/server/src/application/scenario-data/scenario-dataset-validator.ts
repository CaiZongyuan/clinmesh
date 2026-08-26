import type {
  ScenarioDatasetContent,
  ScenarioDiagnostic,
} from '@clinmesh/contracts/scenario'

function graphReaches(
  currentId: string,
  targetId: string,
  children: (id: string) => readonly string[],
  visited = new Set<string>(),
): boolean {
  if (currentId === targetId) return true
  if (visited.has(currentId)) return false
  visited.add(currentId)
  return children(currentId).some(child => graphReaches(child, targetId, children, visited))
}

export function validateScenarioDataset(content: ScenarioDatasetContent): ScenarioDiagnostic[] {
  const diagnostics: ScenarioDiagnostic[] = []
  const diagnosisCodes = new Set(content.catalog.diagnoses.map(item => item.code))
  const investigationCatalog = new Map(content.catalog.investigations.map(item => [item.id, item]))
  const medicationIds = new Set(content.catalog.medications.map(item => item.id))
  const patientIds = new Set(content.patients.map(patient => patient.id))
  const patientsById = new Map(content.patients.map(patient => [patient.id, patient]))
  const hiddenFactCodes = new Set(content.hiddenFacts.map(fact => fact.code))
  const hiddenFactsByCode = new Map(content.hiddenFacts.map(fact => [fact.code, fact]))
  const vitalSignKeys = new Set([
    'diastolicMmHg',
    'heightCm',
    'oxygenSaturationPct',
    'pulseBpm',
    'respirationBpm',
    'systolicMmHg',
    'temperatureC',
    'weightKg',
  ])

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

  for (const [investigationIndex, investigation] of content.catalog.investigations.entries()) {
    const distribution = investigation.normalDistribution
    if (distribution !== undefined) {
      const numericRanges = investigation.referenceRanges.filter(range => (
        range.minimum !== undefined || range.maximum !== undefined
      ))
      const outsideReferenceRange = numericRanges.length === 0 || numericRanges.some(range => (
        (range.minimum !== undefined && distribution.minimum < range.minimum)
        || (range.maximum !== undefined && distribution.maximum > range.maximum)
      ))
      if (outsideReferenceRange) {
        add({
          code: 'INVESTIGATION_L3_REFERENCE_CONFLICT',
          message: `Investigation ${investigation.id} has an L3 domain outside its reference range`,
          path: `catalog.investigations[${investigationIndex}].normalDistribution`,
          severity: 'error',
        })
      }
    }
    for (const [componentIndex, componentItemId] of investigation.componentItemIds?.entries() ?? []) {
      if (!investigationCatalog.has(componentItemId)) {
        add({
          code: 'INVESTIGATION_COMPONENT_REFERENCE_MISSING',
          message: `Investigation ${investigation.id} references an unknown component`,
          path: `catalog.investigations[${investigationIndex}].componentItemIds[${componentIndex}]`,
          severity: 'error',
        })
        continue
      }
      if (graphReaches(
        componentItemId,
        investigation.id,
        id => investigationCatalog.get(id)?.componentItemIds ?? [],
      )) {
        add({
          code: 'INVESTIGATION_COMPONENT_CYCLE',
          message: `Investigation ${investigation.id} has a cyclic component reference`,
          path: `catalog.investigations[${investigationIndex}].componentItemIds[${componentIndex}]`,
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
    if (policy.triggerCode === 'after-topic') {
      const patient = policy.patientId === undefined ? undefined : patientsById.get(policy.patientId)
      if (patient === undefined) {
        add({
          code: 'REVEAL_TOPIC_PATIENT_REQUIRED',
          message: `Reveal Policy ${policy.code} must bind an existing patient for an after-topic trigger`,
          path: `revealPolicies[${index}].patientId`,
          severity: 'error',
        })
      }
      if (
        policy.triggerId === undefined
        || patient?.symptomResponses.some(response => response.id === policy.triggerId) !== true
      ) {
        add({
          code: 'REVEAL_TOPIC_REFERENCE_MISSING',
          message: `Reveal Policy ${policy.code} must reference a symptom-response topic for its patient`,
          path: `revealPolicies[${index}].triggerId`,
          severity: 'error',
        })
      }
      if (typeof hiddenFactsByCode.get(policy.factCode)?.value !== 'string') {
        add({
          code: 'REVEAL_TOPIC_VALUE_INVALID',
          message: `Reveal Policy ${policy.code} requires a string Hidden Fact for a patient answer`,
          path: `hiddenFacts[${content.hiddenFacts.findIndex(fact => fact.code === policy.factCode)}].value`,
          severity: 'error',
        })
      }
    }
  }

  for (const [patientIndex, patient] of content.patients.entries()) {
    const patientPath = `patients[${patientIndex}]`
    const generatorIds = new Set(patient.physiologyBaseline.generators.map(generator => generator.id))
    const generators = new Map(
      patient.physiologyBaseline.generators.map(generator => [generator.id, generator]),
    )
    for (const [investigationIndex, investigation] of content.catalog.investigations.entries()) {
      if (
        investigation.physiologyGeneratorId !== undefined
        && !generatorIds.has(investigation.physiologyGeneratorId)
      ) {
        add({
          code: 'PHYSIOLOGY_GENERATOR_REFERENCE_MISSING',
          message: `Investigation ${investigation.id} references a physiology generator missing from patient ${patient.id}`,
          path: `catalog.investigations[${investigationIndex}].physiologyGeneratorId`,
          severity: 'error',
        })
      }
    }
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

    for (const [generatorIndex, generator] of patient.physiologyBaseline.generators.entries()) {
      if (generator.kind !== 'derived') continue
      for (const [dependencyIndex, dependency] of generator.dependencies.entries()) {
        const missing = dependency.startsWith('vital:')
          ? !vitalSignKeys.has(dependency.slice('vital:'.length))
          : !generatorIds.has(dependency)
        if (missing) {
          add({
            code: 'PHYSIOLOGY_DEPENDENCY_MISSING',
            message: `Physiology generator ${generator.id} references an unknown dependency`,
            path: `${patientPath}.physiologyBaseline.generators[${generatorIndex}].dependencies[${dependencyIndex}]`,
            severity: 'error',
          })
          continue
        }
        if (!dependency.startsWith('vital:') && graphReaches(
          dependency,
          generator.id,
          id => {
            const candidate = generators.get(id)
            return candidate?.kind === 'derived'
              ? candidate.dependencies.filter(value => !value.startsWith('vital:'))
              : []
          },
        )) {
          add({
            code: 'PHYSIOLOGY_DEPENDENCY_CYCLE',
            message: `Physiology generator ${generator.id} has a cyclic dependency`,
            path: `${patientPath}.physiologyBaseline.generators[${generatorIndex}].dependencies[${dependencyIndex}]`,
            severity: 'error',
          })
        }
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
      if (investigation.feeFen !== catalogItem.priceFen) {
        add({
          code: 'INVESTIGATION_FEE_CONFLICT',
          message: `Investigation ${investigation.id} fee differs from catalog item ${catalogItem.id}`,
          path: `${investigationPath}.feeFen`,
          severity: 'error',
        })
      }
      if (investigation.tatMinutes !== catalogItem.tatMinutes) {
        add({
          code: 'INVESTIGATION_TAT_CONFLICT',
          message: `Investigation ${investigation.id} TAT differs from catalog item ${catalogItem.id}`,
          path: `${investigationPath}.tatMinutes`,
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
      if (investigation.result.outcome === 'reported') {
        const resultValue = investigation.result.value
        const expectedCritical = typeof resultValue === 'number' && (
          (catalogItem.criticalMinimum !== undefined && resultValue < catalogItem.criticalMinimum)
          || (catalogItem.criticalMaximum !== undefined && resultValue > catalogItem.criticalMaximum)
        )
        if (investigation.critical !== expectedCritical) {
          add({
            code: 'INVESTIGATION_CRITICAL_THRESHOLD_CONFLICT',
            message: `Investigation ${investigation.id} critical flag differs from catalog thresholds`,
            path: `${investigationPath}.critical`,
            severity: 'error',
          })
        }
      }
      if (investigation.sourceLevel !== 'L1') {
        add({
          code: 'INVESTIGATION_EXACT_SOURCE_INVALID',
          message: `Exact investigation ${investigation.id} must use L1 source truth`,
          path: `${investigationPath}.sourceLevel`,
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
