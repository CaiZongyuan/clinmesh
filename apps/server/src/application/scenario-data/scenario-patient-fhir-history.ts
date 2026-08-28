import { createHash } from 'node:crypto'
import type { FhirResource } from '@clinmesh/contracts/fhir'
import type { ScenarioPatient } from '@clinmesh/contracts/scenario'
import type { FhirRepository, RepositoryContext } from '../../infrastructure/sqlite/fhir-repository.ts'

export function namespacedHistoryResourceId(patientId: string, sourceId: string): string {
  return `history-${createHash('sha256').update(`${patientId}:${sourceId}`).digest('hex').slice(0, 40)}`
}

export function materializeScenarioPatientFhirHistory(input: {
  context: RepositoryContext
  fhir: Pick<FhirRepository, 'create'>
  history: ScenarioPatient['fhirHistory']
  patientId: string
  resourceId?: (sourceId: string) => string
}): FhirResource[] {
  const resourceId = input.resourceId ?? (sourceId => sourceId)
  const created: FhirResource[] = []
  for (const resource of input.history) {
    if (resource.resourceType !== 'Encounter') continue
    created.push(input.fhir.create(input.context, {
      actualPeriod: resource.period,
      class: [{
        coding: [{
          code: resource.classCode,
          display: 'ambulatory',
          system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
        }],
      }],
      id: resourceId(resource.id),
      resourceType: resource.resourceType,
      serviceProvider: { reference: 'Organization/organization-clinmesh' },
      status: resource.status,
      subject: { reference: `Patient/${input.patientId}` },
    }))
  }
  for (const resource of input.history) {
    if (resource.resourceType === 'Encounter') continue
    const encounter = 'encounterId' in resource && resource.encounterId !== undefined
      ? { encounter: { reference: `Encounter/${resourceId(resource.encounterId)}` } }
      : {}
    if (resource.resourceType === 'Condition') {
      created.push(input.fhir.create(input.context, {
        clinicalStatus: {
          coding: [{
            code: resource.clinicalStatus,
            system: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
          }],
        },
        code: {
          ...(resource.code.code === undefined
            ? {}
            : {
                coding: [{
                  code: resource.code.code,
                  display: resource.code.display,
                  ...(resource.code.system === undefined ? {} : { system: resource.code.system }),
                  ...(resource.code.version === undefined ? {} : { version: resource.code.version }),
                }],
              }),
          text: resource.code.display,
        },
        ...encounter,
        id: resourceId(resource.id),
        ...(resource.onsetDateTime === undefined ? {} : { onsetDateTime: resource.onsetDateTime }),
        ...(resource.recordedDate === undefined ? {} : { recordedDate: resource.recordedDate }),
        resourceType: resource.resourceType,
        subject: { reference: `Patient/${input.patientId}` },
      }))
      continue
    }
    if (resource.resourceType === 'Observation') {
      const result = resource.value.outcome === 'reported'
        ? typeof resource.value.value === 'number'
          ? {
              valueQuantity: {
                ...(resource.value.unit === undefined ? {} : {
                  code: resource.value.unit.code,
                  system: resource.value.unit.system,
                  unit: resource.value.unit.display,
                }),
                value: resource.value.value,
              },
            }
          : typeof resource.value.value === 'boolean'
            ? { valueBoolean: resource.value.value }
            : { valueString: resource.value.value }
        : { valueString: resource.value.message }
      created.push(input.fhir.create(input.context, {
        code: {
          ...(resource.code.code === undefined
            ? {}
            : {
                coding: [{
                  code: resource.code.code,
                  display: resource.code.display,
                  ...(resource.code.system === undefined ? {} : { system: resource.code.system }),
                  ...(resource.code.version === undefined ? {} : { version: resource.code.version }),
                }],
              }),
          text: resource.code.display,
        },
        ...(resource.effectiveDateTime === undefined ? {} : { effectiveDateTime: resource.effectiveDateTime }),
        ...encounter,
        id: resourceId(resource.id),
        ...(resource.value.outcome !== 'reported' || resource.value.flag === undefined
          ? {}
          : {
              interpretation: [{
                coding: [{
                  code: resource.value.flag,
                  system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
                }],
              }],
            }),
        resourceType: resource.resourceType,
        status: resource.status,
        subject: { reference: `Patient/${input.patientId}` },
        ...result,
      }))
      continue
    }
    if (resource.resourceType === 'MedicationRequest') {
      const medicationCodings = 'sourceCodings' in resource.medication
        ? resource.medication.sourceCodings
        : resource.medication.code === undefined
          ? []
          : [resource.medication]
      created.push(input.fhir.create(input.context, {
        ...(resource.authoredOn === undefined ? {} : { authoredOn: resource.authoredOn }),
        ...encounter,
        id: resourceId(resource.id),
        intent: resource.intent,
        medication: {
          concept: {
            ...(medicationCodings.length === 0
              ? {}
              : {
                  coding: medicationCodings.map(coding => ({
                    code: coding.code,
                    display: coding.display,
                    ...(coding.system === undefined ? {} : { system: coding.system }),
                    ...(coding.version === undefined ? {} : { version: coding.version }),
                  })),
                }),
            text: resource.medication.display,
          },
        },
        resourceType: resource.resourceType,
        status: resource.status,
        subject: { reference: `Patient/${input.patientId}` },
      }))
      continue
    }
    created.push(input.fhir.create(input.context, {
      clinicalStatus: {
        coding: [{
          code: resource.clinicalStatus,
          system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical',
        }],
      },
      code: {
        ...(resource.code.code === undefined
          ? {}
          : {
              coding: [{
                code: resource.code.code,
                display: resource.code.display,
                ...(resource.code.system === undefined ? {} : { system: resource.code.system }),
              }],
            }),
        text: resource.code.display,
      },
      id: resourceId(resource.id),
      patient: { reference: `Patient/${input.patientId}` },
      ...(resource.recordedDate === undefined ? {} : { recordedDate: resource.recordedDate }),
      resourceType: resource.resourceType,
    }))
  }
  return created
}
