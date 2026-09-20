import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { CaseLaboratoryCatalogSearch, ClinicalCatalog } from '@clinmesh/contracts/his'
import type {
  ReferenceDiagnosisCatalogSearch,
  ReferenceMedicationCatalogSearch,
} from '@clinmesh/contracts/reference-data'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
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
      search={makeSearch<ReferenceMedicationCatalogSearch>(onSearch, { items: [], page: 1, pageSize: 20, total: 0, releaseId: 'synthetic' })}
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
  const results: Record<CatalogKind, {
    inputFound: boolean, calls: Array<[string, number]>, selectionStates: Array<string | null>,
    confirmDisabled: boolean[], confirmations: number,
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
        <PortalContainerProvider container={container}>
          <CatalogDialog kind={kind} onSearch={(query, page) => { calls.push([query, page]) }}
            onSelect={() => { results[kind].confirmations += 1 }} />
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
  document.title = encodeResult({ ...results, windowErrors })
}

function encodeResult(value: unknown): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
}

void run().catch(error => { document.title = encodeResult({ error: String(error) }) })
