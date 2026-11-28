import type { DoctorCaseDetail } from '@clinmesh/contracts/his'
import {
  clinicalScoreBundleSchema,
  type ClinicalRiskAssessmentFieldsInput,
  type ClinicalRiskAssessmentRecord,
  type ClinicalScoreBundle,
  type InpatientVitalSignsRecord,
  type KillipClass,
  type PriorBleedingHistory,
  type SmokingStatus,
} from '@clinmesh/contracts/clinical-scores'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Input } from '@clinmesh/ui/components/input'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'
import { apiGet, getOutpatientClinicalScores, newIdempotencyKey, recordOutpatientRiskAssessment } from './api-client.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { formatShanghaiMinute } from './workspace-format.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { WorkspaceSelect } from './workspace-select.tsx'

type Write = ReturnType<typeof useInpatientWriteIntent>

interface RiskFormState {
  anginaEpisodes24h: string
  aspirinUsedLast7Days: '' | 'true' | 'false'
  cardiacArrestOnAdmission: '' | 'true' | 'false'
  familyHistoryPrematureCad: '' | 'true' | 'false'
  killipClass: '' | KillipClass
  knownCoronaryStenosisGe50: '' | 'true' | 'false'
  priorBleedingHistory: '' | PriorBleedingHistory
  smokingStatus: '' | SmokingStatus
  stSegmentDeviation: '' | 'true' | 'false'
}

const boolKeys = ['aspirinUsedLast7Days', 'cardiacArrestOnAdmission', 'familyHistoryPrematureCad', 'knownCoronaryStenosisGe50', 'stSegmentDeviation'] as const

function toRiskForm(record: ClinicalRiskAssessmentRecord | undefined): RiskFormState {
  const v = record?.values
  const out = {
    anginaEpisodes24h: v?.anginaEpisodes24h == null ? '' : String(v.anginaEpisodes24h),
    aspirinUsedLast7Days: '', cardiacArrestOnAdmission: '', familyHistoryPrematureCad: '', knownCoronaryStenosisGe50: '', stSegmentDeviation: '',
    killipClass: v?.killipClass ?? '',
    priorBleedingHistory: v?.priorBleedingHistory ?? '',
    smokingStatus: v?.smokingStatus ?? '',
  } as RiskFormState
  for (const k of boolKeys) out[k] = v?.[k] == null ? '' : String(v[k]) as 'true' | 'false'
  return out
}

function parseRiskFields(form: RiskFormState): ClinicalRiskAssessmentFieldsInput {
  const anginaTrim = form.anginaEpisodes24h.trim()
  const out: Record<string, unknown> = {
    anginaEpisodes24h: anginaTrim === '' ? null : Number(anginaTrim),
    killipClass: form.killipClass || null,
    priorBleedingHistory: form.priorBleedingHistory || null,
    smokingStatus: form.smokingStatus || null,
  }
  for (const k of boolKeys) out[k] = form[k] === '' ? null : form[k] === 'true'
  return out as ClinicalRiskAssessmentFieldsInput
}

function RemoteAdvanceAlert({ current, base, isVitals, zh, onSync }: { current: number; base: number | undefined; isVitals?: boolean; zh: boolean; onSync: () => void }) {
  return <Alert><AlertDescription className="flex flex-wrap items-center justify-between gap-2">
    <span>{zh
      ? `远端已有更新${isVitals ? '生命体征' : '记录'} #${current}（当前草稿基于 #${base}）；直接${isVitals ? '记录' : '保存'}将执行并发版本校验，或放弃草稿同步最新记录。`
      : `Remote ${isVitals ? 'vital signs' : 'record'} advanced to #${current} (draft based on #${base}); saving checks version conflict, or discard draft to sync.`}</span>
    <Button onClick={onSync} size="sm" type="button" variant="outline">{zh ? (isVitals ? '放弃体征草稿并同步' : '放弃草稿并同步') : (isVitals ? 'Discard vitals draft & sync' : 'Discard draft & sync')}</Button>
  </AlertDescription></Alert>
}

function ClinicalScoresBody({
  bundle,
  canEditRisk,
  error,
  identityKey,
  loading,
  locale,
  onClearSaveError,
  onRetry,
  onSaveRisk,
  riskRecord,
  savingRisk,
}: {
  bundle: ClinicalScoreBundle | undefined
  canEditRisk: boolean
  error: Error | null | undefined
  identityKey: string
  loading: boolean
  locale: WorkspaceLocale
  onClearSaveError?: () => void
  onRetry: () => void
  onSaveRisk: (expectedRevision: number, fields: ClinicalRiskAssessmentFieldsInput) => void
  riskRecord: ClinicalRiskAssessmentRecord | undefined
  savingRisk: boolean
}) {
  const formId = useId()
  const zh = locale === 'zh-CN'
  const t = (cn: string, en: string) => (zh ? cn : en)
  const messages = getWorkspaceMessages(locale)
  const effectiveRecord = bundle?.riskAssessment ?? riskRecord
  const canEditEffective = canEditRisk && effectiveRecord !== undefined
  const recordSyncKey = effectiveRecord === undefined
    ? 'loading'
    : `${effectiveRecord.observationId ?? 'none'}:${effectiveRecord.revision}`
  const mkRiskDraft = (rec = effectiveRecord) => ({
    baseRevision: rec?.revision,
    dirty: false,
    form: toRiskForm(rec),
    identityKey,
    recordSyncKey,
  })
  const [draft, setDraft] = useState(mkRiskDraft)
  useEffect(() => {
    setDraft(prev => {
      if (prev.identityKey !== identityKey) return mkRiskDraft()
      if (effectiveRecord !== undefined && prev.recordSyncKey !== recordSyncKey) {
        const next = mkRiskDraft(effectiveRecord)
        const matchesRemote = JSON.stringify(parseRiskFields(prev.form)) === JSON.stringify(parseRiskFields(next.form))
        if (!prev.dirty || prev.baseRevision === undefined || matchesRemote) return next
      }
      return prev
    })
  }, [identityKey, recordSyncKey, effectiveRecord])
  const form = draft.form
  const hasRemoteRevisionAdvance =
    draft.dirty
    && draft.baseRevision !== undefined
    && effectiveRecord !== undefined
    && draft.baseRevision !== effectiveRecord.revision
  const updateForm = (updater: (prev: RiskFormState) => RiskFormState) => {
    setDraft(prev => ({ ...prev, dirty: true, form: updater(prev.form) }))
  }

  const anginaInvalid = form.anginaEpisodes24h.trim() !== ''
    && (!Number.isInteger(Number(form.anginaEpisodes24h)) || Number(form.anginaEpisodes24h) < 0 || Number(form.anginaEpisodes24h) > 100)

  return (
    <div className="flex flex-col gap-3 pt-2 text-xs">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span>{getWorkspaceErrorMessage(error, messages)}</span>
            <Button onClick={onRetry} size="sm" type="button" variant="outline">{t('重试', 'Retry')}</Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">{t('六项确定性临床评分', 'Deterministic clinical scores')}</span>
          <Button disabled={loading} onClick={onRetry} size="sm" type="button" variant="ghost">{t('刷新评分', 'Refresh scores')}</Button>
        </div>
        {bundle === undefined ? (
          <p className="text-muted-foreground">{loading ? t('正在读取客观记录并计算…', 'Evaluating from recorded clinical data…') : t('展开后按已记录指标实时计算。', 'Computed from recorded clinical indicators.')}</p>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {bundle.scores.map(score => (
              <div className="flex flex-col gap-1 rounded-md border bg-muted/20 p-2" key={score.id}>
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <span className="font-medium">{zh ? score.titleZh : score.titleEn}</span>
                  <Badge variant={score.status === 'complete' ? 'secondary' : 'outline'}>
                    {score.status === 'complete'
                      ? (zh ? score.summaryZh : score.summaryEn)
                      : t(`缺 ${score.missingInputs.length} 项`, `${score.missingInputs.length} missing`)}
                  </Badge>
                </div>
                {score.status === 'incomplete' ? (
                  <p className="text-muted-foreground">{zh ? score.summaryZh : score.summaryEn}</p>
                ) : null}
                {score.sourceReferences.length > 0 ? (
                  <p className="text-[11px] text-muted-foreground tabular-nums">
                    {t('依据：', 'Sources: ')}
                    {score.sourceReferences.map(ref => `${ref.label} (${ref.reference}#${ref.versionId})`).join(' · ')}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      <form
        className="flex flex-col gap-2 rounded-md border p-2.5"
        onSubmit={event => {
          event.preventDefault()
          if (!canEditEffective || savingRisk || anginaInvalid) return
          onSaveRisk(draft.baseRevision ?? effectiveRecord.revision, parseRiskFields(form))
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">{t('专病风险评估（床旁记录）', 'Clinical risk assessment')}</span>
          <span className="text-muted-foreground tabular-nums">
            {effectiveRecord && effectiveRecord.revision > 0 && effectiveRecord.recordedAt
              ? `${t('已记录', 'Recorded')} #${effectiveRecord.revision} · ${formatShanghaiMinute(effectiveRecord.recordedAt)}`
              : t('尚未记录（未填项保持未记录）', 'Not recorded (blank stays unrecorded)')}
          </span>
        </div>
        {hasRemoteRevisionAdvance ? <RemoteAdvanceAlert base={draft.baseRevision} current={effectiveRecord.revision} zh={zh} onSync={() => {
          onClearSaveError?.()
          setDraft(mkRiskDraft(effectiveRecord))
        }} /> : null}
        {effectiveRecord?.effectiveStSegmentDeviation?.source === 'ecg-report' ? (
          <p className="text-muted-foreground">
            {t('ST 段状态当前采用首份已签发 12 导联心电图报告：', 'ST-segment status resolved from initial issued 12-lead ECG report: ')}
            <strong>{effectiveRecord.effectiveStSegmentDeviation.value ? t('有偏移', 'Deviation present') : t('无偏移', 'No deviation')}</strong>
            {` (${effectiveRecord.effectiveStSegmentDeviation.sourceReference}#${effectiveRecord.effectiveStSegmentDeviation.versionId})`}
          </p>
        ) : null}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {([
            ['killipClass', t('Killip 分级', 'Killip class'), [['I', 'Killip I'], ['II', 'Killip II'], ['III', 'Killip III'], ['IV', 'Killip IV']]],
            ['cardiacArrestOnAdmission', t('入院心脏骤停', 'Cardiac arrest'), [['false', t('无', 'No')], ['true', t('有', 'Yes')]]],
            null,
            ['stSegmentDeviation', t('床旁 ST 段偏移', 'Bedside ST deviation'), [['false', t('无偏移', 'Absent')], ['true', t('有偏移', 'Present')]]],
            ['aspirinUsedLast7Days', t('近 7 天阿司匹林', 'Aspirin in 7d'), [['false', t('未使用', 'No')], ['true', t('已使用', 'Yes')]]],
            ['smokingStatus', t('吸烟状态', 'Smoking status'), [['never', t('从不吸烟', 'Never')], ['former', t('既往戒烟', 'Former')], ['current', t('当前吸烟', 'Current')]]],
            ['familyHistoryPrematureCad', t('早发冠心病家族史', 'Premature CAD family history'), [['false', t('阴性', 'Negative')], ['true', t('阳性', 'Positive')]]],
            ['knownCoronaryStenosisGe50', t('已知冠脉狭窄 ≥50%', 'Known CAD stenosis ≥50%'), [['false', t('无 / <50%', 'No / <50%')], ['true', t('有 (≥50%)', 'Yes (≥50%)')]]],
            ['priorBleedingHistory', t('既往自发性出血史', 'Prior spontaneous bleeding'), [['negative', t('无出血史', 'None')], ['non-spontaneous', t('仅外伤/手术出血', 'Traumatic/operative only')], ['spontaneous', t('有自发性出血（需医疗救治/干预）', 'Spontaneous (requiring medical attention)')]]],
          ] as const).map(entry => entry === null ? (
            <label className="flex flex-col gap-1" key="anginaEpisodes24h">
              <span>{t('24h 心绞痛次数', '24h angina count')}</span>
              <Input className="h-8 text-xs" disabled={!canEditEffective || savingRisk} max={100} min={0} onChange={e => { const v = e.currentTarget.value; updateForm(s => ({ ...s, anginaEpisodes24h: v })) }} placeholder={t('未记录', 'Not recorded')} step={1} type="number" value={form.anginaEpisodes24h} />
            </label>
          ) : (
            <div className="flex flex-col gap-1" key={entry[0]}>
              <label htmlFor={`${formId}-${entry[0]}`}>{entry[1]}</label>
              <WorkspaceSelect
                ariaLabel={entry[1]}
                disabled={!canEditEffective || savingRisk}
                id={`${formId}-${entry[0]}`}
                items={[
                  { value: '__empty__', label: t('未记录', 'Not recorded') },
                  ...entry[2].map(([val, text]) => ({ value: val, label: text })),
                ]}
                onValueChange={val => {
                  const next = val === null || val === '__empty__' ? '' : val
                  updateForm(s => ({ ...s, [entry[0]]: next } as RiskFormState))
                }}
                value={form[entry[0]] === '' ? '__empty__' : form[entry[0]]}
              />
            </div>
          ))}
          {canEditRisk ? (
            <div className="flex items-end">
              <Button className="w-full" disabled={!canEditEffective || savingRisk || anginaInvalid} size="sm" type="submit" variant="outline">
                {savingRisk ? t('保存中…', 'Saving…') : t('保存风险评估', 'Save risk assessment')}
              </Button>
            </div>
          ) : null}
        </div>
      </form>
    </div>
  )
}

export function buildOutpatientClinicalScoreRevision(
  detail: Partial<Pick<
    DoctorCaseDetail,
    'diagnosis' | 'examinationRequests' | 'laboratoryRequests' | 'medicationConclusion' | 'triage'
  >>,
  baseRevision?: string,
): string {
  const reqKey = (items: ReadonlyArray<{ id: string; version: number; status: string; report?: { diagnosticReportId: string; diagnosticReportVersion: string } | undefined }> | undefined) =>
    (items ?? []).map(r => `${r.id}:${r.version}:${r.status}:${r.report?.diagnosticReportId ?? ''}:${r.report?.diagnosticReportVersion ?? ''}`).join(',')
  const examKey = reqKey(detail.examinationRequests?.requests)
  const labKey = reqKey(detail.laboratoryRequests?.requests)
  const rxKey = JSON.stringify(detail.medicationConclusion ?? null)
  const dxKey = (detail.diagnosis?.confirmation?.entries ?? [])
    .map(d => `${d.conditionId}:${d.conditionVersion}:${d.code}`)
    .join(',')
  const triageKey = detail.triage === undefined
    ? ''
    : `${detail.triage.bloodPressure.systolicMmHg}/${detail.triage.bloodPressure.diastolicMmHg}:${detail.triage.pulseBpm}:${detail.triage.weightKg ?? ''}:${detail.triage.heightCm ?? ''}`
  return [baseRevision ?? '', examKey, labKey, rxKey, dxKey, triageKey].join('|')
}

export function OutpatientClinicalScoresDisclosure({
  caseId,
  clinicalRevision,
  encounterId,
  encounterVersion,
  locale,
  readOnly,
  scope,
}: {
  caseId: string
  clinicalRevision?: string | undefined
  encounterId: string
  encounterVersion: string
  locale: WorkspaceLocale
  readOnly: boolean
  scope: string
}) {
  const zh = locale === 'zh-CN'
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const scoresKey = ['doctor-clinical-scores', scope, caseId, encounterVersion, clinicalRevision ?? ''] as const
  const scores = useQuery({
    enabled: open,
    queryFn: ({ signal }) => getOutpatientClinicalScores(caseId, signal),
    queryKey: scoresKey,
    refetchInterval: open && !readOnly ? 3_000 : false,
    refetchIntervalInBackground: false,
  })
  const saveRisk = useMutation({
    mutationFn: (payload: { expectedRevision: number; fields: ClinicalRiskAssessmentFieldsInput }) =>
      recordOutpatientRiskAssessment({
        encounterId,
        encounterVersion,
        expectedRevision: payload.expectedRevision,
        fields: payload.fields,
      }, newIdempotencyKey()),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: scoresKey }),
        queryClient.invalidateQueries({
          predicate: query => query.queryKey[0] === 'doctor-case' && query.queryKey.includes(caseId),
        }),
      ])
    },
  })
  const completeCount = scores.data?.scores.filter(item => item.status === 'complete').length

  return (
    <details
      className="clinmesh-inpatient-disclosure mt-3 rounded-lg border px-3 py-2"
      onToggle={event => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-medium">
        {zh ? '专病风险评估与临床评分' : 'Clinical risk assessment & scores'}
        {completeCount === undefined ? null : <span className="ml-2 text-xs text-muted-foreground tabular-nums">{zh ? `已就绪 ${completeCount}/6` : `${completeCount}/6 complete`}</span>}
      </summary>
      <ClinicalScoresBody
        bundle={scores.data}
        canEditRisk={!readOnly}
        error={scores.error ?? saveRisk.error}
        identityKey={`${caseId}:${encounterId}`}
        loading={scores.isFetching}
        locale={locale}
        onClearSaveError={() => saveRisk.reset()}
        onRetry={() => { void scores.refetch() }}
        onSaveRisk={(expectedRevision, fields) => saveRisk.mutate({ expectedRevision, fields })}
        riskRecord={scores.data?.riskAssessment}
        savingRisk={saveRisk.isPending}
      />
    </details>
  )
}

const vitalsKeys = ['diastolicMmHg', 'heightCm', 'oxygenSaturationPct', 'pulseBpm', 'respirationBpm', 'systolicMmHg', 'temperatureC', 'weightKg'] as const
type VitalsFormState = Record<(typeof vitalsKeys)[number], string>

function toVitalsForm(record: InpatientVitalSignsRecord | undefined): VitalsFormState {
  const src: Record<string, unknown> = record === undefined ? {} : {
    ...record,
    diastolicMmHg: record.bloodPressure.diastolicMmHg,
    systolicMmHg: record.bloodPressure.systolicMmHg,
  }
  const out = {} as VitalsFormState
  for (const k of vitalsKeys) out[k] = src[k] === undefined ? '' : String(src[k])
  return out
}

function normalizeVitalsFormForCompare(form: VitalsFormState) {
  const out: Record<string, number | string | null> = {}
  for (const k of vitalsKeys) {
    const trimmed = form[k].trim()
    const parsed = Number(trimmed)
    out[k] = trimmed === '' ? null : Number.isFinite(parsed) ? parsed : trimmed
  }
  return out
}

type InpatientInvestigationSummaryItem = {
  id: string
  previousReports?: ReadonlyArray<{ diagnosticReportId: string }> | undefined
  report?: { diagnosticReportId: string; diagnosticReportVersion: string } | undefined
  status: string
  version: number
}

export function buildInpatientClinicalScoreRevision(input: {
  chargesCount?: number | undefined
  diagnosisRevision: number
  executions: ReadonlyArray<{ id: string; status: string; version: number }>
  investigations?:
    | {
        examinationRequests?: ReadonlyArray<InpatientInvestigationSummaryItem> | undefined
        imagingRequests?: ReadonlyArray<InpatientInvestigationSummaryItem> | undefined
        laboratoryRequests?: ReadonlyArray<InpatientInvestigationSummaryItem> | undefined
      }
    | undefined
  orders: ReadonlyArray<{ id: string; state: string; version: number }>
  surgeries?:
    | {
        executions: ReadonlyArray<{ id: string }>
        inProgress?: ReadonlyArray<{ id: string; requestId?: string | undefined }> | undefined
        requests: ReadonlyArray<{ id: string; status: string; version: number }>
      }
    | undefined
}): string {
  const formatInv = (items: ReadonlyArray<InpatientInvestigationSummaryItem> | undefined) =>
    (items ?? [])
      .map(
        r =>
          `${r.id}@${r.version}:${r.status}:${r.report?.diagnosticReportId ?? ''}#${r.report?.diagnosticReportVersion ?? ''}:${r.previousReports?.length ?? 0}`,
      )
      .join(',')
  const invSummary =
    input.investigations === undefined
      ? ''
      : `${formatInv(input.investigations.laboratoryRequests)}|${formatInv(input.investigations.examinationRequests)}|${formatInv(input.investigations.imagingRequests)}`
  return [
    String(input.diagnosisRevision),
    String(input.chargesCount ?? 0),
    input.orders.map(o => `${o.id}@${o.version}:${o.state}`).join(','),
    input.executions.map(e => `${e.id}@${e.version}:${e.status}`).join(','),
    input.surgeries?.requests.map(r => `${r.id}@${r.version}:${r.status}`).join(',') ?? '',
    input.surgeries?.inProgress?.map(p => `${p.id}:${p.requestId ?? ''}`).join(',') ?? '',
    input.surgeries?.executions.map(e => e.id).join(',') ?? '',
    invSummary,
  ].join(':')
}

export function InpatientVitalsAndScoresDisclosure({
  active = true,
  admissionId,
  archived = false,
  canEdit,
  clinicalRevision,
  encounterVersion,
  latestVitalSigns,
  locale,
  onScoresOpenChange,
  riskAssessment,
  scope,
  write,
}: {
  active?: boolean | undefined
  admissionId: string
  archived?: boolean | undefined
  canEdit: boolean
  clinicalRevision?: string | undefined
  encounterVersion: string
  latestVitalSigns: InpatientVitalSignsRecord | undefined
  locale: WorkspaceLocale
  onScoresOpenChange?: ((open: boolean) => void) | undefined
  riskAssessment: ClinicalRiskAssessmentRecord | undefined
  scope: readonly (string | undefined)[]
  write: Write
}) {
  const zh = locale === 'zh-CN'
  const t = (cn: string, en: string) => (zh ? cn : en)
  const queryClient = useQueryClient()
  const [scoresOpen, setScoresOpen] = useState(false)
  const vitalsSyncKey =
    latestVitalSigns === undefined
      ? 'none:0'
      : `${latestVitalSigns.observationId}:${latestVitalSigns.revision}`
  const mkVitalsDraft = () => ({
    admissionId,
    baseRevision: latestVitalSigns?.revision ?? 0,
    dirty: false,
    form: toVitalsForm(latestVitalSigns),
    vitalsSyncKey,
  })
  const [vitalsDraft, setVitalsDraft] = useState(mkVitalsDraft)

  useEffect(() => {
    setVitalsDraft(prev => {
      const next = mkVitalsDraft()
      if (prev.admissionId !== admissionId) return next
      if (prev.vitalsSyncKey !== vitalsSyncKey) {
        const matchesRemote =
          JSON.stringify(normalizeVitalsFormForCompare(prev.form))
          === JSON.stringify(normalizeVitalsFormForCompare(next.form))
        if (!prev.dirty || matchesRemote) return next
      }
      return prev
    })
  }, [admissionId, latestVitalSigns, vitalsSyncKey])

  const vitals = vitalsDraft.form
  const updateVitals = (updater: (prev: VitalsFormState) => VitalsFormState) => {
    setVitalsDraft(prev => ({ ...prev, dirty: true, form: updater(prev.form) }))
  }
  const hasVitalsRemoteAdvance =
    vitalsDraft.dirty && vitalsDraft.baseRevision !== (latestVitalSigns?.revision ?? 0)

  const scoresKey = [
    ...scope,
    admissionId,
    'clinical-scores',
    encounterVersion,
    latestVitalSigns?.revision ?? 0,
    riskAssessment?.revision ?? 0,
    clinicalRevision ?? '',
  ] as const
  const scores = useQuery({
    enabled: scoresOpen,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${encodeURIComponent(admissionId)}/clinical-scores`, clinicalScoreBundleSchema, signal),
    queryKey: scoresKey,
    refetchInterval: scoresOpen && active && !archived ? 3_000 : false,
    refetchIntervalInBackground: false,
  })

  const sysNum = Number(vitals.systolicMmHg)
  const diaNum = Number(vitals.diastolicMmHg)
  const vitalsValid = [vitals.temperatureC, vitals.pulseBpm, vitals.respirationBpm, vitals.systolicMmHg, vitals.diastolicMmHg, vitals.oxygenSaturationPct]
    .every(v => v.trim() !== '' && Number.isFinite(Number(v)))
    && sysNum > diaNum
    && (vitals.weightKg.trim() === '' || (Number(vitals.weightKg) >= 1 && Number(vitals.weightKg) <= 400))
    && (vitals.heightCm.trim() === '' || (Number(vitals.heightCm) >= 30 && Number(vitals.heightCm) <= 260))

  const completeCount = scores.data?.scores.filter(item => item.status === 'complete').length
  const vitalsSummary = latestVitalSigns === undefined
    ? t('尚未记录', 'Not recorded')
    : `${latestVitalSigns.temperatureC} °C · ${latestVitalSigns.pulseBpm} bpm · ${latestVitalSigns.bloodPressure.systolicMmHg}/${latestVitalSigns.bloodPressure.diastolicMmHg} mmHg · SpO₂ ${latestVitalSigns.oxygenSaturationPct}%${latestVitalSigns.weightKg === undefined ? '' : ` · ${latestVitalSigns.weightKg} kg`}${latestVitalSigns.heightCm === undefined ? '' : ` · ${latestVitalSigns.heightCm} cm`}`

  return (
    <div className="flex flex-col gap-2">
      <details className="clinmesh-inpatient-disclosure">
        <summary>
          {t('护理生命体征', 'Nursing vital signs')}{' '}
          <span className="text-xs font-normal text-muted-foreground tabular-nums">{vitalsSummary}</span>
        </summary>
        <form
          className="grid grid-cols-2 gap-2 pt-2 text-xs sm:grid-cols-4"
          onSubmit={event => {
            event.preventDefault()
            if (!canEdit || !vitalsValid) return
            void write.mutation.mutateAsync({
              input: {
                admissionId,
                bloodPressure: { diastolicMmHg: diaNum, systolicMmHg: sysNum },
                encounterVersion,
                expectedRevision: vitalsDraft.baseRevision,
                ...(vitals.heightCm.trim() === '' ? {} : { heightCm: Number(vitals.heightCm) }),
                oxygenSaturationPct: Number(vitals.oxygenSaturationPct),
                pulseBpm: Number(vitals.pulseBpm),
                respirationBpm: Number(vitals.respirationBpm),
                temperatureC: Number(vitals.temperatureC),
                ...(vitals.weightKg.trim() === '' ? {} : { weightKg: Number(vitals.weightKg) }),
              },
              operation: 'inpatient.vital-signs.record',
            }).then(() => queryClient.invalidateQueries({ queryKey: [...scope, admissionId, 'clinical-scores'] })).catch(() => undefined)
          }}
        >
          {hasVitalsRemoteAdvance ? <div className="col-span-2 sm:col-span-4"><RemoteAdvanceAlert base={vitalsDraft.baseRevision} current={latestVitalSigns?.revision ?? 0} isVitals zh={zh} onSync={() => {
            write.mutation.reset?.()
            setVitalsDraft(mkVitalsDraft())
          }} /></div> : null}
          {([
            ['temperatureC', t('体温 (°C)', 'Temp (°C)'), 30, 45, 0.1, false],
            ['pulseBpm', t('心率 (次/分)', 'Pulse (bpm)'), 20, 300, 1, false],
            ['respirationBpm', t('呼吸 (次/分)', 'Resp (/min)'), 4, 80, 1, false],
            ['oxygenSaturationPct', t('血氧 (%)', 'SpO₂ (%)'), 40, 100, 0.1, false],
            ['systolicMmHg', t('收缩压 (mmHg)', 'Systolic (mmHg)'), 40, 300, 1, false],
            ['diastolicMmHg', t('舒张压 (mmHg)', 'Diastolic (mmHg)'), 20, 200, 1, false],
            ['weightKg', t('体重 (kg，选填)', 'Weight (kg)'), 1, 400, 0.1, true],
            ['heightCm', t('身高 (cm，选填)', 'Height (cm)'), 30, 260, 0.1, true],
          ] as const).map(([key, label, min, max, step, opt]) => (
            <label className="flex flex-col gap-1" key={key}><span>{label}</span><Input className="h-8 text-xs" disabled={!canEdit} max={max} min={min} onChange={e => { const v = e.currentTarget.value; updateVitals(s => ({ ...s, [key]: v })) }} placeholder={opt ? t('未记录', 'Optional') : undefined} step={step} type="number" value={vitals[key]} /></label>
          ))}
          {canEdit ? (
            <div className="col-span-2 flex justify-end sm:col-span-4">
              <Button disabled={!vitalsValid || write.blocked} size="sm" type="submit" variant="outline">{t('记录生命体征', 'Record vital signs')}</Button>
            </div>
          ) : null}
        </form>
      </details>

      <details
        className="clinmesh-inpatient-disclosure"
        onToggle={event => {
          const nextOpen = event.currentTarget.open
          setScoresOpen(nextOpen)
          onScoresOpenChange?.(nextOpen)
        }}
      >
        <summary>
          {t('专病风险评估与临床评分', 'Clinical risk assessment & scores')}
          {completeCount === undefined ? null : <span className="ml-2 text-xs font-normal text-muted-foreground tabular-nums">{t(`已就绪 ${completeCount}/6`, `${completeCount}/6 complete`)}</span>}
        </summary>
        <ClinicalScoresBody
          bundle={scores.data}
          canEditRisk={canEdit}
          error={scores.error ?? (write.mutation.variables?.operation === 'inpatient.risk-assessment.record' ? (write.mutation.error ?? null) : null)}
          identityKey={admissionId}
          loading={scores.isFetching}
          locale={locale}
          onClearSaveError={() => write.mutation.reset?.()}
          onRetry={() => { void scores.refetch() }}
          onSaveRisk={(expectedRevision, fields) => {
            void write.mutation.mutateAsync({
              input: {
                admissionId,
                encounterVersion,
                expectedRevision,
                fields,
              },
              operation: 'inpatient.risk-assessment.record',
            }).then(() => queryClient.invalidateQueries({ queryKey: [...scope, admissionId, 'clinical-scores'] })).catch(() => undefined)
          }}
          riskRecord={riskAssessment}
          savingRisk={write.mutation.isPending && write.mutation.variables?.operation === 'inpatient.risk-assessment.record'}
        />
      </details>
    </div>
  )
}
