import { useState } from 'react'
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
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@clinmesh/ui/components/table'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CircleAlertIcon,
  DatabaseIcon,
  FlaskConicalIcon,
  PencilIcon,
  PlayIcon,
  SaveIcon,
  Trash2Icon,
} from 'lucide-react'
import {
  deleteScenarioDataset,
  generateScenarioDataset,
  getScenarioDataset,
  getScenarioDatasets,
  getScenarioProviders,
  installScenarioDataset,
  newIdempotencyKey,
  sessionQueryKey,
  updateScenarioDataset,
} from './api-client.ts'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'

const providersQueryKey = ['scenario-providers'] as const
const datasetsQueryKey = ['scenario-datasets'] as const

function datasetQueryKey(datasetId: string) {
  return ['scenario-dataset', datasetId] as const
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
  const [draft, setDraft] = useState(dataset)
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
  const updatePatient = (index: number, update: Partial<ScenarioDataset['content']['patients'][number]>): void => {
    setDraft(current => ({
      ...current,
      content: {
        ...current.content,
        patients: current.content.patients.map((patient, patientIndex) => (
          patientIndex === index ? { ...patient, ...update } : patient
        )),
      },
    }))
  }
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
          <Input id="editor-dataset-name" onChange={event => setDraft(current => ({ ...current, name: event.currentTarget.value }))} value={draft.name} />
        </Field>
        <Field>
          <FieldLabel htmlFor="editor-hospital-name">{messages.hospitalDisplayName}</FieldLabel>
          <Input id="editor-hospital-name" onChange={event => setDraft(current => ({
            ...current,
            content: { ...current.content, hospital: { ...current.content.hospital, name: event.currentTarget.value } },
          }))} value={draft.content.hospital.name} />
        </Field>
      </FieldGroup>

      <div className="flex flex-col gap-5">
        {draft.content.patients.map((patient, index) => {
          const chiefComplaint = typeof patient.patientKnowledge.chiefComplaint === 'string'
            ? patient.patientKnowledge.chiefComplaint
            : ''
          const temperatureC = typeof patient.physiologyBaseline.temperatureC === 'number'
            ? patient.physiologyBaseline.temperatureC
            : ''
          return (
            <fieldset className="grid gap-4 border-t pt-4 md:grid-cols-4" key={patient.id}>
              <legend className="pr-3 text-sm font-semibold">{messages.patient} {index + 1}</legend>
              <Field>
                <FieldLabel htmlFor={`editor-patient-name-${index}`}>{messages.patientName}</FieldLabel>
                <Input id={`editor-patient-name-${index}`} onChange={event => updatePatient(index, { name: event.currentTarget.value })} value={patient.name} />
              </Field>
              <Field>
                <FieldLabel htmlFor={`editor-patient-birth-${index}`}>{messages.birthDate}</FieldLabel>
                <Input id={`editor-patient-birth-${index}`} onChange={event => updatePatient(index, { birthDate: event.currentTarget.value })} type="date" value={patient.birthDate} />
              </Field>
              <Field className="md:col-span-2">
                <FieldLabel htmlFor={`editor-chief-complaint-${index}`}>{messages.chiefComplaint}</FieldLabel>
                <Input id={`editor-chief-complaint-${index}`} onChange={event => updatePatient(index, {
                  patientKnowledge: { ...patient.patientKnowledge, chiefComplaint: event.currentTarget.value },
                })} value={chiefComplaint} />
              </Field>
              <Field>
                <FieldLabel htmlFor={`editor-temperature-${index}`}>{messages.temperatureC}</FieldLabel>
                <Input id={`editor-temperature-${index}`} onChange={event => updatePatient(index, {
                  physiologyBaseline: { ...patient.physiologyBaseline, temperatureC: Number(event.currentTarget.value) },
                })} step="0.1" type="number" value={temperatureC} />
              </Field>
            </fieldset>
          )
        })}
      </div>

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
  const [selectedDatasetId, setSelectedDatasetId] = useState<string>()
  const providers = useQuery({
    queryFn: ({ signal }) => getScenarioProviders(signal),
    queryKey: providersQueryKey,
  })
  const datasets = useQuery({
    queryFn: ({ signal }) => getScenarioDatasets(signal),
    queryKey: datasetsQueryKey,
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
  const generate = useMutation({
    mutationFn: () => generateScenarioDataset(request, newIdempotencyKey()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: datasetsQueryKey })
    },
  })
  const updatePopulation = (next: Partial<ScenarioGenerationRequest['population']>): void => {
    setRequest(current => ({ ...current, population: { ...current.population, ...next } }))
  }
  const updateAge = (next: Partial<ScenarioGenerationRequest['population']['age']>): void => {
    setRequest(current => ({
      ...current,
      population: { ...current.population, age: { ...current.population.age, ...next } },
    }))
  }

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
            <Field className="md:col-span-2">
              <FieldLabel htmlFor="scenario-dataset-name">{messages.datasetName}</FieldLabel>
              <Input id="scenario-dataset-name" maxLength={120} onChange={event => setRequest(current => ({ ...current, name: event.currentTarget.value }))} required value={request.name} />
            </Field>
            <Field>
              <FieldLabel htmlFor="scenario-population-count">{messages.populationCount}</FieldLabel>
              <Input id="scenario-population-count" max={1_000} min={1} onChange={event => updatePopulation({ count: Number(event.currentTarget.value) })} required type="number" value={request.population.count} />
            </Field>
            <Field>
              <FieldLabel htmlFor="scenario-age-min">{messages.minimumAge}</FieldLabel>
              <Input id="scenario-age-min" max={120} min={0} onChange={event => updateAge({ minimum: Number(event.currentTarget.value) })} required type="number" value={request.population.age.minimum} />
            </Field>
            <Field>
              <FieldLabel htmlFor="scenario-age-max">{messages.maximumAge}</FieldLabel>
              <Input id="scenario-age-max" max={120} min={0} onChange={event => updateAge({ maximum: Number(event.currentTarget.value) })} required type="number" value={request.population.age.maximum} />
            </Field>
            <Field>
              <FieldLabel htmlFor="scenario-gender">{messages.gender}</FieldLabel>
              <select className="h-8 rounded-md border border-input bg-background px-2 text-sm" id="scenario-gender" onChange={event => updatePopulation({ gender: event.currentTarget.value as ScenarioGenerationRequest['population']['gender'] })} value={request.population.gender}>
                <option value="any">{messages.genderAny}</option>
                <option value="female">{messages.gender_female}</option>
                <option value="male">{messages.gender_male}</option>
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor="scenario-population-seed">{messages.populationSeed}</FieldLabel>
              <Input id="scenario-population-seed" min={0} onChange={event => setRequest(current => ({ ...current, seeds: { ...current.seeds, population: Number(event.currentTarget.value) } }))} required type="number" value={request.seeds.population} />
            </Field>
            <Field>
              <FieldLabel htmlFor="scenario-clinical-seed">{messages.clinicalSeed}</FieldLabel>
              <Input id="scenario-clinical-seed" min={0} onChange={event => setRequest(current => ({ ...current, seeds: { ...current.seeds, clinical: Number(event.currentTarget.value) } }))} required type="number" value={request.seeds.clinical} />
            </Field>
            <Field>
              <FieldLabel htmlFor="scenario-start-date">{messages.historyStart}</FieldLabel>
              <Input id="scenario-start-date" onChange={event => setRequest(current => ({ ...current, timeRange: { ...current.timeRange, start: event.currentTarget.value } }))} required type="date" value={request.timeRange.start} />
            </Field>
            <Field>
              <FieldLabel htmlFor="scenario-end-date">{messages.historyEnd}</FieldLabel>
              <Input id="scenario-end-date" onChange={event => setRequest(current => ({ ...current, timeRange: { ...current.timeRange, end: event.currentTarget.value } }))} required type="date" value={request.timeRange.end} />
            </Field>
          </FieldGroup>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={request.modules.includes('fever')} disabled />
              {messages.moduleFever}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={request.modules.includes('type-2-diabetes')} onCheckedChange={checked => setRequest(current => ({
                ...current,
                modules: checked
                  ? [...new Set([...current.modules, 'type-2-diabetes' as const])]
                  : current.modules.filter(module => module !== 'type-2-diabetes'),
              }))} />
              {messages.moduleDiabetes}
            </label>
          </div>
          <div className="flex justify-end">
            <Button disabled={generate.isPending || providers.data?.items[0]?.available !== true} type="submit">
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
        </form>
      </section>

      <section aria-labelledby="dataset-list-heading" className="flex min-w-0 flex-col gap-3">
        <div className="flex items-center gap-2">
          <DatabaseIcon aria-hidden="true" className="size-4" />
          <h2 className="text-base font-semibold" id="dataset-list-heading">{messages.datasets}</h2>
        </div>
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
