// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebSurfaceCaseContextState } from '../web-runtime.tsx'
import { WebRuntimeProvider, type WebRuntimeValue } from '../web-runtime.tsx'
import { DoctorCaseLayout } from './responsive-layout.tsx'
import { useSurfaceCaseContextPort } from './surface-case-context.ts'

afterEach(cleanup)

function createState(caseId = 'case-001'): WebSurfaceCaseContextState {
  return {
    caseId,
    completion: undefined,
    detail: {
      allergies: [],
      caseId,
      encounter: { id: 'enc-001', status: 'in-progress', versionId: '1' },
      patient: {
        id: 'patient-001',
        identifier: 'HN-001',
        name: '合成患者陈明',
        synthetic: true,
        versionId: '1',
      },
      presentation: {
        chiefComplaint: '发热伴咽痛两天',
        summary: '发热伴咽痛两天',
        vitalSigns: {
          bloodPressure: { diastolicMmHg: 76, systolicMmHg: 118 },
          oxygenSaturationPct: 98,
          pulseBpm: 102,
          respirationBpm: 20,
          temperatureC: 38.2,
        },
      },
      priorFacts: [],
      status: 'in-progress',
      taskId: 'task-001',
      taskVersion: '1',
    },
    locale: 'zh-CN',
    section: 'consultation',
    statusText: '接诊中',
  }
}

function createPortStub() {
  const register = vi.fn((_state: WebSurfaceCaseContextState) => vi.fn())
  return { register }
}

function runtimeValue(overrides: Partial<WebRuntimeValue>): WebRuntimeValue {
  return { appearanceRoot: { current: null }, mode: 'standalone', ...overrides }
}

function Probe({ state }: { state: WebSurfaceCaseContextState | undefined }): null {
  useSurfaceCaseContextPort(state)
  return null
}

describe('useSurfaceCaseContextPort', () => {
  it('registers the snapshot in surface mode and disposes on change and unmount', () => {
    const port = createPortStub()
    const first = createState('case-001')
    const second = createState('case-002')
    const { rerender, unmount } = render(
      <WebRuntimeProvider
        value={runtimeValue({ mode: 'surface', surfaceCaseContext: port })}
      >
        <Probe state={first} />
      </WebRuntimeProvider>,
    )
    expect(port.register).toHaveBeenCalledWith(first)
    rerender(
      <WebRuntimeProvider
        value={runtimeValue({ mode: 'surface', surfaceCaseContext: port })}
      >
        <Probe state={second} />
      </WebRuntimeProvider>,
    )
    expect(port.register).toHaveBeenCalledTimes(2)
    expect(port.register.mock.results[0]!.value).toHaveBeenCalled()
    unmount()
    expect(port.register.mock.results[1]!.value).toHaveBeenCalled()
  })

  it('does not publish in standalone mode or when the host port is absent', () => {
    const port = createPortStub()
    const { rerender } = render(
      <WebRuntimeProvider value={runtimeValue({ mode: 'standalone', surfaceCaseContext: port })}>
        <Probe state={createState()} />
      </WebRuntimeProvider>,
    )
    rerender(
      <WebRuntimeProvider value={runtimeValue({ mode: 'surface' })}>
        <Probe state={createState()} />
      </WebRuntimeProvider>,
    )
    expect(port.register).not.toHaveBeenCalled()
  })

  it('unregisters when the published snapshot clears', () => {
    const port = createPortStub()
    const { rerender } = render(
      <WebRuntimeProvider
        value={runtimeValue({ mode: 'surface', surfaceCaseContext: port })}
      >
        <Probe state={createState()} />
      </WebRuntimeProvider>,
    )
    rerender(
      <WebRuntimeProvider
        value={runtimeValue({ mode: 'surface', surfaceCaseContext: port })}
      >
        <Probe state={undefined} />
      </WebRuntimeProvider>,
    )
    expect(port.register).toHaveBeenCalledTimes(1)
    expect(port.register.mock.results[0]!.value).toHaveBeenCalled()
  })
})

describe('DoctorCaseLayout railPlacement', () => {
  it('suppresses the inline rail and the compact sheet when hosted by DSH', () => {
    render(
      <DoctorCaseLayout
        contextLabel="病例上下文"
        railPlacement="host"
        rail={() => <div data-testid="inline-rail" />}
      >
        <div data-testid="case-content" />
      </DoctorCaseLayout>,
    )
    expect(screen.getByTestId('case-content')).toBeDefined()
    expect(screen.queryByTestId('inline-rail')).toBeNull()
    expect(screen.queryByRole('button', { name: '病例上下文' })).toBeNull()
  })

  it('keeps the inline rail mounted by default', () => {
    render(
      <DoctorCaseLayout
        contextLabel="病例上下文"
        rail={(expanded) => <div data-testid="inline-rail" data-expanded={expanded} />}
      >
        <div data-testid="case-content" />
      </DoctorCaseLayout>,
    )
    const rail = screen.getByTestId('inline-rail')
    expect(rail.getAttribute('data-expanded')).toBe('true')
  })

  it('still mounts the inline rail after unmounting a hosted layout', () => {
    const { rerender } = render(
      <DoctorCaseLayout
        contextLabel="病例上下文"
        railPlacement="host"
        rail={() => <div data-testid="inline-rail" />}
      >
        <div data-testid="case-content" />
      </DoctorCaseLayout>,
    )
    rerender(
      <DoctorCaseLayout
        contextLabel="病例上下文"
        rail={() => <div data-testid="inline-rail" />}
      >
        <div data-testid="case-content" />
      </DoctorCaseLayout>,
    )
    expect(screen.getByTestId('inline-rail')).toBeDefined()
  })
})
