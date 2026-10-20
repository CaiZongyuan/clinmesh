// @vitest-environment jsdom
import { doctorCaseDetailSchema, type ClinicalDocumentContent } from '@clinmesh/contracts/his'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import { PatientBanner } from './patient-summary.tsx'

afterEach(() => { cleanup() })

const messages = getWorkspaceMessages('zh-CN')
const document: ClinicalDocumentContent = {
  chiefComplaint: '反复头晕一周，近两日加重', historyOfPresentIllness: '反复头晕一周。',
  assessment: '头晕原因待查。', disposition: '进一步问诊。', followUp: '不适随诊。', physicalExamination: '神志清楚。',
}

function birthDateForAge(age: number): string {
  return `${new Date().getUTCFullYear() - age}-01-01`
}

function bannerDetail() {
  return doctorCaseDetailSchema.parse({
    allergies: [
      { code: 'synthetic-penicillin', display: '青霉素过敏' },
      { code: 'synthetic-sulfonamide', display: '磺胺类过敏' },
    ],
    caseId: 'case-compact-1',
    consultation: { turns: [], version: 1 },
    encounter: { id: 'encounter-compact-1', status: 'in-progress', versionId: '1' },
    laboratoryRequests: { draftVersion: 0, reportingSupported: true, requests: [] },
    patient: {
      id: 'patient-compact-1', identifier: 'SYN-COMPACT-1', name: '布局测试',
      gender: 'male', synthetic: true, versionId: '1', birthDate: birthDateForAge(35),
    },
    presentation: {
      chiefComplaint: '发热伴咽痛两天', summary: '发热伴咽痛两天',
      vitalSigns: {
        temperatureC: 38.2, pulseBpm: 102, respirationBpm: 20,
        bloodPressure: { systolicMmHg: 118, diastolicMmHg: 76 }, oxygenSaturationPct: 98,
      },
    },
    priorFacts: [],
    status: 'first-visit',
    taskId: 'task-compact-1', taskVersion: '1',
    triage: {
      acuityCode: 'level-4', chiefComplaint: '发热伴咽痛两天', temperatureC: 38.2,
      pulseBpm: 102, respirationBpm: 20,
      bloodPressure: { systolicMmHg: 118, diastolicMmHg: 76 }, oxygenSaturationPct: 98,
    },
  })
}

function renderBanner() {
  return render(
    <PatientBanner
      completionAction={<button type="button">完诊</button>}
      completionChecklist={<section aria-label="完诊清单">完诊清单</section>}
      detail={bannerDetail()}
      messages={messages}
      statusText={messages.status_firstVisit}
    />,
  )
}

function commonAncestor(a: Element, b: Element): Element | null {
  const seen = new Set<Element>()
  for (let node: Element | null = a; node !== null; node = node.parentElement) seen.add(node)
  for (let node: Element | null = b; node !== null; node = node.parentElement) {
    if (seen.has(node)) return node
  }
  return null
}

describe('PatientBanner 紧凑布局', () => {
  it('签署后按最新修订展示主诉，忽略残留工作稿和签署数组顺序', () => {
    const detail = bannerDetail()
    const signed = (revisionNumber: number) => ({
      bundleId: `bundle-${revisionNumber}`, compositionId: `composition-${revisionNumber}`, compositionVersion: '1',
      documentId: `document-${revisionNumber}`, provenanceId: `provenance-${revisionNumber}`,
      revisionNumber, signedAt: '2026-10-20T09:00:00+08:00',
      content: { ...document, chiefComplaint: `头晕${revisionNumber}周` },
    })
    detail.clinicalDocument = { signed: [signed(3), signed(1), signed(2)] }
    render(<PatientBanner detail={detail} messages={messages} statusText={messages.status_firstVisit}
      workingDocument={{ ...document, chiefComplaint: '旧工作稿' }} />)
    expect(screen.getByText('主诉：头晕3周')).toBeTruthy()
    expect(screen.queryByText(messages.clinicalDocumentDraftUnsavedShort)).toBeNull()
  })

  it('工作稿立即同步并标记未保存，清空与保存后不回退分诊，切换病例不串稿', () => {
    const detail = bannerDetail()
    detail.clinicalDocument = { draft: { ...document, version: 1, updatedAt: '2026-10-20T09:00:00+08:00' }, signed: [] }
    const props = { detail, messages, statusText: messages.status_firstVisit }
    const workingDocument = { ...document, chiefComplaint: '头晕两周' }
    const view = render(<PatientBanner {...props} workingDocument={workingDocument} />)
    expect(screen.getByText('主诉：头晕两周')).toBeTruthy()
    expect(screen.getByText(messages.clinicalDocumentDraftUnsavedShort)).toBeTruthy()
    view.rerender(<PatientBanner {...props} workingDocument={{ ...document, chiefComplaint: '' }} />)
    expect(screen.getByText(`主诉：${messages.clinicalHistoryNotRecorded}`)).toBeTruthy()
    view.rerender(<PatientBanner {...props} detail={{ ...detail, clinicalDocument: {
      draft: { ...detail.clinicalDocument.draft!, chiefComplaint: '' }, signed: [],
    } }} />)
    expect(screen.getByText(`主诉：${messages.clinicalHistoryNotRecorded}`)).toBeTruthy()
    expect(screen.queryByText(messages.clinicalDocumentDraftUnsavedShort)).toBeNull()
    view.rerender(<PatientBanner {...props} detail={bannerDetail()} />)
    expect(screen.getByText('主诉：发热伴咽痛两天')).toBeTruthy()
  })

  it('页头显示已保存病历主诉，保留分诊初记', () => {
    const detail = bannerDetail()
    detail.clinicalDocument = {
      draft: {
        chiefComplaint: '反复头晕一周，近两日加重', historyOfPresentIllness: '',
        assessment: '', disposition: '', followUp: '', physicalExamination: '',
        version: 1, updatedAt: '2026-10-20T09:00:00+08:00',
      },
      signed: [],
    }
    render(<PatientBanner detail={detail} messages={messages} statusText={messages.status_firstVisit} />)
    expect(screen.getByText('主诉：反复头晕一周，近两日加重')).toBeTruthy()
    expect(screen.queryByText('主诉：发热伴咽痛两天')).toBeNull()
    expect(detail.triage?.chiefComplaint).toBe('发热伴咽痛两天')
  })

  it('分诊分级与过敏徽章与患者标题同处身份行，不再有独立徽章行', () => {
    renderBanner()
    const banner = screen.getByRole('region', { name: '当前患者' })
    const heading = within(banner).getByRole('heading', { level: 2 })
    for (const labelText of ['四级 · 非急症', '青霉素过敏', '磺胺类过敏']) {
      const badge = within(banner).getByText(labelText, { exact: false })
      const shared = commonAncestor(heading, badge)
      expect(shared).not.toBeNull()
      expect(shared).not.toBe(banner)
    }
  })

  it('性别与年龄合并为身份行内的一个徽章', () => {
    renderBanner()
    const badge = screen.getByText('男 · 35 岁')
    expect(badge).toBeTruthy()
  })

  it('生命体征五项保留完整标签并保持在单个 dl 中', () => {
    renderBanner()
    const banner = screen.getByRole('region', { name: '当前患者' })
    const dl = banner.querySelector('dl')
    expect(dl).not.toBeNull()
    const vitalLabels = ['体温（°C）', '脉搏（次/分）', '呼吸（次/分）', '血压（mmHg）', '血氧饱和度（%）']
    for (const label of vitalLabels) {
      expect(within(dl!).getByText(label, { exact: false })).toBeTruthy()
    }
    expect(within(dl!).getByText('118/76')).toBeTruthy()
    expect(within(dl!).getByText('98')).toBeTruthy()
  })

  it('门诊号、主诉与完诊动作仍然可见', () => {
    renderBanner()
    expect(screen.getByText(/SYN-COMPACT-1/)).toBeTruthy()
    expect(screen.getByText(/发热伴咽痛两天/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '完诊' })).toBeTruthy()
    expect(screen.getByText('首诊中')).toBeTruthy()
  })
})
