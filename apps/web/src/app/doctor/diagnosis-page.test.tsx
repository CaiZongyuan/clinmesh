// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import type { DiagnosisState } from '@clinmesh/contracts/his'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import { DiagnosisPage } from './diagnosis-page.tsx'

function props(overrides: Partial<ComponentProps<typeof DiagnosisPage>> = {}): ComponentProps<typeof DiagnosisPage> {
  return {
    actions: {
      confirm: { error: null, onSubmit: vi.fn(), pending: false },
      save: { error: null, onSubmit: vi.fn(), pending: false, savedRevision: undefined, success: false },
    },
    caseId: 'synthetic-case', catalog: [1, 2].map(id => ({
      id: `diagnosis-${id}`, code: `SYN-${id}`, nameZh: `合成诊断${id}`, nameEn: `Synthetic diagnosis ${id}`,
      system: 'https://clinmesh.example.com/icd-10', version: 1,
    })), elementId: 'diagnosis', locale: 'zh-CN',
    messages: getWorkspaceMessages('zh-CN'), readOnly: false, state: undefined,
    referenceSearch: {
      data: { items: [1, 2].map(id => ({
        id: `diagnosis-${id}`, code: `SYN-${id}`, display: `合成诊断${id}`, domain: 'diagnosis',
        sourceLocator: 'synthetic:test', system: 'https://clinmesh.example.com/icd-10', version: '1', status: 'active',
      })), page: 1, pageSize: 20, total: 2, releaseId: 'synthetic' },
      error: null, isError: false, isFetching: false, isPending: false, onSearch: vi.fn(),
    },
    ...overrides,
  }
}

afterEach(cleanup)

function savedState(confirmed = false): DiagnosisState {
  const entries: DiagnosisState['draft'] = { entries: [
    { catalogItemId: 'diagnosis-1', role: 'primary', note: '第一条保存备注' },
    { catalogItemId: 'diagnosis-2', role: 'secondary', note: '第二条保存备注' },
  ] }
  return {
    draft: entries, draftVersion: 1,
    ...(confirmed ? { confirmation: {
      confirmedAt: '2026-10-10T10:00:00+08:00', id: 'synthetic-confirmation', provenanceId: 'synthetic-provenance',
      revisionNumber: 1, entries: entries.entries.map((entry, index) => ({
        ...entry, code: `SYN-${index + 1}`, display: `合成诊断${index + 1}`, conditionId: `condition-${index + 1}`,
        conditionVersion: '1', system: 'https://clinmesh.example.com/icd-10',
      })),
    } } : {}),
  }
}

describe('diagnosis workspace', () => {
  it('starts with an inline directory and waits for an explicit diagnosis selection', () => {
    const page = props()
    render(<DiagnosisPage {...page} />)
    expect(screen.getByRole('textbox', { name: '搜索疾病目录' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '选择 合成诊断1 SYN-1' }).hasAttribute('disabled')).toBe(false)
    expect(screen.queryByRole('textbox', { name: page.messages.diagnosisNote })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(page.referenceSearch.onSearch).toHaveBeenCalledExactlyOnceWith('', 1)
    expect(page.actions.save.onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: page.messages.confirmDiagnosis }).hasAttribute('disabled')).toBe(true)
  })
  it('adds only explicitly chosen diagnoses and keeps notes when switching the selected entry', async () => {
    const page = props()
    render(<DiagnosisPage {...page} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '选择 合成诊断1 SYN-1' }))
    const firstNote = screen.getByRole('textbox', { name: page.messages.diagnosisNote })
    await user.type(firstNote, '第一条的备注')
    expect(screen.getByRole('button', { name: '选择 合成诊断1 SYN-1' }).hasAttribute('disabled')).toBe(true)
    await user.click(screen.getByRole('button', { name: '选择 合成诊断2 SYN-2' }))
    expect((screen.getByRole('textbox', { name: `${page.messages.diagnosisNote} 2` }) as HTMLTextAreaElement).value).toBe('')
    const selected = within(screen.getByRole('group', { name: '已选诊断' }))
    await user.click(selected.getByRole('button', { name: /合成诊断1/ }))
    expect((screen.getByRole('textbox', { name: page.messages.diagnosisNote }) as HTMLTextAreaElement).value).toBe('第一条的备注')
    expect(selected.getAllByRole('button')).toHaveLength(2)
  })
  it('restores a saved draft inline and enters an editable list and detail view only after formal confirmation', async () => {
    const page = props({ state: savedState() })
    const { rerender } = render(<DiagnosisPage {...page} />)
    expect(screen.getByRole('textbox', { name: '搜索疾病目录' })).toBeTruthy()
    expect((screen.getByRole('textbox', { name: page.messages.diagnosisNote }) as HTMLTextAreaElement).value).toBe('第一条保存备注')
    expect(screen.queryByRole('region', { name: '诊断列表' })).toBeNull()
    rerender(<DiagnosisPage {...page} state={savedState(true)} />)
    const list = within(screen.getByRole('region', { name: '诊断列表' }))
    expect(screen.queryByRole('textbox', { name: '搜索疾病目录' })).toBeNull()
    await userEvent.setup().click(list.getByRole('button', { name: /合成诊断2/ }))
    const editor = within(screen.getByRole('region', { name: '诊断详情' }))
    const note = editor.getByRole('textbox', { name: `${page.messages.diagnosisNote} 2` })
    expect((note as HTMLTextAreaElement).value).toBe('第二条保存备注')
    await userEvent.setup().type(note, ' · 已修订')
    expect(screen.getByRole('button', { name: page.messages.confirmDiagnosis }).hasAttribute('disabled')).toBe(true)
    expect(list.getAllByRole('button', { name: /合成诊断/ })).toHaveLength(2)
  })
  it('filters and returns to the list without deleting diagnoses or losing their notes', async () => {
    const page = props({ state: savedState(true) })
    render(<DiagnosisPage {...page} />)
    const user = userEvent.setup()
    const list = within(screen.getByRole('region', { name: '诊断列表' }))
    const search = list.getByRole('textbox', { name: '搜索本次诊断' })
    await user.type(search, '不存在的诊断')
    expect(list.getByText('没有匹配的诊断')).toBeTruthy()
    expect(list.queryByRole('button', { name: /合成诊断/ })).toBeNull()
    expect(screen.queryByRole('textbox', { name: '搜索疾病目录' })).toBeNull()
    await user.click(list.getByRole('button', { name: '查看全部诊断' }))
    expect(list.getAllByRole('button', { name: /合成诊断/ })).toHaveLength(2)
    await user.click(list.getByRole('button', { name: page.messages.secondaryDiagnosis }))
    expect(list.queryByRole('button', { name: /合成诊断1/ })).toBeNull()
    await user.click(list.getByRole('button', { name: /合成诊断2/ }))
    expect(document.activeElement).toBe(within(screen.getByRole('region', { name: '诊断详情' })).getByRole('heading', { name: '合成诊断2' }))
    expect((screen.getByRole('textbox', { name: `${page.messages.diagnosisNote} 2` }) as HTMLTextAreaElement).value).toBe('第二条保存备注')
    await user.click(screen.getByRole('button', { name: '返回诊断列表' }))
    await waitFor(() => expect(document.activeElement).toBe(search))
    await user.click(list.getByRole('button', { name: /合成诊断2/ }))
    expect((screen.getByRole('textbox', { name: `${page.messages.diagnosisNote} 2` }) as HTMLTextAreaElement).value).toBe('第二条保存备注')
    expect(page.actions.save.onSubmit).not.toHaveBeenCalled()
  })
  it('adds a diagnosis in the shared directory and editor dialog and keeps its changes after finishing selection', async () => {
    const page = props({ state: savedState(true) })
    render(<DiagnosisPage {...page} referenceSearch={{ ...page.referenceSearch, data: {
      ...page.referenceSearch.data!, items: [...page.referenceSearch.data!.items, {
        ...page.referenceSearch.data!.items[0]!, id: 'diagnosis-3', code: 'SYN-3', display: '合成诊断3',
      }], total: 3,
    } }} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '添加诊断' }))
    const dialog = within(screen.getByRole('dialog', { name: '添加诊断' }))
    expect(dialog.getByRole('textbox', { name: '搜索疾病目录' })).toBeTruthy()
    expect(screen.getAllByRole('region', { name: '诊断详情' })).toHaveLength(1)
    await user.click(dialog.getByRole('button', { name: '选择 合成诊断3 SYN-3' }))
    await user.type(dialog.getByRole('textbox', { name: `${page.messages.diagnosisNote} 3` }), '新添加的备注')
    await user.click(dialog.getByRole('button', { name: '完成选择' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect((screen.getByRole('textbox', { name: `${page.messages.diagnosisNote} 3` }) as HTMLTextAreaElement).value).toBe('新添加的备注')
    expect(within(screen.getByRole('region', { name: '诊断列表' })).getAllByRole('button', { name: /合成诊断/ })).toHaveLength(3)
    expect(screen.queryByRole('textbox', { name: '搜索疾病目录' })).toBeNull()
  })
  it('keeps edited notes after autosave failure and retries the same draft before allowing whole-group confirmation', async () => {
    const page = props({ state: savedState() })
    const { rerender } = render(<DiagnosisPage {...page} />)
    const user = userEvent.setup()
    await user.type(screen.getByRole('textbox', { name: page.messages.diagnosisNote }), ' · 补充')
    const editedEntries = [
      { catalogItemId: 'diagnosis-1', role: 'primary' as const, note: '第一条保存备注 · 补充' },
      { catalogItemId: 'diagnosis-2', role: 'secondary' as const, note: '第二条保存备注' },
    ]
    await waitFor(() => expect(page.actions.save.onSubmit).toHaveBeenCalledExactlyOnceWith(editedEntries), { timeout: 2000 })
    const failed = { ...page.actions, save: { ...page.actions.save, error: new Error('synthetic save failure') } }
    rerender(<DiagnosisPage {...page} actions={failed} />)
    expect((screen.getByRole('textbox', { name: page.messages.diagnosisNote }) as HTMLTextAreaElement).value).toBe('第一条保存备注 · 补充')
    expect(screen.getByRole('button', { name: page.messages.confirmDiagnosis }).hasAttribute('disabled')).toBe(true)
    await user.click(screen.getByRole('button', { name: '重试保存' }))
    expect(page.actions.save.onSubmit).toHaveBeenCalledTimes(2)
    expect(page.actions.save.onSubmit).toHaveBeenLastCalledWith(editedEntries)
    const saved = { ...page.actions, save: { ...page.actions.save, success: true, savedRevision: JSON.stringify(editedEntries) } }
    rerender(<DiagnosisPage {...page} actions={saved} state={{ draft: { entries: editedEntries }, draftVersion: 2 }} />)
    await waitFor(() => expect(screen.getByRole('button', { name: page.messages.confirmDiagnosis }).hasAttribute('disabled')).toBe(false))
    rerender(<DiagnosisPage {...page} actions={{ ...saved, save: { ...saved.save, pending: true } }} state={{ draft: { entries: editedEntries }, draftVersion: 2 }} />)
    expect(screen.getByRole('button', { name: page.messages.confirmDiagnosis }).hasAttribute('disabled')).toBe(true)
    rerender(<DiagnosisPage {...page} actions={saved} state={{ draft: { entries: editedEntries }, draftVersion: 2 }} />)
    await user.click(screen.getByRole('button', { name: page.messages.confirmDiagnosis }))
    const review = within(screen.getByRole('alertdialog', { name: '确认诊断版本' }))
    expect(review.getByText(/SYN-1/)).toBeTruthy()
    expect(review.getByText(/SYN-2/)).toBeTruthy()
    expect(review.getByText('第一条保存备注 · 补充')).toBeTruthy()
    rerender(<DiagnosisPage {...page} actions={{ ...saved, save: { ...saved.save, pending: true } }} state={{ draft: { entries: editedEntries }, draftVersion: 2 }} />)
    expect(review.getByRole('button', { name: '确认诊断版本' }).hasAttribute('disabled')).toBe(true)
    rerender(<DiagnosisPage {...page} actions={saved} state={{ draft: { entries: editedEntries }, draftVersion: 2 }} />)
    await user.click(review.getByRole('button', { name: '确认诊断版本' }))
    expect(page.actions.confirm.onSubmit).toHaveBeenCalledOnce()
  })
  it('shows confirmed diagnoses in a searchable read-only list and detail view without exposing draft edits', async () => {
    const state = savedState(true)
    const page = props({ readOnly: true, state: { ...state, draft: { entries: [
      { catalogItemId: 'diagnosis-1', role: 'primary', note: '未确认的草稿内容' },
    ] } } })
    render(<DiagnosisPage {...page} />)
    const list = within(screen.getByRole('region', { name: '诊断列表' }))
    expect(list.getByRole('textbox', { name: '搜索本次诊断' })).toBeTruthy()
    expect(list.getAllByRole('button', { name: /合成诊断/ })).toHaveLength(2)
    expect(screen.getByText('第一条保存备注')).toBeTruthy()
    expect(screen.queryByText('未确认的草稿内容')).toBeNull()
    await userEvent.setup().click(list.getByRole('button', { name: /合成诊断2/ }))
    expect(screen.getByText('第二条保存备注')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: /诊断备注/ })).toBeNull()
    expect(screen.queryByRole('button', { name: '添加诊断' })).toBeNull()
    expect(screen.queryByRole('button', { name: '更换诊断' })).toBeNull()
    expect(screen.queryByRole('button', { name: /移除诊断/ })).toBeNull()
    expect(screen.queryByRole('button', { name: page.messages.confirmDiagnosis })).toBeNull()
    expect(screen.queryByRole('textbox', { name: '搜索疾病目录' })).toBeNull()
    expect(page.actions.save.onSubmit).not.toHaveBeenCalled()
  })
  it('replaces a confirmed diagnosis from the local fallback catalog while keeping its role and note', async () => {
    const { draft: _draft, ...confirmed } = savedState(true)
    const page = props({ state: confirmed })
    render(<DiagnosisPage {...page} catalog={[...page.catalog, {
      id: 'diagnosis-3', code: 'SYN-3', nameZh: '合成诊断3', nameEn: 'Synthetic diagnosis 3',
      system: 'https://clinmesh.example.com/icd-10', version: 1,
    }]} referenceSearch={{ ...page.referenceSearch, isError: true, error: new Error('synthetic catalog failure') }} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '更换诊断' }))
    const dialog = within(screen.getByRole('dialog', { name: '选择诊断' }))
    expect(dialog.getByRole('button', { name: '选择 合成诊断2 SYN-2' }).hasAttribute('disabled')).toBe(true)
    await user.click(dialog.getByRole('button', { name: '选择 合成诊断3 SYN-3' }))
    await user.click(dialog.getByRole('button', { name: '加入诊断' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const editor = within(screen.getByRole('region', { name: '诊断详情' }))
    expect(editor.getByRole('heading', { name: '合成诊断3' })).toBeTruthy()
    expect(editor.getByText('SYN-3')).toBeTruthy()
    expect((editor.getByRole('textbox', { name: page.messages.diagnosisNote }) as HTMLTextAreaElement).value).toBe('第一条保存备注')
    expect(editor.getByRole('button', { name: page.messages.primaryDiagnosis }).getAttribute('aria-pressed')).toBe('true')
  })
})
