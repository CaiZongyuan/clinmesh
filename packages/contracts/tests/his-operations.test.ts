import { describe, expect, it } from 'vitest'
import {
  excludedHisRoutes,
  getHisOperation,
  type HisOperationDefinition,
  listHisOperations,
  matchHisOperation,
} from '@clinmesh/contracts/his-operations'
import { createAgentCapabilityGrantInputSchema } from '@clinmesh/contracts/agent'

const clinicalDocumentOperationIds = {
  draftSet: `encounter.clinical-${'document'}.draft.set`,
  previewSign: `encounter.clinical-${'document'}.sign.preview`,
  revise: `clinical-${'document'}.revise`,
  saveDraft: `clinical-${'document'}.save-draft`,
  sign: `encounter.clinical-${'document'}.sign`,
  storedPreviewSign: `clinical-${'document'}.preview-sign`,
  storedSign: `clinical-${'document'}.sign`,
} as const

describe('HIS operation catalog', () => {
  it('publishes correlation IDs in the shared structured error contract', () => {
    const error = getHisOperation('patient.create').error.parse({
      code: 'ambiguous_outcome',
      correlationId: '01991234-7abc-7def-8abc-0123456789ab',
      message: 'Inspect the Command receipt before retrying',
      operationId: 'patient.create',
      outcome: 'ambiguous',
      retryable: false,
      type: 'api',
    })

    expect(error.correlationId).toBe('01991234-7abc-7def-8abc-0123456789ab')
    expect(() => getHisOperation('patient.create').error.parse({
      ...error,
      correlationId: 'untrusted-correlation',
    })).toThrow()
  })

  it('describes source and panel filters for Laboratory Service candidates', () => {
    const operation = getHisOperation('admin.laboratory-services.candidates.search')

    expect(operation).toMatchObject({
      cliPath: ['admin', 'laboratory-services', 'candidates', 'search'],
      version: 2,
    })
    expect(operation.input.parse({
      page: 1,
      pageSize: 20,
      panelOnly: true,
      sourceDataset: 'laboratory-cn',
    })).toEqual({
      page: 1,
      pageSize: 20,
      panelOnly: true,
      sourceDataset: 'laboratory-cn',
    })
  })

  it('describes diagnosis reference search through one stable operation interface', () => {
    const operation: HisOperationDefinition = getHisOperation('reference.diagnoses.search')

    expect(operation).toMatchObject({
      cliPath: ['reference', 'diagnoses', 'search'],
      http: {
        method: 'GET',
        path: '/api/his/v1/reference-catalogs/diagnoses',
      },
      id: 'reference.diagnoses.search',
      mode: 'query',
      roles: ['administrator', 'outpatient-doctor'],
      version: 1,
    })
    expect(operation.input.parse({ page: 1, pageSize: 20, query: '糖尿病' })).toEqual({
      page: 1,
      pageSize: 20,
      query: '糖尿病',
    })
    expect(() => getHisOperation('reference.diagnoses.missing')).toThrowError(
      'Unknown HIS operation: reference.diagnoses.missing',
    )
  })

  it('publishes every canonical reference and hospital catalog query', () => {
    expect(listHisOperations()
      .filter(operation => ['catalog', 'reference'].includes(operation.cliPath[0]))
      .map(operation => ({
        cliPath: operation.cliPath.join(' '),
        id: operation.id,
        roles: operation.roles,
      }))).toEqual([
      {
        cliPath: 'reference diagnoses search',
        id: 'reference.diagnoses.search',
        roles: ['administrator', 'outpatient-doctor'],
      },
      {
        cliPath: 'reference medications search',
        id: 'reference.medications.search',
        roles: ['administrator', 'outpatient-doctor'],
      },
      {
        cliPath: 'reference laboratory search',
        id: 'reference.laboratory.search',
        roles: ['administrator', 'outpatient-doctor'],
      },
      {
        cliPath: 'catalog registration get',
        id: 'catalog.registration.read',
        roles: ['administrator', 'registrar'],
      },
      {
        cliPath: 'catalog clinical get',
        id: 'catalog.clinical.read',
        roles: ['outpatient-doctor'],
      },
      {
        cliPath: 'catalog services search',
        id: 'catalog.services.search',
        roles: ['administrator', 'outpatient-doctor'],
      },
    ])
  })

  it('publishes the complete registration workflow without legacy virtual-patient commands', () => {
    const registrationOperations = listHisOperations()
      .filter(operation => ['patient', 'registration'].includes(operation.cliPath[0]))
      .map(operation => ({
        id: operation.id,
        mode: operation.mode,
        requirements: operation.requirements,
        risk: operation.risk,
        roles: operation.roles,
      }))

    expect(registrationOperations).toEqual([
      {
        id: 'patient.search',
        mode: 'query',
        requirements: { expectedVersions: false, idempotency: 'none' },
        risk: 'read',
        roles: ['cashier', 'outpatient-doctor', 'pharmacist', 'registrar', 'triage-nurse'],
      },
      {
        id: 'patient.create',
        mode: 'command',
        requirements: { expectedVersions: false, idempotency: 'required' },
        risk: 'write',
        roles: ['registrar'],
      },
      {
        id: 'registration.list',
        mode: 'query',
        requirements: { expectedVersions: false, idempotency: 'none' },
        risk: 'read',
        roles: ['registrar'],
      },
      {
        id: 'registration.create',
        mode: 'command',
        requirements: { expectedVersions: true, idempotency: 'required' },
        risk: 'write',
        roles: ['registrar'],
      },
      {
        id: 'registration.synthetic-case.start',
        mode: 'command',
        requirements: { expectedVersions: true, idempotency: 'required' },
        risk: 'write',
        roles: ['administrator', 'registrar'],
      },
    ])
    expect(listHisOperations().some(operation => operation.id.includes('virtual-patient'))).toBe(false)
  })

  it('publishes the triage queue and version-protected triage command', () => {
    expect(listHisOperations()
      .filter(operation => operation.cliPath[0] === 'triage')
      .map(operation => ({
        id: operation.id,
        mode: operation.mode,
        requirements: operation.requirements,
        roles: operation.roles,
      }))).toEqual([
      {
        id: 'triage.queue.list',
        mode: 'query',
        requirements: { expectedVersions: false, idempotency: 'none' },
        roles: ['triage-nurse'],
      },
      {
        id: 'triage.record',
        mode: 'command',
        requirements: { expectedVersions: true, idempotency: 'required' },
        roles: ['triage-nurse'],
      },
    ])
  })

  it('separates doctor reads, consultation writes, completion preview, and completion command', () => {
    const ids = [
      'doctor.queue.list',
      'doctor.completed-cases.list',
      'doctor.completed-cases.get',
      'doctor.case.get',
      'doctor.case.laboratory-catalog.search',
      'encounter.consultation.ask',
      'encounter.completion.preview',
      'encounter.complete',
    ]
    expect(ids.map(id => {
      const operation = getHisOperation(id)
      return {
        id: operation.id,
        mode: operation.mode,
        risk: operation.risk,
        roles: operation.roles,
      }
    })).toEqual([
      { id: 'doctor.queue.list', mode: 'query', risk: 'read', roles: ['outpatient-doctor'] },
      { id: 'doctor.completed-cases.list', mode: 'query', risk: 'read', roles: ['outpatient-doctor'] },
      { id: 'doctor.completed-cases.get', mode: 'query', risk: 'read', roles: ['outpatient-doctor'] },
      { id: 'doctor.case.get', mode: 'query', risk: 'read', roles: ['outpatient-doctor'] },
      {
        id: 'doctor.case.laboratory-catalog.search',
        mode: 'query',
        risk: 'read',
        roles: ['outpatient-doctor'],
      },
      { id: 'encounter.consultation.ask', mode: 'command', risk: 'write', roles: ['outpatient-doctor'] },
      { id: 'encounter.completion.preview', mode: 'preview', risk: 'read', roles: ['outpatient-doctor'] },
      { id: 'encounter.complete', mode: 'command', risk: 'high-risk-write', roles: ['outpatient-doctor'] },
    ])
    expect(getHisOperation('doctor.completed-cases.list').input.parse({
      diagnosisCatalogItemId: 'diagnosis:hypertension',
      page: 1,
      pageSize: 20,
    })).toMatchObject({ diagnosisCatalogItemId: 'diagnosis:hypertension' })
  })

  it('publishes the case-scoped Hospital Laboratory Service catalog', () => {
    const operation = getHisOperation('doctor.case.laboratory-catalog.search')
    expect(operation).toMatchObject({
      cliPath: ['doctor', 'case', 'laboratory-catalog', 'search'],
      handlerOwner: 'WorkflowService',
      http: {
        method: 'GET',
        path: '/api/his/v1/doctor/cases/:caseId/reference-catalogs/laboratory',
      },
      skill: 'clinmesh-doctor',
    })
    expect(operation.input.parse({
      caseId: 'case-1',
      page: 2,
      pageSize: 20,
      query: '血常规',
    })).toEqual({
      caseId: 'case-1',
      page: 2,
      pageSize: 20,
      query: '血常规',
    })
    expect(operation.output.parse({
      items: [{
        allowedIndicationCodes: ['clinical-evaluation'],
        componentServiceIds: [],
        doctorOrderable: true,
        executingDepartmentId: 'department-laboratory',
        id: 'hospital-laboratory-service-wbc',
        localCode: 'CM-LAB-6690-2',
        nameEn: 'White blood cell count',
        nameZh: '白细胞计数',
        priceFen: 800,
        referenceConcept: {
          code: '6690-2',
          display: '白细胞计数',
          id: 'loinc:synthetic:6690-2',
          sourceLocator: 'concepts[0]',
          system: 'http://loinc.org',
          version: '2.83',
        },
        referenceReleaseId: 'reference-release-current',
        reportDefinition: {
          conclusionTemplate: '白细胞计数结果已完成。',
          results: [{
            referenceConcept: {
              code: '6690-2',
              display: '白细胞计数',
              id: 'loinc:synthetic:6690-2',
              sourceLocator: 'concepts[0]',
              system: 'http://loinc.org',
              version: '2.83',
            },
            referenceRange: { high: 10, low: 4, text: '4.0-10.0 x10^9/L' },
            unit: {
              code: '10*9/L',
              display: '10*9/L',
              system: 'http://unitsofmeasure.org',
            },
            valueType: 'quantity',
          }],
        },
        specimen: { code: 'LP7057-5', display: '血液' },
        serviceKind: 'laboratory',
        tatMinutes: 20,
        version: 1,
      }],
      page: 2,
      pageSize: 20,
      total: 21,
    })).toMatchObject({
      items: [{
        id: 'hospital-laboratory-service-wbc',
        referenceConcept: { code: '6690-2' },
      }],
    })
  })

  it('rejects unknown operation IDs at the Agent Grant contract boundary', () => {
    expect(createAgentCapabilityGrantInputSchema.safeParse({
      agentClientId: '11111111-1111-4111-8111-111111111111',
      operationIds: ['missing.operation'],
      practitionerRoleId: 'practitioner-role-outpatient-doctor',
      ttlSeconds: 3_600,
    }).success).toBe(false)
  })

  it('publishes only the independent diagnosis draft and confirmation lifecycle', () => {
    expect(['encounter.diagnosis.draft.set', 'encounter.diagnosis.confirm'].map(id => {
      const operation = getHisOperation(id)
      return {
        id: operation.id,
        mode: operation.mode,
        requirements: operation.requirements,
        risk: operation.risk,
      }
    })).toEqual([
      {
        id: 'encounter.diagnosis.draft.set',
        mode: 'draft',
        requirements: { expectedVersions: true, idempotency: 'required' },
        risk: 'write',
      },
      {
        id: 'encounter.diagnosis.confirm',
        mode: 'command',
        requirements: { expectedVersions: true, idempotency: 'required' },
        risk: 'high-risk-write',
      },
    ])
    expect(listHisOperations().some(operation => operation.id.includes('revisit'))).toBe(false)
  })

  it('publishes the independent prescription and medication conclusion lifecycle', () => {
    const expected = [
      ['encounter.prescription.draft.set', 'draft', 'write'],
      ['encounter.prescription.draft.delete', 'draft', 'write'],
      ['encounter.prescription.issue', 'command', 'high-risk-write'],
      ['encounter.medication-conclusion.confirm-none', 'command', 'high-risk-write'],
      ['prescription.withdraw', 'command', 'high-risk-write'],
    ]
    expect(expected.map(([id]) => {
      const operation = getHisOperation(id!)
      return [operation.id, operation.mode, operation.risk, operation.requirements]
    })).toEqual(expected.map(entry => [
      ...entry,
      { expectedVersions: true, idempotency: 'required' },
    ]))
  })

  it('publishes structured clinical document draft, preview, sign, and revision', () => {
    const expected = [
      [clinicalDocumentOperationIds.draftSet, 'draft', 'write'],
      [clinicalDocumentOperationIds.previewSign, 'preview', 'write'],
      [clinicalDocumentOperationIds.sign, 'command', 'high-risk-write'],
      [clinicalDocumentOperationIds.revise, 'command', 'high-risk-write'],
    ]
    expect(expected.map(([id]) => {
      const operation = getHisOperation(id!)
      return [operation.id, operation.mode, operation.risk, operation.requirements]
    })).toEqual(expected.map(entry => [
      ...entry,
      { expectedVersions: true, idempotency: 'required' },
    ]))
  })

  it('publishes the independent laboratory request and report lifecycle', () => {
    const expected = [
      ['encounter.laboratory-request.draft.set', 'draft', 'write', ['outpatient-doctor']],
      ['encounter.laboratory-request.draft.delete', 'draft', 'write', ['outpatient-doctor']],
      ['encounter.laboratory-request.issue', 'command', 'high-risk-write', ['outpatient-doctor']],
      ['laboratory-request.cancel', 'command', 'high-risk-write', ['outpatient-doctor']],
      ['laboratory-request.retry-generation', 'command', 'write', ['outpatient-doctor']],
      ['laboratory-report.acknowledge', 'command', 'write', ['outpatient-doctor']],
      ['laboratory-report.correct', 'command', 'high-risk-write', ['administrator']],
    ]
    expect(expected.map(([id]) => {
      const operation = getHisOperation(id as string)
      return [operation.id, operation.mode, operation.risk, operation.roles]
    })).toEqual(expected)
  })

  it('publishes version-protected Hospital Service order and completion commands', () => {
    expect(['service.order', 'service.complete'].map(id => {
      const operation = getHisOperation(id)
      return {
        id: operation.id,
        mode: operation.mode,
        requirements: operation.requirements,
        risk: operation.risk,
        roles: operation.roles,
      }
    })).toEqual([
      {
        id: 'service.order',
        mode: 'command',
        requirements: { expectedVersions: true, idempotency: 'required' },
        risk: 'high-risk-write',
        roles: ['outpatient-doctor'],
      },
      {
        id: 'service.complete',
        mode: 'command',
        requirements: { expectedVersions: true, idempotency: 'required' },
        risk: 'high-risk-write',
        roles: ['outpatient-doctor'],
      },
    ])
  })

  it('publishes cashier payment and pharmacist fulfillment operations', () => {
    const expected = [
      ['billing.queue.list', 'query', 'read', ['cashier']],
      ['payment.preview', 'preview', 'write', ['cashier']],
      ['payment.confirm', 'command', 'high-risk-write', ['cashier']],
      ['pharmacy.queue.list', 'query', 'read', ['pharmacist']],
      ['prescription.review', 'command', 'high-risk-write', ['pharmacist']],
      ['prescription.dispense', 'command', 'high-risk-write', ['pharmacist']],
    ]
    expect(expected.map(([id]) => {
      const operation = getHisOperation(id as string)
      return [operation.id, operation.mode, operation.risk, operation.roles]
    })).toEqual(expected)
  })

  it('publishes only the implemented FHIR R5 read surfaces', () => {
    const operations = listHisOperations().filter(operation => operation.cliPath[0] === 'fhir')
    expect(operations.map(operation => ({
      id: operation.id,
      method: operation.http.method,
      mode: operation.mode,
      risk: operation.risk,
    }))).toEqual([
      { id: 'fhir.metadata.read', method: 'GET', mode: 'query', risk: 'read' },
      { id: 'fhir.resource.read', method: 'GET', mode: 'query', risk: 'read' },
      { id: 'fhir.resource.vread', method: 'GET', mode: 'query', risk: 'read' },
      { id: 'fhir.resource.history', method: 'GET', mode: 'query', risk: 'read' },
      { id: 'fhir.resource.search', method: 'GET', mode: 'query', risk: 'read' },
    ])
    expect(operations.every(operation => operation.http.method === 'GET')).toBe(true)
  })

  it('accepts only declared FHIR search parameters for the selected resource type', () => {
    const operation = getHisOperation('fhir.resource.search')
    const input = {
      parameters: {
        _count: '20',
        _total: 'accurate',
        name: '合成患者',
      },
      resourceType: 'Patient',
    }

    expect(operation.input.parse(input)).toEqual(input)
    expect(operation.http.encodeQuery?.(input)).toEqual(input.parameters)
    expect(() => operation.input.parse({
      parameters: { name: 'not-a-condition-parameter' },
      resourceType: 'Condition',
    })).toThrow()
    expect(() => operation.input.parse({
      parameters: { arbitrary: 'value' },
      resourceType: 'Patient',
    })).toThrow()
  })

  it('matches every operation from its HTTP method and concrete pathname only', () => {
    for (const operation of listHisOperations()) {
      const pathname = operation.http.path.replaceAll(/:[A-Za-z][A-Za-z0-9]*/g, 'test-id')
      expect(matchHisOperation(operation.http.method, pathname)?.id).toBe(operation.id)
    }
    for (const route of excludedHisRoutes) {
      const pathname = route.path.replaceAll(/:[A-Za-z][A-Za-z0-9]*/g, 'test-id')
      expect(matchHisOperation(route.method, pathname)).toBeUndefined()
    }
    expect(matchHisOperation('POST', '/api/his/v1/arbitrary')).toBeUndefined()
  })

  it('publishes Actor-scoped Command receipt lookup for ambiguous recovery', () => {
    const operation = getHisOperation('command.receipt.get')
    expect(operation).toMatchObject({
      cliPath: ['command', 'receipt', 'get'],
      http: { method: 'GET', path: '/api/his/v1/command-receipts' },
      mode: 'query',
      requirements: { expectedVersions: false, idempotency: 'none' },
      risk: 'read',
    })
    const writes = listHisOperations().filter(candidate => (
      candidate.requirements.idempotency === 'required'
    ))
    expect(writes.every(candidate => candidate.commandOperation !== undefined)).toBe(true)
    expect(Object.fromEntries(writes
      .filter(candidate => candidate.commandOperation !== candidate.id)
      .map(candidate => [candidate.id, candidate.commandOperation]))).toEqual({
      'admin.laboratory-services.publish': 'laboratory-service-publication.create',
      [clinicalDocumentOperationIds.draftSet]: clinicalDocumentOperationIds.saveDraft,
      [clinicalDocumentOperationIds.previewSign]: clinicalDocumentOperationIds.storedPreviewSign,
      [clinicalDocumentOperationIds.sign]: clinicalDocumentOperationIds.storedSign,
      'encounter.consultation.ask': 'consultation.ask-question',
      'encounter.diagnosis.confirm': 'encounter.confirm-diagnosis',
      'encounter.diagnosis.draft.set': 'encounter.save-diagnosis-draft',
      'encounter.laboratory-request.draft.delete': 'laboratory-request.delete-draft',
      'encounter.laboratory-request.draft.set': 'laboratory-request.save-draft',
      'encounter.laboratory-request.issue': 'laboratory-request.issue',
      'encounter.medication-conclusion.confirm-none': 'encounter.confirm-no-medication',
      'encounter.prescription.draft.delete': 'encounter.delete-prescription-draft',
      'encounter.prescription.draft.set': 'encounter.save-prescription-draft',
      'encounter.prescription.issue': 'encounter.issue-prescription',
      'patient.create': 'patient.create-synthetic',
      'registration.create': 'registration.register',
      'registration.synthetic-case.start': 'synthetic-case.start-outpatient-visit',
      'service.complete': 'hospital-service.complete',
      'service.order': 'hospital-service.order',
      'triage.record': 'encounter.record-triage',
    })
  })

  it('assigns every operation to one discoverable Agent Skill', () => {
    const counts: Record<string, number> = {}
    for (const operation of listHisOperations()) {
      const skill = String(Reflect.get(operation, 'skill'))
      counts[skill] = (counts[skill] ?? 0) + 1
    }

    expect(counts).toEqual({
      'clinmesh-administrator': 3,
      'clinmesh-billing': 3,
      'clinmesh-doctor': 33,
      'clinmesh-fhir': 5,
      'clinmesh-pharmacy': 3,
      'clinmesh-registration': 6,
      'clinmesh-shared': 1,
      'clinmesh-triage': 2,
    })
  })

  it('publishes identity, error, preview, and server handler ownership metadata', () => {
    expect(listHisOperations().every(operation => (
      operation.identities.join(',') === 'agent,human'
      && operation.error.safeParse({
        code: 'example',
        message: 'Example error',
        outcome: 'definitely_not_sent',
        retryable: false,
        type: 'validation',
      }).success
    ))).toBe(true)
    expect(listHisOperations()
      .filter(operation => operation.previewToken === 'required')
      .map(operation => operation.id)).toEqual([
      clinicalDocumentOperationIds.sign,
      'payment.confirm',
    ])
    expect(getHisOperation('reference.diagnoses.search').handlerOwner).toBe('ReferenceDataService')
    expect(getHisOperation('registration.synthetic-case.start').handlerOwner)
      .toBe('SyntheticCaseVisitService')
    expect(getHisOperation('fhir.metadata.read').handlerOwner).toBe('FhirCapabilities')
    expect(getHisOperation('fhir.resource.search').handlerOwner).toBe('FhirRepository')
    expect(getHisOperation('patient.create').handlerOwner).toBe('WorkflowService')
  })
})
