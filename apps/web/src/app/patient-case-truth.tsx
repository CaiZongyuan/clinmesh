import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { z } from 'zod'
import { getAdministratorCaseTruth } from './api-client.ts'
import { SourceHistoryDetail, sourceResourceTitle } from './source-history-detail.tsx'
import type { WorkspaceLocale } from './workspace-i18n.ts'

const referenceSchema = z.object({ reference: z.string() })
const encounterDiagnosisSchema = z.array(z.object({ condition: referenceSchema }))

function RelatedTruthRecord({ locale, resource }: { locale: WorkspaceLocale; resource: unknown }) {
  const [open, setOpen] = useState(false)
  return (
    <details className="border-t py-3" onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open) }} open={open}>
      <summary className="cursor-pointer break-words text-sm font-medium">{sourceResourceTitle(resource, locale)}</summary>
      {open ? <SourceHistoryDetail locale={locale} resource={resource} /> : null}
    </details>
  )
}

export function PatientCaseTruth({ caseId, locale }: { caseId: string; locale: WorkspaceLocale }) {
  const [open, setOpen] = useState(false)
  const zh = locale === 'zh-CN'
  const truth = useQuery({
    enabled: open,
    gcTime: 0,
    queryFn: ({ signal }) => getAdministratorCaseTruth(caseId, signal),
    queryKey: ['administrator-case-truth', caseId],
  })
  const encounter = truth.data?.items.find(item => item.sourceReference === truth.data?.indexEncounterReference)
  const encounterReferences = new Set([
    truth.data?.indexEncounterReference,
    ...(encounter === undefined ? [] : [`Encounter/${encounter.resource.id}`]),
  ].filter(reference => reference !== undefined))
  const explicitDiagnoses = new Set((encounterDiagnosisSchema.safeParse(encounter?.resource.diagnosis).data ?? [])
    .map(diagnosis => diagnosis.condition.reference))
  const diagnoses = truth.data?.items.filter(item => item.resource.resourceType === 'Condition' && (
    encounterReferences.has(referenceSchema.safeParse(item.resource.encounter).data?.reference ?? '')
    || explicitDiagnoses.has(item.sourceReference)
    || explicitDiagnoses.has(`Condition/${item.resource.id}`)
  )) ?? []
  const diagnosisReferences = new Set(diagnoses.map(item => item.sourceReference))
  const related = truth.data?.items.filter(item => !diagnosisReferences.has(item.sourceReference)
    && item.sourceReference !== truth.data?.indexEncounterReference) ?? []
  return (
    <details className="border-t p-4" onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open) }} open={open}>
      <summary className="cursor-pointer text-sm font-semibold">{zh ? '本次病例真值' : 'Current case ground truth'}</summary>
      {open ? (
        <div className="mt-3">
          <p className="text-xs text-muted-foreground">{zh ? '仅管理员可见，用于核对本次疾病与病例依据。' : 'Administrator view of the current disease and supporting evidence.'}</p>
          {truth.isPending ? <Skeleton className="mt-3 h-32 w-full" /> : truth.isError ? (
            <Alert className="mt-3" variant="destructive">
              <AlertTitle>{zh ? '无法加载本次病例真值' : 'Unable to load case truth'}</AlertTitle>
              <AlertDescription><Button onClick={() => void truth.refetch()} size="sm" variant="outline">{zh ? '重试' : 'Retry'}</Button></AlertDescription>
            </Alert>
          ) : (
            <div className="mt-4 grid gap-5">
              <section>
                <h4 className="text-sm font-semibold">{zh ? '本次诊断' : 'Current diagnoses'}</h4>
                {diagnoses.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">{zh ? '来源病例未记录明确诊断' : 'No explicit diagnosis recorded in the source case'}</p> : diagnoses.map(item => (
                  <SourceHistoryDetail key={item.sourceReference} locale={locale} resource={item.resource} />
                ))}
              </section>
              {encounter === undefined ? null : (
                <section className="border-t pt-3">
                  <h4 className="text-sm font-semibold">{zh ? '本次就诊' : 'Current encounter'}</h4>
                  <SourceHistoryDetail locale={locale} resource={encounter.resource} />
                </section>
              )}
              {related.length === 0 ? null : (
                <section>
                  <h4 className="mb-2 text-sm font-semibold">{zh ? '相关记录' : 'Related records'} · {related.length}</h4>
                  {related.map(item => <RelatedTruthRecord key={item.sourceReference} locale={locale} resource={item.resource} />)}
                </section>
              )}
            </div>
          )}
        </div>
      ) : null}
    </details>
  )
}
