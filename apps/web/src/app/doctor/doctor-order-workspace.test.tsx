// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { DoctorOrderWorkspace } from './doctor-order-workspace.tsx'

afterEach(cleanup)

it('preserves the search and remaining draft when the first order opens its record details', async () => {
  const workspace = (hasRecords: boolean) => <DoctorOrderWorkspace
    entry={<input aria-label="目录搜索" defaultValue="" />}
    pending={<input aria-label="第二项用量" defaultValue="1" />}
    records={<p>第一项已开具</p>}
    details={<p>第一项正式详情</p>}
    hasRecords={hasRecords}
  />
  const view = render(workspace(false))
  const user = userEvent.setup()
  await user.type(screen.getByRole('textbox', { name: '目录搜索' }), '合成药')
  await user.clear(screen.getByRole('textbox', { name: '第二项用量' }))
  await user.type(screen.getByRole('textbox', { name: '第二项用量' }), '2')
  expect(screen.queryByText('第一项正式详情')).toBeNull()
  view.rerender(workspace(true))
  expect(screen.getByDisplayValue('合成药')).toBeTruthy()
  expect(screen.getByDisplayValue('2')).toBeTruthy()
  expect(screen.getByText('第一项已开具')).toBeTruthy()
  expect(screen.getByText('第一项正式详情')).toBeTruthy()
})
