import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import type { ClinicalOverrideInput } from '@clinmesh/contracts/clinical-quality'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import {
  inpatientFullCatalogSchema,
  inpatientFullClinicalSchema,
} from '@clinmesh/contracts/inpatient-clinical'
import { inpatientInvestigationCatalogSchema } from '@clinmesh/contracts/inpatient-investigations'
import type { inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { medicationRouteSchema } from '@clinmesh/contracts/medication-safety'
import type { OrderSetDraft } from '@clinmesh/contracts/order-set-templates'
import type { InpatientDoseResult } from '@clinmesh/core/inpatient-dose'
import { formatPreopOrderPolicy } from '@clinmesh/core/inpatient-surgery-consent'
import { formatMedicationRoute } from '@clinmesh/core/medication-safety'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@clinmesh/ui/components/alert-dialog'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@clinmesh/ui/components/dialog'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Spinner } from '@clinmesh/ui/components/spinner'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { PlusIcon, RefreshCwIcon } from 'lucide-react'
import { ApiClientError, apiGet, getOrderSetDrafts, newIdempotencyKey } from './api-client.ts'
import { ClinicalQualityBanner } from './clinical-quality-banner.tsx'
import { formatMedicationSpec } from './doctor/catalog-picker-dialogs.tsx'
import { indicationLabel } from './doctor/laboratory-page.tsx'
import { OrderCatalogCandidate, OrderComposerFooter } from './doctor/order-composer-layout.tsx'
import { subscribeIssueDraftSettlement } from './inpatient-issue-draft-settlement.ts'
import type { InvestigationAttempt, InvestigationDraftRow } from './inpatient-investigation-drafts.ts'
import { inpatientFrequencyLabel } from './inpatient-labels.ts'
import { orderDose, orderSelection, type OrderAttempt, type OrderDraftRow } from './inpatient-order-drafts.ts'
import { InpatientOrderPicker, type InpatientOrderPick } from './inpatient-order-picker.tsx'
import {
  emptyPostopDraft,
  hydratePostopDraft,
  postopDraftKey,
  postopDraftSchema,
  postopInvestigationLimit,
  postopOrderLimit,
  readPostopDraft,
  savePostopDraft,
  type PostopDraft,
} from './inpatient-postop-drafts.ts'
import {
  InpatientCommandRejection,
  OriginalContinuationUnreadable,
  type useInpatientWriteIntent,
} from './inpatient-write-intent.ts'
import {
  MedicationInsertTriggerButton,
  MedicationPackageInsertSheet,
  type MedicationPackageInsertTarget,
} from './medication-package-insert-sheet.tsx'
import { getBatchFailureMessage, getWorkspaceErrorMessage } from './workspace-error.ts'
import { formatFen, formatShanghaiMinute } from './workspace-format.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { WorkspaceSelect } from './workspace-select.tsx'

type SurgeryExecution = z.infer<typeof inpatientSurgerySchema>['executions'][number]
type InvestigationCatalogItem = z.infer<typeof inpatientInvestigationCatalogSchema>['items'][number]

function doseError(reason: Extract<InpatientDoseResult, { reason: string }>['reason'], locale: WorkspaceLocale) {
  const t = (cn: string, en: string) => (locale === 'zh-CN' ? cn : en)
  if (reason === 'fractional-quantity') return t('剂量须为制剂规格的整数倍', 'Dose must be a whole multiple of the unit strength')
  if (reason === 'dose-limit') return t('单次剂量超出目录上限', 'Single dose exceeds catalog limit')
  if (reason === 'unit-mismatch') return t('剂量单位与制剂含量单位不匹配', 'Dose unit does not match the formulation strength unit')
  if (reason === 'missing-conversion') return t('该药品缺少明确的剂量换算依据', 'Missing unit conversion basis for this medication')
  return t('请填写有效剂量（如 100 mg、1000 mL）', 'Enter a valid dose (e.g. 100 mg, 1000 mL)')
}

export interface InpatientPostopComposerProps {
  open: boolean
  onOpenChange(open: boolean): void
  active: boolean
  session: SessionContext
  admission: InpatientAdmission
  surgeries: readonly SurgeryExecution[]
  initialSurgeryExecutionId?: string | undefined
  locale: WorkspaceLocale
  write: ReturnType<typeof useInpatientWriteIntent>
}

/** 术后医嘱重整统一编排弹窗：整合术后药品、病房护理与术后复查检验/功能检查，共享单一顺序提交与不确定回执恢复边界。 */
export function InpatientPostopComposer(props: InpatientPostopComposerProps): React.JSX.Element | null {
  const { open, onOpenChange, active, session, admission, surgeries, initialSurgeryExecutionId, locale, write } = props
  const zh = locale === 'zh-CN'
  const t = (cn: string, en: string) => (zh ? cn : en)
  const messages = getWorkspaceMessages(locale)
  const formId = useId()

  const defaultSurgeryId = initialSurgeryExecutionId && surgeries.some(item => item.id === initialSurgeryExecutionId)
    ? initialSurgeryExecutionId
    : surgeries.at(-1)?.id ?? ''
  const [selectedSurgeryId, setSelectedSurgeryId] = useState(defaultSurgeryId)
  const wasOpen = useRef(false)
  useEffect(() => {
    const justOpened = open && !wasOpen.current
    wasOpen.current = open
    if (!open) return
    setSelectedSurgeryId(previous => {
      if (!justOpened && previous && surgeries.some(item => item.id === previous)) return previous
      return initialSurgeryExecutionId && surgeries.some(item => item.id === initialSurgeryExecutionId)
        ? initialSurgeryExecutionId
        : surgeries.at(-1)?.id ?? ''
    })
  }, [open, initialSurgeryExecutionId, surgeries])

  const activeSurgeryId = surgeries.some(item => item.id === selectedSurgeryId)
    ? selectedSurgeryId
    : surgeries.at(-1)?.id ?? ''
  const activeSurgery = surgeries.find(item => item.id === activeSurgeryId)
  const scope = ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId]
  const invKey = ['inpatient', session.user.id, session.actor]

  const clinical = useQuery({
    queryKey: [...scope, admission.id, 'clinical'],
    enabled: open && active,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/clinical`, inpatientFullClinicalSchema, signal),
  })
  const clinicalCatalog = useQuery({
    queryKey: [...scope, 'clinical-catalog'],
    enabled: open && active,
    queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/clinical-catalog', inpatientFullCatalogSchema, signal),
  })
  const investigationCatalog = useQuery({
    queryKey: [...invKey, 'investigation-catalog'],
    enabled: open && active,
    queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/investigation-catalog', inpatientInvestigationCatalogSchema, signal),
  })
  const orderSetBundle = useQuery({
    queryKey: [...scope, admission.id, 'order-set-drafts', 'postop', activeSurgeryId],
    enabled: open && active && activeSurgeryId.length > 0,
    staleTime: 0,
    queryFn: ({ signal }) => getOrderSetDrafts(
      { admissionId: admission.id, scope: 'inpatient', surgeryExecutionId: activeSurgeryId },
      undefined,
      signal,
    ),
  })

  const storageKey = activeSurgeryId ? postopDraftKey(session, admission, activeSurgeryId) : ''
  const [draft, setDraft] = useState<PostopDraft>(() => emptyPostopDraft())
  const [storageError, setStorageError] = useState(false)
  const current = useRef<PostopDraft>(draft)
  const hydratedKeys = useRef(new Set<string>())
  const [running, setRunning] = useState(false)
  const busy = useRef(false)
  const mounted = useRef(true)
  const latest = useRef({
    active,
    admission,
    encounterVersion: clinical.data?.encounterVersion ?? admission.versionId,
    open,
    storageKey,
  })
  latest.current = {
    active,
    admission,
    encounterVersion: clinical.data?.encounterVersion ?? admission.versionId,
    open,
    storageKey,
  }
  const lifecycle = useRef({ visible: active && open, revision: 0 })
  if (lifecycle.current.visible !== (active && open)) {
    lifecycle.current = { visible: active && open, revision: lifecycle.current.revision + 1 }
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  useEffect(() => {
    if (!storageKey) {
      const empty = emptyPostopDraft()
      current.current = empty
      setDraft(empty)
      setStorageError(false)
      return
    }
    const reload = () => {
      try {
        const next = readPostopDraft(storageKey, admission.id)
        current.current = next
        setDraft(next)
        setStorageError(false)
      } catch {
        setStorageError(true)
      }
    }
    reload()
    return subscribeIssueDraftSettlement(storageKey, reload)
  }, [storageKey, admission.id])

  const save = useCallback((next: PostopDraft) => {
    if (!storageKey) return false
    try {
      const valid = postopDraftSchema.parse(next)
      current.current = valid
      setDraft(valid)
      savePostopDraft(storageKey, valid)
      setStorageError(false)
      return true
    } catch {
      setStorageError(true)
      return false
    }
  }, [storageKey])

  const medications = clinicalCatalog.data?.medications ?? []
  const services = clinicalCatalog.data?.services ?? []
  const investigationItems = investigationCatalog.data?.items ?? []
  const matchedDraft: OrderSetDraft | undefined = orderSetBundle.data?.drafts[0]
  const catalogsReady = clinicalCatalog.isSuccess && investigationCatalog.isSuccess

  const applyTemplateDraft = useCallback((source: OrderSetDraft) => {
    if (!activeSurgeryId) return
    const next = hydratePostopDraft(current.current, source, {
      investigationItems,
      medications,
      services,
      surgeryExecutionId: activeSurgeryId,
    })
    save(next)
  }, [activeSurgeryId, investigationItems, medications, save, services])

  useEffect(() => {
    if (!open || !active || !storageKey || !matchedDraft || !catalogsReady || storageError) return
    if (hydratedKeys.current.has(storageKey)) return
    const existing = current.current
    if (
      existing.templateFingerprint === matchedDraft.fingerprint
      || existing.orders.length > 0
      || existing.investigations.length > 0
      || existing.successes.length > 0
    ) {
      hydratedKeys.current.add(storageKey)
      return
    }
    hydratedKeys.current.add(storageKey)
    applyTemplateDraft(matchedDraft)
  }, [open, active, storageKey, matchedDraft, catalogsReady, storageError, applyTemplateDraft])

  const [notice, setNotice] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [customTab, setCustomTab] = useState<'order' | 'investigation'>('order')
  const [customInvQuery, setCustomInvQuery] = useState('')
  const [insertTarget, setInsertTarget] = useState<MedicationPackageInsertTarget | null>(null)
  useEffect(() => { if (!open) { setInsertTarget(null); setCustomOpen(false) } }, [open])

  const diagnosed = (clinical.data?.diagnosis.entries.length ?? 0) > 0
  const hasPendingAttempt = draft.orders.some(row => row.attempt !== undefined)
    || draft.investigations.some(row => row.attempt !== undefined)
  const locked = write.blocked || running || storageError || admission.status !== 'admitted' || admission.recordStatus === 'archived' || hasPendingAttempt
  const isCurrent = () => mounted.current
    && latest.current.active
    && latest.current.open
    && latest.current.storageKey === storageKey
    && latest.current.admission.id === admission.id
    && latest.current.admission.status === 'admitted'
    && latest.current.admission.recordStatus !== 'archived'

  const updateOrder = useCallback((id: string, patch: Partial<OrderDraftRow>) => {
    return save({
      ...current.current,
      orders: current.current.orders.map(row => row.id === id ? { ...row, ...patch } : row),
    })
  }, [save])

  const updateInvestigation = useCallback((id: string, patch: Partial<InvestigationDraftRow>) => {
    return save({
      ...current.current,
      investigations: current.current.investigations.map(row => row.id === id ? { ...row, ...patch } : row),
    })
  }, [save])

  const orderProblem = useCallback((row: OrderDraftRow) => {
    if (row.pick.kind === 'medication' && !diagnosed) return t('请先确认住院诊断', 'Confirm inpatient diagnoses first')
    if (row.duration === 'long' && row.frequencyCode === 'ONCE') return t('ONCE 仅允许用于临时医嘱', 'ONCE requires a temporary order')
    if (!orderSelection(row)) return t('请核对每次剂量、频次和给药途径', 'Check dose, frequency and route')
    if (row.pick.kind === 'service' && !services.some(item => item.id === row.pick.item.id && item.version === row.pick.item.version)) {
      return t('服务目录已变化，请移除后重新选择', 'Service catalog changed; remove and select again')
    }
    return undefined
  }, [diagnosed, services, locale])

  const invProblem = useCallback((row: InvestigationDraftRow) => {
    const latestItem = investigationItems.find(item => item.kind === row.item.kind && item.id === row.item.id)
    if (!latestItem?.available) return t('该项目当前不可开立', 'This item is currently unavailable')
    if (latestItem.version !== row.item.version || latestItem.priceFen !== row.item.priceFen) {
      return t('目录或价格已变化，请移除后重新选择', 'Catalog or price changed; remove and select again')
    }
    if (row.item.kind !== 'laboratory') {
      return row.indication.trim().length < 2 ? t('请填写检查指征（至少 2 字）', 'Enter a clinical indication (at least 2 characters)') : undefined
    }
    return !latestItem.indicationCodes.includes(row.indicationCode) ? t('请选择有效检验适应证', 'Choose a valid laboratory indication') : undefined
  }, [investigationItems, locale])

  const addCustomOrder = (pick: InpatientOrderPick | null) => {
    if (!pick || locked || !activeSurgeryId) return
    if (current.current.orders.some(row => row.pick.kind === pick.kind && row.pick.item.id === pick.item.id)) {
      setNotice(t('该医嘱项目已在待开清单中，请直接修改原行', 'This order is already in the list; edit that row'))
      return
    }
    if (current.current.orders.length >= postopOrderLimit) {
      setNotice(t(`术后医嘱最多保留 ${postopOrderLimit} 项`, `Keep at most ${postopOrderLimit} postoperative orders`))
      return
    }
    save({
      ...current.current,
      orders: [
        ...current.current.orders,
        {
          id: newIdempotencyKey(),
          pick,
          duration: pick.kind === 'service' ? 'temporary' : 'long',
          selected: true,
          doseText: pick.kind === 'medication' ? pick.item.doses[0]?.doseText ?? '' : '',
          ...(pick.kind === 'medication' ? { routeCode: pick.item.defaultRouteCode } : {}),
          ...(pick.kind === 'medication' && pick.item.frequencyCodes[0] ? { frequencyCode: pick.item.frequencyCodes[0] } : {}),
          surgeryExecutionId: activeSurgeryId,
        },
      ],
    })
    setNotice('')
  }

  const addCustomInvestigation = (item: InvestigationCatalogItem) => {
    if (locked || !activeSurgeryId || !item.available) return
    if (current.current.investigations.some(row => row.item.kind === item.kind && row.item.id === item.id)) {
      setNotice(t('该检查项目已在待开清单中，请直接修改原行', 'This investigation is already in the list; edit that row'))
      return
    }
    if (current.current.investigations.length >= postopInvestigationLimit) {
      setNotice(t(`术后检查最多保留 ${postopInvestigationLimit} 项`, `Keep at most ${postopInvestigationLimit} postoperative investigations`))
      return
    }
    save({
      ...current.current,
      investigations: [
        ...current.current.investigations,
        {
          id: newIdempotencyKey(),
          item,
          indicationCode: item.indicationCodes[0] ?? '',
          indication: item.kind !== 'laboratory' && activeSurgery ? `${activeSurgery.actualProcedure.coding.display}术后复查` : '',
          selected: true,
          surgeryExecutionId: activeSurgeryId,
        },
      ],
    })
    setNotice('')
  }

  const selectedOrders = draft.orders.filter(row => row.selected && !row.attempt)
  const selectedInvestigations = draft.investigations.filter(row => row.selected && !row.attempt)
  const totalSelected = selectedOrders.length + selectedInvestigations.length
  const anySelectedInvalid = selectedOrders.some(row => orderProblem(row) !== undefined)
    || selectedInvestigations.some(row => invProblem(row) !== undefined)

  const runSubmit = async (options?: {
    recoverOrder?: OrderDraftRow
    recoverInvestigation?: InvestigationDraftRow
    overrideForOrder?: { rowId: string; clinicalOverride: ClinicalOverrideInput }
  }) => {
    const recovering = options?.recoverOrder !== undefined || options?.recoverInvestigation !== undefined
    const overriding = options?.overrideForOrder !== undefined
    if (
      busy.current
      || storageError
      || !isCurrent()
      || (overriding && locked)
      || (!recovering && !overriding && (locked || !catalogsReady || totalSelected === 0 || anySelectedInvalid))
    ) {
      return
    }
    const revision = lifecycle.current.revision
    const currentView = () => isCurrent() && lifecycle.current.revision === revision
    busy.current = true
    setRunning(true)
    setNotice('')
    let pausedOnAmbiguous = false

    try {
      const orderIds = options?.overrideForOrder
        ? [options.overrideForOrder.rowId]
        : options?.recoverOrder
          ? [options.recoverOrder.id]
          : options?.recoverInvestigation
            ? []
            : selectedOrders.map(row => row.id)

      for (const id of orderIds) {
        if (!currentView()) break
        const row = current.current.orders.find(item => item.id === id)
        if (!row || (!options?.recoverOrder && orderProblem(row) !== undefined)) break
        const selection = orderSelection(row)
        if (!selection) break
        const attempt: OrderAttempt = row.attempt ?? {
          idempotencyKey: newIdempotencyKey(),
          input: {
            admissionId: admission.id,
            encounterVersion: latest.current.encounterVersion,
            duration: row.duration,
            selection,
            ...(row.surgeryExecutionId ? { surgeryExecutionId: row.surgeryExecutionId } : { surgeryExecutionId: activeSurgeryId }),
            ...(options?.overrideForOrder?.rowId === row.id ? { clinicalOverride: options.overrideForOrder.clinicalOverride } : {}),
          },
        }
        const beforeAttempt = current.current
        if (!updateOrder(row.id, { attempt, error: undefined })) {
          current.current = beforeAttempt
          setDraft(beforeAttempt)
          pausedOnAmbiguous = true
          break
        }
        try {
          await write.mutation.mutateAsync({
            operation: 'inpatient.order.issue',
            ...attempt,
            isCurrent: currentView,
            ...(options?.recoverOrder ? { recoverOriginal: true } : {}),
          })
          if (!currentView()) break
        } catch (cause) {
          if (
            !mounted.current
            || cause instanceof OriginalContinuationUnreadable
            || (cause instanceof ApiClientError && cause.code === 'INPATIENT_INTENT_STORAGE_UNAVAILABLE')
          ) {
            pausedOnAmbiguous = true
            break
          }
          const definite = cause instanceof InpatientCommandRejection
          const errObj = cause instanceof ApiClientError
            ? {
                status: cause.status,
                code: cause.code,
                ...(cause.reason === undefined ? {} : { reason: cause.reason }),
                ...(cause.clinicalQuality === undefined ? {} : { clinicalQuality: cause.clinicalQuality }),
                ...(cause.code === 'CATALOG_CONFLICT' || cause.code === 'CLINICAL_QUALITY_ALERT' || cause.code === 'CLINICAL_QUALITY_RED_LINE'
                  ? { message: cause.message }
                  : {}),
              }
            : { status: 0, code: '' }
          if (!definite) {
            updateOrder(row.id, { attempt, error: errObj })
            pausedOnAmbiguous = true
            break
          }
        }
      }

      if (!pausedOnAmbiguous && !options?.overrideForOrder && !options?.recoverOrder) {
        const invIds = options?.recoverInvestigation
          ? [options.recoverInvestigation.id]
          : selectedInvestigations.map(row => row.id)

        for (const id of invIds) {
          if (!currentView()) break
          const row = current.current.investigations.find(item => item.id === id)
          if (!row || (!options?.recoverInvestigation && invProblem(row) !== undefined)) break
          const attempt: InvestigationAttempt = row.attempt ?? {
            idempotencyKey: newIdempotencyKey(),
            input: {
              admissionId: admission.id,
              encounterVersion: latest.current.encounterVersion,
              catalogVersion: row.item.version,
              ...(row.surgeryExecutionId ? { surgeryExecutionId: row.surgeryExecutionId } : { surgeryExecutionId: activeSurgeryId }),
              selection: row.item.kind !== 'laboratory'
                ? { kind: row.item.kind, serviceId: row.item.id, indication: row.indication.trim() }
                : { kind: 'laboratory', catalogItemId: row.item.id, indicationCode: row.indicationCode },
            },
          }
          const beforeAttempt = current.current
          if (!updateInvestigation(row.id, { attempt, error: undefined })) {
            current.current = beforeAttempt
            setDraft(beforeAttempt)
            break
          }
          try {
            await write.mutation.mutateAsync({
              operation: 'inpatient.investigation.issue',
              ...attempt,
              isCurrent: currentView,
              ...(options?.recoverInvestigation ? { recoverOriginal: true } : {}),
            })
            if (!currentView()) break
          } catch (cause) {
            if (
              !mounted.current
              || cause instanceof OriginalContinuationUnreadable
              || (cause instanceof ApiClientError && cause.code === 'INPATIENT_INTENT_STORAGE_UNAVAILABLE')
            ) {
              break
            }
            const definite = cause instanceof InpatientCommandRejection
            if (!definite) {
              updateInvestigation(row.id, {
                attempt,
                error: cause instanceof ApiClientError ? { status: cause.status, code: cause.code } : { status: 0, code: '' },
              })
              break
            }
            if (cause.code === 'INPATIENT_INVESTIGATION_CATALOG_CONFLICT') {
              void investigationCatalog.refetch()
              break
            }
          }
        }
      }
    } finally {
      busy.current = false
      if (mounted.current) setRunning(false)
    }
  }

  const skippedItems = useMemo(
    () => matchedDraft?.items.filter(item => item.disposition === 'skipped') ?? [],
    [matchedDraft],
  )
  const excludedItems = useMemo(
    () => matchedDraft?.items.filter(item => item.disposition === 'excluded') ?? [],
    [matchedDraft],
  )
  const unavailableItems = useMemo(
    () => matchedDraft?.items.filter(item => item.disposition === 'unavailable') ?? [],
    [matchedDraft],
  )
  const needsReviewByCatalog = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of matchedDraft?.items ?? []) {
      if (item.disposition === 'needs-review' && item.matchedCatalogId !== null) {
        map.set(`${item.kind}:${item.matchedCatalogId}`, item.reasons.map(r => r.messageZh).join(' '))
      }
    }
    return map
  }, [matchedDraft])

  const customInvMatches = useMemo(() => {
    const q = customInvQuery.trim().toLowerCase()
    return investigationItems
      .filter(item => item.available)
      .filter(item => !q || item.display.toLowerCase().includes(q) || item.id.toLowerCase().includes(q))
      .slice(0, 12)
  }, [investigationItems, customInvQuery])

  if (!open) return null

  const policy = orderSetBundle.data?.target.scope === 'inpatient' ? orderSetBundle.data.target.preopOrderPolicy : undefined
  const loadError = clinical.error ?? clinicalCatalog.error ?? investigationCatalog.error ?? orderSetBundle.error

  return (
    <>
      <Dialog open={open} pending={running} onOpenChange={next => { if (!busy.current) onOpenChange(next) }}>
        <DialogContent className="flex h-[min(860px,calc(100svh-2rem))] flex-col sm:max-w-5xl" showCloseButton={!running}>
          <DialogHeader>
            <DialogTitle>{t('开立术后医嘱（重整与复查）', 'Postoperative order reorganization')}</DialogTitle>
            <DialogDescription>
              {t(
                '按本次已完成手术匹配术后成套医嘱模板，一次审核并顺序提交术后药品、病房护理与术后复查检验/功能检查，全部自动绑定本次手术。',
                'Match the postoperative order set for the completed surgery, review medications, ward nursing, and recheck investigations in one composer, and submit sequentially.',
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
            {activeSurgery ? (
              <div className="flex flex-wrap items-end justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
                {surgeries.length > 1 ? (
                  <Field className="min-w-0 flex-1">
                    <FieldLabel htmlFor={`${formId}-surgery`}>{t('目标已完成手术', 'Completed surgery')}</FieldLabel>
                    <WorkspaceSelect
                      id={`${formId}-surgery`}
                      disabled={running || hasPendingAttempt}
                      value={activeSurgeryId}
                      items={surgeries.map(item => ({
                        value: item.id,
                        label: `${item.actualProcedure.coding.code} · ${item.actualProcedure.coding.display} · ${formatShanghaiMinute(item.performedAt).slice(5)}`,
                      }))}
                      onValueChange={val => { if (val) setSelectedSurgeryId(val) }}
                    />
                  </Field>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{activeSurgery.actualProcedure.coding.display}</span>
                    <span className="font-mono text-xs text-muted-foreground">{activeSurgery.actualProcedure.coding.code}</span>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  {policy ? (
                    <Badge variant={policy === 'stop-on-completion' ? 'warning' : 'secondary'}>
                      {formatPreopOrderPolicy(policy, locale)}
                    </Badge>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={locked || orderSetBundle.isFetching}
                    onClick={async () => {
                      const refreshed = await orderSetBundle.refetch()
                      const freshDraft = refreshed.data?.drafts[0]
                      if (freshDraft) applyTemplateDraft(freshDraft)
                    }}
                  >
                    <RefreshCwIcon aria-hidden="true" data-icon="inline-start" className="size-3.5" />
                    {t('按最新检查与体征重新预筛', 'Re-screen against latest findings')}
                  </Button>
                </div>
              </div>
            ) : null}

            {policy === 'stop-on-completion' ? (
              <section aria-label={t('术前医嘱自动停嘱说明', 'Pre-op auto-stop notice')} className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-foreground">
                {t(
                  '术前有效长期医嘱已按手术通知单策略自动转为「待停嘱核对」，可直接在此重整术后医嘱；病区护士将核对停嘱并校对新开立医嘱。',
                  'Active pre-op long-term orders were automatically transitioned to stop-requested; you can reorganize post-op orders immediately while the ward nurse verifies stops and new orders.',
                )}
              </section>
            ) : policy === 'continue-active' ? (
              <p className="text-xs text-muted-foreground">
                {t(
                  '术前有效长期医嘱继续执行；组套已自动识别术前已在用同品种/同类互斥药物及在途检查并默认跳过，避免重复开立。',
                  'Active pre-op long-term orders continue; already-active medications, mutually exclusive classes, and in-flight investigations are marked skipped by default.',
                )}
              </p>
            ) : null}

            {loadError ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {t('术后医嘱预筛或目录加载失败：', 'Failed to load postoperative order set or catalog: ')}
                  {getWorkspaceErrorMessage(loadError, messages)}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="ml-2"
                    onClick={() => {
                      void clinical.refetch()
                      void clinicalCatalog.refetch()
                      void investigationCatalog.refetch()
                      void orderSetBundle.refetch()
                    }}
                  >
                    {t('重试加载', 'Retry')}
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}

            {orderSetBundle.isPending || clinicalCatalog.isPending || investigationCatalog.isPending ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                <Spinner />
                <span>{t('正在匹配术后重整组套并核对术前在用医嘱与禁忌…', 'Screening postoperative order set against active orders and contraindications…')}</span>
              </div>
            ) : null}

            {matchedDraft ? (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{zh ? matchedDraft.template.titleZh : matchedDraft.template.titleEn}</span>
                <Badge variant="outline">{t(`可开立 ${matchedDraft.counts.ready}`, `${matchedDraft.counts.ready} ready`)}</Badge>
                {matchedDraft.counts.needsReview > 0 ? <Badge variant="warning">{t(`待核实 ${matchedDraft.counts.needsReview}`, `${matchedDraft.counts.needsReview} review`)}</Badge> : null}
                {matchedDraft.counts.skipped > 0 ? <Badge variant="secondary">{t(`术前已在用跳过 ${matchedDraft.counts.skipped}`, `${matchedDraft.counts.skipped} skipped`)}</Badge> : null}
                {matchedDraft.counts.excluded > 0 ? <Badge variant="warning">{t(`已按禁忌剔除 ${matchedDraft.counts.excluded}`, `${matchedDraft.counts.excluded} excluded`)}</Badge> : null}
              </div>
            ) : null}

            {skippedItems.length > 0 ? (
              <section aria-label={t('术前已在用 · 默认跳过', 'Already active pre-op · skipped by default')} className="flex flex-col gap-1.5 rounded-md border bg-muted/20 p-3 text-xs">
                <h4 className="font-semibold text-foreground">{t(`术前已在用 · 默认跳过（${skippedItems.length} 项）`, `Already active · skipped (${skippedItems.length})`)}</h4>
                <ul className="flex flex-col gap-1 text-muted-foreground">
                  {skippedItems.map(item => (
                    <li key={item.key} className="flex flex-wrap items-baseline gap-1.5">
                      <Badge variant="secondary">{t('术前已在用 · 默认跳过', 'Already active · skipped')}</Badge>
                      <span className="font-medium text-foreground">{item.titleZh}</span>
                      <span>{item.reasons.map(r => r.messageZh).join(' ')}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {excludedItems.length > 0 ? (
              <section aria-label={t('已按禁忌剔除', 'Excluded by contraindication')} className="flex flex-col gap-1.5 rounded-md border border-warning/40 bg-warning/5 p-3 text-xs">
                <h4 className="font-semibold text-foreground">{t(`已按禁忌剔除（${excludedItems.length} 项）`, `Excluded by contraindication (${excludedItems.length})`)}</h4>
                <ul className="flex flex-col gap-1 text-muted-foreground">
                  {excludedItems.map(item => (
                    <li key={item.key} className="flex flex-wrap items-baseline gap-1.5">
                      <Badge variant="warning">{t('已按禁忌剔除', 'Excluded')}</Badge>
                      <span className="font-medium text-foreground">{item.titleZh}</span>
                      <span>{item.reasons.map(r => r.messageZh).join(' ')}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {unavailableItems.length > 0 ? (
              <section aria-label={t('暂不可开立', 'Unavailable')} className="flex flex-col gap-1 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                {unavailableItems.map(item => (
                  <div key={item.key} className="flex flex-wrap items-baseline gap-1.5">
                    <Badge variant="outline">{t('暂不可开立', 'Unavailable')}</Badge>
                    <span className="font-medium text-foreground">{item.titleZh}</span>
                    <span>{item.reasons.map(r => r.messageZh).join(' ')}</span>
                  </div>
                ))}
              </section>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={locked}
                onClick={() => save({
                  ...current.current,
                  orders: current.current.orders.map(row => !row.attempt && orderProblem(row) === undefined ? { ...row, selected: true } : row),
                  investigations: current.current.investigations.map(row => !row.attempt && invProblem(row) === undefined ? { ...row, selected: true } : row),
                })}
              >
                {t('全选可开立项目', 'Select all eligible')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={locked}
                onClick={() => save({
                  ...current.current,
                  orders: current.current.orders.map(row => ({ ...row, selected: false })),
                  investigations: current.current.investigations.map(row => ({ ...row, selected: false })),
                })}
              >
                {t('清空勾选', 'Clear selection')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={locked}
                onClick={() => setCustomOpen(prev => !prev)}
              >
                <PlusIcon aria-hidden="true" data-icon="inline-start" className="size-3.5" />
                {customOpen ? t('收起自定义添加', 'Hide custom picker') : t('添加自定义医嘱/检查', 'Add custom order/investigation')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={running || hasPendingAttempt}
                onClick={() => setConfirmClear(true)}
              >
                {t('清空待开清单', 'Discard drafts')}
              </Button>
            </div>

            {customOpen ? (
              <section aria-label={t('添加自定义术后项目', 'Add custom postoperative items')} className="flex flex-col gap-3 rounded-md border bg-muted/20 p-3">
                <ToggleGroup
                  aria-label={t('自定义项目类型', 'Custom item category')}
                  size="sm"
                  variant="outline"
                  value={[customTab]}
                  onValueChange={values => {
                    const next = values[0]
                    if (next === 'order' || next === 'investigation') setCustomTab(next)
                  }}
                >
                  <ToggleGroupItem value="order">{t('药品与病房护理', 'Medications & ward nursing')}</ToggleGroupItem>
                  <ToggleGroupItem value="investigation">{t('检验与功能/影像检查', 'Labs & examinations')}</ToggleGroupItem>
                </ToggleGroup>
                {customTab === 'order' ? (
                  <InpatientOrderPicker
                    id={`${formId}-custom-order`}
                    inline
                    session={session}
                    locale={locale}
                    services={services}
                    diagnosed={diagnosed}
                    disabled={locked}
                    picked={null}
                    onOpenInsert={setInsertTarget}
                    onPick={addCustomOrder}
                  />
                ) : (
                  <div className="flex flex-col gap-2">
                    <Input
                      aria-label={t('搜索自定义术后检查', 'Search custom postoperative investigations')}
                      placeholder={t('输入检验或检查名称，例如 血常规、心电图', 'Search lab or exam name')}
                      value={customInvQuery}
                      onChange={event => setCustomInvQuery(event.currentTarget.value)}
                    />
                    <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
                      {customInvMatches.map(item => (
                        <li key={`${item.kind}:${item.id}`}>
                          <OrderCatalogCandidate
                            label={t(`添加自定义术后检查 ${item.display}`, `Add custom investigation ${item.display}`)}
                            selected={draft.investigations.some(row => row.item.kind === item.kind && row.item.id === item.id)}
                            disabled={locked}
                            onSelect={() => addCustomInvestigation(item)}
                          >
                            <span className="font-medium">{item.display}</span>
                            <Badge variant="outline" className="text-[11px]">
                              {item.kind === 'laboratory' ? t('检验', 'Lab') : item.kind === 'examination' ? t('功能检查', 'Exam') : t('影像', 'Imaging')}
                            </Badge>
                            {item.specimenContainer ? (
                              <Badge variant="secondary" className="text-[11px]">
                                {zh ? item.specimenContainer.containerNameZh : item.specimenContainer.containerNameEn}
                              </Badge>
                            ) : null}
                            <span className="text-xs tabular-nums text-muted-foreground">
                              {item.priceFen === undefined ? '—' : formatFen(item.priceFen, locale)}
                            </span>
                          </OrderCatalogCandidate>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>
            ) : null}

            <section aria-label={t('待开立术后医嘱（药品与病房护理）', 'Pending postoperative orders')} className="flex flex-col gap-2">
              <h4 className="text-sm font-semibold">
                {t(`术后药品与病房护理（待开 ${draft.orders.length} 项 · 已选 ${selectedOrders.length} 项）`, `Post-op medications & nursing (${draft.orders.length} drafts · ${selectedOrders.length} selected)`)}
              </h4>
              {draft.orders.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('当前无待开术后药品或病房护理医嘱。', 'No pending postoperative medication or nursing orders.')}</p>
              ) : draft.orders.map(row => {
                const dose = orderDose(row)
                const med = row.pick.kind === 'medication' ? row.pick.item : undefined
                const reviewNote = needsReviewByCatalog.get(`${row.pick.kind}:${row.pick.item.id}`)
                const spec = med ? formatMedicationSpec(med.strength, med.packageDescription) : ''
                const rowErr = typeof row.error === 'object' ? row.error : undefined
                const prob = orderProblem(row)
                return (
                  <section key={row.id} aria-label={t(`术后待开医嘱：${row.pick.item.display}`, `Post-op order: ${row.pick.item.display}`)} className="flex min-w-0 flex-col gap-2 rounded-md border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Checkbox
                        aria-label={t(`选择术后医嘱${row.pick.item.display}`, `Select post-op order ${row.pick.item.display}`)}
                        checked={row.selected}
                        disabled={locked || !!row.attempt}
                        onCheckedChange={checked => updateOrder(row.id, { selected: checked })}
                      />
                      <strong className="min-w-0 flex-1 text-sm">{row.pick.item.display}</strong>
                      <Badge variant="outline">{row.pick.kind === 'medication' ? t('药品', 'Medication') : t('病房护理', 'Ward nursing')}</Badge>
                      {reviewNote ? <Badge variant="warning">{t('待核实', 'Needs review')}</Badge> : null}
                      {med ? (
                        <MedicationInsertTriggerButton
                          locale={locale}
                          onOpen={() => setInsertTarget({ title: med.display, subtitle: spec || undefined, packageInsert: med.packageInsert })}
                        />
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={locked || !!row.attempt}
                        onClick={() => save({ ...current.current, orders: current.current.orders.filter(item => item.id !== row.id) })}
                      >
                        {t('移除', 'Remove')}
                      </Button>
                    </div>
                    {reviewNote ? <p className="text-xs text-warning">{reviewNote}</p> : null}
                    <div className="grid gap-2 md:grid-cols-4">
                      <Field>
                        <FieldLabel>{t('医嘱时效', 'Duration')}</FieldLabel>
                        <ToggleGroup
                          aria-label={t(`${row.pick.item.display}医嘱时效`, `${row.pick.item.display} duration`)}
                          size="sm"
                          variant="outline"
                          disabled={locked || !!row.attempt}
                          value={[row.duration]}
                          onValueChange={values => {
                            const next = values[0]
                            if (next === 'long' || next === 'temporary') {
                              updateOrder(row.id, {
                                duration: next,
                                error: undefined,
                                ...(next === 'long' && row.frequencyCode === 'ONCE' && row.pick.kind === 'medication'
                                  ? { frequencyCode: row.pick.item.frequencyCodes.find(code => code !== 'ONCE') }
                                  : {}),
                              })
                            }
                          }}
                        >
                          <ToggleGroupItem value="long">{t('长期', 'Long')}</ToggleGroupItem>
                          <ToggleGroupItem value="temporary">{t('临时', 'Temporary')}</ToggleGroupItem>
                        </ToggleGroup>
                      </Field>
                      {row.pick.kind === 'medication' ? (
                        <>
                          <Field>
                            <FieldLabel htmlFor={`${formId}-${row.id}-dose`}>{t('每次剂量', 'Dose')}</FieldLabel>
                            <Input
                              id={`${formId}-${row.id}-dose`}
                              disabled={locked || !!row.attempt}
                              value={row.doseText}
                              maxLength={120}
                              onChange={event => updateOrder(row.id, { doseText: event.currentTarget.value, error: undefined })}
                            />
                            {dose && 'quantity' in dose
                              ? <span className="text-xs text-muted-foreground">= {dose.quantity} {row.pick.item.unit}</span>
                              : dose && 'reason' in dose
                                ? <span className="text-xs text-destructive">{doseError(dose.reason, locale)}</span>
                                : null}
                          </Field>
                          <Field>
                            <FieldLabel htmlFor={`${formId}-${row.id}-freq`}>{t('频次', 'Frequency')}</FieldLabel>
                            <WorkspaceSelect
                              id={`${formId}-${row.id}-freq`}
                              disabled={locked || !!row.attempt}
                              value={row.frequencyCode ?? null}
                              items={row.pick.item.frequencyCodes.map(code => ({
                                value: code,
                                disabled: row.duration === 'long' && code === 'ONCE',
                                label: inpatientFrequencyLabel(code, locale),
                              }))}
                              onValueChange={value => updateOrder(row.id, { frequencyCode: value ?? undefined, error: undefined })}
                            />
                          </Field>
                          <Field>
                            <FieldLabel htmlFor={`${formId}-${row.id}-route`}>{t('给药途径', 'Route')}</FieldLabel>
                            <WorkspaceSelect
                              id={`${formId}-${row.id}-route`}
                              disabled={locked || !!row.attempt}
                              value={row.routeCode ?? null}
                              items={row.pick.item.allowedRouteCodes.map(code => ({
                                value: code,
                                label: formatMedicationRoute(code, locale),
                              }))}
                              onValueChange={value => {
                                const parsed = medicationRouteSchema.safeParse(value)
                                updateOrder(row.id, { routeCode: parsed.success ? parsed.data : undefined, error: undefined })
                              }}
                            />
                          </Field>
                          <Field className="md:col-span-4">
                            <FieldLabel htmlFor={`${formId}-${row.id}-inst`}>{t('给药说明', 'Instructions')}</FieldLabel>
                            <Input
                              id={`${formId}-${row.id}-inst`}
                              disabled={locked || !!row.attempt}
                              value={row.instructions ?? ''}
                              maxLength={240}
                              onChange={event => updateOrder(row.id, { instructions: event.currentTarget.value || undefined })}
                            />
                          </Field>
                        </>
                      ) : (
                        <div className="md:col-span-3 flex items-center text-xs text-muted-foreground">
                          {t(`每次 ${row.serviceQuantity ?? 1} ${row.pick.item.unit} · ${formatFen(row.pick.item.priceFen, locale)}/${row.pick.item.unit} · 病房护士执行后计费`, `${row.serviceQuantity ?? 1} ${row.pick.item.unit} · ${formatFen(row.pick.item.priceFen, locale)}/${row.pick.item.unit} · billed on ward nurse execution`)}
                        </div>
                      )}
                    </div>
                    {prob ? <p className="text-xs text-destructive">{prob}</p> : null}
                    {rowErr?.clinicalQuality ? (
                      <ClinicalQualityBanner
                        check={rowErr.clinicalQuality}
                        code={rowErr.code}
                        locale={locale}
                        onSubmitOverride={!row.attempt && !prob
                          ? (override => void runSubmit({ overrideForOrder: { rowId: row.id, clinicalOverride: override } }))
                          : undefined}
                        pending={locked || Boolean(prob)}
                      />
                    ) : row.error ? (
                      <p role="alert" className="text-xs text-destructive">
                        {typeof row.error === 'string' && zh
                          ? row.error
                          : rowErr?.message ?? getBatchFailureMessage(rowErr, locale)}
                        {' · '}
                        {row.attempt
                          ? t('结果待确认，请恢复原操作', 'Result unconfirmed; recover the original operation')
                          : t('请核对信息后重试', 'Review before retrying')}
                      </p>
                    ) : null}
                    {row.attempt ? (
                      <Button type="button" size="sm" disabled={running} onClick={() => void runSubmit({ recoverOrder: row })}>
                        {t(`恢复原开立：${row.pick.item.display}`, `Recover original order: ${row.pick.item.display}`)}
                      </Button>
                    ) : null}
                  </section>
                )
              })}
            </section>

            <section aria-label={t('待开立术后复查（检验与功能检查）', 'Pending postoperative investigations')} className="flex flex-col gap-2">
              <h4 className="text-sm font-semibold">
                {t(`术后复查检验与功能检查（待开 ${draft.investigations.length} 项 · 已选 ${selectedInvestigations.length} 项）`, `Post-op investigations (${draft.investigations.length} drafts · ${selectedInvestigations.length} selected)`)}
              </h4>
              {draft.investigations.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('当前无待开术后复查项目。', 'No pending postoperative investigations.')}</p>
              ) : draft.investigations.map(row => {
                const reviewNote = needsReviewByCatalog.get(`${row.item.kind}:${row.item.id}`)
                const latestCatalogItem = investigationItems.find(item => item.kind === row.item.kind && item.id === row.item.id)
                const container = row.item.specimenContainer ?? latestCatalogItem?.specimenContainer
                const prob = invProblem(row)
                return (
                  <section key={row.id} aria-label={t(`术后待开检查：${row.item.display}`, `Post-op investigation: ${row.item.display}`)} className="flex min-w-0 flex-col gap-2 rounded-md border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Checkbox
                        aria-label={t(`选择术后检查${row.item.display}`, `Select post-op investigation ${row.item.display}`)}
                        checked={row.selected}
                        disabled={locked || !!row.attempt}
                        onCheckedChange={checked => updateInvestigation(row.id, { selected: checked })}
                      />
                      <strong className="min-w-0 flex-1 text-sm">{row.item.display}</strong>
                      <Badge variant="outline">
                        {row.item.kind === 'laboratory' ? t('检验', 'Laboratory') : row.item.kind === 'examination' ? t('功能检查', 'Functional exam') : t('影像', 'Imaging')}
                      </Badge>
                      {container ? (
                        <Badge variant="secondary">
                          {zh ? `${container.containerNameZh} · ${container.specimenCategoryZh}` : `${container.containerNameEn} · ${container.specimenCategoryEn}`}
                        </Badge>
                      ) : null}
                      {reviewNote ? <Badge variant="warning">{t('待核实', 'Needs review')}</Badge> : null}
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {row.item.priceFen === undefined ? '—' : formatFen(row.item.priceFen, locale)}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={locked || !!row.attempt}
                        onClick={() => save({ ...current.current, investigations: current.current.investigations.filter(item => item.id !== row.id) })}
                      >
                        {t('移除', 'Remove')}
                      </Button>
                    </div>
                    {reviewNote ? <p className="text-xs text-warning">{reviewNote}</p> : null}
                    <Field>
                      <FieldLabel htmlFor={`${formId}-inv-${row.id}`}>
                        {row.item.kind !== 'laboratory' ? t('检查指征', 'Clinical indication') : messages.laboratoryIndication}
                      </FieldLabel>
                      {row.item.kind !== 'laboratory' ? (
                        <Input
                          id={`${formId}-inv-${row.id}`}
                          disabled={locked || !!row.attempt}
                          value={row.indication}
                          maxLength={500}
                          onChange={event => updateInvestigation(row.id, { indication: event.currentTarget.value, error: undefined })}
                        />
                      ) : row.item.indicationCodes.length === 1 ? (
                        <div id={`${formId}-inv-${row.id}`} className="flex h-8 items-center rounded-md border px-2.5 text-sm">
                          {indicationLabel(row.item.indicationCodes[0]!, messages)}
                        </div>
                      ) : (
                        <WorkspaceSelect
                          id={`${formId}-inv-${row.id}`}
                          disabled={locked || !!row.attempt}
                          value={row.indicationCode || null}
                          items={row.item.indicationCodes.map(code => ({ value: code, label: indicationLabel(code, messages) }))}
                          onValueChange={value => updateInvestigation(row.id, { indicationCode: value ?? '', error: undefined })}
                        />
                      )}
                    </Field>
                    {prob ? <p className="text-xs text-destructive">{prob}</p> : null}
                    {row.error ? (
                      <p role="alert" className="text-xs text-destructive">
                        {typeof row.error === 'string' && zh
                          ? row.error
                          : getBatchFailureMessage(typeof row.error === 'string' ? undefined : row.error, locale)}
                        {' · '}
                        {row.attempt
                          ? t('结果待确认，请恢复原操作', 'Result unconfirmed; recover the original operation')
                          : t('请核对信息后重试', 'Review before retrying')}
                      </p>
                    ) : null}
                    {row.attempt ? (
                      <Button type="button" size="sm" disabled={running} onClick={() => void runSubmit({ recoverInvestigation: row })}>
                        {t(`恢复原开立：${row.item.display}`, `Recover original request: ${row.item.display}`)}
                      </Button>
                    ) : null}
                  </section>
                )
              })}
            </section>

            {draft.successes.length > 0 ? (
              <div role="status" className="flex flex-col gap-1 rounded-md border border-success/40 bg-success/5 p-3 text-xs">
                <p className="font-medium text-foreground">
                  {t(`已成功开立术后医嘱与检查 ${draft.successes.length} 项`, `Issued ${draft.successes.length} postoperative orders & investigations`)}
                </p>
                {draft.successes.map(item => (
                  <p key={item.id} className="text-muted-foreground">
                    {item.display} · {item.kind === 'order' ? t('已开立，待护士校对', 'Issued, awaiting nurse verification') : t('已开立，待护士送检', 'Issued, awaiting nurse dispatch')}
                  </p>
                ))}
              </div>
            ) : null}

            {storageError || notice ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {storageError
                    ? t('术后重整待开清单无法保存或读取，已停止提交。请确认清空后重试。', 'Postoperative draft storage unavailable; submission stopped. Confirm discarding drafts to retry.')
                    : notice}
                </AlertDescription>
              </Alert>
            ) : null}
          </div>

          <OrderComposerFooter
            hint={
              running
                ? t('正在顺序提交术后医嘱与检查，请稍候…', 'Submitting postoperative orders and investigations sequentially…')
                : hasPendingAttempt
                  ? t('存在待确认结果的原操作，已暂停后续提交；请先恢复原操作', 'An original operation has an unconfirmed outcome; remaining items paused until recovered')
                  : anySelectedInvalid
                    ? t('还差：请修正已勾选项目中的标注问题', 'Complete: fix highlighted issues in selected items')
                    : t(`本次将顺序提交已选 ${selectedOrders.length} 项医嘱与 ${selectedInvestigations.length} 项检查（均关联本台手术）`, `Will submit ${selectedOrders.length} orders and ${selectedInvestigations.length} investigations linked to this surgery`)
            }
          >
            <DialogClose render={<Button type="button" variant="outline" />}>{t('关闭', 'Close')}</DialogClose>
            <Button
              type="button"
              aria-busy={running || undefined}
              data-busy={running || undefined}
              disabled={locked || !catalogsReady || totalSelected === 0 || anySelectedInvalid}
              onClick={() => void runSubmit()}
            >
              {running ? <Spinner aria-hidden="true" data-icon="inline-start" /> : null}
              {running
                ? t('正在提交术后医嘱…', 'Submitting…')
                : t(`提交术后医嘱与检查（${totalSelected}）`, `Submit post-op orders & tests (${totalSelected})`)}
            </Button>
          </OrderComposerFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog pending={false} open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('清空术后医嘱重整待开清单？', 'Discard postoperative drafts?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('将清除本台手术尚未提交的术后待开医嘱与检查项目；已正式开立的医嘱与检查不受影响。', 'Discards unsubmitted postoperative orders and investigations for this surgery. Already issued items remain.')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('保留待开清单', 'Keep drafts')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { save(emptyPostopDraft()); setConfirmClear(false) }}>
              {t('确认清空', 'Confirm discard')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <MedicationPackageInsertSheet locale={locale} onClose={() => setInsertTarget(null)} target={insertTarget} />
    </>
  )
}
