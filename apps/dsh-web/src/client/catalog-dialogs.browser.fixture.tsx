import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { CaseLaboratoryCatalogSearch, ClinicalCatalog } from '@clinmesh/contracts/his'
import type {
  ReferenceDiagnosisCatalogSearch,
  ReferenceMedicationCatalogSearch,
} from '@clinmesh/contracts/reference-data'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
import { PersonaJobStatusNotice } from '../../../web/src/app/persona-job-failure.tsx'
import {
  DiagnosisCatalogDialog,
  LaboratoryCatalogDialog,
  MedicationCatalogDialog,
  type ReferenceCatalogSearchModel,
} from '../../../../apps/web/src/app/doctor/catalog-picker-dialogs.tsx'

type CatalogKind = 'diagnosis' | 'laboratory' | 'medication'

const triggerLabels: Record<CatalogKind, string> = {
  diagnosis: '添加诊断',
  laboratory: '选择检验项目',
  medication: '添加药品',
}

const searchInputLabels: Record<CatalogKind, string> = {
  diagnosis: '搜索疾病目录',
  laboratory: '搜索检验目录',
  medication: '搜索药品目录',
}

const diagnosisCatalog: ClinicalCatalog['diagnoses'] = [{
  code: 'J11.101',
  id: 'diag-influenza-a',
  nameEn: 'Influenza A',
  nameZh: '甲型流感',
  system: 'https://clinmesh.example.com/icd-10',
  version: 1,
}]

type PrescriptionMedication = Extract<ClinicalCatalog, { prescriptionConclusionSupported: true }>['medications'][number]

const medicationCatalog: PrescriptionMedication[] = [{
  allowedCombinationIds: [],
  allowedCourseDays: [3],
  allowedDoseTexts: ['每次 75mg'],
  allowedFrequencyCodes: ['bid'],
  allowedQuantities: [1],
  defaultCourseDays: 3,
  defaultDoseText: '每次 75mg',
  defaultFrequencyCode: 'bid',
  defaultQuantity: 1,
  id: 'med-oseltamivir',
  nameEn: 'Oseltamivir Capsule',
  nameZh: '奥司他韦胶囊',
  version: 1,
}]

function makeSearch<Data>(onSearch: (query: string, page: number) => void): ReferenceCatalogSearchModel<Data> {
  return { data: undefined, error: null, isError: false, isFetching: false, isPending: false, onSearch }
}

function CatalogDialog({ kind, onSearch }: {
  kind: CatalogKind
  onSearch: (query: string, page: number) => void
}) {
  const excludedIds = new Set<string>()
  const select = (): void => {}
  if (kind === 'diagnosis') {
    return (
      <DiagnosisCatalogDialog
        excludedIds={excludedIds}
        locale="zh-CN"
        localCatalog={diagnosisCatalog}
        onSelect={select}
        search={makeSearch<ReferenceDiagnosisCatalogSearch>(onSearch)}
      />
    )
  }
  if (kind === 'laboratory') {
    return (
      <LaboratoryCatalogDialog
        locale="zh-CN"
        onSelect={select}
        search={makeSearch<CaseLaboratoryCatalogSearch>(onSearch)}
      />
    )
  }
  return (
    <MedicationCatalogDialog
      excludedIds={excludedIds}
      locale="zh-CN"
      localCatalog={medicationCatalog}
      onSelect={select}
      search={makeSearch<ReferenceMedicationCatalogSearch>(onSearch)}
    />
  )
}

const settle = (milliseconds = 100): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds))

function typeInto(input: Element, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('Missing input value setter')
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function run() {
  const host = document.createElement('div')
  document.body.append(host)
  const shadow = host.attachShadow({ mode: 'open' })
  const container = document.createElement('div')
  shadow.append(container)
  const windowErrors: string[] = []
  window.addEventListener('error', event => { windowErrors.push(String(event.error ?? event.message)) })
  const results: Record<CatalogKind, { inputFound: boolean, calls: Array<[string, number]> }> = {
    diagnosis: { inputFound: false, calls: [] },
    laboratory: { inputFound: false, calls: [] },
    medication: { inputFound: false, calls: [] },
  }
  for (const kind of ['diagnosis', 'laboratory', 'medication'] as const) {
    const calls = results[kind].calls
    let root: Root | undefined
    flushSync(() => {
      root = createRoot(container)
      root.render(
        <PortalContainerProvider container={container}>
          <CatalogDialog kind={kind} onSearch={(query, page) => { calls.push([query, page]) }} />
        </PortalContainerProvider>,
      )
    })
    if (root === undefined) throw new Error('Missing React root')
    const trigger = [...container.querySelectorAll('button')].find(button => button.textContent === triggerLabels[kind])
    if (!trigger) throw new Error(`Missing ${kind} trigger`)
    trigger.click()
    await settle()
    const input = container.querySelector(`input[aria-label="${searchInputLabels[kind]}"]`)
    results[kind].inputFound = input instanceof HTMLInputElement
    if (kind === 'laboratory' && input instanceof HTMLInputElement) {
      typeInto(input, '血')
      await settle()
      typeInto(input, '血常规')
      await settle(450)
    }
    void root.unmount()
    container.textContent = ''
  }
  const personaRoot = createRoot(container)
  flushSync(() => {
    personaRoot.render(
      <PortalContainerProvider container={container}>
        <PersonaJobStatusNotice
          error={{ code: 'AI_RESPONSE_INVALID', message: 'Synthetic provider response is invalid' }}
          finishedAt="2026-09-20T07:23:32.782Z"
          label="患者档案生成失败"
          locale="zh-CN"
          status="failed"
        />
      </PortalContainerProvider>,
    )
  })
  const detailsTrigger = [...container.querySelectorAll('button')].find(button => button.textContent === '查看失败详情')
  if (!detailsTrigger) throw new Error('Missing persona failure details trigger')
  detailsTrigger.click()
  await settle()
  const dialog = container.querySelector('[role="dialog"]')
  const persona = {
    opened: dialog !== null,
    details: dialog?.textContent ?? '',
    portalOutsideShadow: document.body.querySelector('[role="dialog"]') !== null,
    closed: false,
  }
  const close = [...(dialog?.querySelectorAll('button') ?? [])].find(button => button.textContent === '关闭')
  if (!close) throw new Error('Missing persona failure details close button')
  close.click()
  await settle()
  persona.closed = container.querySelector('[role="dialog"]') === null
  personaRoot.unmount()
  document.title = encodeResult({ ...results, persona, windowErrors })
}

function encodeResult(value: unknown): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
}

void run().catch(error => { document.title = encodeResult({ error: String(error) }) })
