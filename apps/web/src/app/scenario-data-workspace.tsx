import { useEffect, useState } from 'react'
import type { ScenarioDataset, ScenarioGenerationRequest } from '@clinmesh/contracts/scenario'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@clinmesh/ui/components/alert-dialog'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@clinmesh/ui/components/select'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@clinmesh/ui/components/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CircleAlertIcon,
  DatabaseIcon,
  FlaskConicalIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SaveIcon,
  SearchIcon,
  Trash2Icon,
} from 'lucide-react'
import {
  deleteScenarioDataset,
  enqueueScenarioGenerationJob,
  generateScenarioDataset,
  getScenarioDataset,
  getScenarioDatasets,
  getScenarioGenerationJob,
  getScenarioProviders,
  installScenarioDataset,
  newIdempotencyKey,
  sessionQueryKey,
  updateScenarioDataset,
} from './api-client.ts'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { PaginationControls } from './pagination-controls.tsx'

const providersQueryKey = ['scenario-providers'] as const
const datasetsQueryKey = ['scenario-datasets'] as const

function datasetQueryKey(datasetId: string) {
  return ['scenario-dataset', datasetId] as const
}

function generationJobQueryKey(jobId: string) {
  return ['scenario-generation-job', jobId] as const
}

const initialRequest: ScenarioGenerationRequest = {
  modules: ['fever'],
  name: '发热门诊样本',
  population: { age: { maximum: 65, minimum: 18 }, count: 1, gender: 'any' },
  providerId: 'builtin',
  seeds: { clinical: 7331, population: 4242 },
  timeRange: { end: '2026-08-01', start: '2020-01-01' },
  timeZone: 'Asia/Shanghai',
}

function updateModules(
  modules: ScenarioGenerationRequest['modules'],
  module: ScenarioGenerationRequest['modules'][number],
  checked: boolean,
): ScenarioGenerationRequest['modules'] {
  if (checked) return [...new Set([...modules, module])]
  return modules.length === 1 ? modules : modules.filter(candidate => candidate !== module)
}

function joinLines(values: readonly string[]): string {
  return values.join('\n')
}

function splitLines(value: string): string[] {
  return value.split('\n').map(line => line.trim()).filter(line => line.length > 0)
}

function updateAt<T>(values: readonly T[], index: number, update: (value: T) => T): T[] {
  return values.map((value, valueIndex) => valueIndex === index ? update(value) : value)
}

type InvestigationCatalogItem = ScenarioDataset['content']['catalog']['investigations'][number]
type InvestigationReferenceRange = InvestigationCatalogItem['referenceRanges'][number]
type ScenarioPatient = ScenarioDataset['content']['patients'][number]
type ScenarioHistoryEvent = ScenarioPatient['longitudinalHistory'][number]
type ScenarioFhirHistory = ScenarioPatient['fhirHistory'][number]
type ScenarioDiagnosis = ScenarioPatient['diagnosisSpace']['primary']
type UpdatePatient = (update: (patient: ScenarioPatient) => ScenarioPatient) => void

function updateFirstReferenceRange(
  item: InvestigationCatalogItem,
  update: (range: InvestigationReferenceRange) => InvestigationReferenceRange,
): InvestigationCatalogItem {
  const current = item.referenceRanges[0] ?? { appliesToGender: 'any' as const, text: '未设置' }
  return { ...item, referenceRanges: [update(current), ...item.referenceRanges.slice(1)] }
}

function withoutPhysiologyGenerator(item: InvestigationCatalogItem): InvestigationCatalogItem {
  const { physiologyGeneratorId: _removed, ...remaining } = item
  return remaining
}

function withoutComponents(item: InvestigationCatalogItem): InvestigationCatalogItem {
  const { componentItemIds: _removed, ...remaining } = item
  return remaining
}

function withoutNormalDistribution(item: InvestigationCatalogItem): InvestigationCatalogItem {
  const { normalDistribution: _removed, ...remaining } = item
  return remaining
}

function scalarHiddenFactValue(value: ScenarioDataset['content']['hiddenFacts'][number]['value']): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function nextScopedId(prefix: string, ids: readonly string[]): string {
  const existing = new Set(ids)
  let sequence = 1
  while (existing.has(`${prefix}-${sequence}`)) sequence += 1
  return `${prefix}-${sequence}`
}

function optionalString<T extends object, Key extends keyof T>(
  value: T,
  key: Key,
  next: string,
): T {
  if (next !== '') return Object.assign({}, value, { [key]: next })
  const copy = { ...value }
  Reflect.deleteProperty(copy, key)
  return copy
}

const fhirHistoryTypes = [
  'Condition',
  'Encounter',
  'Observation',
  'MedicationRequest',
  'AllergyIntolerance',
] as const

function createFhirHistoryResource(
  resourceType: ScenarioFhirHistory['resourceType'],
  id: string,
  timestamp: string,
): ScenarioFhirHistory {
  if (resourceType === 'Encounter') {
    return {
      classCode: 'AMB',
      id,
      period: { start: timestamp },
      resourceType,
      status: 'finished',
    }
  }
  if (resourceType === 'Observation') {
    return {
      code: { display: '待编辑观察' },
      effectiveDateTime: timestamp,
      id,
      resourceType,
      status: 'final',
      value: { outcome: 'reported', value: '待编辑结果' },
    }
  }
  if (resourceType === 'MedicationRequest') {
    return {
      authoredOn: timestamp,
      id,
      intent: 'order',
      medication: { display: '待编辑药品' },
      resourceType,
      status: 'active',
    }
  }
  if (resourceType === 'AllergyIntolerance') {
    return {
      clinicalStatus: 'active',
      code: { display: '待编辑过敏原' },
      id,
      recordedDate: timestamp,
      resourceType,
    }
  }
  return {
    clinicalStatus: 'active',
    code: { display: '待编辑诊断' },
    id,
    recordedDate: timestamp,
    resourceType,
  }
}

function HistoryEditor({
  locale,
  patient,
  timeRangeEnd,
  updatePatient,
}: {
  locale: WorkspaceLocale
  patient: ScenarioPatient
  timeRangeEnd: string
  updatePatient: UpdatePatient
}): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  const [newFhirResourceType, setNewFhirResourceType] = useState<ScenarioFhirHistory['resourceType']>('Condition')
  const timestamp = `${timeRangeEnd}T09:00:00+08:00`
  const updateHistoryEvent = (
    index: number,
    update: (event: ScenarioHistoryEvent) => ScenarioHistoryEvent,
  ): void => updatePatient(current => ({
    ...current,
    longitudinalHistory: updateAt(current.longitudinalHistory, index, update),
  }))
  const updateFhirHistory = (
    index: number,
    update: (resource: ScenarioFhirHistory) => ScenarioFhirHistory,
  ): void => updatePatient(current => ({
    ...current,
    fhirHistory: updateAt(current.fhirHistory, index, update),
  }))

  return (
    <TabsContent className="flex flex-col gap-6 pt-4" value="history">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{messages.longitudinalHistory}</h3>
          <Button onClick={() => updatePatient(current => {
            const id = nextScopedId(
              'history-event-new',
              current.longitudinalHistory.map(event => event.id),
            )
            return {
              ...current,
              longitudinalHistory: [...current.longitudinalHistory, {
                code: 'unmapped',
                display: '待编辑病史',
                id,
                kind: 'condition',
                mappedCode: null,
                occurredAt: timestamp,
                sourceResourceId: id.replace('history-event-', ''),
                sourceResourceType: 'Condition',
                status: 'active',
              }],
            }
          })} size="sm" type="button" variant="outline">
            <PlusIcon data-icon="inline-start" />{messages.addHistoryEvent}
          </Button>
        </div>
        {patient.longitudinalHistory.map((event, eventIndex) => {
          const suffix = ` ${eventIndex + 1}`
          return (
            <fieldset className="grid gap-4 border-b pb-4 md:grid-cols-2 xl:grid-cols-4" key={event.id}>
              <legend className="sr-only">{messages.historyDisplay}{suffix}</legend>
              <Field className="md:col-span-2">
                <FieldLabel htmlFor={`editor-history-display-${eventIndex}`}>{messages.historyDisplay}{suffix}</FieldLabel>
                <Input id={`editor-history-display-${eventIndex}`} onChange={change => updateHistoryEvent(eventIndex, current => ({ ...current, display: change.target.value }))} value={event.display} />
              </Field>
              <Field>
                <FieldLabel htmlFor={`editor-history-kind-${eventIndex}`}>{messages.historyKind}{suffix}</FieldLabel>
                <Select onValueChange={value => updateHistoryEvent(eventIndex, current => ({ ...current, kind: value as ScenarioHistoryEvent['kind'] }))} value={event.kind}>
                  <SelectTrigger className="w-full" id={`editor-history-kind-${eventIndex}`}><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup>{(['allergy', 'condition', 'encounter', 'medication', 'observation'] as const).map(kind => <SelectItem key={kind} value={kind}>{kind}</SelectItem>)}</SelectGroup></SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor={`editor-history-status-${eventIndex}`}>{messages.historyStatus}{suffix}</FieldLabel>
                <Input id={`editor-history-status-${eventIndex}`} onChange={change => updateHistoryEvent(eventIndex, current => ({ ...current, status: change.target.value }))} value={event.status} />
              </Field>
              <Field>
                <FieldLabel htmlFor={`editor-history-code-${eventIndex}`}>{messages.historyCode}{suffix}</FieldLabel>
                <Input id={`editor-history-code-${eventIndex}`} onChange={change => updateHistoryEvent(eventIndex, current => ({ ...current, code: change.target.value }))} value={event.code} />
              </Field>
              <Field>
                <FieldLabel htmlFor={`editor-history-mapped-${eventIndex}`}>{messages.mappedCode}{suffix}</FieldLabel>
                <Input id={`editor-history-mapped-${eventIndex}`} onChange={change => updateHistoryEvent(eventIndex, current => ({ ...current, mappedCode: change.target.value || null }))} value={event.mappedCode ?? ''} />
              </Field>
              <Field>
                <FieldLabel htmlFor={`editor-history-occurred-${eventIndex}`}>{messages.occurredAt}{suffix}</FieldLabel>
                <Input id={`editor-history-occurred-${eventIndex}`} onChange={change => updateHistoryEvent(eventIndex, current => ({ ...current, occurredAt: change.target.value }))} value={event.occurredAt} />
              </Field>
              <Field>
                <FieldLabel htmlFor={`editor-history-ended-${eventIndex}`}>{messages.endedAt}{suffix}</FieldLabel>
                <Input id={`editor-history-ended-${eventIndex}`} onChange={change => updateHistoryEvent(eventIndex, current => optionalString(current, 'endedAt', change.target.value))} value={event.endedAt ?? ''} />
              </Field>
              <Field>
                <FieldLabel htmlFor={`editor-history-source-type-${eventIndex}`}>{messages.sourceResourceType}{suffix}</FieldLabel>
                <Select onValueChange={value => updateHistoryEvent(eventIndex, current => ({ ...current, sourceResourceType: value as ScenarioHistoryEvent['sourceResourceType'] }))} value={event.sourceResourceType}>
                  <SelectTrigger className="w-full" id={`editor-history-source-type-${eventIndex}`}><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup>{fhirHistoryTypes.map(type => <SelectItem key={type} value={type}>{type}</SelectItem>)}</SelectGroup></SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor={`editor-history-source-id-${eventIndex}`}>{messages.sourceResourceId}{suffix}</FieldLabel>
                <Input id={`editor-history-source-id-${eventIndex}`} onChange={change => updateHistoryEvent(eventIndex, current => ({ ...current, sourceResourceId: change.target.value }))} value={event.sourceResourceId} />
              </Field>
              <div className="flex items-end justify-end">
                <Button aria-label={`${messages.removeHistoryEvent}${suffix}`} onClick={() => updatePatient(current => ({ ...current, longitudinalHistory: current.longitudinalHistory.filter((_, index) => index !== eventIndex) }))} size="icon" title={`${messages.removeHistoryEvent}${suffix}`} type="button" variant="ghost"><Trash2Icon /></Button>
              </div>
            </fieldset>
          )
        })}
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h3 className="text-sm font-semibold">{messages.fhirHistory}</h3>
          <div className="flex flex-wrap items-end gap-2">
            <Field className="w-52">
              <FieldLabel htmlFor="editor-new-fhir-resource-type">{messages.fhirResourceType}</FieldLabel>
              <Select onValueChange={value => setNewFhirResourceType(value as ScenarioFhirHistory['resourceType'])} value={newFhirResourceType}>
                <SelectTrigger className="w-full" id="editor-new-fhir-resource-type"><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup>{fhirHistoryTypes.map(type => <SelectItem key={type} value={type}>{type}</SelectItem>)}</SelectGroup></SelectContent>
              </Select>
            </Field>
            <Button onClick={() => updatePatient(current => {
              const id = nextScopedId(
                `history-${newFhirResourceType.toLowerCase()}`,
                current.fhirHistory.map(resource => resource.id),
              )
              return {
                ...current,
                fhirHistory: [...current.fhirHistory, createFhirHistoryResource(
                  newFhirResourceType,
                  id,
                  timestamp,
                )],
              }
            })} size="sm" type="button" variant="outline">
              <PlusIcon data-icon="inline-start" />{messages.addFhirHistory}
            </Button>
          </div>
        </div>
        {patient.fhirHistory.map((resource, resourceIndex) => {
          const suffix = ` ${resourceIndex + 1}`
          const removeButton = (
            <div className="flex items-end justify-end">
              <Button aria-label={`${messages.removeFhirHistory}${suffix}`} onClick={() => updatePatient(current => ({ ...current, fhirHistory: current.fhirHistory.filter((_, index) => index !== resourceIndex) }))} size="icon" title={`${messages.removeFhirHistory}${suffix}`} type="button" variant="ghost"><Trash2Icon /></Button>
            </div>
          )
          if (resource.resourceType === 'Encounter') {
            return <fieldset className="grid gap-4 border-b pb-4 md:grid-cols-2 xl:grid-cols-4" key={resource.id}>
              <legend className="pr-3 text-sm font-semibold">Encounter{suffix}</legend>
              <Field><FieldLabel htmlFor={`editor-fhir-id-${resourceIndex}`}>{messages.fhirResourceId}{suffix}</FieldLabel><Input id={`editor-fhir-id-${resourceIndex}`} onChange={change => updateFhirHistory(resourceIndex, current => current.resourceType === 'Encounter' ? { ...current, id: change.target.value } : current)} value={resource.id} /></Field>
              <Field><FieldLabel htmlFor={`editor-fhir-class-${resourceIndex}`}>{messages.fhirEncounterClass}{suffix}</FieldLabel><Input id={`editor-fhir-class-${resourceIndex}`} onChange={change => updateFhirHistory(resourceIndex, current => current.resourceType === 'Encounter' ? { ...current, classCode: change.target.value } : current)} value={resource.classCode} /></Field>
              <Field><FieldLabel htmlFor={`editor-fhir-status-${resourceIndex}`}>{messages.fhirEncounterStatus}{suffix}</FieldLabel><Input id={`editor-fhir-status-${resourceIndex}`} onChange={change => updateFhirHistory(resourceIndex, current => current.resourceType === 'Encounter' ? { ...current, status: change.target.value } : current)} value={resource.status} /></Field>
              <Field><FieldLabel htmlFor={`editor-fhir-start-${resourceIndex}`}>{messages.fhirEncounterStart}{suffix}</FieldLabel><Input id={`editor-fhir-start-${resourceIndex}`} onChange={change => updateFhirHistory(resourceIndex, current => current.resourceType === 'Encounter' ? { ...current, period: { ...current.period, start: change.target.value } } : current)} value={resource.period.start} /></Field>
              <Field><FieldLabel htmlFor={`editor-fhir-end-${resourceIndex}`}>{messages.fhirEncounterEnd}{suffix}</FieldLabel><Input id={`editor-fhir-end-${resourceIndex}`} onChange={change => updateFhirHistory(resourceIndex, current => current.resourceType === 'Encounter' ? { ...current, period: optionalString(current.period, 'end', change.target.value) } : current)} value={resource.period.end ?? ''} /></Field>
              {removeButton}
            </fieldset>
          }
          const isCondition = resource.resourceType === 'Condition'
          const isAllergy = resource.resourceType === 'AllergyIntolerance'
          if (isCondition || isAllergy) {
            const nameLabel = isCondition ? messages.fhirDiagnosisName : messages.fhirAllergyName
            const codeLabel = isCondition ? messages.fhirDiagnosisCode : messages.fhirAllergyCode
            return <fieldset className="grid gap-4 border-b pb-4 md:grid-cols-2 xl:grid-cols-4" key={resource.id}>
              <legend className="pr-3 text-sm font-semibold">{resource.resourceType}{suffix}</legend>
              <Field><FieldLabel htmlFor={`editor-fhir-id-${resourceIndex}`}>{messages.fhirResourceId}{suffix}</FieldLabel><Input id={`editor-fhir-id-${resourceIndex}`} onChange={change => updateFhirHistory(resourceIndex, current => current.resourceType === resource.resourceType ? { ...current, id: change.target.value } : current)} value={resource.id} /></Field>
              <Field><FieldLabel htmlFor={`editor-fhir-clinical-${resourceIndex}`}>{messages.fhirClinicalStatus}{suffix}</FieldLabel><Input id={`editor-fhir-clinical-${resourceIndex}`} onChange={change => updateFhirHistory(resourceIndex, current => current.resourceType === resource.resourceType ? { ...current, clinicalStatus: change.target.value } : current)} value={resource.clinicalStatus} /></Field>
              <Field><FieldLabel htmlFor={`editor-fhir-name-${resourceIndex}`}>{nameLabel}{suffix}</FieldLabel><Input id={`editor-fhir-name-${resourceIndex}`} onChange={change => updateFhirHistory(resourceIndex, current => current.resourceType === resource.resourceType ? { ...current, code: { ...current.code, display: change.target.value } } : current)} value={resource.code.display} /></Field>
              <Field><FieldLabel htmlFor={`editor-fhir-code-${resourceIndex}`}>{codeLabel}{suffix}</FieldLabel><Input id={`editor-fhir-code-${resourceIndex}`} onChange={change => updateFhirHistory(resourceIndex, current => current.resourceType === resource.resourceType ? { ...current, code: optionalString(current.code, 'code', change.target.value) } : current)} value={resource.code.code ?? ''} /></Field>
              {isCondition ? <>
                <Field><FieldLabel htmlFor={`editor-fhir-encounter-${resourceIndex}`}>{messages.fhirEncounterId}{suffix}</FieldLabel><Input id={`editor-fhir-encounter-${resourceIndex}`} onChange={change => updateFhirHistory(resourceIndex, current => current.resourceType === 'Condition' ? optionalString(current, 'encounterId', change.target.value) : current)} value={resource.encounterId ?? ''} /></Field>
                <Field><FieldLabel htmlFor={`editor-fhir-onset-${resourceIndex}`}>{messages.fhirOnsetAt}{suffix}</FieldLabel><Input id={`editor-fhir-onset-${resourceIndex}`} onChange={change => updateFhirHistory(resourceIndex, current => current.resourceType === 'Condition' ? optionalString(current, 'onsetDateTime', change.target.value) : current)} value={resource.onsetDateTime ?? ''} /></Field>
              </> : null}
              <Field><FieldLabel htmlFor={`editor-fhir-recorded-${resourceIndex}`}>{messages.fhirRecordedAt}{suffix}</FieldLabel><Input id={`editor-fhir-recorded-${resourceIndex}`} onChange={change => updateFhirHistory(resourceIndex, current => current.resourceType === resource.resourceType ? optionalString(current, 'recordedDate', change.target.value) : current)} value={resource.recordedDate ?? ''} /></Field>
              {removeButton}
            </fieldset>
          }
          if (resource.resourceType === 'Observation') {
            return <fieldset className="grid gap-4 border-b pb-4 md:grid-cols-2 xl:grid-cols-4" key={resource.id}>
              <legend className="pr-3 text-sm font-semibold">Observation{suffix}</legend>
              <Field><FieldLabel htmlFor={`editor-fhir-id-${resourceIndex}`}>{messages.fhirResourceId}{suffix}</FieldLabel><Input id={`editor-fhir-id-${resourceIndex}`} onChange={change => updateFhirHistory(resourceIndex, current => current.resourceType === 'Observation' ? { ...current, id: change.target.value } : current)} value={resource.id} /></Field>
              <Field><FieldLabel htmlFor={`editor-fhir-status-${resourceIndex}`}>{messages.historyStatus}{suffix}</FieldLabel><Input id={`editor-fhir-status-${resourceIndex}`} onChange={change => updateFhirHistory(resourceIndex, current => current.resourceType === 'Observation' ? { ...current, status: change.target.value } : current)} value={resource.status} /></Field>
              <Field><FieldLabel htmlFor={`editor-fhir-name-${resourceIndex}`}>{messages.fhirObservationName}{suffix}</FieldLabel><Input id={`editor-fhir-name-${resourceIndex}`} onChange={change => updateFhirHistory(resourceIndex, current => current.resourceType === 'Observation' ? { ...current, code: { ...current.code, display: change.target.value } } : current)} value={resource.code.display} /></Field>
              <Field><FieldLabel htmlFor={`editor-fhir-code-${resourceIndex}`}>{messages.fhirObservationCode}{suffix}</FieldLabel><Input id={`editor-fhir-code-${resourceIndex}`} onChange={change => updateFhirHistory(resourceIndex, current => current.resourceType === 'Observation' ? { ...current, code: optionalString(current.code, 'code', change.target.value) } : current)} value={resource.code.code ?? ''} /></Field>
              <Field><FieldLabel htmlFor={`editor-fhir-effective-${resourceIndex}`}>{messages.fhirEffectiveAt}{suffix}</FieldLabel><Input id={`editor-fhir-effective-${resourceIndex}`} onChange={change => updateFhirHistory(resourceIndex, current => current.resourceType === 'Observation' ? optionalString(current, 'effectiveDateTime', change.target.value) : current)} value={resource.effectiveDateTime ?? ''} /></Field>
              <Field><FieldLabel htmlFor={`editor-fhir-encounter-${resourceIndex}`}>{messages.fhirEncounterId}{suffix}</FieldLabel><Input id={`editor-fhir-encounter-${resourceIndex}`} onChange={change => updateFhirHistory(resourceIndex, current => current.resourceType === 'Observation' ? optionalString(current, 'encounterId', change.target.value) : current)} value={resource.encounterId ?? ''} /></Field>
              <Field><FieldLabel htmlFor={`editor-fhir-value-${resourceIndex}`}>{messages.fhirObservationValue}{suffix}</FieldLabel><Input disabled={resource.value.outcome !== 'reported' || typeof resource.value.value === 'boolean'} id={`editor-fhir-value-${resourceIndex}`} onChange={change => updateFhirHistory(resourceIndex, current => current.resourceType === 'Observation' && current.value.outcome === 'reported' && typeof current.value.value !== 'boolean' ? { ...current, value: { ...current.value, value: typeof current.value.value === 'number' ? Number(change.target.value) : change.target.value } } : current)} value={resource.value.outcome === 'reported' && typeof resource.value.value !== 'boolean' ? resource.value.value : ''} /></Field>
              {removeButton}
            </fieldset>
          }
          return <fieldset className="grid gap-4 border-b pb-4 md:grid-cols-2 xl:grid-cols-4" key={resource.id}>
            <legend className="pr-3 text-sm font-semibold">MedicationRequest{suffix}</legend>
            <Field><FieldLabel htmlFor={`editor-fhir-id-${resourceIndex}`}>{messages.fhirResourceId}{suffix}</FieldLabel><Input id={`editor-fhir-id-${resourceIndex}`} onChange={change => updateFhirHistory(resourceIndex, current => current.resourceType === 'MedicationRequest' ? { ...current, id: change.target.value } : current)} value={resource.id} /></Field>
            <Field><FieldLabel htmlFor={`editor-fhir-status-${resourceIndex}`}>{messages.fhirMedicationStatus}{suffix}</FieldLabel><Input id={`editor-fhir-status-${resourceIndex}`} onChange={change => updateFhirHistory(resourceIndex, current => current.resourceType === 'MedicationRequest' ? { ...current, status: change.target.value } : current)} value={resource.status} /></Field>
            <Field><FieldLabel htmlFor={`editor-fhir-intent-${resourceIndex}`}>{messages.fhirMedicationIntent}{suffix}</FieldLabel><Input id={`editor-fhir-intent-${resourceIndex}`} onChange={change => updateFhirHistory(resourceIndex, current => current.resourceType === 'MedicationRequest' ? { ...current, intent: change.target.value } : current)} value={resource.intent} /></Field>
            <Field><FieldLabel htmlFor={`editor-fhir-name-${resourceIndex}`}>{messages.fhirMedicationName}{suffix}</FieldLabel><Input id={`editor-fhir-name-${resourceIndex}`} onChange={change => updateFhirHistory(resourceIndex, current => current.resourceType === 'MedicationRequest' ? { ...current, medication: { ...current.medication, display: change.target.value } } : current)} value={resource.medication.display} /></Field>
            <Field><FieldLabel htmlFor={`editor-fhir-code-${resourceIndex}`}>{messages.fhirMedicationCode}{suffix}</FieldLabel><Input id={`editor-fhir-code-${resourceIndex}`} onChange={change => updateFhirHistory(resourceIndex, current => current.resourceType === 'MedicationRequest' ? { ...current, medication: optionalString(current.medication, 'code', change.target.value) } : current)} value={resource.medication.code ?? ''} /></Field>
            <Field><FieldLabel htmlFor={`editor-fhir-authored-${resourceIndex}`}>{messages.fhirAuthoredAt}{suffix}</FieldLabel><Input id={`editor-fhir-authored-${resourceIndex}`} onChange={change => updateFhirHistory(resourceIndex, current => current.resourceType === 'MedicationRequest' ? optionalString(current, 'authoredOn', change.target.value) : current)} value={resource.authoredOn ?? ''} /></Field>
            <Field><FieldLabel htmlFor={`editor-fhir-encounter-${resourceIndex}`}>{messages.fhirEncounterId}{suffix}</FieldLabel><Input id={`editor-fhir-encounter-${resourceIndex}`} onChange={change => updateFhirHistory(resourceIndex, current => current.resourceType === 'MedicationRequest' ? optionalString(current, 'encounterId', change.target.value) : current)} value={resource.encounterId ?? ''} /></Field>
            {removeButton}
          </fieldset>
        })}
      </div>
    </TabsContent>
  )
}

function DiagnosisListEditor({
  diagnoses,
  kind,
  locale,
  updatePatient,
}: {
  diagnoses: readonly ScenarioDiagnosis[]
  kind: 'comorbidities' | 'differentials'
  locale: WorkspaceLocale
  updatePatient: UpdatePatient
}): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  const isComorbidity = kind === 'comorbidities'
  const heading = isComorbidity ? messages.comorbidities : messages.differentials
  const addLabel = isComorbidity ? messages.addComorbidity : messages.addDifferential
  const removeLabel = isComorbidity ? messages.removeComorbidity : messages.removeDifferential
  const nameLabel = isComorbidity ? messages.comorbidityName : messages.differentialName
  const codeLabel = isComorbidity ? messages.comorbidityCode : messages.differentialCode
  const evidenceLabel = isComorbidity ? messages.comorbidityEvidence : messages.differentialEvidence

  return <div className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">{heading}</h3>
      <Button onClick={() => updatePatient(current => {
        const values = current.diagnosisSpace[kind]
        const id = nextScopedId(
          isComorbidity ? 'diagnosis-comorbidity-new' : 'diagnosis-differential-new',
          values.map(diagnosis => diagnosis.id),
        )
        return {
          ...current,
          diagnosisSpace: {
            ...current.diagnosisSpace,
            [kind]: [...values, {
              code: null,
              display: isComorbidity ? '待编辑共病' : '待编辑鉴别诊断',
              evidence: ['待补充依据'],
              id,
            }],
          },
        }
      })} size="sm" type="button" variant="outline"><PlusIcon data-icon="inline-start" />{addLabel}</Button>
    </div>
    {diagnoses.map((diagnosis, diagnosisIndex) => {
      const suffix = ` ${diagnosisIndex + 1}`
      const updateDiagnosis = (update: (value: ScenarioDiagnosis) => ScenarioDiagnosis): void => updatePatient(current => ({
        ...current,
        diagnosisSpace: {
          ...current.diagnosisSpace,
          [kind]: updateAt(current.diagnosisSpace[kind], diagnosisIndex, update),
        },
      }))
      return <fieldset className="grid gap-4 border-b pb-4 md:grid-cols-2 xl:grid-cols-4" key={diagnosis.id}>
        <legend className="sr-only">{nameLabel}{suffix}</legend>
        <Field className="md:col-span-2"><FieldLabel htmlFor={`editor-${kind}-name-${diagnosisIndex}`}>{nameLabel}{suffix}</FieldLabel><Input id={`editor-${kind}-name-${diagnosisIndex}`} onChange={change => updateDiagnosis(current => ({ ...current, display: change.target.value }))} value={diagnosis.display} /></Field>
        <Field><FieldLabel htmlFor={`editor-${kind}-code-${diagnosisIndex}`}>{codeLabel}{suffix}</FieldLabel><Input id={`editor-${kind}-code-${diagnosisIndex}`} onChange={change => updateDiagnosis(current => ({ ...current, code: change.target.value || null }))} value={diagnosis.code ?? ''} /></Field>
        <Field className="md:col-span-2"><FieldLabel htmlFor={`editor-${kind}-evidence-${diagnosisIndex}`}>{evidenceLabel}{suffix}</FieldLabel><Textarea id={`editor-${kind}-evidence-${diagnosisIndex}`} onChange={change => updateDiagnosis(current => ({ ...current, evidence: splitLines(change.target.value) }))} value={joinLines(diagnosis.evidence)} /></Field>
        <div className="flex items-end justify-end"><Button aria-label={`${removeLabel}${suffix}`} onClick={() => updatePatient(current => ({ ...current, diagnosisSpace: { ...current.diagnosisSpace, [kind]: current.diagnosisSpace[kind].filter((_, index) => index !== diagnosisIndex) } }))} size="icon" title={`${removeLabel}${suffix}`} type="button" variant="ghost"><Trash2Icon /></Button></div>
      </fieldset>
    })}
  </div>
}

function editableDataset(dataset: ScenarioDataset): ScenarioDataset {
  return {
    ...dataset,
    content: {
      ...dataset.content,
      patients: dataset.content.patients.map(patient => ({
        ...patient,
        investigations: patient.investigations.map(investigation => ({
          ...investigation,
          sourceLevel: 'L1',
        })),
      })),
    },
  }
}

function DatasetEditor({
  dataset,
  locale,
  onDeleted,
}: {
  dataset: ScenarioDataset
  locale: WorkspaceLocale
  onDeleted: () => void
}): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState(() => editableDataset(dataset))
  const [selectedPatientIndex, setSelectedPatientIndex] = useState(0)
  const save = useMutation({
    mutationFn: () => updateScenarioDataset(draft, newIdempotencyKey()),
    onSuccess: async response => {
      queryClient.setQueryData(datasetQueryKey(dataset.datasetId), response.data)
      await queryClient.invalidateQueries({ queryKey: datasetsQueryKey })
    },
  })
  const install = useMutation({
    mutationFn: () => installScenarioDataset(dataset.datasetId, dataset.version, newIdempotencyKey()),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: sessionQueryKey }),
        queryClient.invalidateQueries({ queryKey: ['scenario-current'] }),
      ])
    },
  })
  const remove = useMutation({
    mutationFn: () => deleteScenarioDataset(dataset.datasetId, dataset.version, newIdempotencyKey()),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: datasetQueryKey(dataset.datasetId) })
      await queryClient.invalidateQueries({ queryKey: datasetsQueryKey })
      onDeleted()
    },
  })
  const hasErrors = dataset.diagnostics.some(diagnostic => diagnostic.severity === 'error')
  const updatePatient = (
    update: (patient: ScenarioDataset['content']['patients'][number]) => ScenarioDataset['content']['patients'][number],
  ): void => {
    setDraft(current => ({
      ...current,
      content: {
        ...current.content,
        patients: updateAt(current.content.patients, selectedPatientIndex, update),
      },
    }))
  }
  const updateCatalogInvestigation = (
    index: number,
    update: (item: ScenarioDataset['content']['catalog']['investigations'][number]) => ScenarioDataset['content']['catalog']['investigations'][number],
  ): void => {
    setDraft(current => ({
      ...current,
      content: {
        ...current.content,
        catalog: {
          ...current.content.catalog,
          investigations: updateAt(current.content.catalog.investigations, index, update),
        },
      },
    }))
  }
  const updateCatalogMedication = (
    index: number,
    update: (item: ScenarioDataset['content']['catalog']['medications'][number]) => ScenarioDataset['content']['catalog']['medications'][number],
  ): void => {
    setDraft(current => ({
      ...current,
      content: {
        ...current.content,
        catalog: {
          ...current.content.catalog,
          medications: updateAt(current.content.catalog.medications, index, update),
        },
      },
    }))
  }
  const updateInventoryLot = (
    index: number,
    update: (lot: ScenarioDataset['content']['inventory'][number]) => ScenarioDataset['content']['inventory'][number],
  ): void => {
    setDraft(current => ({
      ...current,
      content: {
        ...current.content,
        inventory: updateAt(current.content.inventory, index, update),
      },
    }))
  }
  const updateHiddenFact = (
    index: number,
    update: (fact: ScenarioDataset['content']['hiddenFacts'][number]) => ScenarioDataset['content']['hiddenFacts'][number],
  ): void => {
    setDraft(current => ({
      ...current,
      content: {
        ...current.content,
        hiddenFacts: updateAt(current.content.hiddenFacts, index, update),
      },
    }))
  }
  const updateRevealPolicy = (
    index: number,
    update: (policy: ScenarioDataset['content']['revealPolicies'][number]) => ScenarioDataset['content']['revealPolicies'][number],
  ): void => {
    setDraft(current => ({
      ...current,
      content: {
        ...current.content,
        revealPolicies: updateAt(current.content.revealPolicies, index, update),
      },
    }))
  }
  const updateSimulatorRule = (
    index: number,
    update: (rule: ScenarioDataset['content']['simulatorRules'][number]) => ScenarioDataset['content']['simulatorRules'][number],
  ): void => {
    setDraft(current => ({
      ...current,
      content: {
        ...current.content,
        simulatorRules: updateAt(current.content.simulatorRules, index, update),
      },
    }))
  }
  const patient = draft.content.patients[selectedPatientIndex] ?? draft.content.patients[0]!
  const mutationError = save.error ?? install.error ?? remove.error

  return (
    <section aria-labelledby="dataset-editor-heading" className="flex flex-col gap-5 border-t pt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold" id="dataset-editor-heading">{messages.datasetEditor}</h2>
          <div className="text-sm text-muted-foreground">
            {messages.datasetVersion.replace('{version}', String(dataset.version))}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            <SaveIcon data-icon="inline-start" />
            {messages.saveChanges}
          </Button>
          <Button disabled={hasErrors || install.isPending} onClick={() => install.mutate()} variant="outline">
            <PlayIcon data-icon="inline-start" />
            {messages.installDataset}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger render={<Button disabled={remove.isPending} variant="destructive" />}>
              <Trash2Icon data-icon="inline-start" />
              {messages.deleteDataset}
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{messages.deleteDatasetTitle}</AlertDialogTitle>
                <AlertDialogDescription>{messages.deleteDatasetDescription}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{messages.cancel}</AlertDialogCancel>
                <AlertDialogAction onClick={() => remove.mutate()} variant="destructive">
                  {messages.confirmDelete}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {dataset.diagnostics.length > 0 ? (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>{messages.validationErrors}</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {dataset.diagnostics.map(diagnostic => (
                <li key={`${diagnostic.code}:${diagnostic.path}`}>{diagnostic.path}: {diagnostic.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <FieldGroup className="grid gap-4 md:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="editor-dataset-name">{messages.datasetName}</FieldLabel>
          <Input id="editor-dataset-name" onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} value={draft.name} />
        </Field>
        <Field>
          <FieldLabel htmlFor="editor-hospital-name">{messages.hospitalDisplayName}</FieldLabel>
          <Input id="editor-hospital-name" onChange={event => setDraft(current => ({
            ...current,
            content: { ...current.content, hospital: { ...current.content.hospital, name: event.target.value } },
          }))} value={draft.content.hospital.name} />
        </Field>
      </FieldGroup>

      {draft.content.patients.length > 1 ? (
        <Field className="max-w-sm">
          <FieldLabel htmlFor="editor-patient-selection">{messages.patientSelection}</FieldLabel>
          <Select
            onValueChange={value => setSelectedPatientIndex(Number(value))}
            value={String(selectedPatientIndex)}
          >
            <SelectTrigger className="w-full" id="editor-patient-selection">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {draft.content.patients.map((candidate, index) => (
                  <SelectItem key={candidate.id} value={String(index)}>
                    {index + 1}. {candidate.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      ) : null}

      <Tabs defaultValue="patient" className="min-w-0">
        <TabsList className="max-w-full justify-start overflow-x-auto" variant="line">
          <TabsTrigger value="patient">{messages.casePatientTab}</TabsTrigger>
          <TabsTrigger value="history">{messages.caseHistoryTab}</TabsTrigger>
          <TabsTrigger value="symptoms">{messages.caseSymptomsTab}</TabsTrigger>
          <TabsTrigger value="clinical">{messages.caseClinicalTab}</TabsTrigger>
          <TabsTrigger value="decision">{messages.caseDecisionTab}</TabsTrigger>
          <TabsTrigger value="catalog">{messages.caseCatalogTab}</TabsTrigger>
          <TabsTrigger value="rules">{messages.caseRulesTab}</TabsTrigger>
        </TabsList>

        <TabsContent className="pt-4" value="patient">
          <FieldGroup className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Field>
              <FieldLabel htmlFor="editor-patient-name">{messages.patientName}</FieldLabel>
              <Input id="editor-patient-name" onChange={event => updatePatient(current => ({ ...current, name: event.target.value }))} value={patient.name} />
            </Field>
            <Field>
              <FieldLabel htmlFor="editor-patient-birth">{messages.birthDate}</FieldLabel>
              <Input id="editor-patient-birth" onChange={event => updatePatient(current => ({ ...current, birthDate: event.target.value }))} type="date" value={patient.birthDate} />
            </Field>
            <Field>
              <FieldLabel htmlFor="editor-patient-gender">{messages.gender}</FieldLabel>
              <Select
                onValueChange={value => updatePatient(current => ({
                  ...current,
                  gender: value as typeof current.gender,
                }))}
                value={patient.gender}
              >
                <SelectTrigger className="w-full" id="editor-patient-gender"><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup>
                  {(['female', 'male', 'other', 'unknown'] as const).map(gender => (
                    <SelectItem key={gender} value={gender}>{messages[`gender_${gender}`]}</SelectItem>
                  ))}
                </SelectGroup></SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="editor-patient-occupation">{messages.occupation}</FieldLabel>
              <Input id="editor-patient-occupation" onChange={event => updatePatient(current => ({
                ...current,
                persona: { ...current.persona, occupation: event.target.value },
              }))} value={patient.persona.occupation} />
            </Field>
            <Field className="md:col-span-2">
              <FieldLabel htmlFor="editor-chief-complaint">{messages.chiefComplaint}</FieldLabel>
              <Input id="editor-chief-complaint" onChange={event => updatePatient(current => ({
                ...current,
                patientKnowledge: { ...current.patientKnowledge, chiefComplaint: event.target.value },
              }))} value={patient.patientKnowledge.chiefComplaint} />
            </Field>
            <Field className="md:col-span-2">
              <FieldLabel htmlFor="editor-opening-statement">{messages.openingStatement}</FieldLabel>
              <Input id="editor-opening-statement" onChange={event => updatePatient(current => ({
                ...current,
                encounter: { ...current.encounter, openingStatement: event.target.value },
              }))} value={patient.encounter.openingStatement} />
            </Field>
            <Field className="md:col-span-2">
              <FieldLabel htmlFor="editor-persona-attitude">{messages.patientAttitude}</FieldLabel>
              <Textarea id="editor-persona-attitude" onChange={event => updatePatient(current => ({
                ...current,
                persona: { ...current.persona, attitude: event.target.value },
              }))} value={patient.persona.attitude} />
            </Field>
            <Field className="md:col-span-2">
              <FieldLabel htmlFor="editor-medication-memory">{messages.medicationMemory}</FieldLabel>
              <Textarea id="editor-medication-memory" onChange={event => updatePatient(current => ({
                ...current,
                patientKnowledge: { ...current.patientKnowledge, medicationMemory: event.target.value },
              }))} value={patient.patientKnowledge.medicationMemory} />
            </Field>
            <Field>
              <FieldLabel htmlFor="editor-temperature">{messages.temperatureC}</FieldLabel>
              <Input id="editor-temperature" onChange={event => updatePatient(current => ({
                ...current,
                physiologyBaseline: {
                  ...current.physiologyBaseline,
                  vitalSigns: { ...current.physiologyBaseline.vitalSigns, temperatureC: Number(event.target.value) },
                },
              }))} step="0.1" type="number" value={patient.physiologyBaseline.vitalSigns.temperatureC ?? ''} />
            </Field>
            <Field>
              <FieldLabel htmlFor="editor-systolic">{messages.systolicMmHg}</FieldLabel>
              <Input id="editor-systolic" onChange={event => updatePatient(current => ({
                ...current,
                physiologyBaseline: {
                  ...current.physiologyBaseline,
                  vitalSigns: { ...current.physiologyBaseline.vitalSigns, systolicMmHg: Number(event.target.value) },
                },
              }))} type="number" value={patient.physiologyBaseline.vitalSigns.systolicMmHg ?? ''} />
            </Field>
            <Field>
              <FieldLabel htmlFor="editor-diastolic">{messages.diastolicMmHg}</FieldLabel>
              <Input id="editor-diastolic" onChange={event => updatePatient(current => ({
                ...current,
                physiologyBaseline: {
                  ...current.physiologyBaseline,
                  vitalSigns: { ...current.physiologyBaseline.vitalSigns, diastolicMmHg: Number(event.target.value) },
                },
              }))} type="number" value={patient.physiologyBaseline.vitalSigns.diastolicMmHg ?? ''} />
            </Field>
          </FieldGroup>
        </TabsContent>

        <HistoryEditor
          locale={locale}
          patient={patient}
          timeRangeEnd={draft.content.reproduction.timeRange.end}
          updatePatient={updatePatient}
        />

        <TabsContent className="flex flex-col gap-5 pt-4" value="symptoms">
          {patient.symptomResponses.map((response, responseIndex) => (
            <fieldset className="grid gap-4 border-b pb-5 md:grid-cols-2" key={response.id}>
              <legend className="pr-3 text-sm font-semibold">{response.name}</legend>
              <Field>
                <FieldLabel htmlFor={`editor-symptom-name-${responseIndex}`}>{messages.topicName}</FieldLabel>
                <Input id={`editor-symptom-name-${responseIndex}`} onChange={event => updatePatient(current => ({
                  ...current,
                  symptomResponses: current.symptomResponses.map((item, index) => index === responseIndex
                    ? { ...item, name: event.target.value }
                    : item),
                }))} value={response.name} />
              </Field>
              <Field orientation="horizontal" className="self-end pb-2">
                <Checkbox checked={response.passive} id={`editor-symptom-passive-${responseIndex}`} onCheckedChange={checked => updatePatient(current => ({
                  ...current,
                  symptomResponses: current.symptomResponses.map((item, index) => index === responseIndex
                    ? { ...item, passive: checked === true }
                    : item),
                }))} />
                <FieldLabel htmlFor={`editor-symptom-passive-${responseIndex}`}>{messages.passiveSymptom}</FieldLabel>
              </Field>
              <Field>
                <FieldLabel htmlFor={`editor-response-points-${responseIndex}`}>{messages.responsePoints}</FieldLabel>
                <Textarea id={`editor-response-points-${responseIndex}`} onChange={event => updatePatient(current => ({
                  ...current,
                  symptomResponses: current.symptomResponses.map((item, index) => index === responseIndex
                    ? { ...item, responsePoints: splitLines(event.target.value) }
                    : item),
                }))} value={joinLines(response.responsePoints)} />
              </Field>
              <Field>
                <FieldLabel htmlFor={`editor-denials-${responseIndex}`}>{messages.denials}</FieldLabel>
                <Textarea id={`editor-denials-${responseIndex}`} onChange={event => updatePatient(current => ({
                  ...current,
                  symptomResponses: current.symptomResponses.map((item, index) => index === responseIndex
                    ? { ...item, denies: splitLines(event.target.value) }
                    : item),
                }))} value={joinLines(response.denies)} />
              </Field>
              {response.secondAskConcede === undefined ? null : (
                <>
                  <Field>
                    <FieldLabel htmlFor={`editor-first-response-${responseIndex}`}>{messages.firstResponse}</FieldLabel>
                    <Textarea id={`editor-first-response-${responseIndex}`} onChange={event => updatePatient(current => ({
                      ...current,
                      symptomResponses: current.symptomResponses.map((item, index) => index === responseIndex
                        ? { ...item, secondAskConcede: { ...item.secondAskConcede!, firstResponse: event.target.value } }
                        : item),
                    }))} value={response.secondAskConcede.firstResponse} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`editor-revealed-response-${responseIndex}`}>{messages.revealedResponse}</FieldLabel>
                    <Textarea id={`editor-revealed-response-${responseIndex}`} onChange={event => updatePatient(current => ({
                      ...current,
                      symptomResponses: current.symptomResponses.map((item, index) => index === responseIndex
                        ? { ...item, secondAskConcede: { ...item.secondAskConcede!, revealedResponse: event.target.value } }
                        : item),
                    }))} value={response.secondAskConcede.revealedResponse} />
                  </Field>
                </>
              )}
            </fieldset>
          ))}
        </TabsContent>

        <TabsContent className="flex flex-col gap-6 pt-4" value="clinical">
          <div className="flex flex-col gap-4">
            <h3 className="text-sm font-semibold">{messages.examinationFindings}</h3>
            {patient.examinationFindings.map((finding, findingIndex) => (
              <fieldset className="grid gap-4 border-b pb-4 md:grid-cols-2" key={finding.id}>
                <legend className="sr-only">{finding.name}</legend>
                <Field>
                  <FieldLabel htmlFor={`editor-exam-name-${findingIndex}`}>{messages.examinationName}</FieldLabel>
                  <Input id={`editor-exam-name-${findingIndex}`} onChange={event => updatePatient(current => ({
                    ...current,
                    examinationFindings: current.examinationFindings.map((item, index) => index === findingIndex
                      ? { ...item, name: event.target.value }
                      : item),
                  }))} value={finding.name} />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`editor-exam-abnormal-${findingIndex}`}>{messages.abnormalFindings}</FieldLabel>
                  <Textarea id={`editor-exam-abnormal-${findingIndex}`} onChange={event => updatePatient(current => ({
                    ...current,
                    examinationFindings: current.examinationFindings.map((item, index) => index === findingIndex
                      ? { ...item, abnormal: splitLines(event.target.value) }
                      : item),
                  }))} value={joinLines(finding.abnormal)} />
                </Field>
                <Field className="md:col-span-2">
                  <FieldLabel htmlFor={`editor-exam-finding-${findingIndex}`}>{messages.examinationFinding}</FieldLabel>
                  <Textarea id={`editor-exam-finding-${findingIndex}`} onChange={event => updatePatient(current => ({
                    ...current,
                    examinationFindings: current.examinationFindings.map((item, index) => index === findingIndex
                      ? { ...item, finding: event.target.value }
                      : item),
                  }))} value={finding.finding} />
                </Field>
              </fieldset>
            ))}
          </div>
          <div className="flex flex-col gap-4">
            <h3 className="text-sm font-semibold">{messages.investigationTruth}</h3>
            {patient.investigations.map((investigation, investigationIndex) => (
              <fieldset className="grid gap-4 border-b pb-4 md:grid-cols-2 xl:grid-cols-4" key={investigation.id}>
                <legend className="pr-3 text-sm font-semibold">{investigation.name}</legend>
                <Field>
                  <FieldLabel htmlFor={`editor-investigation-level-${investigationIndex}`}>{messages.sourceLevel}</FieldLabel>
                  <Badge aria-label={messages.sourceLevel} id={`editor-investigation-level-${investigationIndex}`} variant="secondary">L1</Badge>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`editor-investigation-value-${investigationIndex}`}>{messages.resultValue}</FieldLabel>
                  <Input disabled={investigation.result.outcome !== 'reported' || typeof investigation.result.value === 'boolean'} id={`editor-investigation-value-${investigationIndex}`} onChange={event => updatePatient(current => ({
                    ...current,
                    investigations: current.investigations.map((item, index) => index === investigationIndex && item.result.outcome === 'reported'
                      ? {
                          ...item,
                          result: {
                            ...item.result,
                            value: typeof item.result.value === 'number'
                              ? Number(event.target.value)
                              : event.target.value,
                          },
                        }
                      : item),
                  }))} value={investigation.result.outcome === 'reported' && typeof investigation.result.value !== 'boolean' ? investigation.result.value : ''} />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`editor-investigation-tat-${investigationIndex}`}>{messages.tatMinutes}</FieldLabel>
                  <Input id={`editor-investigation-tat-${investigationIndex}`} min={0} onChange={event => updatePatient(current => ({
                    ...current,
                    investigations: current.investigations.map((item, index) => index === investigationIndex
                      ? { ...item, tatMinutes: Number(event.target.value) }
                      : item),
                  }))} type="number" value={investigation.tatMinutes} />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`editor-investigation-fee-${investigationIndex}`}>{messages.feeFen}</FieldLabel>
                  <Input id={`editor-investigation-fee-${investigationIndex}`} min={0} onChange={event => updatePatient(current => ({
                    ...current,
                    investigations: current.investigations.map((item, index) => index === investigationIndex
                      ? { ...item, feeFen: Number(event.target.value) }
                      : item),
                  }))} type="number" value={investigation.feeFen} />
                </Field>
                <Field className="md:col-span-2 xl:col-span-4">
                  <FieldLabel htmlFor={`editor-investigation-report-${investigationIndex}`}>{messages.reportText}</FieldLabel>
                  <Textarea id={`editor-investigation-report-${investigationIndex}`} onChange={event => updatePatient(current => ({
                    ...current,
                    investigations: current.investigations.map((item, index) => index === investigationIndex
                      ? { ...item, report: event.target.value }
                      : item),
                  }))} value={investigation.report} />
                </Field>
              </fieldset>
            ))}
          </div>
        </TabsContent>

        <TabsContent className="flex flex-col gap-6 pt-4" value="decision">
          <FieldGroup className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Field>
              <FieldLabel htmlFor="editor-primary-code">{messages.primaryDiagnosisCode}</FieldLabel>
              <Input id="editor-primary-code" onChange={event => updatePatient(current => ({
                ...current,
                diagnosisSpace: { ...current.diagnosisSpace, primary: { ...current.diagnosisSpace.primary, code: event.target.value || null } },
              }))} value={patient.diagnosisSpace.primary.code ?? ''} />
            </Field>
            <Field className="md:col-span-1 xl:col-span-3">
              <FieldLabel htmlFor="editor-primary-display">{messages.primaryDiagnosisName}</FieldLabel>
              <Input id="editor-primary-display" onChange={event => updatePatient(current => ({
                ...current,
                diagnosisSpace: { ...current.diagnosisSpace, primary: { ...current.diagnosisSpace.primary, display: event.target.value } },
              }))} value={patient.diagnosisSpace.primary.display} />
            </Field>
            <Field className="md:col-span-2">
              <FieldLabel htmlFor="editor-primary-evidence">{messages.diagnosisEvidence}</FieldLabel>
              <Textarea id="editor-primary-evidence" onChange={event => updatePatient(current => ({
                ...current,
                diagnosisSpace: { ...current.diagnosisSpace, primary: { ...current.diagnosisSpace.primary, evidence: splitLines(event.target.value) } },
              }))} value={joinLines(patient.diagnosisSpace.primary.evidence)} />
            </Field>
            <Field className="md:col-span-2">
              <FieldLabel htmlFor="editor-management-options">{messages.acceptableManagement}</FieldLabel>
              <Textarea id="editor-management-options" onChange={event => updatePatient(current => ({
                ...current,
                managementSpace: { ...current.managementSpace, acceptableOptions: splitLines(event.target.value) },
              }))} value={joinLines(patient.managementSpace.acceptableOptions)} />
            </Field>
            <Field className="md:col-span-2">
              <FieldLabel htmlFor="editor-management-contraindications">{messages.managementContraindications}</FieldLabel>
              <Textarea id="editor-management-contraindications" onChange={event => updatePatient(current => ({
                ...current,
                managementSpace: { ...current.managementSpace, contraindications: splitLines(event.target.value) },
              }))} value={joinLines(patient.managementSpace.contraindications)} />
            </Field>
            <Field className="md:col-span-2">
              <FieldLabel htmlFor="editor-follow-up">{messages.followUp}</FieldLabel>
              <Textarea id="editor-follow-up" onChange={event => updatePatient(current => ({
                ...current,
                managementSpace: { ...current.managementSpace, followUp: event.target.value },
              }))} value={patient.managementSpace.followUp} />
            </Field>
            <Field>
              <FieldLabel htmlFor="editor-cost-minimum">{messages.reasonableCostMinimumFen}</FieldLabel>
              <Input id="editor-cost-minimum" min={0} onChange={event => updatePatient(current => ({
                ...current,
                costBaseline: { ...current.costBaseline, reasonableRangeFen: [Number(event.target.value), current.costBaseline.reasonableRangeFen[1]] },
              }))} type="number" value={patient.costBaseline.reasonableRangeFen[0]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="editor-cost-maximum">{messages.reasonableCostMaximumFen}</FieldLabel>
              <Input id="editor-cost-maximum" min={0} onChange={event => updatePatient(current => ({
                ...current,
                costBaseline: { ...current.costBaseline, reasonableRangeFen: [current.costBaseline.reasonableRangeFen[0], Number(event.target.value)] },
              }))} type="number" value={patient.costBaseline.reasonableRangeFen[1]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="editor-cost-threshold">{messages.overInvestigationThresholdFen}</FieldLabel>
              <Input id="editor-cost-threshold" min={0} onChange={event => updatePatient(current => ({
                ...current,
                costBaseline: { ...current.costBaseline, overInvestigationThresholdFen: Number(event.target.value) },
              }))} type="number" value={patient.costBaseline.overInvestigationThresholdFen} />
            </Field>
          </FieldGroup>
          <DiagnosisListEditor
            diagnoses={patient.diagnosisSpace.comorbidities}
            kind="comorbidities"
            locale={locale}
            updatePatient={updatePatient}
          />
          <DiagnosisListEditor
            diagnoses={patient.diagnosisSpace.differentials}
            kind="differentials"
            locale={locale}
            updatePatient={updatePatient}
          />
          <Field>
            <FieldLabel htmlFor="editor-diagnosis-traps">{messages.diagnosisTraps}</FieldLabel>
            <Textarea id="editor-diagnosis-traps" onChange={event => updatePatient(current => ({
              ...current,
              diagnosisSpace: { ...current.diagnosisSpace, traps: splitLines(event.target.value) },
            }))} value={joinLines(patient.diagnosisSpace.traps)} />
          </Field>
        </TabsContent>

        <TabsContent className="flex flex-col gap-6 pt-4" value="catalog">
          <div className="flex flex-col gap-4">
            <h3 className="text-sm font-semibold">{messages.investigationCatalog}</h3>
            {draft.content.catalog.investigations.map((item, itemIndex) => (
              <fieldset className="grid gap-4 border-b pb-4 md:grid-cols-2 xl:grid-cols-4" key={item.id}>
                <legend className="pr-3 text-sm font-semibold">{item.name}</legend>
                <Field>
                  <FieldLabel htmlFor={`editor-catalog-investigation-name-${itemIndex}`}>{messages.catalogName}</FieldLabel>
                  <Input id={`editor-catalog-investigation-name-${itemIndex}`} onChange={event => updateCatalogInvestigation(itemIndex, catalogItem => ({ ...catalogItem, name: event.target.value }))} value={item.name} />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`editor-catalog-investigation-price-${itemIndex}`}>{messages.investigationPriceFen}</FieldLabel>
                  <Input id={`editor-catalog-investigation-price-${itemIndex}`} min={0} onChange={event => updateCatalogInvestigation(itemIndex, catalogItem => ({ ...catalogItem, priceFen: Number(event.target.value) }))} type="number" value={item.priceFen} />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`editor-catalog-investigation-tat-${itemIndex}`}>{messages.tatMinutes}</FieldLabel>
                  <Input id={`editor-catalog-investigation-tat-${itemIndex}`} min={0} onChange={event => updateCatalogInvestigation(itemIndex, catalogItem => ({ ...catalogItem, tatMinutes: Number(event.target.value) }))} type="number" value={item.tatMinutes} />
                </Field>
                <Field orientation="horizontal" className="self-end pb-2">
                  <Checkbox checked={item.available} id={`editor-catalog-investigation-available-${itemIndex}`} onCheckedChange={checked => updateCatalogInvestigation(itemIndex, catalogItem => ({ ...catalogItem, available: checked === true }))} />
                  <FieldLabel htmlFor={`editor-catalog-investigation-available-${itemIndex}`}>{messages.availableAtHospital}</FieldLabel>
                </Field>
                <Field className="md:col-span-2">
                  <FieldLabel htmlFor={`editor-catalog-investigation-reference-${itemIndex}`}>{messages.referenceRangeText}</FieldLabel>
                  <Input id={`editor-catalog-investigation-reference-${itemIndex}`} onChange={event => updateCatalogInvestigation(itemIndex, catalogItem => updateFirstReferenceRange(catalogItem, range => ({ ...range, text: event.target.value })))} value={item.referenceRanges[0]?.text ?? ''} />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`editor-catalog-investigation-reference-minimum-${itemIndex}`}>{messages.referenceMinimum}</FieldLabel>
                  <Input id={`editor-catalog-investigation-reference-minimum-${itemIndex}`} onChange={event => updateCatalogInvestigation(itemIndex, catalogItem => updateFirstReferenceRange(catalogItem, (range) => {
                    if (event.target.value !== '') return { ...range, minimum: Number(event.target.value) }
                    const { minimum: _removed, ...remaining } = range
                    return remaining
                  }))} type="number" value={item.referenceRanges[0]?.minimum ?? ''} />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`editor-catalog-investigation-reference-maximum-${itemIndex}`}>{messages.referenceMaximum}</FieldLabel>
                  <Input id={`editor-catalog-investigation-reference-maximum-${itemIndex}`} onChange={event => updateCatalogInvestigation(itemIndex, catalogItem => updateFirstReferenceRange(catalogItem, (range) => {
                    if (event.target.value !== '') return { ...range, maximum: Number(event.target.value) }
                    const { maximum: _removed, ...remaining } = range
                    return remaining
                  }))} type="number" value={item.referenceRanges[0]?.maximum ?? ''} />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`editor-catalog-investigation-generator-${itemIndex}`}>{messages.physiologyGeneratorId}</FieldLabel>
                  <Input id={`editor-catalog-investigation-generator-${itemIndex}`} onChange={event => updateCatalogInvestigation(itemIndex, catalogItem => event.target.value === '' ? withoutPhysiologyGenerator(catalogItem) : { ...catalogItem, physiologyGeneratorId: event.target.value })} value={item.physiologyGeneratorId ?? ''} />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`editor-catalog-investigation-components-${itemIndex}`}>{messages.componentItemIds}</FieldLabel>
                  <Textarea id={`editor-catalog-investigation-components-${itemIndex}`} onChange={event => updateCatalogInvestigation(itemIndex, catalogItem => {
                    const componentItemIds = splitLines(event.target.value)
                    return componentItemIds.length === 0
                      ? withoutComponents(catalogItem)
                      : { ...catalogItem, componentItemIds }
                  })} value={joinLines(item.componentItemIds ?? [])} />
                </Field>
                <Field className="self-end pb-2" orientation="horizontal">
                  <Checkbox checked={item.normalDistribution !== undefined} id={`editor-catalog-investigation-l3-${itemIndex}`} onCheckedChange={checked => updateCatalogInvestigation(itemIndex, (catalogItem) => {
                    if (checked !== true) return withoutNormalDistribution(catalogItem)
                    const range = catalogItem.referenceRanges[0]
                    const minimum = range?.minimum ?? 0
                    const maximum = range?.maximum ?? Math.max(1, minimum + 1)
                    return {
                      ...catalogItem,
                      normalDistribution: {
                        assayCv: 0.02,
                        maximum,
                        mean: (minimum + maximum) / 2,
                        minimum,
                        standardDeviation: Math.max((maximum - minimum) / 6, 0.01),
                      },
                    }
                  })} />
                  <FieldLabel htmlFor={`editor-catalog-investigation-l3-${itemIndex}`}>{messages.enableL3Sampling}</FieldLabel>
                </Field>
                {item.normalDistribution === undefined ? null : <>
                  <Field>
                    <FieldLabel htmlFor={`editor-catalog-investigation-l3-mean-${itemIndex}`}>{messages.l3Mean}</FieldLabel>
                    <Input id={`editor-catalog-investigation-l3-mean-${itemIndex}`} onChange={event => updateCatalogInvestigation(itemIndex, catalogItem => catalogItem.normalDistribution === undefined ? catalogItem : ({ ...catalogItem, normalDistribution: { ...catalogItem.normalDistribution, mean: Number(event.target.value) } }))} type="number" value={item.normalDistribution.mean} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`editor-catalog-investigation-l3-standard-deviation-${itemIndex}`}>{messages.l3StandardDeviation}</FieldLabel>
                    <Input id={`editor-catalog-investigation-l3-standard-deviation-${itemIndex}`} min={0.0001} onChange={event => updateCatalogInvestigation(itemIndex, catalogItem => catalogItem.normalDistribution === undefined ? catalogItem : ({ ...catalogItem, normalDistribution: { ...catalogItem.normalDistribution, standardDeviation: Number(event.target.value) } }))} type="number" value={item.normalDistribution.standardDeviation} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`editor-catalog-investigation-l3-cv-${itemIndex}`}>{messages.assayCv}</FieldLabel>
                    <Input id={`editor-catalog-investigation-l3-cv-${itemIndex}`} max={1} min={0} onChange={event => updateCatalogInvestigation(itemIndex, catalogItem => catalogItem.normalDistribution === undefined ? catalogItem : ({ ...catalogItem, normalDistribution: { ...catalogItem.normalDistribution, assayCv: Number(event.target.value) } }))} step={0.01} type="number" value={item.normalDistribution.assayCv} />
                  </Field>
                </>}
              </fieldset>
            ))}
          </div>
          <div className="flex flex-col gap-4">
            <h3 className="text-sm font-semibold">{messages.medicationCatalog}</h3>
            {draft.content.catalog.medications.map((item, itemIndex) => (
              <fieldset className="grid gap-4 border-b pb-4 md:grid-cols-2 xl:grid-cols-4" key={item.id}>
                <legend className="pr-3 text-sm font-semibold">{item.name}</legend>
                <Field>
                  <FieldLabel htmlFor={`editor-medication-name-${itemIndex}`}>{messages.catalogName}</FieldLabel>
                  <Input id={`editor-medication-name-${itemIndex}`} onChange={event => updateCatalogMedication(itemIndex, medication => ({ ...medication, name: event.target.value }))} value={item.name} />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`editor-medication-dose-${itemIndex}`}>{messages.defaultDose}</FieldLabel>
                  <Input id={`editor-medication-dose-${itemIndex}`} onChange={event => updateCatalogMedication(itemIndex, medication => ({ ...medication, defaultDose: event.target.value }))} value={item.defaultDose} />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`editor-medication-frequency-${itemIndex}`}>{messages.defaultFrequency}</FieldLabel>
                  <Input id={`editor-medication-frequency-${itemIndex}`} onChange={event => updateCatalogMedication(itemIndex, medication => ({ ...medication, defaultFrequency: event.target.value }))} value={item.defaultFrequency} />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`editor-medication-price-${itemIndex}`}>{messages.medicationPriceFen}</FieldLabel>
                  <Input id={`editor-medication-price-${itemIndex}`} min={0} onChange={event => updateCatalogMedication(itemIndex, medication => ({ ...medication, priceFen: Number(event.target.value) }))} type="number" value={item.priceFen} />
                </Field>
                <Field className="md:col-span-2">
                  <FieldLabel htmlFor={`editor-medication-diagnoses-${itemIndex}`}>{messages.allowedDiagnosisCodes}</FieldLabel>
                  <Textarea id={`editor-medication-diagnoses-${itemIndex}`} onChange={event => updateCatalogMedication(itemIndex, medication => ({
                    ...medication,
                    workflow: { ...medication.workflow, allowedDiagnosisCodes: splitLines(event.target.value) },
                  }))} value={joinLines(item.workflow.allowedDiagnosisCodes)} />
                </Field>
                <Field className="md:col-span-2">
                  <FieldLabel htmlFor={`editor-medication-restriction-${itemIndex}`}>{messages.medicationRestriction}</FieldLabel>
                  <Textarea id={`editor-medication-restriction-${itemIndex}`} onChange={event => updateCatalogMedication(itemIndex, medication => ({ ...medication, restriction: event.target.value || null }))} value={item.restriction ?? ''} />
                </Field>
              </fieldset>
            ))}
          </div>
          <div className="flex flex-col gap-4">
            <h3 className="text-sm font-semibold">{messages.inventory}</h3>
            {draft.content.inventory.map((lot, lotIndex) => (
              <fieldset className="grid gap-4 border-b pb-4 md:grid-cols-3" key={lot.lotId}>
                <legend className="pr-3 text-sm font-semibold">{lot.lotId}</legend>
                <Field>
                  <FieldLabel htmlFor={`editor-inventory-item-${lotIndex}`}>{messages.medication}</FieldLabel>
                  <Input id={`editor-inventory-item-${lotIndex}`} onChange={event => updateInventoryLot(lotIndex, inventoryLot => ({ ...inventoryLot, itemId: event.target.value }))} value={lot.itemId} />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`editor-inventory-quantity-${lotIndex}`}>{messages.inventoryQuantity}</FieldLabel>
                  <Input id={`editor-inventory-quantity-${lotIndex}`} min={0} onChange={event => updateInventoryLot(lotIndex, inventoryLot => ({ ...inventoryLot, quantity: Number(event.target.value) }))} type="number" value={lot.quantity} />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`editor-inventory-expiry-${lotIndex}`}>{messages.expiresOn}</FieldLabel>
                  <Input id={`editor-inventory-expiry-${lotIndex}`} onChange={event => updateInventoryLot(lotIndex, inventoryLot => ({ ...inventoryLot, expiresOn: event.target.value }))} type="date" value={lot.expiresOn} />
                </Field>
              </fieldset>
            ))}
          </div>
        </TabsContent>

        <TabsContent className="flex flex-col gap-6 pt-4" value="rules">
          <div className="flex flex-col gap-4">
            <h3 className="text-sm font-semibold">{messages.hiddenFacts}</h3>
            {draft.content.hiddenFacts.map((fact, factIndex) => (
              <fieldset className="grid gap-4 border-b pb-4 md:grid-cols-3" key={`hidden-fact-${factIndex}`}>
                <legend className="sr-only">{fact.code}</legend>
                <Field>
                  <FieldLabel htmlFor={`editor-hidden-code-${factIndex}`}>{messages.factCode}</FieldLabel>
                  <Input id={`editor-hidden-code-${factIndex}`} onChange={event => updateHiddenFact(factIndex, hiddenFact => ({ ...hiddenFact, code: event.target.value }))} value={fact.code} />
                </Field>
                <Field className="md:col-span-2">
                  <FieldLabel htmlFor={`editor-hidden-value-${factIndex}`}>{messages.hiddenFactValue}</FieldLabel>
                  <Input disabled={typeof fact.value === 'object' && fact.value !== null} id={`editor-hidden-value-${factIndex}`} onChange={event => updateHiddenFact(factIndex, hiddenFact => ({ ...hiddenFact, value: event.target.value }))} value={scalarHiddenFactValue(fact.value)} />
                </Field>
              </fieldset>
            ))}
          </div>
          <div className="flex flex-col gap-4">
            <h3 className="text-sm font-semibold">{messages.revealPolicies}</h3>
            {draft.content.revealPolicies.map((policy, policyIndex) => (
              <fieldset className="grid gap-4 border-b pb-4 md:grid-cols-3" key={`reveal-policy-${policyIndex}`}>
                <legend className="sr-only">{policy.code}</legend>
                <Field>
                  <FieldLabel htmlFor={`editor-policy-code-${policyIndex}`}>{messages.policyCode}</FieldLabel>
                  <Input id={`editor-policy-code-${policyIndex}`} onChange={event => updateRevealPolicy(policyIndex, revealPolicy => ({ ...revealPolicy, code: event.target.value }))} value={policy.code} />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`editor-policy-fact-${policyIndex}`}>{messages.factCode}</FieldLabel>
                  <Input id={`editor-policy-fact-${policyIndex}`} onChange={event => updateRevealPolicy(policyIndex, revealPolicy => ({ ...revealPolicy, factCode: event.target.value }))} value={policy.factCode} />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`editor-policy-trigger-${policyIndex}`}>{messages.revealTrigger}</FieldLabel>
                  <Select onValueChange={value => updateRevealPolicy(policyIndex, revealPolicy => ({ ...revealPolicy, triggerCode: value as typeof revealPolicy.triggerCode }))} value={policy.triggerCode}>
                    <SelectTrigger className="w-full" id={`editor-policy-trigger-${policyIndex}`}><SelectValue /></SelectTrigger>
                    <SelectContent><SelectGroup>
                      {(['initial', 'after-topic', 'after-examination', 'after-request', 'after-time', 'second-ask-concede', 'evaluator-only'] as const).map(trigger => (
                        <SelectItem key={trigger} value={trigger}>{messages[`revealTrigger_${trigger.replaceAll('-', '_')}` as keyof typeof messages]}</SelectItem>
                      ))}
                    </SelectGroup></SelectContent>
                  </Select>
                </Field>
              </fieldset>
            ))}
          </div>
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">{messages.simulatorRules}</h3>
              <Button onClick={() => setDraft(current => {
                const code = nextScopedId(
                  'simulator-rule-new',
                  current.content.simulatorRules.map(rule => rule.code),
                )
                return {
                  ...current,
                  content: {
                    ...current.content,
                    simulatorRules: [...current.content.simulatorRules, {
                      code,
                      outcome: 'success',
                      simulator: 'lis',
                    }],
                  },
                }
              })} size="sm" type="button" variant="outline"><PlusIcon data-icon="inline-start" />{messages.addSimulatorRule}</Button>
            </div>
            {draft.content.simulatorRules.map((rule, ruleIndex) => {
              const suffix = ` ${ruleIndex + 1}`
              return <fieldset className="grid gap-4 border-b pb-4 md:grid-cols-3" key={`simulator-rule-${ruleIndex}`}>
                <legend className="sr-only">{messages.simulatorRuleCode}{suffix}</legend>
                <Field>
                  <FieldLabel htmlFor={`editor-simulator-code-${ruleIndex}`}>{messages.simulatorRuleCode}{suffix}</FieldLabel>
                  <Input id={`editor-simulator-code-${ruleIndex}`} onChange={event => updateSimulatorRule(ruleIndex, current => ({ ...current, code: event.target.value }))} value={rule.code} />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`editor-simulator-${ruleIndex}`}>{messages.simulator}{suffix}</FieldLabel>
                  <Select onValueChange={value => updateSimulatorRule(ruleIndex, current => ({ ...current, simulator: value ?? current.simulator }))} value={rule.simulator}>
                    <SelectTrigger className="w-full" id={`editor-simulator-${ruleIndex}`}><SelectValue /></SelectTrigger>
                    <SelectContent><SelectGroup>{['lis', 'payment'].map(simulator => <SelectItem key={simulator} value={simulator}>{simulator.toUpperCase()}</SelectItem>)}</SelectGroup></SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`editor-simulator-outcome-${ruleIndex}`}>{messages.simulatorOutcome}{suffix}</FieldLabel>
                  <Select onValueChange={value => updateSimulatorRule(ruleIndex, current => ({ ...current, outcome: value ?? current.outcome }))} value={rule.outcome}>
                    <SelectTrigger className="w-full" id={`editor-simulator-outcome-${ruleIndex}`}><SelectValue /></SelectTrigger>
                    <SelectContent><SelectGroup>
                      <SelectItem value="success">{messages.simulatorSuccess}</SelectItem>
                      <SelectItem value="declined">{messages.simulatorDecline}</SelectItem>
                      <SelectItem value="ambiguous">{messages.simulatorAmbiguous}</SelectItem>
                    </SelectGroup></SelectContent>
                  </Select>
                </Field>
                <div className="flex items-end justify-end md:col-span-3"><Button aria-label={`${messages.removeSimulatorRule}${suffix}`} onClick={() => setDraft(current => ({ ...current, content: { ...current.content, simulatorRules: current.content.simulatorRules.filter((_, index) => index !== ruleIndex) } }))} size="icon" title={`${messages.removeSimulatorRule}${suffix}`} type="button" variant="ghost"><Trash2Icon /></Button></div>
              </fieldset>
            })}
          </div>
        </TabsContent>
      </Tabs>

      {mutationError !== null ? (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>{getWorkspaceErrorTitle(mutationError, messages, messages.operationFailed)}</AlertTitle>
          <AlertDescription>{getWorkspaceErrorMessage(mutationError, messages)}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  )
}

export function ScenarioDataWorkspace({ locale }: { locale: WorkspaceLocale }): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  const queryClient = useQueryClient()
  const [request, setRequest] = useState(initialRequest)
  const [datasetPage, setDatasetPage] = useState(1)
  const [datasetSearch, setDatasetSearch] = useState('')
  const [submittedDatasetSearch, setSubmittedDatasetSearch] = useState('')
  const [generationJobId, setGenerationJobId] = useState<string>()
  const [selectedDatasetId, setSelectedDatasetId] = useState<string>()
  const providers = useQuery({
    queryFn: ({ signal }) => getScenarioProviders(signal),
    queryKey: providersQueryKey,
  })
  const datasets = useQuery({
    queryFn: ({ signal }) => getScenarioDatasets(signal, datasetPage, submittedDatasetSearch),
    queryKey: [...datasetsQueryKey, datasetPage, submittedDatasetSearch],
  })
  const selectedDataset = useQuery({
    enabled: selectedDatasetId !== undefined,
    queryFn: ({ signal }) => {
      if (selectedDatasetId === undefined) throw new Error('No Scenario Dataset is selected')
      return getScenarioDataset(selectedDatasetId, signal)
    },
    queryKey: selectedDatasetId === undefined
      ? ['scenario-dataset', 'none']
      : datasetQueryKey(selectedDatasetId),
  })
  const generationJob = useQuery({
    enabled: generationJobId !== undefined,
    queryFn: ({ signal }) => {
      if (generationJobId === undefined) throw new Error('No Scenario generation job is selected')
      return getScenarioGenerationJob(generationJobId, signal)
    },
    queryKey: generationJobId === undefined
      ? ['scenario-generation-job', 'none']
      : generationJobQueryKey(generationJobId),
    refetchInterval: query => (
      query.state.data?.status === 'queued' || query.state.data?.status === 'running'
        ? 100
        : false
    ),
  })
  const generate = useMutation({
    mutationFn: async () => request.providerId === 'synthea'
      ? {
          kind: 'job' as const,
          response: await enqueueScenarioGenerationJob(request, newIdempotencyKey()),
        }
      : {
          kind: 'dataset' as const,
          response: await generateScenarioDataset(request, newIdempotencyKey()),
        },
    onSuccess: async result => {
      if (result.kind === 'job') {
        queryClient.setQueryData(
          generationJobQueryKey(result.response.data.jobId),
          result.response.data,
        )
        setGenerationJobId(result.response.data.jobId)
        return
      }
      await queryClient.invalidateQueries({ queryKey: datasetsQueryKey })
    },
  })
  useEffect(() => {
    if (generationJob.data?.status !== 'succeeded') return
    void queryClient.invalidateQueries({ queryKey: datasetsQueryKey })
  }, [generationJob.data?.status, queryClient])
  const updatePopulation = (next: Partial<ScenarioGenerationRequest['population']>): void => {
    setRequest(current => ({ ...current, population: { ...current.population, ...next } }))
  }
  const updateAge = (next: Partial<ScenarioGenerationRequest['population']['age']>): void => {
    setRequest(current => ({
      ...current,
      population: { ...current.population, age: { ...current.population.age, ...next } },
    }))
  }
  const selectedProvider = providers.data?.items.find(
    provider => provider.providerId === request.providerId,
  )
  const generationStatus = generationJob.data?.status

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <section aria-labelledby="provider-heading" className="flex flex-col gap-3 border-b pb-5">
        <h2 className="text-base font-semibold" id="provider-heading">{messages.generationProviders}</h2>
        {providers.isPending ? <Skeleton className="h-16 w-full" /> : null}
        {providers.isError ? (
          <Alert variant="destructive">
            <CircleAlertIcon aria-hidden="true" />
            <AlertTitle>{getWorkspaceErrorTitle(providers.error, messages, messages.providersUnavailable)}</AlertTitle>
            <AlertDescription>{getWorkspaceErrorMessage(providers.error, messages)}</AlertDescription>
          </Alert>
        ) : null}
        {providers.data !== undefined ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {providers.data.items.map(provider => (
              <div className="flex min-w-0 items-start justify-between gap-3 border-l-2 px-3 py-2" key={provider.providerId}>
                <div className="min-w-0">
                  <div className="font-medium">{provider.providerName}</div>
                  <div className="text-sm text-muted-foreground">
                    {provider.available ? messages.providerAvailable : provider.unavailableReason}
                  </div>
                </div>
                <Badge variant={provider.available ? 'default' : 'secondary'}>
                  {provider.available ? messages.available : messages.unavailable}
                </Badge>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="generation-heading" className="flex flex-col gap-4 border-b pb-6">
        <div className="flex items-center gap-2">
          <FlaskConicalIcon aria-hidden="true" className="size-4" />
          <h2 className="text-base font-semibold" id="generation-heading">{messages.generateDataset}</h2>
        </div>
        <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); generate.mutate() }}>
          <FieldGroup className="grid gap-4 md:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="scenario-provider">{messages.provider}</FieldLabel>
              <select
                className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                id="scenario-provider"
                onChange={event => {
                  const providerId = event.target.value as ScenarioGenerationRequest['providerId']
                  setRequest(current => ({ ...current, providerId }))
                }}
                value={request.providerId}
              >
                {providers.data?.items.map(provider => (
                  <option disabled={!provider.available} key={provider.providerId} value={provider.providerId}>
                    {provider.providerName}
                  </option>
                ))}
              </select>
            </Field>
            <Field className="md:col-span-2">
              <FieldLabel htmlFor="scenario-dataset-name">{messages.datasetName}</FieldLabel>
              <Input id="scenario-dataset-name" maxLength={120} onChange={event => setRequest(current => ({ ...current, name: event.target.value }))} required value={request.name} />
            </Field>
            <Field>
              <FieldLabel htmlFor="scenario-population-count">{messages.populationCount}</FieldLabel>
              <Input id="scenario-population-count" max={1_000} min={1} onChange={event => updatePopulation({ count: Number(event.target.value) })} required type="number" value={request.population.count} />
            </Field>
            <Field>
              <FieldLabel htmlFor="scenario-age-min">{messages.minimumAge}</FieldLabel>
              <Input id="scenario-age-min" max={120} min={0} onChange={event => updateAge({ minimum: Number(event.target.value) })} required type="number" value={request.population.age.minimum} />
            </Field>
            <Field>
              <FieldLabel htmlFor="scenario-age-max">{messages.maximumAge}</FieldLabel>
              <Input id="scenario-age-max" max={120} min={0} onChange={event => updateAge({ maximum: Number(event.target.value) })} required type="number" value={request.population.age.maximum} />
            </Field>
            <Field>
              <FieldLabel htmlFor="scenario-gender">{messages.gender}</FieldLabel>
              <select className="h-8 rounded-md border border-input bg-background px-2 text-sm" id="scenario-gender" onChange={event => updatePopulation({ gender: event.target.value as ScenarioGenerationRequest['population']['gender'] })} value={request.population.gender}>
                <option value="any">{messages.genderAny}</option>
                <option value="female">{messages.gender_female}</option>
                <option value="male">{messages.gender_male}</option>
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor="scenario-population-seed">{messages.populationSeed}</FieldLabel>
              <Input id="scenario-population-seed" min={0} onChange={event => setRequest(current => ({ ...current, seeds: { ...current.seeds, population: Number(event.target.value) } }))} required type="number" value={request.seeds.population} />
            </Field>
            <Field>
              <FieldLabel htmlFor="scenario-clinical-seed">{messages.clinicalSeed}</FieldLabel>
              <Input id="scenario-clinical-seed" min={0} onChange={event => setRequest(current => ({ ...current, seeds: { ...current.seeds, clinical: Number(event.target.value) } }))} required type="number" value={request.seeds.clinical} />
            </Field>
            <Field>
              <FieldLabel htmlFor="scenario-start-date">{messages.historyStart}</FieldLabel>
              <Input id="scenario-start-date" onChange={event => setRequest(current => ({ ...current, timeRange: { ...current.timeRange, start: event.target.value } }))} required type="date" value={request.timeRange.start} />
            </Field>
            <Field>
              <FieldLabel htmlFor="scenario-end-date">{messages.historyEnd}</FieldLabel>
              <Input id="scenario-end-date" onChange={event => setRequest(current => ({ ...current, timeRange: { ...current.timeRange, end: event.target.value } }))} required type="date" value={request.timeRange.end} />
            </Field>
          </FieldGroup>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={request.modules.includes('fever')}
                disabled={request.modules.length === 1 && request.modules.includes('fever')}
                onCheckedChange={checked => setRequest(current => ({
                  ...current,
                  modules: updateModules(current.modules, 'fever', checked === true),
                }))}
              />
              {messages.moduleFever}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={request.modules.includes('type-2-diabetes')}
                disabled={request.modules.length === 1 && request.modules.includes('type-2-diabetes')}
                onCheckedChange={checked => setRequest(current => ({
                  ...current,
                  modules: updateModules(current.modules, 'type-2-diabetes', checked === true),
                }))}
              />
              {messages.moduleDiabetes}
            </label>
          </div>
          <div className="flex justify-end">
            <Button disabled={generate.isPending || selectedProvider?.available !== true} type="submit">
              <FlaskConicalIcon data-icon="inline-start" />
              {generate.isPending ? messages.generatingDataset : messages.generateData}
            </Button>
          </div>
          {generate.isError ? (
            <Alert variant="destructive">
              <CircleAlertIcon aria-hidden="true" />
              <AlertTitle>{getWorkspaceErrorTitle(generate.error, messages, messages.generationFailed)}</AlertTitle>
              <AlertDescription>{getWorkspaceErrorMessage(generate.error, messages)}</AlertDescription>
            </Alert>
          ) : null}
          {generationJob.data !== undefined ? (
            <Alert variant={generationStatus === 'failed' ? 'destructive' : 'default'}>
              <FlaskConicalIcon aria-hidden="true" />
              <AlertTitle>{messages.generationJob}</AlertTitle>
              <AlertDescription>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={generationStatus === 'failed' ? 'destructive' : 'secondary'}>
                    {generationStatus === 'queued'
                      ? messages.generationQueued
                      : generationStatus === 'running'
                        ? messages.generationRunning
                        : generationStatus === 'succeeded'
                          ? messages.generationSucceeded
                          : messages.generationFailed}
                  </Badge>
                  {generationJob.data.error?.message}
                </div>
              </AlertDescription>
            </Alert>
          ) : null}
        </form>
      </section>

      <section aria-labelledby="dataset-list-heading" className="flex min-w-0 flex-col gap-3">
        <div className="flex items-center gap-2">
          <DatabaseIcon aria-hidden="true" className="size-4" />
          <h2 className="text-base font-semibold" id="dataset-list-heading">{messages.datasets}</h2>
        </div>
        <form
          className="flex max-w-lg items-end gap-2"
          onSubmit={event => {
            event.preventDefault()
            setDatasetPage(1)
            setSubmittedDatasetSearch(datasetSearch.trim())
          }}
        >
          <Field>
            <FieldLabel htmlFor="scenario-dataset-search">{messages.searchDatasets}</FieldLabel>
            <Input
              id="scenario-dataset-search"
              maxLength={120}
              onChange={event => setDatasetSearch(event.currentTarget.value)}
              placeholder={messages.datasetSearchPlaceholder}
              value={datasetSearch}
            />
          </Field>
          <Button type="submit">
            <SearchIcon data-icon="inline-start" />
            {messages.search}
          </Button>
        </form>
        {datasets.isPending ? <Skeleton className="h-32 w-full" /> : null}
        {datasets.isError ? (
          <Alert variant="destructive">
            <CircleAlertIcon aria-hidden="true" />
            <AlertTitle>{getWorkspaceErrorTitle(datasets.error, messages, messages.datasetsUnavailable)}</AlertTitle>
            <AlertDescription>{getWorkspaceErrorMessage(datasets.error, messages)}</AlertDescription>
          </Alert>
        ) : null}
        {datasets.data?.items.length === 0 ? <div className="border-y py-8 text-center text-sm text-muted-foreground">{messages.noDatasets}</div> : null}
        {datasets.data !== undefined && datasets.data.items.length > 0 ? (
          <Table>
            <TableHeader><TableRow><TableHead>{messages.datasetName}</TableHead><TableHead>{messages.provider}</TableHead><TableHead>{messages.patients}</TableHead><TableHead>{messages.validation}</TableHead><TableHead>{messages.version}</TableHead><TableHead><span className="sr-only">{messages.actions}</span></TableHead></TableRow></TableHeader>
            <TableBody>
              {datasets.data.items.map(dataset => (
                <TableRow key={dataset.datasetId}>
                  <TableCell className="font-medium">{dataset.name}</TableCell>
                  <TableCell>{dataset.providerId === 'builtin' ? 'ClinMesh' : 'Synthea'}</TableCell>
                  <TableCell>{dataset.patientCount}</TableCell>
                  <TableCell><Badge variant={dataset.diagnosticCounts.error > 0 ? 'destructive' : 'secondary'}>{dataset.diagnosticCounts.error > 0 ? `${dataset.diagnosticCounts.error} ${messages.errors}` : messages.valid}</Badge></TableCell>
                  <TableCell>{dataset.version}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      aria-label={`${messages.edit} ${dataset.name}`}
                      onClick={() => setSelectedDatasetId(dataset.datasetId)}
                      size="icon"
                      title={`${messages.edit} ${dataset.name}`}
                      variant="ghost"
                    >
                      <PencilIcon aria-hidden="true" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
        {datasets.data !== undefined ? (
          <PaginationControls
            messages={messages}
            onPageChange={setDatasetPage}
            page={datasets.data.page}
            pageSize={datasets.data.pageSize}
            total={datasets.data.total}
          />
        ) : null}
        {selectedDataset.isPending && selectedDatasetId !== undefined ? <Skeleton className="h-48 w-full" /> : null}
        {selectedDataset.isError ? (
          <Alert variant="destructive">
            <CircleAlertIcon aria-hidden="true" />
            <AlertTitle>{getWorkspaceErrorTitle(selectedDataset.error, messages, messages.datasetsUnavailable)}</AlertTitle>
            <AlertDescription>{getWorkspaceErrorMessage(selectedDataset.error, messages)}</AlertDescription>
          </Alert>
        ) : null}
        {selectedDataset.data !== undefined ? (
          <DatasetEditor
            dataset={selectedDataset.data}
            key={`${selectedDataset.data.datasetId}:${selectedDataset.data.version}`}
            locale={locale}
            onDeleted={() => setSelectedDatasetId(undefined)}
          />
        ) : null}
      </section>
    </div>
  )
}
