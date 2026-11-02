// @vitest-environment jsdom
import { Button } from '@clinmesh/ui/components/button'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceActionBar, WorkspaceCardLayout, WorkspaceTabs } from './workspace-card-layout.tsx'

afterEach(cleanup)

function layout(busy?: string) {
  return <WorkspaceCardLayout id="busy-contract" patient={<p>合成患者</p>}
    action={<WorkspaceActionBar reason="还差：科室" busy={busy} action={<Button>确认挂号</Button>} />}>
    <input aria-label="挂号科室" />
  </WorkspaceCardLayout>
}

it('提交中主按钮转圈并写「正在…」，内容区不可编辑，结束后恢复', () => {
  const view = render(layout('正在挂号'))
  const bar = screen.getByRole('region', { name: '当前操作' })
  expect(bar.getAttribute('aria-busy')).toBe('true')
  expect(screen.getByRole('status').textContent).toBe('正在挂号')
  const pending = screen.getByRole('button', { name: '正在挂号' })
  expect(pending.hasAttribute('disabled')).toBe(true)
  expect(pending.querySelector('svg')).not.toBeNull()
  expect(screen.queryByRole('button', { name: '确认挂号' })).toBeNull()
  // inert 让内容区和患者头同时退出焦点与输入。
  expect(view.container.querySelector('input')!.closest('[inert]')).not.toBeNull()
  expect(screen.getByText('合成患者').closest('[inert]')).not.toBeNull()
  expect(bar.closest('[inert]')).toBeNull()

  view.rerender(layout())
  expect(screen.getByRole('button', { name: '确认挂号' })).toBeTruthy()
  expect(screen.getByText('还差：科室')).toBeTruthy()
  expect(view.container.querySelector('[inert]')).toBeNull()
})

it('操作栏包在内容里时只让操作栏以外的部分不可编辑', () => {
  const view = render(<WorkspaceCardLayout id="busy-nested" patient={<p>合成患者</p>}>
    <input aria-label="出院说明" />
    <div><WorkspaceActionBar busy="正在提交" action={<Button>确认收款</Button>} /></div>
  </WorkspaceCardLayout>)
  const bar = screen.getByRole('region', { name: '当前操作' })
  expect(bar.closest('[inert]')).toBeNull()
  expect(view.container.querySelector('input')!.closest('[inert]')).not.toBeNull()
  expect(screen.getByText('合成患者').closest('[inert]')).not.toBeNull()
})

it('提交时焦点留在操作栏，结束后回到主按钮', () => {
  const view = render(layout())
  screen.getByRole('button', { name: '确认挂号' }).focus()
  view.rerender(layout('正在挂号'))
  expect(document.activeElement).toBe(screen.getByRole('region', { name: '当前操作' }))
  view.rerender(layout())
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '确认挂号' }))
})

it('窄屏浮层里选中患者后队列收起，焦点回到队列按钮', () => {
  const width = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')!
  Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => 600 })
  try {
    render(<WorkspaceCardLayout id="overlay-focus" queue={<div data-workspace-queue-items=""><button>合成患者</button></div>}>
      <input aria-label="主诉" />
    </WorkspaceCardLayout>)
    fireEvent.click(screen.getByRole('button', { name: '展开队列' }))
    const row = screen.getByRole('button', { name: '合成患者' })
    row.focus()
    fireEvent.click(row)
    expect(screen.queryByRole('button', { name: '合成患者' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '展开队列' }))
  } finally {
    Object.defineProperty(Element.prototype, 'clientWidth', width)
  }
})

it('页签待办数用黄色标出，为 0 时不显示，读屏仍说明待办数且和助手条数分开', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  try {
    // jsdom 量不到宽度，非当前页签会收进「更多」，所以每次只断言当前页签。
    const tabs = (value: string) => <WorkspaceTabs id={`tab-counts-${value}`} value={value} onValueChange={() => {}} items={[
      { value: 'orders', label: '诊断医嘱', count: 2 }, { value: 'fees', label: '费用', count: 0, assistant: 1 }]} />
    render(tabs('orders'))
    expect(within(screen.getByRole('tab', { name: '诊断医嘱' })).getByText('2').className).toContain('text-warning')
    cleanup()
    render(tabs('fees'))
    const fees = screen.getByRole('tab', { name: '费用' })
    expect(within(fees).queryByText('0')).toBeNull()
    expect(within(fees).getByText('助手 1')).toBeTruthy()
    expect(fees.textContent).toContain('待办 0 项')
  } finally {
    vi.unstubAllGlobals()
  }
})
