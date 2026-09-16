import { z } from 'zod'
import type { WorkspaceLocale } from './workspace-i18n.ts'

const objectSchema = z.record(z.string(), z.unknown())

function object(value: unknown): Record<string, unknown> {
  return objectSchema.safeParse(value).data ?? {}
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function joined(values: (string | undefined)[], separator = ' · '): string | undefined {
  const present = values.filter(value => value !== undefined)
  return present.length === 0 ? undefined : present.join(separator)
}

function concept(value: unknown): string | undefined {
  const item = object(value)
  return text(item.text) ?? text(item.display) ?? joined(list(item.coding).map(coding => {
    const entry = object(coding)
    return text(entry.display) ?? text(entry.code)
  })) ?? text(item.code)
}

const quantityUnits: Record<string, string> = { Cel: '°C', '[degF]': '°F', 'mm[Hg]': 'mmHg' }

function quantity(value: unknown): string | undefined {
  const item = object(value)
  const amount = text(item.value)
  const unit = text(item.unit) ?? text(item.code)
  return amount === undefined ? undefined : joined([text(item.comparator), amount, unit === undefined ? undefined : quantityUnits[unit] ?? unit], ' ')
}

function dateTime(value: unknown, locale: WorkspaceLocale): string | undefined {
  const raw = text(value)
  if (raw === undefined || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) return raw
  const date = new Date(raw)
  if (!Number.isFinite(date.getTime())) return raw
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(date)
}

function period(value: unknown, locale: WorkspaceLocale): string | undefined {
  const item = object(value)
  return joined([dateTime(item.start, locale), dateTime(item.end, locale)], ' — ')
}

function range(value: unknown): string | undefined {
  const item = object(value)
  const description = text(item.text)
  if (description !== undefined) return description
  const low = quantity(item.low)
  const high = quantity(item.high)
  if (low !== undefined && high !== undefined) return `${low} — ${high}`
  if (low !== undefined) return `≥ ${low}`
  if (high !== undefined) return `≤ ${high}`
  return undefined
}

function reference(value: unknown): string | undefined {
  const item = object(value)
  return text(item.display) ?? text(item.reference)
}

function result(value: unknown, locale: WorkspaceLocale): string | undefined {
  const item = object(value)
  if (typeof item.valueBoolean === 'boolean') return item.valueBoolean ? (locale === 'zh-CN' ? '是' : 'Yes') : (locale === 'zh-CN' ? '否' : 'No')
  return quantity(item.valueQuantity) ?? concept(item.valueCodeableConcept)
    ?? text(item.valueString) ?? text(item.valueInteger) ?? dateTime(item.valueDateTime, locale)
    ?? text(item.valueTime) ?? range(item.valueRange) ?? period(item.valuePeriod, locale)
    ?? joined([quantity(object(item.valueRatio).numerator), quantity(object(item.valueRatio).denominator)], ' / ')
}

const periodUnits: Record<string, string> = { s: '秒', min: '分钟', h: '小时', d: '天', wk: '周', mo: '月', a: '年' }

const resourceNames: Record<string, string> = {
  AllergyIntolerance: '过敏记录', CarePlan: '照护计划', Condition: '诊断', DiagnosticReport: '检查报告',
  Device: '医疗器械', SupplyDelivery: '耗材供应', CareTeam: '照护团队', ImagingStudy: '影像检查',
  Encounter: '就诊', Immunization: '疫苗接种', Medication: '药品', MedicationAdministration: '给药',
  MedicationRequest: '用药', Observation: '观察 / 检验', Procedure: '操作',
}
const statusNames: Record<string, string> = {
  active: '活动', inactive: '非活动', resolved: '已缓解', remission: '缓解期', recurrence: '复发', relapse: '再发',
  confirmed: '已确认', unconfirmed: '未确认', provisional: '暂定', differential: '鉴别诊断', refuted: '已排除',
  final: '最终', preliminary: '初步', amended: '已修订', corrected: '已更正', registered: '已登记',
  completed: '已完成', finished: '已结束', 'in-progress': '进行中', planned: '计划中',
  stopped: '已停止', cancelled: '已取消', draft: '草稿', 'on-hold': '暂停', unknown: '未知',
  'entered-in-error': '录入错误', 'not-done': '未执行',
}

export function sourceHistoryTitle(item: { title: string; resourceType: string }, locale: WorkspaceLocale): string {
  return locale === 'zh-CN' && item.title === item.resourceType
    ? resourceNames[item.resourceType] ?? item.title
    : item.title
}

export function sourceResourceTitle(resource: unknown, locale: WorkspaceLocale): string {
  const item = object(resource)
  const type = text(item.resourceType) ?? (locale === 'zh-CN' ? '未知类型' : 'Unknown type')
  return concept(item.code) ?? concept(item.medicationCodeableConcept) ?? reference(item.medicationReference)
    ?? concept(item.vaccineCode) ?? text(item.title) ?? (locale === 'zh-CN' ? resourceNames[type] ?? type : type)
}

export function SourceHistoryDetail({ resource, locale }: { resource: unknown; locale: WorkspaceLocale }) {
  const item = object(resource)
  const zh = locale === 'zh-CN'
  const label = (chinese: string, english: string) => zh ? chinese : english
  const status = (value: unknown) => {
    const raw = text(value) ?? concept(value)
    return raw === undefined ? undefined : (zh ? statusNames[raw] ?? raw : raw)
  }
  const type = text(item.resourceType) ?? label('未知类型', 'Unknown type')
  const title = sourceResourceTitle(resource, locale)
  const fields: [string, string | undefined][] = [
    [label('记录类型', 'Record type'), zh ? resourceNames[type] ?? type : type],
    [label('编码', 'Code'), joined(list(object(item.code).coding).map(coding => {
      const entry = object(coding)
      return joined([text(entry.code), text(entry.system)], ' · ')
    }))],
    [label('状态', 'Status'), status(item.status)],
    [label('临床状态', 'Clinical status'), status(item.clinicalStatus)],
    [label('确认状态', 'Verification status'), status(item.verificationStatus)],
    [label('发生时间', 'Onset'), dateTime(item.onsetDateTime, locale) ?? period(item.onsetPeriod, locale)],
    [label('结束时间', 'Abatement'), dateTime(item.abatementDateTime, locale) ?? period(item.abatementPeriod, locale)],
    [label('记录时间', 'Recorded'), dateTime(item.recordedDate, locale)],
    [label('就诊时间', 'Encounter period'), period(item.period, locale)],
    [label('观察时间', 'Effective time'), dateTime(item.effectiveDateTime, locale) ?? period(item.effectivePeriod, locale)],
    [label('开具时间', 'Authored'), dateTime(item.authoredOn, locale)],
    [label('执行时间', 'Performed'), dateTime(item.performedDateTime, locale) ?? period(item.performedPeriod, locale)],
    [label('接种时间', 'Occurrence'), dateTime(item.occurrenceDateTime, locale) ?? text(item.occurrenceString)],
    [label('报告时间', 'Issued'), dateTime(item.issued, locale)],
    [label('结果', 'Result'), result(item, locale)],
    [label('参考范围', 'Reference range'), joined(list(item.referenceRange).map(range))],
    [label('结果解释', 'Interpretation'), joined(list(item.interpretation).map(concept))],
    [label('未报告原因', 'Data absent reason'), concept(item.dataAbsentReason)],
    [label('严重程度', 'Severity'), concept(item.severity)],
    [label('部位', 'Body site'), joined(list(item.bodySite).map(concept)) ?? concept(item.bodySite)],
    [label('就诊类别', 'Encounter class'), concept(item.class)],
    [label('就诊类型', 'Encounter type'), joined(list(item.type).map(concept))],
    [label('原因', 'Reason'), joined(list(item.reasonCode).map(concept))],
    [label('结论', 'Conclusion'), text(item.conclusion)],
    [label('备注', 'Notes'), joined(list(item.note).map(note => text(object(note).text)), '\n')],
  ]
  return (
    <div className="mt-3 min-w-0">
      <h5 className="break-words text-base font-semibold">{title}</h5>
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        {fields.flatMap(([name, value]) => value === undefined ? [] : [
          <div className="min-w-0" key={name}><dt className="text-xs text-muted-foreground">{name}</dt><dd className="mt-1 whitespace-pre-wrap break-words">{value}</dd></div>,
        ])}
      </dl>
      {list(item.component).map((component, index) => {
        const part = object(component)
        return (
          <section className="mt-3 border-t pt-3 text-sm" key={index}>
            <h6 className="font-medium">{concept(part.code) ?? label('分项', 'Component')}</h6>
            <p className="mt-1">{result(part, locale) ?? concept(part.dataAbsentReason) ?? label('未提供结果', 'No result provided')}</p>
            {part.referenceRange === undefined ? null : <p className="mt-1 text-xs text-muted-foreground">{label('参考范围', 'Reference range')}：{joined(list(part.referenceRange).map(range))}</p>}
            {part.interpretation === undefined ? null : <p className="mt-1 text-xs">{joined(list(part.interpretation).map(concept))}</p>}
          </section>
        )
      })}
      {list(item.dosageInstruction).map((dosage, index) => {
        const instruction = object(dosage)
        const repeat = object(object(instruction.timing).repeat)
        const frequency = joined([text(repeat.frequency), text(repeat.frequencyMax)], '–')
        const interval = joined([text(repeat.period), text(repeat.periodMax)], '–')
        const unit = text(repeat.periodUnit)
        const displayUnit = unit === undefined ? undefined : (zh ? periodUnits[unit] ?? unit : unit)
        const timing = concept(object(instruction.timing).code) ?? (frequency !== undefined && interval !== undefined && displayUnit !== undefined
          ? `${label('每', 'Every ')}${interval} ${displayUnit} / ${frequency} ${label('次', 'times')}` : undefined)
        return (
          <section className="mt-3 border-t pt-3 text-sm" key={index}>
            <h6 className="font-medium">{label('用法用量', 'Dosage')}</h6>
            {instruction.text === undefined ? null : <p className="mt-1 whitespace-pre-wrap">{text(instruction.text)}</p>}
            <p className="mt-1">{joined([concept(instruction.route), concept(instruction.method), timing])}</p>
            {list(instruction.doseAndRate).map((dose, doseIndex) => <p className="mt-1" key={doseIndex}>{joined([
              quantity(object(dose).doseQuantity) ?? range(object(dose).doseRange),
              quantity(object(dose).rateQuantity) ?? range(object(dose).rateRange),
            ])}</p>)}
            {instruction.asNeededBoolean === true || instruction.asNeededCodeableConcept !== undefined
              ? <p className="mt-1">{joined([label('按需使用', 'As needed'), concept(instruction.asNeededCodeableConcept)])}</p> : null}
          </section>
        )
      })}
      <details className="mt-4 border-t pt-3">
        <summary className="cursor-pointer text-xs text-muted-foreground">{label('原始 JSON', 'Raw JSON')}</summary>
        <pre className="mt-3 max-h-[420px] overflow-auto border bg-muted/20 p-3 text-xs">{JSON.stringify(resource, null, 2)}</pre>
      </details>
    </div>
  )
}
