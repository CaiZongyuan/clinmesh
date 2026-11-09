import { z } from 'zod'
import { resolveClinicalHistoryRequirements } from '@clinmesh/core/clinical-document'
import type { FhirResource } from '@clinmesh/contracts/fhir'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { ActorContext } from './command-executor.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'

export const clinicalVisitKindSystem = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/clinical-visit-kind'
const typesSchema = z.array(z.object({ coding: z.array(z.object({ system: z.string().optional(), code: z.string().optional() }).loose()).optional() }).loose())

export function clinicalVisitTypes(encounter: FhirResource) {
  return typesSchema.parse(encounter.type ?? [])
}

export function readClinicalHistoryContext(database: ClinMeshDatabase, context: ActorContext, caseId: string, patient: FhirResource, encounter: FhirResource) {
  const row = z.object({ department_code: z.string().nullable(), visit_date: z.string().nullable() }).parse(database.driver.prepare(`
    SELECT department.code AS department_code, registration.visit_date
    FROM outpatient_case AS clinical_case
    LEFT JOIN outpatient_catalog AS department ON department.workspace_id = clinical_case.workspace_id
      AND department.epoch = clinical_case.epoch AND department.item_id = clinical_case.department_id AND department.kind = 'department'
    LEFT JOIN registration ON registration.workspace_id = clinical_case.workspace_id
      AND registration.epoch = clinical_case.epoch AND registration.registration_id = clinical_case.registration_id
    WHERE clinical_case.workspace_id = ? AND clinical_case.epoch = ? AND clinical_case.case_id = ?
  `).get(context.workspaceId, context.epoch, caseId))
  const demographics = z.object({ gender: z.string().optional(), birthDate: z.string().optional() }).parse(patient)
  const kinds = clinicalVisitTypes(encounter).flatMap(type => type.coding ?? []).filter(coding => coding.system === clinicalVisitKindSystem)
  const code = kinds.length === 1 ? kinds[0]?.code : undefined
  const visitKind = code === 'initial' || code === 'follow-up' ? code : 'unknown'
  const input = { ...demographics, visitDate: row.visit_date ?? undefined, departmentCode: row.department_code ?? undefined, visitKind } as const
  const requirements = resolveClinicalHistoryRequirements(input)
  return { requirements, fingerprint: canonicalJsonHash({ input, patientVersion: patient.meta?.versionId, policyVersion: requirements.policyVersion }) }
}
