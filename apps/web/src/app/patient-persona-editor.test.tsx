// @vitest-environment jsdom
import type { PatientPersonaContent } from '@clinmesh/contracts/scenario'
import type { SessionContext } from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { PatientPersonaEditor } from './patient-persona-editor.tsx'

const session: SessionContext = {
  user: { id: 'admin', email: 'admin@demo.clinmesh.local', name: '合成管理员' }, availableRoles: [],
  actor: { actorId: 'actor-admin', epoch: 'epoch-1', locationId: 'admin-location', organizationId: 'hospital',
    practitionerId: 'admin', practitionerRoleId: 'role-admin', roleCode: 'administrator', scenarioRunId: 'run-1', workspaceId: 'workspace-demo' },
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear() })

it('retains an edited persona after a disclosure warning and saves a new revision only on confirmation', async () => {
  const content: PatientPersonaContent = {
    chiefComplaint: '头晕一周', knownHistorySummary: '高血压十年。', medicationMemory: '每天吃降压药。',
    openingStatement: '医生，我这几天头晕。', symptomExperience: '站起来时头晕。',
    persona: { attitude: '配合', character: '直爽', healthLiteracy: '一般', speechStyle: '短句' },
  }
  const requests: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (String(_url) === '/api/auth/context') return Response.json(session)
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
  render(<QueryClientProvider client={client}><PatientPersonaEditor caseId="case-persona" content={content} locale="zh-CN" session={session} onCancel={() => {}} onSaved={saved} /></QueryClientProvider>)
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

it('recovers a manually created first persona after remount with the original input and key', async () => {
  const content: PatientPersonaContent = {
    chiefComplaint: '胸闷一周', knownHistorySummary: '既往未发现慢性病。', medicationMemory: '无长期用药。',
    openingStatement: '走路时胸口发闷。', symptomExperience: '活动后胸闷，休息后缓解。',
    persona: { attitude: '配合', character: '平和', healthLiteracy: '一般', speechStyle: '简短' },
  }
  const attempts: Array<{ body: unknown; key: string | null }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url) === '/api/auth/context') return Response.json(session)
    attempts.push({ body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get('idempotency-key') })
    if (attempts.length === 1) throw new TypeError('Response lost')
    return Response.json({ auditId: 'audit-manual', requestId: 'request-manual', effects: [], warnings: [], data: {
      caseId: 'case-first', workspaceId: 'workspace-demo', revision: 1, content, createdAt: '2026-10-27T00:00:00Z',
      model: 'administrator-manual', inputHash: 'a'.repeat(64), outputHash: 'b'.repeat(64), promptHash: 'c'.repeat(64), promptVersion: 'patient-persona-manual-edit-v1',
    } })
  }))
  const saved = vi.fn(async () => {})
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const editor = () => <QueryClientProvider client={client}><PatientPersonaEditor caseId="case-first" content={content} locale="zh-CN" session={session} onCancel={() => {}} onSaved={saved} /></QueryClientProvider>
  const first = render(editor())
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '保存为新修订' }))
  expect(await screen.findByRole('button', { name: '恢复原档案操作' })).toBeTruthy()
  first.unmount()
  render(<QueryClientProvider client={client}><PatientPersonaEditor caseId="case-first" locale="zh-CN" session={session} onCancel={() => {}} onSaved={saved} /></QueryClientProvider>)
  expect(screen.getByLabelText('主诉')).toHaveProperty('value', '胸闷一周')
  await user.click(screen.getByRole('button', { name: '恢复原档案操作' }))
  await waitFor(() => expect(saved).toHaveBeenCalledOnce())
  expect(attempts).toHaveLength(2)
  expect(attempts[1]).toEqual(attempts[0])
  client.clear()
})

it('does not submit a manual persona after the authenticated epoch changes', async () => {
  let writes = 0
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    if (String(url) === '/api/auth/context') return Response.json({ ...session, actor: { ...session.actor, epoch: 'epoch-2' } })
    writes += 1
    throw new Error('Must not send the old intent')
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const content: PatientPersonaContent = {
    chiefComplaint: '胸闷', knownHistorySummary: '无慢性病史', medicationMemory: '无长期用药', openingStatement: '我胸闷', symptomExperience: '活动后胸闷',
    persona: { attitude: '配合', character: '平和', healthLiteracy: '一般', speechStyle: '简短' },
  }
  render(<QueryClientProvider client={client}><PatientPersonaEditor caseId="case-old" content={content} locale="zh-CN" session={session} onCancel={() => {}} onSaved={async () => {}} /></QueryClientProvider>)
  await userEvent.setup().click(screen.getByRole('button', { name: '保存为新修订' }))
  expect(await screen.findByText('保存失败')).toBeTruthy()
  expect(writes).toBe(0)
  expect(sessionStorage.length).toBe(0)
  client.clear()
})
