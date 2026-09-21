import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { CaseLaboratoryCatalogSearch, ClinicalCatalog } from '@clinmesh/contracts/his'
import type {
  ReferenceDiagnosisCatalogSearch,
  ReferenceMedicationCatalogSearch,
} from '@clinmesh/contracts/reference-data'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
import { AgentActionFeedbackProvider, useAgentActionFeedback } from '../../../web/src/app/agent-action-feedback.tsx'
import { WebRuntimeProvider } from '../../../web/src/app/web-runtime.tsx'
import '../../../web/src/app/agent-action-feedback.css'
import { PersonaJobStatusNotice } from '../../../web/src/app/persona-job-failure.tsx'
import {
  DiagnosisCatalogDialog,
  LaboratoryCatalogDialog,
  MedicationCatalogDialog,
  type ReferenceCatalogSearchModel,
} from '../../../../apps/web/src/app/doctor/catalog-picker-dialogs.tsx'

type CatalogKind = 'diagnosis' | 'laboratory' | 'medication'
let feedback: ReturnType<typeof useAgentActionFeedback>

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

const laboratoryConcept = {
  code: '6690-2', display: '合成白细胞计数', id: 'synthetic-wbc',
  sourceLocator: 'synthetic:test', system: 'http://loinc.org', version: '2.83',
}
const laboratoryCatalog: CaseLaboratoryCatalogSearch = {
  items: [{
    allowedIndicationCodes: ['clinical-evaluation'], componentServiceIds: [], doctorOrderable: true,
    executingDepartmentId: 'department-laboratory', id: 'synthetic-lab', localCode: 'SYN-LAB',
    nameZh: '合成白细胞计数', priceFen: 1000, referenceConcept: laboratoryConcept,
    referenceReleaseId: 'synthetic', reportDefinition: {
      conclusionTemplate: '合成检验结果',
      results: [{
        alternateCodings: [], referenceConcept: laboratoryConcept, referenceRange: { text: '合成结果' },
        valueType: 'string', allowedValues: ['合成结果'],
      }],
    },
    specimen: { code: 'blood', display: '血液' }, serviceKind: 'laboratory', tatMinutes: 20, version: 1,
  }],
  page: 1, pageSize: 20, total: 1,
}

function makeSearch<Data>(onSearch: (query: string, page: number) => void, data: Data): ReferenceCatalogSearchModel<Data> {
  return { data, error: null, isError: false, isFetching: false, isPending: false, onSearch }
}

function CatalogDialog({ kind, onSearch, onSelect }: {
  kind: CatalogKind
  onSearch: (query: string, page: number) => void
  onSelect: () => void
}) {
  feedback = useAgentActionFeedback({ identity: 'session:doctor', view: 'consultation', selection: 'case-1', section: kind })
  const excludedIds = new Set<string>()
  if (kind === 'diagnosis') {
    return (
      <DiagnosisCatalogDialog
        excludedIds={excludedIds}
        locale="zh-CN"
        localCatalog={diagnosisCatalog}
        onSelect={onSelect}
        search={makeSearch<ReferenceDiagnosisCatalogSearch>(onSearch, { items: [], page: 1, pageSize: 20, total: 0, releaseId: 'synthetic' })}
      />
    )
  }
  if (kind === 'laboratory') {
    return (
      <LaboratoryCatalogDialog
        locale="zh-CN"
        onSelect={onSelect}
        search={makeSearch(onSearch, laboratoryCatalog)}
      />
    )
  }
  return (
    <MedicationCatalogDialog
      excludedIds={excludedIds}
      locale="zh-CN"
      localCatalog={medicationCatalog}
      onSelect={onSelect}
      search={makeSearch<ReferenceMedicationCatalogSearch>(onSearch, {
        items: [{
          brandName: null, id: 'synthetic-product', code: 'SYN-1', genericName: '合成测试片',
          dosageForm: '片剂', strength: '10 mg', manufacturer: '合成药厂', approvalNumber: '合成批准号',
          packageDescription: '10片/盒', status: 'active', system: 'urn:synthetic:medication',
          version: '1', sourceLocator: 'synthetic:test',
        }], page: 1, pageSize: 20, total: 1, releaseId: 'synthetic',
      })}
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
  for (const style of document.querySelectorAll('style')) shadow.append(style.cloneNode(true))
  const container = document.createElement('div')
  shadow.append(container)
  const windowErrors: string[] = []
  window.addEventListener('error', event => { windowErrors.push(String(event.error ?? event.message)) })
  const results: Record<CatalogKind, {
    inputFound: boolean, calls: Array<[string, number]>, selectionStates: Array<string | null>,
    confirmDisabled: boolean[], confirmations: number,
    catalogHighlighted?: boolean, productHighlighted?: boolean, packageHighlighted?: boolean,
  }> = {
    diagnosis: { inputFound: false, calls: [], selectionStates: [], confirmDisabled: [], confirmations: 0 },
    laboratory: { inputFound: false, calls: [], selectionStates: [], confirmDisabled: [], confirmations: 0 },
    medication: { inputFound: false, calls: [], selectionStates: [], confirmDisabled: [], confirmations: 0 },
  }
  for (const kind of ['diagnosis', 'laboratory', 'medication'] as const) {
    const calls = results[kind].calls
    let root: Root | undefined
    flushSync(() => {
      root = createRoot(container)
      root.render(
        <WebRuntimeProvider value={{ mode: 'surface', appearanceRoot: { current: container } }}>
          <AgentActionFeedbackProvider>
            <PortalContainerProvider container={container}>
              <CatalogDialog kind={kind} onSearch={(query, page) => { calls.push([query, page]) }}
                onSelect={() => { results[kind].confirmations += 1 }} />
            </PortalContainerProvider>
          </AgentActionFeedbackProvider>
        </WebRuntimeProvider>,
      )
    })
    if (root === undefined) throw new Error('Missing React root')
    const trigger = [...container.querySelectorAll('button')].find(button => button.textContent === triggerLabels[kind])
    if (!trigger) throw new Error(`Missing ${kind} trigger`)
    trigger.click()
    await settle()
    if (kind !== 'laboratory') {
      const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
      dialog.style.cssText = 'position:relative;z-index:50;transform:translate(0px);width:340px'
      flushSync(() => feedback({ id: kind, operationId: `outpatient.${kind === 'diagnosis' ? 'diagnosis' : 'prescription'}.draft.set`, input: {}, phase: 'executing' }))
      await settle(200)
      const isHighlighted = (target: Element | null) => {
        if (!target) return false
        const targetRect = target.getBoundingClientRect()
        return [...dialog.querySelectorAll('.clinmesh-agent-target')].some(glow => {
          const glowRect = glow.getBoundingClientRect()
          return ['left', 'top', 'width', 'height'].every(key => Math.abs(
            (targetRect[key as keyof DOMRect] as number) - (glowRect[key as keyof DOMRect] as number),
          ) < 1)
        })
      }
      results[kind].catalogHighlighted = isHighlighted(dialog)
      if (kind === 'medication') {
        results[kind].productHighlighted = isHighlighted(dialog.querySelector('[data-agent-medication-name]'))
        results[kind].packageHighlighted = isHighlighted(dialog.querySelector('[data-agent-medication-package]'))
      }
    }
    const input = container.querySelector(`input[aria-label="${searchInputLabels[kind]}"]`)
    results[kind].inputFound = input instanceof HTMLInputElement
    if (kind === 'laboratory' && input instanceof HTMLInputElement) {
      typeInto(input, '血')
      await settle()
      typeInto(input, '血常规')
      await settle(450)
    }
    const selection = container.querySelector<HTMLButtonElement>('button[aria-pressed]')
    const confirm = [...container.querySelectorAll('button')].find(button => (
      button.textContent === { diagnosis: '加入诊断', laboratory: '确定选择', medication: '加入处方' }[kind]
    ))
    if (!selection || !confirm) throw new Error(`Missing ${kind} selection controls`)
    for (let index = 0; index < 4; index += 1) {
      results[kind].selectionStates.push(selection.getAttribute('aria-pressed'))
      results[kind].confirmDisabled.push(confirm.disabled)
      if (index < 3) {
        selection.click()
        await settle()
      }
    }
    if (results[kind].confirmations !== 0) throw new Error(`Selection unexpectedly confirmed ${kind}`)
    const row = selection.closest('tr')
    if (!row) throw new Error(`Missing ${kind} row`)
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }))
    await settle()
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
  for (let attempt = 0; attempt < 20 && container.querySelector('[role="dialog"]') !== null; attempt += 1) {
    await settle()
  }
  persona.closed = container.querySelector('[role="dialog"]') === null
  personaRoot.unmount()
  document.title = encodeResult({ ...results, persona, windowErrors })
}

function encodeResult(value: unknown): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
}

void run().catch(error => { document.title = encodeResult({ error: String(error) }) })
