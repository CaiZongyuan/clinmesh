// @vitest-environment jsdom
import type { DoctorCaseDetail } from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InpatientVitalsAndScoresDisclosure, OutpatientClinicalScoresDisclosure } from './clinical-scores-panel.tsx'
import { PatientVitals } from './doctor/patient-summary.tsx'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { getWorkspaceMessages } from './workspace-i18n.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ClinicalScoresPanel disclosures', () => {
  it('does not fetch clinical-scores while collapsed, then renders complete/incomplete badges and saves tri-state risk assessment on expand', async () => {
    const calls: Array<{ body?: unknown; method: string; url: string }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ body, method, url })
      if (method === 'GET' && url.endsWith('/api/his/v1/doctor/cases/case-1/clinical-scores')) {
        return Response.json({
          encounterId: 'enc-1',
          encounterVersion: '3',
          evaluatedAt: '2026-10-25T10:00:00+08:00',
          riskAssessment: {
            effectiveStSegmentDeviation: {
              source: 'ecg-report',
              sourceReference: 'DiagnosticReport/ecg-1',
              value: true,
              versionId: '1',
            },
            observationId: null,
            observationVersion: null,
            provenanceId: null,
            recordedAt: null,
            recordedBy: null,
            revision: 0,
            values: {
              anginaEpisodes24h: null,
              aspirinUsedLast7Days: null,
              cardiacArrestOnAdmission: null,
              killipClass: null,
              priorBleedingHistory: null,
              smokingStatus: null,
              stSegmentDeviation: null,
            },
          },
          scores: [
            {
              id: 'ckd-epi-2021-egfr',
              missingInputs: [],
              sourceReferences: [{ label: '血清肌酐', reference: 'Observation/scr-1', versionId: '1' }],
              status: 'complete',
              summaryEn: '88.2 mL/min/1.73m2 · G2',
              summaryZh: '88.2 mL/min/1.73m2 · G2 轻度下降',
              tierCode: 'G2',
              tierLabelEn: 'G2',
              tierLabelZh: 'G2 轻度下降',
              titleEn: 'CKD-EPI 2021 eGFR',
              titleZh: 'CKD-EPI 2021 估算肾小球滤过率 (eGFR)',
              unit: 'mL/min/1.73m2',
              value: 88.2,
            },
            ...(['cockcroft-gault-crcl', 'grace-acs', 'timi-ua-nstemi', 'precise-dapt', 'ascvd-ldl-target'] as const).map(id => ({
              id,
              missingInputs: ['weightKg'],
              sourceReferences: [],
              status: 'incomplete' as const,
              summaryEn: 'Missing required inputs: Body weight (kg)',
              summaryZh: '待补齐：体重 (kg)',
              tierCode: null,
              tierLabelEn: null,
              tierLabelZh: null,
              titleEn: id,
              titleZh: id,
              unit: '分',
              value: null,
            })),
          ],
          vitalSigns: null,
        })
      }
      if (method === 'PUT' && url.endsWith('/api/his/v1/encounters/enc-1/risk-assessment')) {
        return Response.json({
          auditId: 'audit-1',
          data: {
            encounterVersion: '3',
            riskAssessment: {
              effectiveStSegmentDeviation: null,
              observationId: 'obs-1',
              observationVersion: '1',
              provenanceId: 'prov-1',
              recordedAt: '2026-10-25T10:05:00+08:00',
              recordedBy: 'actor-1',
              revision: 1,
              values: {
                anginaEpisodes24h: null,
                aspirinUsedLast7Days: null,
                cardiacArrestOnAdmission: null,
                killipClass: 'II',
                priorBleedingHistory: null,
                smokingStatus: 'current',
                stSegmentDeviation: null,
              },
            },
          },
          effects: [],
          requestId: 'req-1',
          warnings: [],
        })
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`)
    })

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries')
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <OutpatientClinicalScoresDisclosure
          caseId="case-1"
          clinicalRevision="rev-1"
          encounterId="enc-1"
          encounterVersion="3"
          locale="zh-CN"
          readOnly={false}
          scope="scope-1"
        />
      </QueryClientProvider>,
    )

    expect(calls).toHaveLength(0)

    const details = screen.getByText('专病风险评估与临床评分').closest('details')!
    details.open = true
    fireEvent(details, new Event('toggle'))

    await waitFor(() => {
      expect(screen.getByText('88.2 mL/min/1.73m2 · G2 轻度下降')).toBeTruthy()
    })
    expect(screen.getAllByText('待补齐：体重 (kg)').length).toBe(5)
    expect(screen.getByText(/DiagnosticReport\/ecg-1#1/)).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Killip 分级'), { target: { value: 'II' } })
    fireEvent.change(screen.getByLabelText('吸烟状态'), { target: { value: 'current' } })
    fireEvent.click(screen.getByRole('button', { name: '保存风险评估' }))

    await waitFor(() => {
      expect(calls.some(call => call.method === 'PUT')).toBe(true)
    })
    const putCall = calls.find(call => call.method === 'PUT')!
    expect(putCall.body).toEqual({
      expectedVersions: { 'Encounter/enc-1': '3' },
      input: {
        expectedRevision: 0,
        fields: {
          anginaEpisodes24h: null,
          aspirinUsedLast7Days: null,
          cardiacArrestOnAdmission: null,
          familyHistoryPrematureCad: null,
          killipClass: 'II',
          knownCoronaryStenosisGe50: null,
          priorBleedingHistory: null,
          smokingStatus: 'current',
          stSegmentDeviation: null,
        },
      },
    })
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ predicate: expect.any(Function) }))

    // Updating clinicalRevision while expanded automatically refetches clinical-scores
    const getCountBefore = calls.filter(call => call.method === 'GET').length
    rerender(
      <QueryClientProvider client={client}>
        <OutpatientClinicalScoresDisclosure
          caseId="case-1"
          clinicalRevision="rev-2"
          encounterId="enc-1"
          encounterVersion="3"
          locale="zh-CN"
          readOnly={false}
          scope="scope-1"
        />
      </QueryClientProvider>,
    )
    await waitFor(() => {
      expect(calls.filter(call => call.method === 'GET').length).toBeGreaterThan(getCountBefore)
    })

    // Switching directly between two cached cases with identical revision (both 0) must reset unsaved/prior case form values
    fireEvent.change(screen.getByLabelText('Killip 分级'), { target: { value: 'IV' } })
    expect((screen.getByLabelText('Killip 分级') as HTMLSelectElement).value).toBe('IV')
    rerender(
      <QueryClientProvider client={client}>
        <OutpatientClinicalScoresDisclosure
          caseId="case-2"
          clinicalRevision="rev-1"
          encounterId="enc-2"
          encounterVersion="1"
          locale="zh-CN"
          readOnly={false}
          scope="scope-1"
        />
      </QueryClientProvider>,
    )
    expect((screen.getByLabelText('Killip 分级') as HTMLSelectElement).value).toBe('')
    expect((screen.getByLabelText('Killip 分级') as HTMLSelectElement).disabled).toBe(true)
  })

  it('records inpatient nursing vital signs and risk assessment via InpatientVitalsAndScoresDisclosure and localizes PatientVitals weight/height', async () => {
    const mutateAsync = vi.fn().mockResolvedValue({})
    const write = {
      blocked: false,
      mutation: { isPending: false, mutateAsync, variables: undefined },
    } as unknown as ReturnType<typeof useInpatientWriteIntent>

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/api/his/v1/inpatient/admissions/adm-1/clinical-scores')) {
        return Response.json({
          encounterId: 'adm-1',
          encounterVersion: '2',
          evaluatedAt: '2026-10-25T10:00:00+08:00',
          riskAssessment: {
            effectiveStSegmentDeviation: null,
            observationId: null,
            observationVersion: null,
            provenanceId: null,
            recordedAt: null,
            recordedBy: null,
            revision: 0,
            values: {
              anginaEpisodes24h: null,
              aspirinUsedLast7Days: null,
              cardiacArrestOnAdmission: null,
              killipClass: null,
              priorBleedingHistory: null,
              smokingStatus: null,
              stSegmentDeviation: null,
            },
          },
          scores: (['ckd-epi-2021-egfr', 'cockcroft-gault-crcl', 'grace-acs', 'timi-ua-nstemi', 'precise-dapt', 'ascvd-ldl-target'] as const).map(id => ({
            id,
            missingInputs: ['serumCreatinine'],
            sourceReferences: [],
            status: 'incomplete' as const,
            summaryEn: 'Missing serum creatinine',
            summaryZh: '待补齐：血清肌酐',
            tierCode: null,
            tierLabelEn: null,
            tierLabelZh: null,
            titleEn: id,
            titleZh: id,
            unit: '分',
            value: null,
          })),
          vitalSigns: null,
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <InpatientVitalsAndScoresDisclosure
          admissionId="adm-1"
          canEdit={true}
          encounterVersion="2"
          latestVitalSigns={undefined}
          locale="zh-CN"
          riskAssessment={undefined}
          scope={['inpatient', 'ws-1', 'ep-1', 'role-1']}
          write={write}
        />
        <PatientVitals
          detail={{
            presentation: {
              vitalSigns: {
                bloodPressure: { diastolicMmHg: 80, systolicMmHg: 128 },
                heightCm: 174,
                oxygenSaturationPct: 98,
                pulseBpm: 76,
                respirationBpm: 18,
                temperatureC: 36.7,
                weightKg: 71.5,
              },
            },
          } as unknown as DoctorCaseDetail}
          messages={getWorkspaceMessages('en-US')}
        />
      </QueryClientProvider>,
    )

    expect(screen.getByText('Weight (kg)')).toBeTruthy()
    expect(screen.getByText('Height (cm)')).toBeTruthy()
    expect(screen.getByText('71.5')).toBeTruthy()
    expect(screen.getByText('174')).toBeTruthy()

    const vitalsDetails = screen.getByText('护理生命体征').closest('details')!
    vitalsDetails.open = true
    // First save is disabled until required vital measurements are explicitly entered (never prefilled with fabricated normals)
    expect((screen.getByRole('button', { name: '记录生命体征' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('体温 (°C)'), { target: { value: '36.8' } })
    fireEvent.change(screen.getByLabelText('心率 (次/分)'), { target: { value: '76' } })
    fireEvent.change(screen.getByLabelText('呼吸 (次/分)'), { target: { value: '18' } })
    fireEvent.change(screen.getByLabelText('血氧 (%)'), { target: { value: '98' } })
    fireEvent.change(screen.getByLabelText('收缩压 (mmHg)'), { target: { value: '126' } })
    fireEvent.change(screen.getByLabelText('舒张压 (mmHg)'), { target: { value: '78' } })
    fireEvent.change(screen.getByLabelText('体重 (kg，选填)'), { target: { value: '75' } })
    fireEvent.change(screen.getByLabelText('身高 (cm，选填)'), { target: { value: '176' } })
    fireEvent.click(screen.getByRole('button', { name: '记录生命体征' }))

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
        input: expect.objectContaining({
          admissionId: 'adm-1',
          encounterVersion: '2',
          expectedRevision: 0,
          heightCm: 176,
          weightKg: 75,
        }),
        operation: 'inpatient.vital-signs.record',
      }))
    })

    const scoresDetails = screen.getByText('专病风险评估与临床评分').closest('details')!
    scoresDetails.open = true
    fireEvent(scoresDetails, new Event('toggle'))
    await waitFor(() => {
      expect(screen.getAllByText('待补齐：血清肌酐')).toHaveLength(6)
    })

    fireEvent.change(screen.getByLabelText('既往自发性出血史'), { target: { value: 'spontaneous' } })
    fireEvent.click(screen.getByRole('button', { name: '保存风险评估' }))
    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
        input: expect.objectContaining({
          admissionId: 'adm-1',
          expectedRevision: 0,
          fields: expect.objectContaining({ priorBleedingHistory: 'spontaneous' }),
        }),
        operation: 'inpatient.risk-assessment.record',
      }))
    })
  })

  it('preserves dirty risk edits and base expectedRevision across background remote revisions so CAS conflicts are surfaced', async () => {
    let remoteRevision = 1
    let remoteKillip: 'I' | 'III' = 'I'
    const putBodies: unknown[] = []

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url.endsWith('/api/his/v1/doctor/cases/case-cas/clinical-scores')) {
        return Response.json({
          encounterId: 'enc-cas',
          encounterVersion: '3',
          evaluatedAt: '2026-10-25T10:00:00+08:00',
          riskAssessment: {
            effectiveStSegmentDeviation: null,
            observationId: `obs-${remoteRevision}`,
            observationVersion: String(remoteRevision),
            provenanceId: `prov-${remoteRevision}`,
            recordedAt: '2026-10-25T10:00:00+08:00',
            recordedBy: 'actor-other',
            revision: remoteRevision,
            values: {
              anginaEpisodes24h: null,
              aspirinUsedLast7Days: null,
              cardiacArrestOnAdmission: null,
              familyHistoryPrematureCad: null,
              killipClass: remoteKillip,
              knownCoronaryStenosisGe50: null,
              priorBleedingHistory: null,
              smokingStatus: null,
              stSegmentDeviation: null,
            },
          },
          scores: (['ckd-epi-2021-egfr', 'cockcroft-gault-crcl', 'grace-acs', 'timi-ua-nstemi', 'precise-dapt', 'ascvd-ldl-target'] as const).map(id => ({
            id,
            missingInputs: ['serumCreatinine'],
            sourceReferences: [],
            status: 'incomplete' as const,
            summaryEn: 'Missing serum creatinine',
            summaryZh: '待补齐：血清肌酐',
            tierCode: null,
            tierLabelEn: null,
            tierLabelZh: null,
            titleEn: id,
            titleZh: id,
            unit: '分',
            value: null,
          })),
          vitalSigns: null,
        })
      }
      if (method === 'PUT' && url.endsWith('/api/his/v1/encounters/enc-cas/risk-assessment')) {
        putBodies.push(JSON.parse(String(init?.body)))
        return new Response(
          JSON.stringify({
            error: {
              code: 'REVISION_CONFLICT',
              details: {},
              message: '风险评估已被并发更新，请刷新后重试',
              requestId: 'req-conflict',
              retryable: false,
            },
          }),
          { headers: { 'content-type': 'application/json' }, status: 409 },
        )
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`)
    })

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <OutpatientClinicalScoresDisclosure
          caseId="case-cas"
          clinicalRevision="rev-1"
          encounterId="enc-cas"
          encounterVersion="3"
          locale="zh-CN"
          readOnly={false}
          scope="scope-1"
        />
      </QueryClientProvider>,
    )

    const details = screen.getByText('专病风险评估与临床评分').closest('details')!
    details.open = true
    fireEvent(details, new Event('toggle'))
    await waitFor(() => {
      expect((screen.getByLabelText('Killip 分级') as HTMLSelectElement).value).toBe('I')
    })

    // Clinician edits Killip I -> II locally (dirty = true, baseRevision = 1)
    fireEvent.change(screen.getByLabelText('Killip 分级'), { target: { value: 'II' } })
    expect((screen.getByLabelText('Killip 分级') as HTMLSelectElement).value).toBe('II')

    // Another clinician saves revision 2 (Killip III) and triggers background refetch
    remoteRevision = 2
    remoteKillip = 'III'
    rerender(
      <QueryClientProvider client={client}>
        <OutpatientClinicalScoresDisclosure
          caseId="case-cas"
          clinicalRevision="rev-2"
          encounterId="enc-cas"
          encounterVersion="3"
          locale="zh-CN"
          readOnly={false}
          scope="scope-1"
        />
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(screen.getByText(/远端已有更新记录 #2/)).toBeTruthy()
    })
    // Unsaved dirty draft Killip II is preserved rather than clobbered with III
    expect((screen.getByLabelText('Killip 分级') as HTMLSelectElement).value).toBe('II')

    // Clicking Save submits base expectedRevision: 1 so backend CAS surfaces 409 conflict
    fireEvent.click(screen.getByRole('button', { name: '保存风险评估' }))
    await waitFor(() => {
      expect(putBodies).toHaveLength(1)
    })
    expect(putBodies[0]).toMatchObject({
      input: {
        expectedRevision: 1,
        fields: expect.objectContaining({ killipClass: 'II' }),
      },
    })
    await waitFor(() => {
      expect(screen.getByText(/当前业务状态或前置条件不满足/)).toBeTruthy()
    })

    // Clinician can explicitly discard stale draft to sync remote #2 and clear the conflict alert
    fireEvent.click(screen.getByRole('button', { name: '放弃草稿并同步' }))
    expect((screen.getByLabelText('Killip 分级') as HTMLSelectElement).value).toBe('III')
    await waitFor(() => {
      expect(screen.queryByText(/当前业务状态或前置条件不满足/)).toBeNull()
    })
  })
})
