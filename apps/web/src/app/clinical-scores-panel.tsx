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
import { useEffect, useState } from 'react'
import { apiGet, getOutpatientClinicalScores, newIdempotencyKey, recordOutpatientRiskAssessment } from './api-client.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { formatShanghaiMinute } from './workspace-format.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'

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

function toRiskForm(record: ClinicalRiskAssessmentRecord | undefined): RiskFormState {
  const v = record?.values
  return {
    anginaEpisodes24h: v?.anginaEpisodes24h == null ? '' : String(v.anginaEpisodes24h),
    aspirinUsedLast7Days: v?.aspirinUsedLast7Days == null ? '' : String(v.aspirinUsedLast7Days) as 'true' | 'false',
    cardiacArrestOnAdmission: v?.cardiacArrestOnAdmission == null ? '' : String(v.cardiacArrestOnAdmission) as 'true' | 'false',
    familyHistoryPrematureCad: v?.familyHistoryPrematureCad == null ? '' : String(v.familyHistoryPrematureCad) as 'true' | 'false',
    killipClass: v?.killipClass ?? '',
    knownCoronaryStenosisGe50: v?.knownCoronaryStenosisGe50 == null ? '' : String(v.knownCoronaryStenosisGe50) as 'true' | 'false',
    priorBleedingHistory: v?.priorBleedingHistory ?? '',
    smokingStatus: v?.smokingStatus ?? '',
    stSegmentDeviation: v?.stSegmentDeviation == null ? '' : String(v.stSegmentDeviation) as 'true' | 'false',
  }
}

function parseRiskFields(form: RiskFormState): ClinicalRiskAssessmentFieldsInput {
  const anginaTrim = form.anginaEpisodes24h.trim()
  return {
    anginaEpisodes24h: anginaTrim === '' ? null : Number(anginaTrim),
    aspirinUsedLast7Days: form.aspirinUsedLast7Days === '' ? null : form.aspirinUsedLast7Days === 'true',
    cardiacArrestOnAdmission: form.cardiacArrestOnAdmission === '' ? null : form.cardiacArrestOnAdmission === 'true',
    familyHistoryPrematureCad: form.familyHistoryPrematureCad === '' ? null : form.familyHistoryPrematureCad === 'true',
    killipClass: form.killipClass === '' ? null : form.killipClass,
    knownCoronaryStenosisGe50: form.knownCoronaryStenosisGe50 === '' ? null : form.knownCoronaryStenosisGe50 === 'true',
    priorBleedingHistory: form.priorBleedingHistory === '' ? null : form.priorBleedingHistory,
    smokingStatus: form.smokingStatus === '' ? null : form.smokingStatus,
    stSegmentDeviation: form.stSegmentDeviation === '' ? null : form.stSegmentDeviation === 'true',
  }
}

const selectCls = 'h-8 rounded-md border border-input bg-background px-2 text-xs'

function ClinicalScoresBody({
  bundle,
  canEditRisk,
  error,
  identityKey,
  loading,
  locale,
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
  onRetry: () => void
  onSaveRisk: (expectedRevision: number, fields: ClinicalRiskAssessmentFieldsInput) => void
  riskRecord: ClinicalRiskAssessmentRecord | undefined
  savingRisk: boolean
}) {
  const zh = locale === 'zh-CN'
  const t = (cn: string, en: string) => (zh ? cn : en)
  const messages = getWorkspaceMessages(locale)
  const effectiveRecord = bundle?.riskAssessment ?? riskRecord
  const canEditEffective = canEditRisk && effectiveRecord !== undefined
  const recordSyncKey = effectiveRecord === undefined
    ? 'loading'
    : `${effectiveRecord.observationId ?? 'none'}:${effectiveRecord.revision}`
  const [draft, setDraft] = useState<{
    dirty: boolean
    form: RiskFormState
    identityKey: string
    recordSyncKey: string
  }>(() => ({
    dirty: false,
    form: toRiskForm(effectiveRecord),
    identityKey,
    recordSyncKey,
  }))
  useEffect(() => {
    setDraft(prev => {
      if (prev.identityKey !== identityKey) {
        return { dirty: false, form: toRiskForm(effectiveRecord), identityKey, recordSyncKey }
      }
      if (prev.recordSyncKey !== recordSyncKey && (!prev.dirty || prev.recordSyncKey === 'loading' || recordSyncKey !== 'loading')) {
        return { dirty: false, form: toRiskForm(effectiveRecord), identityKey, recordSyncKey }
      }
      return prev
    })
  }, [identityKey, recordSyncKey, effectiveRecord])
  const form = draft.form
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
          onSaveRisk(effectiveRecord.revision, parseRiskFields(form))
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
        {effectiveRecord?.effectiveStSegmentDeviation?.source === 'ecg-report' ? (
          <p className="text-muted-foreground">
            {t('ST 段状态当前优先采用已签发 12 导联心电图报告：', 'ST-segment status resolved from issued 12-lead ECG report: ')}
            <strong>{effectiveRecord.effectiveStSegmentDeviation.value ? t('有偏移', 'Deviation present') : t('无偏移', 'No deviation')}</strong>
            {` (${effectiveRecord.effectiveStSegmentDeviation.sourceReference}#${effectiveRecord.effectiveStSegmentDeviation.versionId})`}
          </p>
        ) : null}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <label className="flex flex-col gap-1">
            <span>{t('Killip 分级', 'Killip class')}</span>
            <select className={selectCls} disabled={!canEditEffective || savingRisk} onChange={e => { const v = e.currentTarget.value as '' | KillipClass; updateForm(s => ({ ...s, killipClass: v })) }} value={form.killipClass}>
              <option value="">{t('未记录', 'Not recorded')}</option>
              {(['I', 'II', 'III', 'IV'] as const).map(item => <option key={item} value={item}>{`Killip ${item}`}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('入院心脏骤停', 'Cardiac arrest')}</span>
            <select className={selectCls} disabled={!canEditEffective || savingRisk} onChange={e => { const v = e.currentTarget.value as '' | 'true' | 'false'; updateForm(s => ({ ...s, cardiacArrestOnAdmission: v })) }} value={form.cardiacArrestOnAdmission}>
              <option value="">{t('未记录', 'Not recorded')}</option>
              <option value="false">{t('无', 'No')}</option>
              <option value="true">{t('有', 'Yes')}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('24h 心绞痛次数', '24h angina count')}</span>
            <Input className="h-8 text-xs" disabled={!canEditEffective || savingRisk} max={100} min={0} onChange={e => { const v = e.currentTarget.value; updateForm(s => ({ ...s, anginaEpisodes24h: v })) }} placeholder={t('未记录', 'Not recorded')} step={1} type="number" value={form.anginaEpisodes24h} />
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('床旁 ST 段偏移', 'Bedside ST deviation')}</span>
            <select className={selectCls} disabled={!canEditEffective || savingRisk} onChange={e => { const v = e.currentTarget.value as '' | 'true' | 'false'; updateForm(s => ({ ...s, stSegmentDeviation: v })) }} value={form.stSegmentDeviation}>
              <option value="">{t('未记录', 'Not recorded')}</option>
              <option value="false">{t('无偏移', 'Absent')}</option>
              <option value="true">{t('有偏移', 'Present')}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('近 7 天阿司匹林', 'Aspirin in 7d')}</span>
            <select className={selectCls} disabled={!canEditEffective || savingRisk} onChange={e => { const v = e.currentTarget.value as '' | 'true' | 'false'; updateForm(s => ({ ...s, aspirinUsedLast7Days: v })) }} value={form.aspirinUsedLast7Days}>
              <option value="">{t('未记录', 'Not recorded')}</option>
              <option value="false">{t('未使用', 'No')}</option>
              <option value="true">{t('已使用', 'Yes')}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('吸烟状态', 'Smoking status')}</span>
            <select className={selectCls} disabled={!canEditEffective || savingRisk} onChange={e => { const v = e.currentTarget.value as '' | SmokingStatus; updateForm(s => ({ ...s, smokingStatus: v })) }} value={form.smokingStatus}>
              <option value="">{t('未记录', 'Not recorded')}</option>
              <option value="never">{t('从不吸烟', 'Never')}</option>
              <option value="former">{t('既往戒烟', 'Former')}</option>
              <option value="current">{t('当前吸烟', 'Current')}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('早发冠心病家族史', 'Premature CAD family history')}</span>
            <select className={selectCls} disabled={!canEditEffective || savingRisk} onChange={e => { const v = e.currentTarget.value as '' | 'true' | 'false'; updateForm(s => ({ ...s, familyHistoryPrematureCad: v })) }} value={form.familyHistoryPrematureCad}>
              <option value="">{t('未记录', 'Not recorded')}</option>
              <option value="false">{t('阴性', 'Negative')}</option>
              <option value="true">{t('阳性', 'Positive')}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('已知冠脉狭窄 ≥50%', 'Known CAD stenosis ≥50%')}</span>
            <select className={selectCls} disabled={!canEditEffective || savingRisk} onChange={e => { const v = e.currentTarget.value as '' | 'true' | 'false'; updateForm(s => ({ ...s, knownCoronaryStenosisGe50: v })) }} value={form.knownCoronaryStenosisGe50}>
              <option value="">{t('未记录', 'Not recorded')}</option>
              <option value="false">{t('无 / <50%', 'No / <50%')}</option>
              <option value="true">{t('有 (≥50%)', 'Yes (≥50%)')}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('既往出血史', 'Prior bleeding')}</span>
            <select className={selectCls} disabled={!canEditEffective || savingRisk} onChange={e => { const v = e.currentTarget.value as '' | PriorBleedingHistory; updateForm(s => ({ ...s, priorBleedingHistory: v })) }} value={form.priorBleedingHistory}>
              <option value="">{t('未记录', 'Not recorded')}</option>
              <option value="negative">{t('阴性', 'Negative')}</option>
              <option value="positive">{t('阳性', 'Positive')}</option>
            </select>
          </label>
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
        onRetry={() => { void scores.refetch() }}
        onSaveRisk={(expectedRevision, fields) => saveRisk.mutate({ expectedRevision, fields })}
        riskRecord={scores.data?.riskAssessment}
        savingRisk={saveRisk.isPending}
      />
    </details>
  )
}

interface VitalsFormState {
  diastolicMmHg: string
  heightCm: string
  oxygenSaturationPct: string
  pulseBpm: string
  respirationBpm: string
  systolicMmHg: string
  temperatureC: string
  weightKg: string
}

function toVitalsForm(record: InpatientVitalSignsRecord | undefined): VitalsFormState {
  return {
    diastolicMmHg: record === undefined ? '' : String(record.bloodPressure.diastolicMmHg),
    heightCm: record?.heightCm === undefined ? '' : String(record.heightCm),
    oxygenSaturationPct: record === undefined ? '' : String(record.oxygenSaturationPct),
    pulseBpm: record === undefined ? '' : String(record.pulseBpm),
    respirationBpm: record === undefined ? '' : String(record.respirationBpm),
    systolicMmHg: record === undefined ? '' : String(record.bloodPressure.systolicMmHg),
    temperatureC: record === undefined ? '' : String(record.temperatureC),
    weightKg: record?.weightKg === undefined ? '' : String(record.weightKg),
  }
}

export function InpatientVitalsAndScoresDisclosure({
  admissionId,
  canEdit,
  clinicalRevision,
  encounterVersion,
  latestVitalSigns,
  locale,
  riskAssessment,
  scope,
  write,
}: {
  admissionId: string
  canEdit: boolean
  clinicalRevision?: string | undefined
  encounterVersion: string
  latestVitalSigns: InpatientVitalSignsRecord | undefined
  locale: WorkspaceLocale
  riskAssessment: ClinicalRiskAssessmentRecord | undefined
  scope: readonly (string | undefined)[]
  write: Write
}) {
  const zh = locale === 'zh-CN'
  const t = (cn: string, en: string) => (zh ? cn : en)
  const queryClient = useQueryClient()
  const [scoresOpen, setScoresOpen] = useState(false)
  const [vitals, setVitals] = useState<VitalsFormState>(() => toVitalsForm(latestVitalSigns))

  useEffect(() => {
    setVitals(toVitalsForm(latestVitalSigns))
  }, [admissionId, latestVitalSigns?.revision])

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
                expectedRevision: latestVitalSigns?.revision ?? 0,
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
          <label className="flex flex-col gap-1"><span>{t('体温 (°C)', 'Temp (°C)')}</span><Input className="h-8 text-xs" disabled={!canEdit} max={45} min={30} onChange={e => { const v = e.currentTarget.value; setVitals(s => ({ ...s, temperatureC: v })) }} step={0.1} type="number" value={vitals.temperatureC} /></label>
          <label className="flex flex-col gap-1"><span>{t('心率 (次/分)', 'Pulse (bpm)')}</span><Input className="h-8 text-xs" disabled={!canEdit} max={300} min={20} onChange={e => { const v = e.currentTarget.value; setVitals(s => ({ ...s, pulseBpm: v })) }} step={1} type="number" value={vitals.pulseBpm} /></label>
          <label className="flex flex-col gap-1"><span>{t('呼吸 (次/分)', 'Resp (/min)')}</span><Input className="h-8 text-xs" disabled={!canEdit} max={80} min={4} onChange={e => { const v = e.currentTarget.value; setVitals(s => ({ ...s, respirationBpm: v })) }} step={1} type="number" value={vitals.respirationBpm} /></label>
          <label className="flex flex-col gap-1"><span>{t('血氧 (%)', 'SpO₂ (%)')}</span><Input className="h-8 text-xs" disabled={!canEdit} max={100} min={40} onChange={e => { const v = e.currentTarget.value; setVitals(s => ({ ...s, oxygenSaturationPct: v })) }} step={0.1} type="number" value={vitals.oxygenSaturationPct} /></label>
          <label className="flex flex-col gap-1"><span>{t('收缩压 (mmHg)', 'Systolic (mmHg)')}</span><Input className="h-8 text-xs" disabled={!canEdit} max={300} min={40} onChange={e => { const v = e.currentTarget.value; setVitals(s => ({ ...s, systolicMmHg: v })) }} step={1} type="number" value={vitals.systolicMmHg} /></label>
          <label className="flex flex-col gap-1"><span>{t('舒张压 (mmHg)', 'Diastolic (mmHg)')}</span><Input className="h-8 text-xs" disabled={!canEdit} max={200} min={20} onChange={e => { const v = e.currentTarget.value; setVitals(s => ({ ...s, diastolicMmHg: v })) }} step={1} type="number" value={vitals.diastolicMmHg} /></label>
          <label className="flex flex-col gap-1"><span>{t('体重 (kg，选填)', 'Weight (kg)')}</span><Input className="h-8 text-xs" disabled={!canEdit} max={400} min={1} onChange={e => { const v = e.currentTarget.value; setVitals(s => ({ ...s, weightKg: v })) }} placeholder={t('未记录', 'Optional')} step={0.1} type="number" value={vitals.weightKg} /></label>
          <label className="flex flex-col gap-1"><span>{t('身高 (cm，选填)', 'Height (cm)')}</span><Input className="h-8 text-xs" disabled={!canEdit} max={260} min={30} onChange={e => { const v = e.currentTarget.value; setVitals(s => ({ ...s, heightCm: v })) }} placeholder={t('未记录', 'Optional')} step={0.1} type="number" value={vitals.heightCm} /></label>
          {canEdit ? (
            <div className="col-span-2 flex justify-end sm:col-span-4">
              <Button disabled={!vitalsValid || write.blocked} size="sm" type="submit" variant="outline">{t('记录生命体征', 'Record vital signs')}</Button>
            </div>
          ) : null}
        </form>
      </details>

      <details
        className="clinmesh-inpatient-disclosure"
        onToggle={event => setScoresOpen(event.currentTarget.open)}
      >
        <summary>
          {t('专病风险评估与临床评分', 'Clinical risk assessment & scores')}
          {completeCount === undefined ? null : <span className="ml-2 text-xs font-normal text-muted-foreground tabular-nums">{t(`已就绪 ${completeCount}/6`, `${completeCount}/6 complete`)}</span>}
        </summary>
        <ClinicalScoresBody
          bundle={scores.data}
          canEditRisk={canEdit}
          error={scores.error}
          identityKey={admissionId}
          loading={scores.isFetching}
          locale={locale}
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
