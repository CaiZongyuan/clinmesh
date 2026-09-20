// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { AgentPageRegistryProvider, useAgentPageRegistration, useRegisterAgentPage, useRegisterAgentForm } from './agent-page-context.tsx'

afterEach(cleanup)

it('reads the latest unsaved input only from forms in the registered page and patient scope', async () => {
  let read: () => unknown = () => undefined
  function Editor({ selectionId }: { selectionId: string }): React.JSX.Element {
    const [note, setNote] = useState('初始内容')
    useRegisterAgentForm({ viewId: 'consultation', selectionId, name: 'diagnosis', values: { note } })
    return <input aria-label={selectionId} value={note} onChange={event => setNote(event.currentTarget.value)} />
  }
  function Page(): null {
    useRegisterAgentPage({ actions: {}, label: '医生', claim: {
      version: 1, viewId: 'consultation', viewRevision: '1', ui: { status: 'ready' },
      selection: { id: 'case-1', kind: 'case', version: '1' },
    }, readState: () => ({ clinicalDocumentDraft: null }) })
    read = useAgentPageRegistration()?.readState ?? (() => undefined)
    return null
  }
  render(<AgentPageRegistryProvider><Page /><Editor selectionId="case-1" /><Editor selectionId="case-2" /></AgentPageRegistryProvider>)
  const user = userEvent.setup()
  await user.clear(screen.getByLabelText('case-1'))
  await user.type(screen.getByLabelText('case-1'), '尚未保存')
  expect(read()).toEqual({ clinicalDocumentDraft: null, forms: { diagnosis: { note: '尚未保存' } } })
})
