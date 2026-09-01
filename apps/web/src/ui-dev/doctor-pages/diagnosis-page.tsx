import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@clinmesh/ui/components/card'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@clinmesh/ui/components/select'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import {
  CheckIcon,
  ClipboardPenLineIcon,
  LinkIcon,
  RotateCcwIcon,
  SaveIcon,
} from 'lucide-react'
import { useState } from 'react'

type ChronicStatus = 'no' | 'yes'

interface DiagnosisDraft {
  chronic: ChronicStatus
  doctor: string
  evidence: string[]
  icd10: string
  notes: string
  primaryDiagnosis: string
  secondaryDiagnosis: string
  severity: string
  time: string
}

interface LinkedProblem {
  detail: string
  id: string
  label: string
  status: '本次就诊' | '慢病' | '过敏史'
}

const diagnosisItems = [
  { code: 'J06.9', label: '急性上呼吸道感染', value: 'j069' },
  { code: 'I10', label: '原发性高血压', value: 'i10' },
  { code: 'J20.9', label: '急性支气管炎', value: 'j209' },
  { code: 'J11.1', label: '流行性感冒伴呼吸道表现', value: 'j111' },
] as const

const diagnosisSelectItems = diagnosisItems.map(item => ({
  label: `${item.label}（${item.code}）`,
  value: item.value,
}))

const severityItems = [
  { label: '轻度', value: 'mild' },
  { label: '中度', value: 'moderate' },
  { label: '重度', value: 'severe' },
] as const

const doctorItems = [
  { label: '张医生（呼吸内科）', value: 'zhang' },
  { label: '李医生（呼吸内科）', value: 'li' },
  { label: '陈医生（全科医学科）', value: 'chen' },
] as const

const dispositionItems = [
  { label: '门诊随访', value: 'outpatient' },
  { label: '转专科门诊', value: 'specialist' },
  { label: '建议住院评估', value: 'admission' },
  { label: '转急诊', value: 'emergency' },
] as const

const evidenceOptions = ['流涕', '咽痛', '咳嗽', '低热', '咽部充血', '白细胞正常'] as const

const linkedProblems = [
  { detail: '流涕、咽痛、咳嗽、低热', id: 'current-symptoms', label: '上呼吸道感染相关症状', status: '本次就诊' },
  { detail: '持续 5 年，目前口服氨氯地平', id: 'hypertension', label: '原发性高血压', status: '慢病' },
  { detail: '既往使用后出现皮疹', id: 'penicillin-allergy', label: '青霉素过敏史', status: '过敏史' },
] as const satisfies readonly LinkedProblem[]

const initialDraft: DiagnosisDraft = {
  chronic: 'no',
  doctor: 'zhang',
  evidence: [...evidenceOptions],
  icd10: 'J06.9；I10',
  notes: '建议注意保暖，避免受凉，充分休息。继续监测血压。',
  primaryDiagnosis: 'j069',
  secondaryDiagnosis: 'i10',
  severity: 'mild',
  time: '2025-06-06T08:36',
}

const emptyDraft: DiagnosisDraft = {
  chronic: 'no',
  doctor: 'zhang',
  evidence: [],
  icd10: '',
  notes: '',
  primaryDiagnosis: 'j069',
  secondaryDiagnosis: 'i10',
  severity: 'mild',
  time: '2025-06-06T08:36',
}

const initialLinkedProblemIds = linkedProblems.map(problem => problem.id)

function ProblemStatusBadge({ status }: { status: LinkedProblem['status'] }): React.JSX.Element {
  const variant = status === '过敏史' ? 'destructive' : status === '慢病' ? 'warning' : 'success'
  return <Badge variant={variant}>{status}</Badge>
}

export function DiagnosisPage(): React.JSX.Element {
  const [draft, setDraft] = useState<DiagnosisDraft>(() => ({ ...initialDraft }))
  const [isDirty, setIsDirty] = useState(false)
  const [linkedProblemIds, setLinkedProblemIds] = useState<string[]>(initialLinkedProblemIds)
  const [followUpDate, setFollowUpDate] = useState('2025-06-09')
  const [disposition, setDisposition] = useState('outpatient')
  const [followUpNotes, setFollowUpNotes] = useState('注意保暖，避免受凉；规律作息，清淡饮食；若症状加重或持续不缓解，请及时就诊。')
  const [education, setEducation] = useState('上呼吸道感染多由病毒引起。勤洗手，咳嗽或打喷嚏时遮掩口鼻，避免与家人共用水杯。')
  const [planSaved, setPlanSaved] = useState(false)

  const updateDraft = <Key extends keyof DiagnosisDraft>(key: Key, value: DiagnosisDraft[Key]): void => {
    setDraft(current => ({ ...current, [key]: value }))
    setIsDirty(true)
  }

  const saveDiagnosis = (): void => {
    setIsDirty(false)
  }

  const resetDraft = (): void => {
    setDraft({ ...emptyDraft })
    setIsDirty(true)
  }

  return (
    <div className="@container/diagnosis mx-auto flex w-full max-w-[1280px] flex-col gap-4 p-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ClipboardPenLineIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            诊断录入
          </CardTitle>
          <CardAction>
            <Button onClick={resetDraft} size="sm" type="button" variant="ghost">
              <RotateCcwIcon data-icon="inline-start" />
              清空
            </Button>
          </CardAction>
        </CardHeader>

        <CardContent>
          <FieldGroup className="gap-5">
            <FieldGroup className="grid gap-4 @min-[680px]/diagnosis:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="diagnosis-primary">主诊断 *</FieldLabel>
                <Select
                  items={diagnosisSelectItems}
                  onValueChange={value => updateDraft('primaryDiagnosis', String(value))}
                  value={draft.primaryDiagnosis}
                >
                  <SelectTrigger className="w-full" id="diagnosis-primary">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {diagnosisSelectItems.map(item => (
                        <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <FieldLabel htmlFor="diagnosis-secondary">次要诊断</FieldLabel>
                <Select
                  items={diagnosisSelectItems}
                  onValueChange={value => updateDraft('secondaryDiagnosis', String(value))}
                  value={draft.secondaryDiagnosis}
                >
                  <SelectTrigger className="w-full" id="diagnosis-secondary">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {diagnosisSelectItems.map(item => (
                        <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </FieldGroup>

            <FieldGroup className="grid gap-4 @min-[680px]/diagnosis:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="diagnosis-icd10">ICD-10 编码 *</FieldLabel>
                <Input
                  id="diagnosis-icd10"
                  onChange={event => updateDraft('icd10', event.target.value)}
                  value={draft.icd10}
                />
              </Field>

              <FieldGroup className="grid grid-cols-[minmax(0,1fr)_auto] gap-4">
                <Field>
                  <FieldLabel htmlFor="diagnosis-severity">病情分级</FieldLabel>
                  <Select
                    items={severityItems}
                    onValueChange={value => updateDraft('severity', String(value))}
                    value={draft.severity}
                  >
                    <SelectTrigger className="w-full" id="diagnosis-severity">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {severityItems.map(item => (
                          <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>

                <FieldSet>
                  <FieldLegend variant="label">慢病管理</FieldLegend>
                  <ToggleGroup
                    aria-label="是否纳入慢病管理"
                    onValueChange={values => {
                      const next = values[0] as ChronicStatus | undefined
                      if (next !== undefined) updateDraft('chronic', next)
                    }}
                    spacing={0}
                    value={[draft.chronic]}
                    variant="outline"
                  >
                    <ToggleGroupItem value="yes">是</ToggleGroupItem>
                    <ToggleGroupItem value="no">否</ToggleGroupItem>
                  </ToggleGroup>
                </FieldSet>
              </FieldGroup>
            </FieldGroup>

            <FieldSet>
              <FieldLegend variant="label">诊断依据 *</FieldLegend>
              <FieldDescription>选择已在问诊、查体或检验中确认的依据</FieldDescription>
              <ToggleGroup
                aria-label="诊断依据"
                className="w-full flex-wrap justify-start"
                multiple
                onValueChange={values => updateDraft('evidence', values as string[])}
                size="sm"
                value={draft.evidence}
                variant="outline"
              >
                {evidenceOptions.map(evidence => (
                  <ToggleGroupItem aria-label={evidence} key={evidence} value={evidence}>
                    <CheckIcon aria-hidden="true" />
                    {evidence}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </FieldSet>

            <FieldGroup className="grid gap-4 @min-[760px]/diagnosis:grid-cols-[minmax(0,1.35fr)_minmax(15rem,0.65fr)]">
              <Field>
                <FieldLabel htmlFor="diagnosis-notes">诊断备注</FieldLabel>
                <Textarea
                  id="diagnosis-notes"
                  onChange={event => updateDraft('notes', event.target.value)}
                  rows={5}
                  value={draft.notes}
                />
              </Field>

              <FieldGroup className="gap-4">
                <Field>
                  <FieldLabel htmlFor="diagnosis-time">诊断时间</FieldLabel>
                  <Input
                    id="diagnosis-time"
                    onChange={event => updateDraft('time', event.target.value)}
                    type="datetime-local"
                    value={draft.time}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="diagnosis-doctor">诊断医生</FieldLabel>
                  <Select
                    items={doctorItems}
                    onValueChange={value => updateDraft('doctor', String(value))}
                    value={draft.doctor}
                  >
                    <SelectTrigger className="w-full" id="diagnosis-doctor">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {doctorItems.map(item => (
                          <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              </FieldGroup>
            </FieldGroup>
          </FieldGroup>
        </CardContent>

        <CardFooter className="flex-wrap gap-3">
          <p className="mr-auto text-xs text-muted-foreground">
            {isDirty ? '当前修改尚未保存' : '诊断信息已保存'}
          </p>
          <Button onClick={saveDiagnosis} type="button">
            <SaveIcon data-icon="inline-start" />
            保存诊断
          </Button>
        </CardFooter>
      </Card>

      <div className="grid items-start gap-4 @min-[960px]/diagnosis:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <LinkIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              问题与既往史关联
            </CardTitle>
            <CardAction><Badge variant="outline">已关联 {linkedProblemIds.length} 项</Badge></CardAction>
          </CardHeader>
          <CardContent>
            <FieldSet>
              <FieldLegend className="sr-only">选择关联问题</FieldLegend>
              <FieldGroup className="gap-1">
                {linkedProblems.map(problem => {
                  const checked = linkedProblemIds.includes(problem.id)
                  return (
                    <Field key={problem.id} orientation="horizontal">
                      <Checkbox
                        aria-label={`关联${problem.label}`}
                        checked={checked}
                        id={`problem-${problem.id}`}
                        onCheckedChange={nextChecked => {
                          setLinkedProblemIds(current => (
                            nextChecked
                              ? [...new Set([...current, problem.id])]
                              : current.filter(id => id !== problem.id)
                          ))
                        }}
                      />
                      <FieldContent>
                        <div className="flex min-w-0 items-start gap-3">
                          <div className="min-w-0 flex-1">
                            <FieldLabel htmlFor={`problem-${problem.id}`}>{problem.label}</FieldLabel>
                            <FieldDescription>{problem.detail}</FieldDescription>
                          </div>
                          <ProblemStatusBadge status={problem.status} />
                        </div>
                      </FieldContent>
                    </Field>
                  )
                })}
              </FieldGroup>
            </FieldSet>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>随访与处置计划</CardTitle>
            <CardAction>
              {planSaved ? <Badge variant="success">已保存</Badge> : <Badge variant="secondary">待保存</Badge>}
            </CardAction>
          </CardHeader>
          <CardContent>
            <FieldGroup className="gap-4">
              <FieldGroup className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="follow-up-date">复诊日期</FieldLabel>
                  <Input
                    id="follow-up-date"
                    onChange={event => { setFollowUpDate(event.target.value); setPlanSaved(false) }}
                    type="date"
                    value={followUpDate}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="follow-up-disposition">处置去向</FieldLabel>
                  <Select
                    items={dispositionItems}
                    onValueChange={value => { setDisposition(String(value)); setPlanSaved(false) }}
                    value={disposition}
                  >
                    <SelectTrigger className="w-full" id="follow-up-disposition">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {dispositionItems.map(item => (
                          <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              </FieldGroup>
              <Field>
                <FieldLabel htmlFor="follow-up-notes">注意事项</FieldLabel>
                <Textarea
                  id="follow-up-notes"
                  onChange={event => { setFollowUpNotes(event.target.value); setPlanSaved(false) }}
                  rows={3}
                  value={followUpNotes}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="follow-up-education">健康宣教</FieldLabel>
                <Textarea
                  id="follow-up-education"
                  onChange={event => { setEducation(event.target.value); setPlanSaved(false) }}
                  rows={3}
                  value={education}
                />
              </Field>
              <Field>
                <FieldTitle>返院提示</FieldTitle>
                <FieldDescription>
                  若出现高热（≥38.5°C）、呼吸困难、胸痛或意识改变，请立即就诊。
                </FieldDescription>
              </Field>
            </FieldGroup>
          </CardContent>
          <CardFooter className="justify-end">
            <Button onClick={() => setPlanSaved(true)} type="button" variant="outline">
              <SaveIcon data-icon="inline-start" />
              保存随访计划
            </Button>
          </CardFooter>
        </Card>
      </div>
    </div>
  )
}
