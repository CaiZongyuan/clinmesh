import { Field as PrimitiveField } from '@clinmesh/ui/components/field'
import { cn } from '@clinmesh/ui/lib/utils'
import { Children, createContext, isValidElement, useContext, useState, type ComponentProps, type ReactNode } from 'react'
import { AgentDraftField } from '../workspace-card-layout.tsx'
import type { WorkspaceLocale } from '../workspace-i18n.ts'
import type { DoctorAgentDraftKind } from './doctor-case-support.tsx'

const DraftEdits = createContext<{ edits: Record<string, number>; dismiss(key: string, revision: number): void } | null>(null)
const DraftScope = createContext<{ caseId: string; kind: DoctorAgentDraftKind; revision: number; locale: WorkspaceLocale } | null>(null)
const DraftItem = createContext<string | undefined>(undefined)

export function DoctorDraftMarksProvider({ children }: { children: ReactNode }) {
  const [edits, setEdits] = useState<Record<string, number>>({})
  return <DraftEdits.Provider value={{ edits, dismiss: (key, revision) => setEdits(current => current[key] === revision ? current : { ...current, [key]: revision }) }}>
    {children}
  </DraftEdits.Provider>
}

export function DoctorDraftScope({ children, ...scope }: { caseId: string; kind: DoctorAgentDraftKind; revision: number; locale: WorkspaceLocale; children: ReactNode }) {
  return <DraftScope.Provider value={scope}>{children}</DraftScope.Provider>
}

export function DoctorDraftItemScope({ id, children }: { id: string | undefined; children: ReactNode }) {
  return <DraftItem.Provider value={id}>{children}</DraftItem.Provider>
}

export function useDoctorDraftItemEdit() {
  const scope = useContext(DraftScope)
  const marks = useContext(DraftEdits)
  return (id: string) => {
    if (scope !== null) marks?.dismiss(`${scope.caseId}:${scope.kind}:item:${id}`, scope.revision)
  }
}

export function DoctorDraftItem({ id, children, enabled = true }: { id: string; children: ReactNode; enabled?: boolean }) {
  const scope = useContext(DraftScope)
  const marks = useContext(DraftEdits)
  const key = scope === null ? '' : `${scope.caseId}:${scope.kind}:item:${id}`
  const assisted = enabled && scope !== null && marks !== null && scope.revision > (marks.edits[key] ?? 0)
  return <DoctorDraftItemScope id={id}><div className={cn('min-w-0 flex-1', assisted && 'rounded-md border border-dashed border-info')}><AgentDraftField assisted={assisted}
    locale={scope?.locale ?? 'zh-CN'}>
    {children}
  </AgentDraftField></div></DoctorDraftItemScope>
}

function fieldId(children: ReactNode): string | undefined {
  let result: string | undefined
  Children.forEach(children, child => {
    if (result !== undefined || !isValidElement<{ htmlFor?: string; children?: ReactNode }>(child)) return
    result = child.props.htmlFor ?? fieldId(child.props.children)
  })
  return result
}

export function DoctorDraftField(props: ComponentProps<typeof PrimitiveField> & { 'data-clinical-document-field'?: string }) {
  const scope = useContext(DraftScope)
  const marks = useContext(DraftEdits)
  const item = useContext(DraftItem)
  const id = fieldId(props.children)
  if (scope === null || marks === null || id === undefined || /correction|revision|reason/.test(id)
    || ['diagnosis', 'prescription', 'laboratory', 'imaging', 'pathology'].includes(scope.kind) && item === undefined) return <PrimitiveField {...props} />
  const key = `${scope.caseId}:${scope.kind}:${item ?? ''}:${id}`
  const assisted = scope.revision > (marks.edits[key] ?? 0) && (item === undefined || scope.revision > (marks.edits[`${scope.caseId}:${scope.kind}:item:${item}`] ?? 0))
  const { 'data-clinical-document-field': clinicalField, ...fieldProps } = props
  const placement = props.className?.split(' ').filter(token => token.includes('col-span')).join(' ')
  return <div className={placement} data-clinical-document-field={clinicalField}>
    <AgentDraftField assisted={assisted} locale={scope.locale} onUserEdit={() => marks.dismiss(key, scope.revision)}>
      <PrimitiveField {...fieldProps} />
    </AgentDraftField>
  </div>
}
