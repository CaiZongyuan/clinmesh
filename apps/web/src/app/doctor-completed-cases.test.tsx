// @vitest-environment jsdom
import {
  clinicalCatalogSchema,
  doctorCompletedCaseDetailSchema,
  doctorCompletedCaseListSchema,
  type SessionContext,
} from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DoctorCompletedCaseLibrary } from './doctor-completed-cases.tsx'

const clients: QueryClient[] = []
afterEach(() => {
  cleanup()
  clients.splice(0).forEach(client => client.clear())
  vi.unstubAllGlobals()
})

const doctorSession: SessionContext = {
  actor: {
    actorId: 'actor-outpatient-doctor',
    epoch: 'epoch-1',
    locationId: 'location-clinic',
    organizationId: 'organization-clinmesh',
    practitionerId: 'practitioner-outpatient-doctor',
    practitionerRoleId: 'practitioner-role-outpatient-doctor',
    roleCode: 'outpatient-doctor',
    scenarioRunId: 'scenario-run-1',
    workspaceId: 'workspace-demo',
  },
  availableRoles: [{
    code: 'outpatient-doctor',
    id: 'practitioner-role-outpatient-doctor',
    locationId: 'location-clinic',
    organizationId: 'organization-clinmesh',
    practitionerId: 'practitioner-outpatient-doctor',
    practitionerName: '合成门诊医生',
  }],
  user: {
    email: 'doctor@demo.clinmesh.local',
    id: 'user-outpatient-doctor',
    name: '合成门诊医生',
  },
}

describe('DoctorCompletedCaseLibrary prescription check elements', () => {
  it('renders prescriber name, strength & package, Chinese frequency, and unit with catalog fallback', async () => {
    const patient = {
      birthDate: '1988-03-16',
      gender: 'female',
      id: 'patient-completed-rx-1',
      identifier: 'CM-SYN-COMPLETED-RX-001',
      name: '合成患者完诊查对',
      synthetic: true,
      versionId: '2',
    } as const
    const catalog = clinicalCatalogSchema.parse({
      diagnoses: [],
      laboratory: [],
      medications: [{
        allowedCombinationIds: [],
        allowedCourseDays: [3, 5],
        allowedDoseTexts: ['0.2 g'],
        allowedFrequencyCodes: ['PRN'],
        allowedQuantities: [24],
        defaultCourseDays: 3,
        defaultDoseText: '0.2 g',
        defaultFrequencyCode: 'PRN',
        defaultQuantity: 24,
        dosageForm: '片剂',
        id: 'medication-ibuprofen',
        nameEn: 'Ibuprofen tablets',
        nameZh: '布洛芬片',
        packageDescription: '24片/盒',
        priceFen: 1500,
        strength: '0.2 g',
        unit: '片',
        version: 1,
      }],
      prescriptionConclusionSupported: true,
    })
    const list = doctorCompletedCaseListSchema.parse({
      items: [{
        caseId: 'case-completed-rx-1',
        completedAt: '2026-08-24T09:00:00+08:00',
        encounterId: 'encounter-completed-rx-1',
        encounterVersion: '6',
        patient,
      }],
      page: 1,
      pageSize: 20,
      total: 1,
    })
    const detail = doctorCompletedCaseDetailSchema.parse({
      caseId: 'case-completed-rx-1',
      clinicalDocuments: [],
      completedAt: '2026-08-24T09:00:00+08:00',
      encounter: {
        id: 'encounter-completed-rx-1',
        status: 'completed',
        versionId: '6',
      },
      examinationRequests: [],
      imagingRequests: [],
      laboratoryRequests: [],
      medicationConclusion: {
        prescription: {
          authoredAt: '2026-08-24T08:35:00+08:00',
          authoredByName: '合成门诊医生',
          authoredByPractitionerRoleId: 'practitioner-role-outpatient-doctor',
          id: 'prescription-completed-rx-1',
          items: [
            {
              catalogItemId: 'medication-oseltamivir',
              courseDays: 5,
              display: '磷酸奥司他韦胶囊',
              doseText: '75 mg',
              frequencyCode: 'BID',
              medicationRequestId: 'medication-request-snapshot-1',
              medicationRequestVersion: '2',
              packageDescription: '10粒/盒',
              quantity: 10,
              strength: '75 mg',
              unit: '粒',
            },
            {
              catalogItemId: 'medication-ibuprofen',
              courseDays: 3,
              display: '布洛芬片',
              doseText: '0.2 g',
              frequencyCode: 'PRN',
              medicationRequestId: 'medication-request-legacy-2',
              medicationRequestVersion: '1',
              quantity: 24,
            },
          ],
          number: 'RX-COMPLETED-CHECK-001',
          status: 'paid',
          version: 2,
          withdrawalSupported: false,
        },
      },
      pathologyRequests: [],
      patient,
      timeline: [{
        kind: 'encounter-completed',
        occurredAt: '2026-08-24T09:00:00+08:00',
        reference: 'Encounter/encounter-completed-rx-1',
        relatedReferences: [],
      }],
    })

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/his/v1/catalogs/clinical') return Response.json(catalog)
      if (url.pathname === '/api/his/v1/doctor/completed-cases') return Response.json(list)
      if (url.pathname === '/api/his/v1/doctor/completed-cases/case-completed-rx-1') return Response.json(detail)
      throw new Error(`Unexpected completed-cases request: ${url.pathname}`)
    }))
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })

    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    clients.push(client)
    const user = userEvent.setup()
    render(
      <QueryClientProvider client={client}>
        <DoctorCompletedCaseLibrary
          locale="zh-CN"
          navigation={null}
          onOpenCorrection={() => {}}
          session={doctorSession}
        />
      </QueryClientProvider>,
    )

    await user.click(await screen.findByRole('button', { name: `查看病例 ${patient.name}` }))
    expect(await screen.findByText(/开方医生 合成门诊医生/)).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: '规格与包装' })).toBeTruthy()

    const snapshotRow = screen.getByText('磷酸奥司他韦胶囊').closest('tr')
    expect(snapshotRow).toBeTruthy()
    expect(within(snapshotRow!).getByText('75 mg · 10粒/盒')).toBeTruthy()
    expect(within(snapshotRow!).getByText('每日两次（BID）')).toBeTruthy()
    expect(within(snapshotRow!).getByText('10 粒')).toBeTruthy()

    const fallbackRow = screen.getByText('布洛芬片').closest('tr')
    expect(fallbackRow).toBeTruthy()
    expect(within(fallbackRow!).getByText('0.2 g · 24片/盒')).toBeTruthy()
    expect(within(fallbackRow!).getByText('必要时（PRN）')).toBeTruthy()
    expect(within(fallbackRow!).getByText('24 片')).toBeTruthy()
  })
})
