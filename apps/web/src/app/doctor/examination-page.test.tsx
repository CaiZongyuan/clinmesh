// @vitest-environment jsdom
import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { ExaminationPage } from './examination-page.tsx'
import { examinationFixture } from './examination.test-support.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('删除功能检查草稿须预览具体患者、项目和指征，保留不写入且确认后才删除', async () => {
  const request = examinationFixture()
  const detail = doctorCaseDetailSchema.parse({
    registrationNumber: null,
    allergies: [],
    caseId: 'case-delete',
    encounter: { id: 'encounter-delete', versionId: '3', status: 'in-progress' },
    patient: { id: 'patient-delete', identifier: 'SYN-DELETE', name: '合成删除患者', synthetic: true, versionId: '1' },
    presentation: null,
    priorFacts: [],
    status: 'first-visit',
    taskId: 'case-task',
    taskVersion: '1',
    examinationRequests: {
      draftVersion: 2,
      requests: [],
      draft: { service: request.service, indication: '胸部不适评估' },
    },
  })
  const writes: RequestInit[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/examination-services'))
        return Response.json({ items: [{ service: request.service, available: true }] })
      writes.push(init!)
      return Response.json({
        auditId: 'audit-delete',
        requestId: 'command-delete',
        effects: [],
        warnings: [],
        data: { caseId: detail.caseId, draftVersion: 3 },
      })
    }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ExaminationPage
        detail={detail}
        locale="zh-CN"
        readOnly={false}
        active
        elementId="examination"
        actionContext={undefined}
        onSelectRequest={() => undefined}
      />
    </QueryClientProvider>,
  )
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '删除草稿' }))
  const dialog = await screen.findByRole('dialog', { name: '删除功能检查草稿' })
  expect(dialog.textContent).toContain('合成删除患者')
  expect(dialog.textContent).toContain(request.service.name)
  expect(dialog.textContent).toContain('胸部不适评估')
  await user.click(screen.getByRole('button', { name: '保留草稿' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '删除功能检查草稿' })).toBeNull())
  expect(writes).toHaveLength(0)
  await user.click(screen.getByRole('button', { name: '删除草稿' }))
  await user.click(screen.getByRole('button', { name: '确认删除草稿' }))
  await vi.waitFor(() => expect(writes).toHaveLength(1))
  expect(writes[0]!.method).toBe('DELETE')
  expect(JSON.parse(String(writes[0]!.body))).toEqual({
    expectedVersions: { 'Encounter/encounter-delete': '3' },
    input: { expectedDraftVersion: 2 },
  })
  client.clear()
})

it('功能检查目录与指征保存为当前就诊草稿，开立使用最新草稿及Encounter版本', async () => {
  const request = examinationFixture(),
    service = request.service
  let detail = doctorCaseDetailSchema.parse({
    registrationNumber: null,
    allergies: [],
    caseId: 'case-1',
    encounter: { id: 'encounter-1', versionId: '3', status: 'in-progress' },
    patient: { id: 'patient-1', identifier: 'SYN-1', name: '合成患者', synthetic: true, versionId: '1' },
    presentation: null,
    priorFacts: [],
    status: 'first-visit',
    taskId: 'case-task',
    taskVersion: '1',
    examinationRequests: { draftVersion: 0, requests: [] },
  })
  const writes: { path: string; body: unknown }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/examination-services')) return Response.json({ items: [{ available: true, service }] })
      const body = JSON.parse(String(init?.body))
      writes.push({ path, body })
      if (path.endsWith('/draft')) {
        detail = {
          ...detail,
          examinationRequests: { draftVersion: 1, requests: [], draft: { service, indication: body.input.indication } },
        }
        return Response.json({
          auditId: 'audit-save',
          requestId: 'command-save',
          effects: [],
          warnings: [],
          data: { caseId: detail.caseId, draftVersion: 1 },
        })
      }
      if (path.endsWith('/actions/issue'))
        return Response.json({
          auditId: 'audit-issue',
          requestId: 'command-issue',
          effects: [],
          warnings: [],
          data: {
            caseId: detail.caseId,
            draftVersion: 2,
            request: { ...request, status: 'issued', report: undefined },
          },
        })
      throw new Error(`Unexpected ${path}`)
    }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const props = () => (
    <QueryClientProvider client={client}>
      <ExaminationPage
        detail={detail}
        locale="zh-CN"
        readOnly={false}
        active
        elementId="examination"
        actionContext={undefined}
        onSelectRequest={() => undefined}
      />
    </QueryClientProvider>
  )
  const view = render(props()),
    user = userEvent.setup()
  await user.click(await screen.findByRole('combobox', { name: '功能检查项目' }))
  await user.click(await screen.findByRole('option', { name: service.name }))
  await user.type(screen.getByLabelText('检查指征'), '胸部不适评估')
  await user.click(screen.getByRole('button', { name: '保存功能检查草稿' }))
  await vi.waitFor(() => expect(writes).toHaveLength(1))
  view.rerender(props())
  await user.click(await screen.findByRole('button', { name: '开立功能检查' }))
  await vi.waitFor(() => expect(writes).toHaveLength(2))
  expect(writes[0]!.body).toEqual({
    expectedVersions: { 'Encounter/encounter-1': '3' },
    input: { serviceId: service.id, indication: '胸部不适评估', expectedDraftVersion: 0 },
  })
  expect(writes[1]!.body).toEqual({
    expectedVersions: { 'Encounter/encounter-1': '3' },
    input: { expectedDraftVersion: 1 },
  })
  client.clear()
})
