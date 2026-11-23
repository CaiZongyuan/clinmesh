// @vitest-environment jsdom
import { cleanup, render as renderComponent, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import type { ClinicalDocumentContent, DoctorCaseDetail, ImagingRequest } from '@clinmesh/contracts/his'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import { ClinicalDocumentPage, type ClinicalDocumentPageActions } from './clinical-document-page.tsx'
import { ExaminationPage } from './examination-page.tsx'
import { ImagingRequestList, type ImagingViewState } from './imaging-page.tsx'
import { DoctorDraftMarksProvider } from './doctor-draft-fields.tsx'
import {
  OutpatientOrderGateGuidance,
  assertOutpatientAgentOrderPrerequisites,
  resolveOutpatientOrderPrerequisiteGate,
} from './outpatient-order-gate.tsx'

const clients: QueryClient[] = []
function render(element: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return renderComponent(
    <QueryClientProvider client={client}>
      <DoctorDraftMarksProvider>{element}</DoctorDraftMarksProvider>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  vi.unstubAllGlobals()
})

const documentContent: ClinicalDocumentContent = {
  chiefComplaint: '发热伴咽痛一天。',
  historyOfPresentIllness: '昨晚起发热伴咽痛一天。',
  priorMedicalHistory: '系统未记录既往病史。',
  familyHistory: '无特殊家族史。',
  allergyHistory: '否认药物过敏史。',
  menstrualHistory: '',
  obstetricHistory: '',
  physicalExamination: '咽部充血，双肺呼吸音清。',
  auxiliaryExamination: '暂未见外院及本院辅助检查结果。',
  assessment: '考虑急性上呼吸道感染。',
  disposition: '门诊对症观察。',
  followUp: '高热不退及时复诊。',
}

const signedDocument = {
  bundleId: 'bundle-1',
  compositionId: 'composition-1',
  compositionVersion: '1',
  content: documentContent,
  documentId: 'document-1',
  provenanceId: 'provenance-1',
  revisionNumber: 1,
  signedAt: '2026-10-16T09:00:00+08:00',
}

const confirmedDiagnosis = {
  confirmation: {
    confirmedAt: '2026-10-16T09:05:00+08:00',
    entries: [{
      catalogItemId: 'diagnosis-influenza',
      code: 'J10.1',
      conditionId: 'condition-1',
      conditionVersion: '1',
      display: '流感伴其他呼吸道表现',
      role: 'primary' as const,
      system: 'http://hl7.org/fhir/sid/icd-10',
    }],
    id: 'confirmation-1',
    provenanceId: 'provenance-diag-1',
    revisionNumber: 1,
  },
  draftVersion: 2,
}

const baseConsultationDetail: DoctorCaseDetail = {
  registrationNumber: 'CM-OP-20261016-0000001',
  allergies: [],
  caseId: 'case-gate-1',
  consultation: { turns: [], version: 1 },
  encounter: { id: 'encounter-gate-1', status: 'in-progress', versionId: '3' },
  examinationRequests: {
    draft: {
      indication: '胸闷待查',
      service: {
        applicability: '成人心律失常与心肌缺血筛查',
        bodySite: '心脏',
        code: 'EXAM-ECG-12',
        department: '功能检查科',
        examCode: 'ecg-12-lead',
        id: 'examination-ecg-12-lead',
        method: '常规十二导联描记',
        modality: 'ECG',
        name: '常规十二导联心电图',
        reportSections: ['technique', 'findings', 'impression'],
        version: 1,
      },
    },
    draftVersion: 1,
    requests: [],
  },
  patient: {
    birthDate: '1988-06-01',
    gender: 'male',
    id: 'patient-gate-1',
    identifier: 'SYN-GATE-1',
    name: '合成门禁患者',
    synthetic: true,
    versionId: '1',
  },
  presentation: null,
  priorFacts: [],
  status: 'first-visit',
  taskId: 'task-gate-1',
  taskVersion: '1',
}

describe('outpatient order prerequisite gate (#515)', () => {
  it('evaluates unsigned record first, unconfirmed diagnosis second, and skips legacy non-Consultation cases', () => {
    const unsignedGate = resolveOutpatientOrderPrerequisiteGate(baseConsultationDetail)
    expect(unsignedGate).toMatchObject({
      blocked: true,
      missingSignedRecord: true,
      missingConfirmedDiagnosis: true,
    })
    expect(() => assertOutpatientAgentOrderPrerequisites(baseConsultationDetail))
      .toThrow(/CLINICAL_DOCUMENT_UNSIGNED/)

    const signedOnlyDetail: DoctorCaseDetail = {
      ...baseConsultationDetail,
      clinicalDocument: { signed: [signedDocument] },
    }
    const unconfirmedGate = resolveOutpatientOrderPrerequisiteGate(signedOnlyDetail)
    expect(unconfirmedGate).toMatchObject({
      blocked: true,
      missingSignedRecord: false,
      missingConfirmedDiagnosis: true,
    })
    expect(() => assertOutpatientAgentOrderPrerequisites(signedOnlyDetail))
      .toThrow(/DIAGNOSIS_UNCONFIRMED/)

    const secondaryOnlyDetail: DoctorCaseDetail = {
      ...signedOnlyDetail,
      diagnosis: {
        confirmation: {
          ...confirmedDiagnosis.confirmation,
          entries: confirmedDiagnosis.confirmation.entries.map(entry => ({
            ...entry,
            role: 'secondary' as const,
          })),
        },
        draftVersion: 2,
      },
    }
    expect(resolveOutpatientOrderPrerequisiteGate(secondaryOnlyDetail)).toMatchObject({
      blocked: true,
      code: 'DIAGNOSIS_UNCONFIRMED',
      missingSignedRecord: false,
      missingConfirmedDiagnosis: true,
    })
    expect(() => assertOutpatientAgentOrderPrerequisites(secondaryOnlyDetail))
      .toThrow(/DIAGNOSIS_UNCONFIRMED/)

    const readyDetail: DoctorCaseDetail = {
      ...signedOnlyDetail,
      diagnosis: confirmedDiagnosis,
    }
    expect(resolveOutpatientOrderPrerequisiteGate(readyDetail)).toMatchObject({
      blocked: false,
      missingSignedRecord: false,
      missingConfirmedDiagnosis: false,
    })
    expect(() => assertOutpatientAgentOrderPrerequisites(readyDetail)).not.toThrow()

    const { consultation: _omitted, ...legacyDetail } = baseConsultationDetail
    expect(resolveOutpatientOrderPrerequisiteGate(legacyDetail).blocked).toBe(false)
  })

  it('renders jump actions and disables ExaminationPage issue button while keeping draft save/delete available', async () => {
    const user = userEvent.setup()
    const navigated: string[] = []
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [] })))

    const gate = resolveOutpatientOrderPrerequisiteGate(baseConsultationDetail, section => navigated.push(section))
    render(
      <ExaminationPage
        actionContext={undefined}
        active
        detail={baseConsultationDetail}
        elementId="exam-gate"
        locale="zh-CN"
        onSelectRequest={vi.fn()}
        orderGate={gate}
        readOnly={false}
      />,
    )

    expect((screen.getByRole('button', { name: '开立功能检查' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '删除草稿' }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByText('开单前须先签署首版病历并确认主诊断')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '去签署首版病历' }))
    await user.click(screen.getByRole('button', { name: '去确认诊断' }))
    expect(navigated).toEqual(['record', 'diagnosis'])

    cleanup()
    render(
      <OutpatientOrderGateGuidance
        gate={resolveOutpatientOrderPrerequisiteGate(
          { ...baseConsultationDetail, clinicalDocument: { signed: [signedDocument] } },
          section => navigated.push(section),
        )}
        locale="zh-CN"
      />,
    )
    expect(screen.getByText('开单前须先确认主诊断')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '去签署首版病历' })).toBeNull()
    expect(screen.getByRole('button', { name: '去确认诊断' })).toBeTruthy()
  })

  it('auto-opens post-sign clinical document revision draft and supports saving or discarding it', async () => {
    const user = userEvent.setup()
    const savedDocuments: ClinicalDocumentContent[] = []
    const changedDocuments: ClinicalDocumentContent[] = []
    const revisionDraft = {
      ...documentContent,
      auxiliaryExamination: '胸部 CT 平扫（2026-10-16 10:00，第 1 版）：右肺中叶少许斑片影。',
      updatedAt: '2026-10-16T10:05:00+08:00',
      version: 2,
    }
    const actions: ClinicalDocumentPageActions = {
      prepareSign: { data: undefined, error: null, onReset: vi.fn(), onSubmit: vi.fn(), pending: false },
      revise: { error: null, onSubmit: vi.fn(), pending: false, success: false },
      save: {
        error: null,
        hasUnsavedChanges: false,
        onSubmit: doc => savedDocuments.push(doc),
        pending: false,
        success: false,
      },
      sign: { error: null, onSubmit: vi.fn(), pending: false, success: false },
    }

    render(
      <ClinicalDocumentPage
        actions={actions}
        allowRevision
        defaultRevisionOpen={false}
        detail={{
          ...baseConsultationDetail,
          clinicalDocument: { draft: revisionDraft, signed: [signedDocument] },
        }}
        elementId="clinical-doc-gate"
        locale="zh-CN"
        messages={getWorkspaceMessages('zh-CN')}
        onDocumentChange={doc => changedDocuments.push(doc)}
        workingDocument={revisionDraft}
      />,
    )

    expect(screen.getByText('存在待签署的病历修订草稿')).toBeTruthy()
    const form = screen.getByRole('form', { name: '修订病历版本' })
    expect((within(form).getByLabelText('辅助检查') as HTMLTextAreaElement).value)
      .toContain('胸部 CT 平扫')

    await user.click(within(form).getByRole('button', { name: '保存修订草稿' }))
    expect(savedDocuments).toHaveLength(1)
    expect(savedDocuments[0]?.auxiliaryExamination).toContain('胸部 CT 平扫')

    await user.click(within(form).getByRole('button', { name: '放弃修订草稿' }))
    expect(changedDocuments.at(-1)).toEqual(signedDocument.content)
    expect(savedDocuments.at(-1)).toEqual(signedDocument.content)
  })

  it('offers post-sign report summary insertion into revision draft with 1-click navigation to record', async () => {
    const user = userEvent.setup()
    const onNavigateToRecord = vi.fn()
    const view: ImagingViewState = {
      isOpen: () => false,
      isShown: () => false,
      markShown: vi.fn(),
      setOpen: vi.fn(),
    }
    const request: ImagingRequest = {
      id: 'img-req-1',
      indication: '发热咳嗽待查',
      previousReports: [],
      report: {
        diagnosticReportId: 'img-report-1',
        diagnosticReportVersion: '1',
        examinedAt: '2026-10-16T09:30:00+08:00',
        findings: '双肺纹理稍增粗。',
        impression: '未见明显实质性浸润影。',
        issuedAt: '2026-10-16T09:40:00+08:00',
        revisionNumber: 1,
        status: 'final',
        studyId: 'study-1',
        technique: '胸部正位片',
      },
      service: {
        applicability: '成人胸部筛查',
        bodySite: '胸部',
        code: 'DX-CHEST',
        department: '放射科',
        examCode: 'chest-radiograph',
        id: 'imaging-chest-radiograph',
        method: '正位摄片',
        modality: 'DX',
        name: '胸部正位片',
        reportSections: ['technique', 'findings', 'impression'],
        version: 1,
      },
      serviceRequestId: 'sr-img-1',
      serviceRequestVersion: '1',
      status: 'reported',
      taskId: 'task-img-1',
      taskVersion: '1',
      version: 2,
    }

    render(
      <ImagingRequestList
        actions={{
          canCorrect: false,
          hasSignedRecord: true,
          onChanged: vi.fn(),
          onInsertSummary: () => 'inserted',
          onNavigateToRecord,
          view,
        }}
        locale="zh-CN"
        readOnly={false}
        requests={[request]}
      />,
    )

    await user.click(screen.getByRole('button', { name: '摘要插入病历' }))
    expect(screen.getByText('已写入病历修订草稿（辅助检查），请前往病历记录提交修订签名。')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '前往病历修订' }))
    expect(onNavigateToRecord).toHaveBeenCalledTimes(1)
  })
})
