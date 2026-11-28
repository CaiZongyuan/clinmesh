import { useEffect, useRef, useState } from 'react'
import { FilePlus2, Trash2 } from 'lucide-react'
import { ExaminationReportText } from './examination-report-text.tsx'
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
import { OrderSetSelectorBar } from '../order-set-selector.tsx'
import { getWorkspaceErrorMessage } from '../workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import {
  applyOrderSetLabDrafts,
  syncOrderSetExamDraft,
  useInvestigationPreferences,
  useManualInvestigationDrafts,
  useOrderSetExamDraft,
} from './investigation-draft-storage.ts'
import { InvestigationRequestWorkspace } from './investigation-request-workspace.tsx'
import { InvestigationBilling, InvestigationPrice } from './investigation-billing.tsx'
import { OutpatientInvestigationActions } from './outpatient-investigation-actions.tsx'
import type { OutpatientInvestigationActionContext } from './outpatient-investigation-action-store.ts'
import { OutpatientOrderGateGuidance, resolveOutpatientOrderPrerequisiteGate, type OutpatientOrderPrerequisiteGate } from './outpatient-order-gate.tsx'

export function ExaminationPage({
  detail,
  locale,
  readOnly,
  active,
  elementId,
  actionContext,
  orderGate,
  recommendationScope,
  selectedRequestId,
  onSelectRequest,
}: {
  detail: DoctorCaseDetail
  locale: WorkspaceLocale
  readOnly: boolean
  active: boolean
  elementId: string
  actionContext: OutpatientInvestigationActionContext | undefined
  orderGate?: OutpatientOrderPrerequisiteGate | undefined
  recommendationScope?: string | undefined
  selectedRequestId?: string | undefined
  onSelectRequest: (id: string) => void
}) {
  const effectiveOrderGate = orderGate ?? resolveOutpatientOrderPrerequisiteGate(detail)
  const zh = locale === 'zh-CN',
    state = detail.examinationRequests,
    draftVersion = state?.draftVersion ?? 0,
    messages = getWorkspaceMessages(locale)
  const unsavedExam = useOrderSetExamDraft(detail.caseId, detail.encounter.id)
  const override = unsavedExam.value?.baseDraftVersion === draftVersion ? unsavedExam.value : null
  const labDraftScope = JSON.stringify([recommendationScope, detail.caseId, detail.encounter.id, 'laboratory'])
  const labDrafts = useManualInvestigationDrafts(labDraftScope)
  const labPreferences = useInvestigationPreferences(labDraftScope)
  const [serviceId, setServiceId] = useState(override?.serviceId ?? state?.draft?.service.id ?? 'examination-ecg-12-lead'),
    [indication, setIndication] = useState(override?.indication ?? state?.draft?.indication ?? '')
  const previousCaseIdRef = useRef(detail.caseId)
  useEffect(() => {
    const caseChanged = previousCaseIdRef.current !== detail.caseId
    previousCaseIdRef.current = detail.caseId
    if (override !== null) {
      setServiceId(override.serviceId)
      setIndication(override.indication)
    } else if (state?.draft !== undefined) {
      setServiceId(state.draft.service.id)
      setIndication(state.draft.indication)
    } else if (caseChanged) {
      setServiceId('examination-ecg-12-lead')
      setIndication('')
    }
  }, [detail.caseId, override, state?.draft?.indication, state?.draft?.service.id, state?.draftVersion])
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
    onSuccess: (_result, action) => {
      unsavedExam.save(() => null)
      if (action === 'issue') setIndication('')
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
            {readOnly ? null : (
              <OrderSetSelectorBar
                disabled={readOnly || mutation.isPending}
                excludeKinds={['medication']}
                itemKinds={['examination']}
                locale={locale}
                onApply={draft => {
                  const examItem = draft.items.find(item => item.candidate?.kind === 'examination')
                  const { exam, removed } = syncOrderSetExamDraft(draft, unsavedExam, draftVersion)
                  if (exam) { setServiceId(exam.serviceId); setIndication(exam.indication) }
                  const lab = applyOrderSetLabDrafts(draft, labDrafts, labPreferences)
                  return {
                    addedCount: exam ? 1 : 0,
                    ...(lab.added > 0 ? { extraNote: zh ? `同时向「检验」待开清单加入 ${lab.added} 项` : `Also added ${lab.added} items to Laboratory pending list` } : {}),
                    removedCount: removed + lab.removed,
                    reviewCount: (examItem?.disposition === 'needs-review' ? 1 : 0) + lab.review,
                  }
                }}
                target={{ caseId: detail.caseId, scope: 'outpatient' }}
              />
            )}
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
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    data-unavailable={effectiveOrderGate.blocked ? '' : undefined}
                    disabled={readOnly || mutation.isPending || effectiveOrderGate.blocked}
                    onClick={() => mutation.mutate('issue')}
                  >
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
                <OutpatientOrderGateGuidance gate={effectiveOrderGate} locale={locale} />
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
