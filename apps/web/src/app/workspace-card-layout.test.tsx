// @vitest-environment jsdom
import { Button } from '@clinmesh/ui/components/button'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { WorkspaceActionBar, WorkspaceCardLayout } from './workspace-card-layout.tsx'

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
