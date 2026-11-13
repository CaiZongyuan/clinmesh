import { useState } from 'react'
import { FilePlus2, Trash2 } from 'lucide-react'
import { ExaminationReportText } from './examination-report-text.tsx'
import { AgentReviewAnchor } from '../agent-review.tsx'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { DoctorCaseDetail, ExaminationRequest } from '@clinmesh/contracts/his'
import { Alert, AlertTitle, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@clinmesh/ui/components/select'
import { Textarea } from '@clinmesh/ui/components/textarea'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@clinmesh/ui/components/dialog'
import {
  deleteExaminationRequestDraft,
  getCaseExaminationServices,
  issueExaminationRequest,
  newIdempotencyKey,
  saveExaminationRequestDraft,
} from '../api-client.ts'
import { getWorkspaceErrorMessage } from '../workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import { InvestigationRequestWorkspace } from './investigation-request-workspace.tsx'
import { InvestigationBilling, InvestigationPrice } from './investigation-billing.tsx'
import { OutpatientInvestigationActions } from './outpatient-investigation-actions.tsx'
import type { OutpatientInvestigationActionContext } from './outpatient-investigation-action-store.ts'

export function ExaminationPage({
  detail,
  locale,
  readOnly,
  active,
  elementId,
  actionContext,
  selectedRequestId,
  onSelectRequest,
}: {
  detail: DoctorCaseDetail
  locale: WorkspaceLocale
  readOnly: boolean
  active: boolean
  elementId: string
  actionContext: OutpatientInvestigationActionContext | undefined
  selectedRequestId?: string | undefined
  onSelectRequest: (id: string) => void
}) {
  const zh = locale === 'zh-CN',
    state = detail.examinationRequests,
    messages = getWorkspaceMessages(locale)
  const [serviceId, setServiceId] = useState(state?.draft?.service.id ?? 'examination-ecg-12-lead'),
    [indication, setIndication] = useState(state?.draft?.indication ?? '')
  const [deleteReview, setDeleteReview] = useState<{
    version: number
    encounterVersion: string
    name: string
    indication: string
  } | null>(null)
  const catalog = useQuery({
    queryKey: ['examination-services', detail.caseId],
    enabled: active,
    queryFn: ({ signal }) => getCaseExaminationServices(detail.caseId, signal),
  })
  const mutation = useMutation({
    mutationFn: async (action: 'save' | 'issue' | 'delete') => {
      const input = {
        encounterId: detail.encounter.id,
        encounterVersion: detail.encounter.versionId,
        expectedDraftVersion: state?.draftVersion ?? 0,
      }
      return action === 'save'
        ? saveExaminationRequestDraft({ ...input, serviceId, indication }, newIdempotencyKey())
        : action === 'issue'
          ? issueExaminationRequest(input, newIdempotencyKey())
          : deleteExaminationRequestDraft(input, newIdempotencyKey())
    },
    onSettled: () => actionContext?.onChanged(),
  })
  const requests = state?.requests ?? [],
    selected = requests.find((item) => item.id === selectedRequestId) ?? requests[0]
  const label = (request: ExaminationRequest) =>
    ({
      issued: zh ? '待收费/执行' : 'Issued',
      accepted: zh ? '已受理' : 'Accepted',
      'in-progress': zh ? '检查中' : 'In progress',
      reported: zh ? '待阅' : 'Unread',
      acknowledged: zh ? '已阅' : 'Acknowledged',
      cancelled: zh ? '已取消' : 'Cancelled',
      'generation-failed': zh ? '未取得结果' : 'No result',
    })[request.status]
  const service = catalog.data?.items.find((item) => item.service.id === serviceId)?.service
  return (
    <section id={elementId} className="min-w-0">
      <InvestigationRequestWorkspace
        locale={locale}
        requests={requests.map((request) => ({
          id: request.id,
          title: request.service.name,
          statusLabel: label(request),
          unread: request.status === 'reported',
          inProgress: ['issued', 'accepted', 'in-progress'].includes(request.status),
        }))}
        selectedRequestId={selected?.id}
        onSelectRequest={onSelectRequest}
        entry={
          <FieldGroup>
            <Field>
              <FieldLabel>{zh ? '功能检查项目' : 'Functional examination'}</FieldLabel>
              <Select
                value={serviceId}
                onValueChange={(value) => {
                  if (value !== null) setServiceId(value)
                }}
                disabled={readOnly || mutation.isPending}
              >
                <SelectTrigger aria-label={zh ? '功能检查项目' : 'Functional examination'}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {catalog.data?.items.map((item) => (
                      <SelectItem key={item.service.id} value={item.service.id} disabled={!item.available}>
                        {item.service.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor={`examination-indication-${detail.caseId}`}>
                {zh ? '检查指征' : 'Clinical indication'}
              </FieldLabel>
              <Textarea
                id={`examination-indication-${detail.caseId}`}
                value={indication}
                onChange={(event) => setIndication(event.target.value)}
                maxLength={500}
                disabled={readOnly || mutation.isPending}
              />
            </Field>
            {service ? <InvestigationPrice locale={locale} price={service.outpatientBilling} /> : null}
            <Button
              disabled={readOnly || mutation.isPending || indication.trim().length < 2 || !service}
              onClick={() => mutation.mutate('save')}
            >
              {zh ? '保存功能检查草稿' : 'Save examination draft'}
            </Button>
          </FieldGroup>
        }
        pending={
          <div className="flex flex-col gap-3">
            {state?.draft ? (
              <>
                <strong>{state.draft.service.name}</strong>
                <p>{state.draft.indication}</p>
                <div className="flex gap-2">
                  <Button disabled={readOnly || mutation.isPending} onClick={() => mutation.mutate('issue')}>
                    <FilePlus2 aria-hidden="true" />
                    {zh ? '开立功能检查' : 'Issue examination'}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={readOnly || mutation.isPending}
                    onClick={() =>
                      setDeleteReview({
                        version: state.draftVersion,
                        encounterVersion: detail.encounter.versionId,
                        name: state.draft!.service.name,
                        indication: state.draft!.indication,
                      })
                    }
                  >
                    <Trash2 aria-hidden="true" />
                    {zh ? '删除草稿' : 'Delete draft'}
                  </Button>
                </div>
              </>
            ) : (
              <p>{zh ? '暂无功能检查草稿' : 'No examination draft'}</p>
            )}
            {mutation.isError || catalog.isError ? (
              <Alert variant="destructive">
                <AlertTitle>{zh ? '操作未完成' : 'Action incomplete'}</AlertTitle>
                <AlertDescription>
                  {getWorkspaceErrorMessage(mutation.error ?? catalog.error ?? new Error(), messages)}
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
        }
        actionRecords={
          actionContext ? (
            <OutpatientInvestigationActions
              context={actionContext}
              kind="examination"
              locale={locale}
              readOnly={readOnly}
              records={requests.map((request) => ({
                request,
                title: request.service.name,
                statusLabel: label(request),
              }))}
              onSelectRequest={onSelectRequest}
              selectedRequestId={selected?.id}
            />
          ) : null
        }
      >
        {selected ? (
          <AgentReviewAnchor id={`doctor-investigation:${selected.id}`}>
            <div className="flex flex-col gap-3">
              <h4>{selected.service.name}</h4>
              <p>
                {selected.indication} · {label(selected)}
              </p>
              {selected.billing ? <InvestigationBilling billing={selected.billing} locale={locale} /> : null}
              {selected.generationError ? (
                <Alert variant="destructive">
                  <AlertTitle>{zh ? '未取得报告' : 'No report'}</AlertTitle>
                  <AlertDescription>{selected.generationError.message}</AlertDescription>
                </Alert>
              ) : null}
              {selected.report ? <ExaminationReportText report={selected.report} locale={locale} /> : null}
            </div>
          </AgentReviewAnchor>
        ) : (
          <p>{zh ? '尚未开立功能检查' : 'No functional examination issued'}</p>
        )}
      </InvestigationRequestWorkspace>
      <Dialog
        open={deleteReview !== null}
        pending={mutation.isPending}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setDeleteReview(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{zh ? '删除功能检查草稿' : 'Delete examination draft'}</DialogTitle>
            <DialogDescription>
              {zh ? '核对当前患者的待开立草稿后确认删除。' : 'Review this patient’s draft before deleting it.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 p-4">
            <p>{detail.patient.name}</p>
            <strong>{deleteReview?.name}</strong>
            <p>{deleteReview?.indication}</p>
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>{zh ? '保留草稿' : 'Keep draft'}</DialogClose>
            <Button
              variant="destructive"
              disabled={
                readOnly ||
                mutation.isPending ||
                deleteReview?.version !== state?.draftVersion ||
                deleteReview?.encounterVersion !== detail.encounter.versionId
              }
              onClick={() => mutation.mutate('delete', { onSuccess: () => setDeleteReview(null) })}
            >
              <Trash2 aria-hidden="true" />
              {zh ? '确认删除草稿' : 'Confirm draft deletion'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
