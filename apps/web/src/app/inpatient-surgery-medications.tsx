import { useEffect, useState } from 'react'
import { z } from 'zod'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import {
  medicationRouteSchema,
  type MedicationRoute,
} from '@clinmesh/contracts/medication-safety'
import type {
  InpatientBaseStockMedication,
  InpatientSurgicalMedicationPackage,
  inpatientProcedureItemSchema,
  inpatientSurgeryCatalogSchema,
  inpatientSurgeryExecutionSchema,
  inpatientSurgeryRequestSchema,
} from '@clinmesh/contracts/inpatient-surgery'
import { resolveInpatientDose } from '@clinmesh/core/inpatient-dose'
import {
  linkedNursingForProcedureId,
  packagesForProcedureCode,
  validateSurgicalMedicationSelection,
} from '@clinmesh/core/inpatient-surgery-medications'
import { formatMedicationRoute } from '@clinmesh/core/medication-safety'
import { inpatientSurgeryResponseSchema } from '@clinmesh/contracts/inpatient-surgery'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@clinmesh/ui/components/table'
import { BookOpenIcon } from 'lucide-react'
import { ClinicalQualityBanner, extractClinicalQualityError } from './clinical-quality-banner.tsx'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import {
  MedicationPackageInsertSheet,
  type MedicationPackageInsertTarget,
} from './medication-package-insert-sheet.tsx'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { formatFen, formatShanghaiMinute } from './workspace-format.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { WorkspaceSelect } from './workspace-select.tsx'

export const executeMedicationRowSchema = z
  .object({
    medicationId: z.string(),
    catalogVersion: z.number().int().positive(),
    display: z.string(),
    doseText: z.string(),
    routeCode: medicationRouteSchema,
  })
  .strict()

export type ExecuteMedicationRow = z.infer<typeof executeMedicationRowSchema>

type CatalogInput = z.input<typeof inpatientSurgeryCatalogSchema> | undefined
type ProcedureItem = z.infer<typeof inpatientProcedureItemSchema>
type Execution = z.infer<typeof inpatientSurgeryExecutionSchema>
type Request = z.infer<typeof inpatientSurgeryRequestSchema>

export function evaluateExecuteMedicationRow(
  row: ExecuteMedicationRow,
  baseStockMedications: readonly InpatientBaseStockMedication[],
  locale: WorkspaceLocale,
): {
  medication: InpatientBaseStockMedication | undefined
  quantity: number | null
  problem: string | null
} {
  const t = (cn: string, en: string) => (locale === 'zh-CN' ? cn : en)
  const medication = baseStockMedications.find(item => item.id === row.medicationId)
  if (!medication) {
    return {
      medication: undefined,
      quantity: null,
      problem: t(
        '台内药品目录已失效，请移除或重新选择',
        'Intraoperative medication is unavailable; remove it or select again',
      ),
    }
  }
  if (medication.version !== row.catalogVersion) {
    return {
      medication,
      quantity: null,
      problem: t(
        '台内药品目录依据已变化，请重新核对',
        'Medication catalog changed; review it again',
      ),
    }
  }
  const trimmedDose = row.doseText.trim()
  const resolved = resolveInpatientDose(
    {
      unit: medication.unit,
      doses: medication.doses,
      ...(medication.doseBasis === undefined ? {} : { doseBasis: medication.doseBasis }),
      maxDoseQuantity: medication.maxDoseQuantity,
    },
    trimmedDose,
  )
  if (!('quantity' in resolved)) {
    const problem =
      resolved.reason === 'fractional-quantity'
        ? t(
            `单次剂量须折算为整数计价单位（${medication.unit}）`,
            `Dose must convert to an integer billing unit (${medication.unit})`,
          )
        : resolved.reason === 'dose-limit'
          ? t(
              `超出单次最大允许用量（最多 ${medication.maxDoseQuantity} ${medication.unit}）`,
              `Exceeds single-dose limit (max ${medication.maxDoseQuantity} ${medication.unit})`,
            )
          : resolved.reason === 'missing-conversion' || resolved.reason === 'unit-mismatch'
            ? t(
                '剂量单位与制剂规格不匹配，无法折算计价单位',
                'Dose unit does not match preparation specification',
              )
            : t(
                '请输入有效单次剂量与单位（如 5 mL 或 100 mg）',
                'Enter a valid single dose with unit (e.g. 5 mL or 100 mg)',
              )
    return { medication, quantity: null, problem }
  }
  const checked = validateSurgicalMedicationSelection(medication, {
    medicationId: row.medicationId,
    catalogVersion: row.catalogVersion,
    doseText: trimmedDose,
    quantity: resolved.quantity,
    routeCode: row.routeCode,
  })
  if (!checked.ok) {
    return {
      medication,
      quantity: null,
      problem:
        checked.reason === 'MEDICATION_ROUTE_NOT_ALLOWED'
          ? t('所选给药途径不在允许范围内', 'Selected route is not allowed')
          : t(
              '单次给药剂量超出安全上限，请调整剂量',
              'Single dose exceeds safety limit; adjust the dose',
            ),
    }
  }
  return { medication, quantity: checked.quantity, problem: null }
}

function formatUnavailablePackageItems(
  pkg: InpatientSurgicalMedicationPackage,
  locale: WorkspaceLocale,
): string | null {
  const unavailable = pkg.items.filter(item => !item.available)
  if (unavailable.length === 0) return null
  const zh = locale === 'zh-CN'
  return unavailable
    .map(item =>
      item.unavailableReason === 'inactive'
        ? `${zh ? '已停用：' : 'Inactive: '}${item.display}`
        : `${zh ? '未安装：' : 'Not installed: '}${item.display}`,
    )
    .join(zh ? '；' : '; ')
}

export function SurgeryExecutionExtrasSummary({
  execution,
  locale,
}: {
  execution: Execution | undefined
  locale: WorkspaceLocale
}): React.JSX.Element | null {
  const t = (cn: string, en: string) => (locale === 'zh-CN' ? cn : en)
  const medications = execution?.medications ?? []
  const linkedNursing = execution?.linkedNursing
  if (medications.length === 0 && !linkedNursing) return null
  return (
    <p className="text-xs text-muted-foreground">
      {[
        ...medications.map(
          med =>
            `${t('台内药', 'Intraoperative med')}：${med.display} ${med.doseText}（${formatMedicationRoute(med.routeCode, locale)} · ${formatFen(med.amountFen, locale)}）`,
        ),
        ...(linkedNursing
          ? [
              `${t('术中专科护理', 'Specialty nursing')}：${linkedNursing.display}（${formatFen(linkedNursing.amountFen, locale)}）`,
            ]
          : []),
      ].join(' · ')}
    </p>
  )
}
function insertTargetForMedication(
  med: InpatientBaseStockMedication,
): MedicationPackageInsertTarget {
  return {
    title: med.display,
    subtitle: [med.strength, med.packageDescription].filter(Boolean).join(' · '),
    packageInsert: med.packageInsert,
  }
}

export function SurgeryBatchMedicationsEditor({
  requestId,
  procedure,
  catalog,
  rows,
  disabled,
  locale,
  onChange,
}: {
  requestId: string
  procedure: ProcedureItem | undefined
  catalog: CatalogInput
  rows: readonly ExecuteMedicationRow[]
  disabled: boolean
  locale: WorkspaceLocale
  onChange: (next: ExecuteMedicationRow[]) => void
}): React.JSX.Element {
  const t = (cn: string, en: string) => (locale === 'zh-CN' ? cn : en)
  const baseStockMedications = catalog?.baseStockMedications ?? []
  const matchingPackages = packagesForProcedureCode(
    catalog?.medicationPackages ?? [],
    procedure?.coding.code,
  )
  const linkedNursing = linkedNursingForProcedureId(
    catalog?.nursingBindings ?? [],
    procedure?.id,
  )
  const [selectedMedicationId, setSelectedMedicationId] = useState<string | null>(null)
  const [insertTarget, setInsertTarget] = useState<MedicationPackageInsertTarget | null>(null)

  const selectedMed = baseStockMedications.find(item => item.id === selectedMedicationId)
  const alreadyAdded = selectedMed !== undefined && rows.some(row => row.medicationId === selectedMed.id)

  const applyPackage = (pkg: InpatientSurgicalMedicationPackage) => {
    const next = [...rows]
    for (const item of pkg.items) {
      if (!item.available || item.catalogVersion === null) continue
      const entry: ExecuteMedicationRow = {
        medicationId: item.medicationId,
        catalogVersion: item.catalogVersion,
        display: item.display,
        doseText: item.doseText,
        routeCode: item.routeCode,
      }
      const existingIndex = next.findIndex(row => row.medicationId === item.medicationId)
      if (existingIndex >= 0) next[existingIndex] = entry
      else if (next.length < 20) next.push(entry)
    }
    onChange(next)
  }

  const addMedication = () => {
    if (!selectedMed || alreadyAdded || rows.length >= 20) return
    onChange([
      ...rows,
      {
        medicationId: selectedMed.id,
        catalogVersion: selectedMed.version,
        display: selectedMed.display,
        doseText: selectedMed.doses[0]?.doseText ?? `1 ${selectedMed.unit}`,
        routeCode: selectedMed.defaultRouteCode,
      },
    ])
    setSelectedMedicationId(null)
  }

  const updateRow = (medicationId: string, patch: Partial<ExecuteMedicationRow>) => {
    onChange(
      rows.map(row => (row.medicationId === medicationId ? { ...row, ...patch } : row)),
    )
  }

  return (
    <section
      aria-label={t('台内基数用药与专科护理', 'Intraoperative medications and specialty nursing')}
      className="flex flex-col gap-3 rounded-md border p-3"
    >
      {linkedNursing ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <span>
            {t('术中专科护理自动联动：', 'Auto-linked specialty nursing: ')}
            <b className="font-medium text-foreground">{linkedNursing.display}</b>
          </span>
          <span className="tabular-nums">
            {formatFen(linkedNursing.priceFen, locale)}/{linkedNursing.unit} ·{' '}
            {t('完成本台手术时自动计入费用', 'posted automatically upon completion')}
          </span>
        </div>
      ) : null}

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold">
          {t(`台内基数用药（${rows.length}/20）`, `Intraoperative medications (${rows.length}/20)`)}
        </h4>
        <span className="text-xs text-muted-foreground">
          {t(
            '随手术记录台内给药与药品费用，不生成病区医嘱，不扣减中心药房库存',
            'Posts intraoperative administration and charges without ward orders or pharmacy stock deduction',
          )}
        </span>
      </div>

      {matchingPackages.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {matchingPackages.map((pkg) => {
            const hasAvailable = pkg.items.some(item => item.available && item.catalogVersion !== null)
            const unavailableSummary = formatUnavailablePackageItems(pkg, locale)
            const label = locale === 'zh-CN' ? pkg.display : pkg.displayEn
            return (
              <div key={pkg.id} className="flex flex-wrap items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled || !hasAvailable}
                  onClick={() => applyPackage(pkg)}
                >
                  {t('套用套餐：', 'Apply package: ')}
                  {label}
                </Button>
                {unavailableSummary ? (
                  <span className="text-xs text-muted-foreground">{unavailableSummary}</span>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-2">
        <Field className="min-w-0 flex-1">
          <FieldLabel htmlFor={`execute-med-select-${requestId}`}>
            {t('选择台内基数药', 'Select intraoperative medication')}
          </FieldLabel>
          <WorkspaceSelect
            id={`execute-med-select-${requestId}`}
            value={selectedMedicationId}
            disabled={disabled || baseStockMedications.length === 0}
            items={baseStockMedications.map(med => ({
              value: med.id,
              disabled: rows.some(row => row.medicationId === med.id),
              label: `${med.display} · ${med.strength} · ${formatFen(med.priceFen, locale)}/${med.unit}`,
            }))}
            onValueChange={setSelectedMedicationId}
          />
        </Field>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || !selectedMed || alreadyAdded || rows.length >= 20}
          onClick={addMedication}
        >
          {t('添加台内药', 'Add medication')}
        </Button>
      </div>

      {rows.length > 0 ? (
        <FieldGroup className="flex flex-col gap-2">
          {rows.map((row) => {
            const evaluated = evaluateExecuteMedicationRow(row, baseStockMedications, locale)
            const med = evaluated.medication
            return (
              <div
                key={row.medicationId}
                className="flex flex-col gap-2 rounded-md border p-2.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium">{row.display}</span>
                    {med ? (
                      <span className="text-xs text-muted-foreground">
                        {med.strength} · {formatFen(med.priceFen, locale)}/{med.unit}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {med ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        aria-label={t(
                          `查看${row.display}说明书`,
                          `View ${row.display} package insert`,
                        )}
                        onClick={() => setInsertTarget(insertTargetForMedication(med))}
                      >
                        <BookOpenIcon data-icon="inline-start" />
                        {t('说明书', 'Insert')}
                      </Button>
                    ) : null}
                    {med && med.version !== row.catalogVersion ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        disabled={disabled}
                        onClick={() =>
                          updateRow(row.medicationId, {
                            catalogVersion: med.version,
                            display: med.display,
                          })
                        }
                      >
                        {t('重新核对药品目录', 'Review medication catalog')}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={disabled}
                      aria-label={t(
                        `移除台内药 ${row.display}`,
                        `Remove medication ${row.display}`,
                      )}
                      onClick={() =>
                        onChange(rows.filter(item => item.medicationId !== row.medicationId))
                      }
                    >
                      {t('移除', 'Remove')}
                    </Button>
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field data-invalid={evaluated.problem !== null || undefined}>
                    <FieldLabel htmlFor={`execute-med-dose-${requestId}-${row.medicationId}`}>
                      {row.display}
                      {t('剂量', ' dose')}
                    </FieldLabel>
                    <Input
                      id={`execute-med-dose-${requestId}-${row.medicationId}`}
                      aria-invalid={evaluated.problem !== null || undefined}
                      disabled={disabled}
                      value={row.doseText}
                      onChange={event =>
                        updateRow(row.medicationId, { doseText: event.currentTarget.value })
                      }
                    />
                    {med && med.doses.length > 1 ? (
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        {med.doses.map(preset => (
                          <Button
                            key={preset.doseText}
                            type="button"
                            variant="outline"
                            size="xs"
                            disabled={disabled}
                            onClick={() =>
                              updateRow(row.medicationId, { doseText: preset.doseText })
                            }
                          >
                            {preset.doseText}
                          </Button>
                        ))}
                      </div>
                    ) : null}
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`execute-med-route-${requestId}-${row.medicationId}`}>
                      {row.display}
                      {t('给药途径', ' route')}
                    </FieldLabel>
                    <WorkspaceSelect
                      id={`execute-med-route-${requestId}-${row.medicationId}`}
                      value={row.routeCode}
                      disabled={disabled}
                      items={(med?.allowedRouteCodes ?? [row.routeCode]).map(code => ({
                        value: code,
                        label: formatMedicationRoute(code, locale),
                      }))}
                      onValueChange={(nextRoute) => {
                        if (nextRoute) {
                          updateRow(row.medicationId, { routeCode: nextRoute })
                        }
                      }}
                    />
                  </Field>
                </div>
                {evaluated.problem ? (
                  <FieldDescription role="alert" className="text-destructive">
                    {evaluated.problem}
                  </FieldDescription>
                ) : med && evaluated.quantity !== null ? (
                  <FieldDescription className="tabular-nums">
                    {t('折算计价 ', 'Billed as ')}
                    {evaluated.quantity} {med.unit} ·{' '}
                    {formatFen(med.priceFen * evaluated.quantity, locale)}
                  </FieldDescription>
                ) : null}
              </div>
            )
          })}
        </FieldGroup>
      ) : null}

      <MedicationPackageInsertSheet
        locale={locale}
        target={insertTarget}
        onClose={() => setInsertTarget(null)}
      />
    </section>
  )
}

export function IntraoperativeMedicationsSection({
  admission,
  locale,
  write,
  execution,
  request,
  catalog,
  dataReady,
  running,
  writable,
}: {
  admission: InpatientAdmission
  locale: WorkspaceLocale
  write: ReturnType<typeof useInpatientWriteIntent>
  execution: Execution
  request: Request
  catalog: CatalogInput
  dataReady: boolean
  running: boolean
  writable: boolean
}): React.JSX.Element | null {
  const t = (cn: string, en: string) => (locale === 'zh-CN' ? cn : en)
  const baseStockMedications = catalog?.baseStockMedications ?? []
  const matchingPackages = packagesForProcedureCode(
    catalog?.medicationPackages ?? [],
    execution.actualProcedure.coding.code,
  )
  const presetItems = matchingPackages.flatMap(pkg =>
    pkg.items.filter(item => item.available && item.catalogVersion !== null),
  )
  const uniquePresets = presetItems.filter(
    (item, idx, arr) =>
      arr.findIndex(
        candidate =>
          candidate.medicationId === item.medicationId && candidate.doseText === item.doseText,
      ) === idx,
  )

  const [medicationId, setMedicationId] = useState<string | null>(null)
  const [doseText, setDoseText] = useState('')
  const [routeCode, setRouteCode] = useState<MedicationRoute>('IV')
  const [note, setNote] = useState('')
  const [insertTarget, setInsertTarget] = useState<MedicationPackageInsertTarget | null>(null)

  const successfulCommand = write.mutation.data?.command
  useEffect(() => {
    if (successfulCommand?.operation !== 'inpatient.surgery.record-medication') return
    if (
      successfulCommand.input.admissionId !== admission.id ||
      successfulCommand.input.requestId !== request.id ||
      successfulCommand.input.executionId !== execution.id
    ) {
      return
    }
    setMedicationId(null)
    setDoseText('')
    setNote('')
  }, [successfulCommand, admission.id, request.id, execution.id])

  const selectedMed = baseStockMedications.find(item => item.id === medicationId)
  const evaluated =
    selectedMed !== undefined
      ? evaluateExecuteMedicationRow(
          {
            medicationId: selectedMed.id,
            catalogVersion: selectedMed.version,
            display: selectedMed.display,
            doseText,
            routeCode,
          },
          baseStockMedications,
          locale,
        )
      : null

  const medications = execution.medications ?? []
  const linkedNursing = execution.linkedNursing

  if (!running && medications.length === 0 && !linkedNursing) {
    return null
  }
  if (running && medications.length === 0 && baseStockMedications.length === 0 && matchingPackages.length === 0) {
    return null
  }

  const ownError =
    write.mutation.error &&
    write.mutation.variables?.operation === 'inpatient.surgery.record-medication' &&
    write.mutation.variables.input.admissionId === admission.id &&
    write.mutation.variables.input.executionId === execution.id
      ? write.mutation.error
      : null

  const blocked = !writable || write.blocked || !dataReady || admission.status !== 'admitted'
  const canSubmit = Boolean(
    !blocked && selectedMed && evaluated && evaluated.problem === null && evaluated.quantity !== null,
  )

  const applyIntraoperativePackage = async (pkg: InpatientSurgicalMedicationPackage) => {
    if (blocked) return
    const availableItems = pkg.items.filter(item => item.available && item.catalogVersion !== null)
    if (availableItems.length === 0) return
    let currentVersion = request.version
    for (const item of availableItems) {
      try {
        const result = await write.mutation.mutateAsync({
          operation: 'inpatient.surgery.record-medication',
          input: {
            admissionId: admission.id,
            requestId: request.id,
            expectedRequestVersion: currentVersion,
            executionId: execution.id,
            medication: {
              medicationId: item.medicationId,
              catalogVersion: item.catalogVersion!,
              doseText: item.doseText,
              quantity: item.quantity,
              routeCode: item.routeCode,
            },
          },
        })
        const parsed = inpatientSurgeryResponseSchema.safeParse(result.response)
        const nextVersion = parsed.success
          ? parsed.data.data.requests.find(candidate => candidate.id === request.id)?.version
          : undefined
        currentVersion = nextVersion ?? currentVersion + 1
      } catch {
        break
      }
    }
  }

  const submit = () => {
    if (!canSubmit || !selectedMed || !evaluated || evaluated.quantity === null) return
    const trimmedNote = note.trim()
    write.mutation.mutate({
      operation: 'inpatient.surgery.record-medication',
      input: {
        admissionId: admission.id,
        requestId: request.id,
        expectedRequestVersion: request.version,
        executionId: execution.id,
        medication: {
          medicationId: selectedMed.id,
          catalogVersion: selectedMed.version,
          doseText: doseText.trim(),
          quantity: evaluated.quantity,
          routeCode,
        },
        ...(trimmedNote ? { note: trimmedNote } : {}),
      },
    })
  }

  return (
    <section
      aria-label={
        running
          ? t('台内基数用药', 'Intraoperative medications')
          : t('台内用药与术中专科护理', 'Intraoperative medications and specialty nursing')
      }
      className="flex min-w-0 flex-col gap-2.5 border-t pt-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">
          {running
            ? t('台内基数用药', 'Intraoperative medications')
            : t('台内用药与术中专科护理', 'Intraoperative medications and specialty nursing')}
        </h4>
        {medications.length > 0 ? (
          <span className="text-xs tabular-nums text-muted-foreground">
            {t('台内药小计 ', 'Medication subtotal ')}
            <b className="font-semibold text-foreground">
              {formatFen(
                medications.reduce((sum, item) => sum + item.amountFen, 0),
                locale,
              )}
            </b>
          </span>
        ) : null}
      </div>

      {running && writable ? (
        <div className="flex flex-col gap-2.5 rounded-md border p-3">
          {ownError ? (
            extractClinicalQualityError(ownError) ? (
              <ClinicalQualityBanner error={ownError} locale={locale} />
            ) : (
              <Alert variant="destructive">
                <AlertDescription>
                  {getWorkspaceErrorMessage(ownError, getWorkspaceMessages(locale))}
                </AlertDescription>
              </Alert>
            )
          ) : null}
          {matchingPackages.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              {matchingPackages.map((pkg) => {
                const hasAvailable = pkg.items.some(item => item.available && item.catalogVersion !== null)
                const unavailableSummary = formatUnavailablePackageItems(pkg, locale)
                const label = locale === 'zh-CN' ? pkg.display : pkg.displayEn
                return (
                  <div key={pkg.id} className="flex flex-wrap items-center gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={blocked || !hasAvailable}
                      onClick={() => {
                        void applyIntraoperativePackage(pkg)
                      }}
                    >
                      {t('套用套餐：', 'Apply package: ')}
                      {label}
                    </Button>
                    {unavailableSummary ? (
                      <span className="text-xs text-muted-foreground">{unavailableSummary}</span>
                    ) : null}
                  </div>
                )
              })}
            </div>
          ) : null}
          {uniquePresets.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {uniquePresets.map(preset => (
                <Button
                  key={`${preset.medicationId}:${preset.doseText}`}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={blocked}
                  onClick={() => {
                    setMedicationId(preset.medicationId)
                    setDoseText(preset.doseText)
                    setRouteCode(preset.routeCode)
                  }}
                >
                  {t(`带入：${preset.display} ${preset.doseText}`, `Preset: ${preset.display} ${preset.doseText}`)}
                </Button>
              ))}
            </div>
          ) : null}
          <FieldGroup className="grid gap-3 @lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto] @lg:items-end">
            <Field>
              <div className="flex items-center justify-between gap-1">
                <FieldLabel htmlFor={`intraop-med-select-${execution.id}`}>
                  {t('选择台内基数药', 'Select intraoperative medication')}
                </FieldLabel>
                {selectedMed ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    aria-label={t(
                      `查看${selectedMed.display}说明书`,
                      `View ${selectedMed.display} package insert`,
                    )}
                    onClick={() => setInsertTarget(insertTargetForMedication(selectedMed))}
                  >
                    <BookOpenIcon data-icon="inline-start" />
                    {t('说明书', 'Insert')}
                  </Button>
                ) : null}
              </div>
              <WorkspaceSelect
                id={`intraop-med-select-${execution.id}`}
                value={medicationId}
                disabled={blocked || baseStockMedications.length === 0}
                items={baseStockMedications.map(med => ({
                  value: med.id,
                  label: `${med.display} · ${med.strength} · ${formatFen(med.priceFen, locale)}/${med.unit}`,
                }))}
                onValueChange={(nextId) => {
                  setMedicationId(nextId)
                  const nextMed = baseStockMedications.find(item => item.id === nextId)
                  if (nextMed) {
                    setDoseText(nextMed.doses[0]?.doseText ?? `1 ${nextMed.unit}`)
                    setRouteCode(nextMed.defaultRouteCode)
                  }
                }}
              />
            </Field>
            <Field data-invalid={(selectedMed && evaluated?.problem !== null) || undefined}>
              <FieldLabel htmlFor={`intraop-med-dose-${execution.id}`}>
                {t('单次剂量', 'Single dose')}
              </FieldLabel>
              <Input
                id={`intraop-med-dose-${execution.id}`}
                disabled={blocked || !selectedMed}
                placeholder={selectedMed?.doses[0]?.doseText ?? '5 mL'}
                value={doseText}
                onChange={event => setDoseText(event.currentTarget.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`intraop-med-route-${execution.id}`}>
                {t('给药途径', 'Route')}
              </FieldLabel>
              <WorkspaceSelect
                id={`intraop-med-route-${execution.id}`}
                value={routeCode}
                disabled={blocked || !selectedMed}
                items={(selectedMed?.allowedRouteCodes ?? [routeCode]).map(code => ({
                  value: code,
                  label: formatMedicationRoute(code, locale),
                }))}
                onValueChange={(nextRoute) => {
                  if (nextRoute) setRouteCode(nextRoute)
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`intraop-med-note-${execution.id}`}>
                {t('用药说明（选填）', 'Medication note (optional)')}
              </FieldLabel>
              <Input
                id={`intraop-med-note-${execution.id}`}
                maxLength={2000}
                disabled={blocked || !selectedMed}
                value={note}
                onChange={event => setNote(event.currentTarget.value)}
              />
            </Field>
            <Button type="button" size="sm" disabled={!canSubmit} onClick={submit}>
              {t('登记台内药', 'Record medication')}
            </Button>
          </FieldGroup>
          {selectedMed && evaluated?.problem ? (
            <FieldDescription role="alert" className="text-destructive">
              {evaluated.problem}
            </FieldDescription>
          ) : selectedMed && evaluated?.quantity !== null && evaluated?.quantity !== undefined ? (
            <FieldDescription className="tabular-nums">
              {t('本笔计价 ', 'Entry charge ')}
              {evaluated.quantity} {selectedMed.unit} × {formatFen(selectedMed.priceFen, locale)}/
              {selectedMed.unit} ={' '}
              <b>{formatFen(selectedMed.priceFen * evaluated.quantity, locale)}</b>
            </FieldDescription>
          ) : null}
        </div>
      ) : null}

      {medications.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('台内药品', 'Intraoperative medication')}</TableHead>
              <TableHead>{t('剂量与途径', 'Dose & route')}</TableHead>
              <TableHead>{t('计价数量', 'Billed quantity')}</TableHead>
              <TableHead className="text-right">{t('费用', 'Charge')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {medications.map((med) => {
              const catalogMed = baseStockMedications.find(item => item.id === med.medicationId)
              return (
                <TableRow key={med.id}>
                  <TableCell className="whitespace-normal">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span>{med.display}</span>
                      {catalogMed?.packageInsert ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          aria-label={t(
                            `查看${med.display}说明书`,
                            `View ${med.display} package insert`,
                          )}
                          onClick={() => setInsertTarget(insertTargetForMedication(catalogMed))}
                        >
                          <BookOpenIcon data-icon="inline-start" />
                          {t('说明书', 'Insert')}
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {med.doseText} · {formatMedicationRoute(med.routeCode, locale)}
                    <span className="ml-1 text-xs tabular-nums text-muted-foreground">
                      · {formatShanghaiMinute(med.recordedAt).slice(11)}
                    </span>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {med.quantity} {med.unit}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatFen(med.amountFen, locale)}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      ) : null}

      {!running && linkedNursing ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
          <span>
            {t('术中专科护理', 'Intraoperative specialty nursing')} ·{' '}
            <b className="font-medium">{linkedNursing.display}</b>（1 {linkedNursing.unit}）
          </span>
          <b className="tabular-nums">{formatFen(linkedNursing.amountFen, locale)}</b>
        </div>
      ) : null}

      <MedicationPackageInsertSheet
        locale={locale}
        target={insertTarget}
        onClose={() => setInsertTarget(null)}
      />
    </section>
  )
}
