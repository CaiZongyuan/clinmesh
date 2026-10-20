// @vitest-environment jsdom
import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import { PatientBanner } from './patient-summary.tsx'

afterEach(() => { cleanup() })

const messages = getWorkspaceMessages('zh-CN')

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
    registrationNumber: 'CM-OP-20261020-000123',
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
    expect(screen.getByText('CM-OP-20261020-000123')).toBeTruthy()
    expect(screen.queryByText(/门诊号：SYN-COMPACT-1/)).toBeNull()
    expect(screen.getByText(/发热伴咽痛两天/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '完诊' })).toBeTruthy()
    expect(screen.getByText('首诊中')).toBeTruthy()
  })

  it('复制完整的当前门诊号，切换病例后不保留旧号码或成功反馈', async () => {
    const user = userEvent.setup()
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    const { rerender } = renderBanner()
    await user.click(screen.getByRole('button', { name: '复制门诊号 CM-OP-20261020-000123' }))
    expect(write).toHaveBeenLastCalledWith('CM-OP-20261020-000123')
    expect(screen.getByRole('status').textContent).toBe('门诊号已复制')
    rerender(<PatientBanner detail={{ ...bannerDetail(), caseId: 'case-next', registrationNumber: 'CM-OP-20261020-1234567' }} messages={messages} statusText={messages.status_firstVisit} />)
    expect(screen.queryByText('CM-OP-20261020-000123')).toBeNull()
    expect(screen.queryByText('门诊号已复制')).toBeNull()
    await user.click(screen.getByRole('button', { name: '复制门诊号 CM-OP-20261020-1234567' }))
    expect(write).toHaveBeenLastCalledWith('CM-OP-20261020-1234567')
  })

  it('缺少门诊号时显示未记录，复制被拒绝时只显示失败', async () => {
    const user = userEvent.setup()
    const { rerender } = renderBanner()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Denied'))
    await user.click(screen.getByRole('button', { name: /复制门诊号/ }))
    expect(screen.getByRole('alert').textContent).toBe('复制失败，请手动选择门诊号复制')
    expect(screen.queryByText('门诊号已复制')).toBeNull()
    rerender(<PatientBanner detail={{ ...bannerDetail(), registrationNumber: null }} messages={messages} statusText={messages.status_firstVisit} />)
    expect(screen.getByText('未记录')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /复制门诊号/ })).toBeNull()
    expect(screen.queryByText(/SYN-COMPACT-1/)).toBeNull()
  })

  it('完诊进度与生命体征合并为同一次级行，不再单独占一行', () => {
    renderBanner()
    const banner = screen.getByRole('region', { name: '当前患者' })
    const progress = within(banner).getByText('完诊清单', { exact: false })
    const vital = within(banner).getByText('体温（°C）', { exact: false })
    const shared = commonAncestor(progress, vital)
    expect(shared).not.toBeNull()
    expect(shared).not.toBe(banner)
  })
})
