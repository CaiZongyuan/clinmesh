// @vitest-environment jsdom
import type { PatientPersonaContent } from '@clinmesh/contracts/scenario'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { PatientPersonaEditor } from './patient-persona-editor.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('retains an edited persona after a disclosure warning and saves a new revision only on confirmation', async () => {
  const content: PatientPersonaContent = {
    chiefComplaint: '头晕一周', knownHistorySummary: '高血压十年。', medicationMemory: '每天吃降压药。',
    openingStatement: '医生，我这几天头晕。', symptomExperience: '站起来时头晕。',
    persona: { attitude: '配合', character: '直爽', healthLiteracy: '一般', speechStyle: '短句' },
  }
  const requests: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body: unknown = JSON.parse(String(init?.body))
    requests.push(body)
    if (requests.length === 1) return Response.json({ error: { code: 'PERSONA_DIAGNOSIS_LEAK_WARNING', message: 'Diagnosis disclosure' } }, { status: 409 })
    return Response.json({
      auditId: 'audit-edit', requestId: 'request-edit', effects: [], warnings: [],
      data: {
        caseId: 'case-persona', workspaceId: 'workspace-demo', revision: 2,
        content: { ...content, knownHistorySummary: '高血压十年，定期复查。' },
        createdAt: '2026-09-16T00:00:00Z', model: 'administrator-manual',
        inputHash: 'a'.repeat(64), outputHash: 'b'.repeat(64), promptHash: 'c'.repeat(64), promptVersion: 'patient-persona-manual-edit-v1',
      },
    })
  }))
  const saved = vi.fn(async () => {})
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><PatientPersonaEditor caseId="case-persona" content={content} locale="zh-CN" onCancel={() => {}} onSaved={saved} /></QueryClientProvider>)
  const user = userEvent.setup()
  await user.clear(screen.getByLabelText('已知史'))
  await user.type(screen.getByLabelText('已知史'), '高血压十年，定期复查。')
  await user.click(screen.getByRole('button', { name: '保存为新修订' }))
  expect(await screen.findByText('档案可能透露本次诊断')).toBeTruthy()
  expect(saved).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '确认并强制保存' }))
  await waitFor(() => expect(saved).toHaveBeenCalledOnce())
  expect(requests).toEqual([
    { input: { content: { ...content, knownHistorySummary: '高血压十年，定期复查。' }, forceDiagnosisLeakOverride: false } },
    { input: { content: { ...content, knownHistorySummary: '高血压十年，定期复查。' }, forceDiagnosisLeakOverride: true } },
  ])
  client.clear()
})
