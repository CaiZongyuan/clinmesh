// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DoctorPreparationProvider, useDoctorPreparation } from './doctor-preparation-state.tsx'

function SubmissionControls() {
  const preparation = useDoctorPreparation()!
  const key = JSON.stringify(['workspace:epoch:doctor:case-preparation', 'diagnosis'])
  return <><p>{preparation.submitting('diagnosis') ? '正在确认' : '可继续'}</p>
    <button onClick={() => preparation.setSubmitting(key, 'request-old', true)}>开始原请求</button>
    <button onClick={() => preparation.setSubmitting(key, 'request-new', true)}>开始新请求</button>
    <button onClick={() => preparation.setSubmitting(key, 'request-old', false)}>原请求结束</button>
    <button onClick={() => preparation.setSubmitting(key, 'request-new', false)}>新请求结束</button></>
}

const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals() })

describe('doctor preparation submission state', () => {
  it('keeps the latest confirmation disabled until its own request settles', async () => {
    const client = new QueryClient()
    clients.push(client)
    render(<QueryClientProvider client={client}><DoctorPreparationProvider detail={undefined} enabled={false}
      scope="workspace:epoch:doctor:case-preparation" inputRevision="1"><SubmissionControls /></DoctorPreparationProvider></QueryClientProvider>)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '开始原请求' }))
    await user.click(screen.getByRole('button', { name: '开始新请求' }))
    await user.click(screen.getByRole('button', { name: '原请求结束' }))
    expect(screen.getByText('正在确认')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '新请求结束' }))
    expect(screen.getByText('可继续')).toBeTruthy()
  })
})
