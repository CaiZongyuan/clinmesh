import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@clinmesh/ui/components/card'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@clinmesh/ui/components/empty'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@clinmesh/ui/components/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import {
  CheckCircle2Icon,
  Clock3Icon,
  FileTextIcon,
  HistoryIcon,
  PillIcon,
  PlusIcon,
  PrinterIcon,
  SaveIcon,
  ShieldCheckIcon,
  Trash2Icon,
  Undo2Icon,
} from 'lucide-react'
import { useState, type ReactElement } from 'react'

interface MedicationTemplate {
  defaultDays: string
  defaultDose: string
  defaultFrequency: string
  defaultQuantity: string
  defaultRoute: string
  education: string
  id: string
  name: string
  price: number
  spec: string
  stock: string
  unit: string
}

interface MedicationDraft extends MedicationTemplate {
  days: string
  dose: string
  frequency: string
  quantity: string
  route: string
}

type DocumentState = 'draft' | 'saved' | 'signed'

const medicationCatalog = [
  {
    defaultDays: '3',
    defaultDose: '0.5 g',
    defaultFrequency: 'tid',
    defaultQuantity: '9',
    defaultRoute: 'oral',
    education: '用于退热止痛，两次服药至少间隔 4 小时；若出现皮疹或肝区不适，请停药就医。',
    id: 'acetaminophen',
    name: '对乙酰氨基酚片',
    price: 1.2,
    spec: '0.5 g x 10 片',
    stock: '126 盒',
    unit: '片',
  },
  {
    defaultDays: '5',
    defaultDose: '10 ml',
    defaultFrequency: 'tid',
    defaultQuantity: '1',
    defaultRoute: 'oral',
    education: '饭后服用，服药期间适当多饮水，有助于痰液排出。',
    id: 'ambroxol-liquid',
    name: '盐酸氨溴索口服溶液',
    price: 22.5,
    spec: '100 ml / 瓶',
    stock: '54 瓶',
    unit: '瓶',
  },
  {
    defaultDays: '5',
    defaultDose: '10 mg',
    defaultFrequency: 'qd',
    defaultQuantity: '5',
    defaultRoute: 'oral',
    education: '每日固定时间服用；少数人可能出现嗜睡，服药后避免驾车或高空作业。',
    id: 'loratadine',
    name: '氯雷他定片',
    price: 2.4,
    spec: '10 mg x 6 片',
    stock: '72 盒',
    unit: '片',
  },
  {
    defaultDays: '5',
    defaultDose: '20 mg',
    defaultFrequency: 'tid',
    defaultQuantity: '15',
    defaultRoute: 'oral',
    education: '整片吞服，避免与中枢性镇咳药自行合用；症状持续时应复诊。',
    id: 'benproperine',
    name: '枸橼酸喷托维林片',
    price: 0.86,
    spec: '25 mg x 24 片',
    stock: '68 盒',
    unit: '片',
  },
  {
    defaultDays: '5',
    defaultDose: '0.3 g',
    defaultFrequency: 'tid',
    defaultQuantity: '15',
    defaultRoute: 'oral',
    education: '饭后温水送服；若出现明显胃部不适、皮疹或呼吸不适，请停药并就医。',
    id: 'carbocisteine',
    name: '羧甲司坦片',
    price: 0.74,
    spec: '0.25 g x 24 片',
    stock: '91 盒',
    unit: '片',
  },
] as const satisfies readonly MedicationTemplate[]

const initialMedicationIds = ['acetaminophen', 'ambroxol-liquid', 'loratadine'] as const

const prescriptionTypeItems = [
  { label: '西药处方', value: 'western' },
  { label: '中成药处方', value: 'patent' },
  { label: '外用药处方', value: 'topical' },
] as const

const frequencyItems = [
  { label: '每日 1 次', value: 'qd' },
  { label: '每日 2 次', value: 'bid' },
  { label: '每日 3 次', value: 'tid' },
  { label: '每 8 小时', value: 'q8h' },
  { label: '必要时', value: 'prn' },
] as const

const routeItems = [
  { label: '口服', value: 'oral' },
  { label: '雾化吸入', value: 'inhaled' },
  { label: '外用', value: 'topical' },
] as const

const prescriptionHistory = [
  {
    amount: '56.20',
    date: '2025-04-22',
    diagnosis: '普通感冒（咳嗽）',
    medicationIds: ['acetaminophen', 'ambroxol-liquid', 'loratadine'] as const,
  },
  {
    amount: '32.50',
    date: '2025-03-18',
    diagnosis: '过敏性鼻炎',
    medicationIds: ['loratadine'] as const,
  },
  {
    amount: '28.60',
    date: '2025-02-10',
    diagnosis: '急性上呼吸道感染',
    medicationIds: ['acetaminophen', 'carbocisteine'] as const,
  },
] as const

const commonPlans = [
  {
    description: '退热、化痰、抗过敏',
    medicationIds: ['acetaminophen', 'ambroxol-liquid', 'loratadine'] as const,
    name: '成人上感对症方案',
  },
  {
    description: '化痰与短期对症处理',
    medicationIds: ['ambroxol-liquid', 'carbocisteine'] as const,
    name: '咳痰处理方案',
  },
] as const

const currencyFormatter = new Intl.NumberFormat('zh-CN', {
  currency: 'CNY',
  style: 'currency',
})

function createMedicationDraft(template: MedicationTemplate): MedicationDraft {
  return {
    ...template,
    days: template.defaultDays,
    dose: template.defaultDose,
    frequency: template.defaultFrequency,
    quantity: template.defaultQuantity,
    route: template.defaultRoute,
  }
}

function draftsFromIds(ids: readonly string[]): MedicationDraft[] {
  return ids.flatMap(id => {
    const template = medicationCatalog.find(item => item.id === id)
    return template === undefined ? [] : [createMedicationDraft(template)]
  })
}

export function PrescriptionPage(): ReactElement {
  const [documentState, setDocumentState] = useState<DocumentState>('draft')
  const [guidePrepared, setGuidePrepared] = useState(false)
  const [lastAppliedPlan, setLastAppliedPlan] = useState<string | null>(null)
  const [medications, setMedications] = useState<MedicationDraft[]>(() => draftsFromIds(initialMedicationIds))
  const [prescriptionType, setPrescriptionType] = useState('western')
  const [savedAsCommon, setSavedAsCommon] = useState(false)
  const [selectedCatalogId, setSelectedCatalogId] = useState<string | null>('benproperine')

  const medicationIds = new Set(medications.map(item => item.id))
  const availableMedicationItems = medicationCatalog.flatMap(item =>
    medicationIds.has(item.id) ? [] : [{ label: `${item.name} · ${item.spec}`, value: item.id }],
  )
  const isComplete = medications.length > 0 && medications.every(item =>
    item.dose.trim().length > 0 && Number(item.days) > 0 && Number(item.quantity) > 0,
  )
  const total = medications.reduce((sum, item) => sum + item.price * Number(item.quantity || 0), 0)
  const patientPayment = total * 0.3
  const insurancePayment = total - patientPayment

  const markDraft = (): void => {
    setDocumentState('draft')
    setGuidePrepared(false)
    setSavedAsCommon(false)
  }

  const updateMedication = (id: string, patch: Partial<MedicationDraft>): void => {
    setMedications(current => current.map(item => item.id === id ? { ...item, ...patch } : item))
    markDraft()
  }

  const addMedication = (): void => {
    if (selectedCatalogId === null || medicationIds.has(selectedCatalogId)) return
    const template = medicationCatalog.find(item => item.id === selectedCatalogId)
    if (template === undefined) return

    setMedications(current => [...current, createMedicationDraft(template)])
    const next = medicationCatalog.find(item => item.id !== selectedCatalogId && !medicationIds.has(item.id))
    setSelectedCatalogId(next?.id ?? null)
    markDraft()
  }

  const removeMedication = (id: string): void => {
    setMedications(current => current.filter(item => item.id !== id))
    setSelectedCatalogId(id)
    markDraft()
  }

  const applyPlan = (label: string, ids: readonly string[]): void => {
    setMedications(draftsFromIds(ids))
    setLastAppliedPlan(label)
    setSelectedCatalogId(medicationCatalog.find(item => !ids.includes(item.id))?.id ?? null)
    markDraft()
  }

  return (
    <div className="@container/prescription flex min-w-0 flex-col gap-4">
      <Card size="sm">
        <CardHeader className="border-b">
          <CardTitle>处方开立</CardTitle>
          <CardDescription>西药处方 · 门诊当日有效</CardDescription>
          <CardAction>
            <Badge variant={documentState === 'signed' ? 'success' : documentState === 'saved' ? 'info' : 'secondary'}>
              {documentState === 'signed' ? '已签署' : documentState === 'saved' ? '草稿已保存' : '编辑中'}
            </Badge>
          </CardAction>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          <form onSubmit={event => { event.preventDefault(); addMedication() }}>
            <FieldGroup className="flex-row flex-wrap items-center gap-3">
              <Field className="w-auto" orientation="horizontal">
                <FieldLabel htmlFor="prescription-type">处方类型</FieldLabel>
                <Select
                  items={prescriptionTypeItems}
                  onValueChange={value => {
                    if (value === null) return
                    setPrescriptionType(value)
                    markDraft()
                  }}
                  value={prescriptionType}
                >
                  <SelectTrigger id="prescription-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {prescriptionTypeItems.map(item => (
                        <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>

              <Field className="min-w-60 flex-1" orientation="horizontal">
                <FieldLabel className="shrink-0" htmlFor="medication-to-add">添加药品</FieldLabel>
                <Select
                  disabled={availableMedicationItems.length === 0}
                  items={availableMedicationItems}
                  onValueChange={setSelectedCatalogId}
                  value={selectedCatalogId}
                >
                  <SelectTrigger className="w-full" id="medication-to-add">
                    <SelectValue placeholder="选择药品和规格" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {availableMedicationItems.map(item => (
                        <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>

              <Button disabled={selectedCatalogId === null} type="submit">
                <PlusIcon data-icon="inline-start" />
                新增药品
              </Button>
            </FieldGroup>
          </form>

          <Table className="min-w-[47rem]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-9">#</TableHead>
                <TableHead>药品名称 / 规格</TableHead>
                <TableHead>单次剂量</TableHead>
                <TableHead>频次</TableHead>
                <TableHead>天数</TableHead>
                <TableHead>数量</TableHead>
                <TableHead>给药途径</TableHead>
                <TableHead className="w-10"><span className="sr-only">操作</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {medications.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8}>
                    <Empty>
                      <EmptyHeader>
                        <EmptyMedia variant="icon"><PillIcon /></EmptyMedia>
                        <EmptyTitle>尚未添加药品</EmptyTitle>
                        <EmptyDescription>从上方选择药品后加入处方。</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </TableCell>
                </TableRow>
              ) : medications.map((medication, index) => (
                <TableRow key={medication.id}>
                  <TableCell className="tabular-nums text-muted-foreground">{index + 1}</TableCell>
                  <TableCell>
                    <strong className="block font-medium">{medication.name}</strong>
                    <span className="text-xs text-muted-foreground">{medication.spec} · 库存 {medication.stock}</span>
                  </TableCell>
                  <TableCell>
                    <Input
                      aria-label={`${medication.name}单次剂量`}
                      className="min-w-20"
                      onChange={event => updateMedication(medication.id, { dose: event.target.value })}
                      value={medication.dose}
                    />
                  </TableCell>
                  <TableCell>
                    <Select
                      items={frequencyItems}
                      onValueChange={value => { if (value !== null) updateMedication(medication.id, { frequency: value }) }}
                      value={medication.frequency}
                    >
                      <SelectTrigger aria-label={`${medication.name}服药频次`} className="min-w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {frequencyItems.map(item => (
                            <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Input
                      aria-label={`${medication.name}用药天数`}
                      className="w-16"
                      min="1"
                      onChange={event => updateMedication(medication.id, { days: event.target.value })}
                      type="number"
                      value={medication.days}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex min-w-20 items-center gap-1.5">
                      <Input
                        aria-label={`${medication.name}数量`}
                        className="w-16"
                        min="1"
                        onChange={event => updateMedication(medication.id, { quantity: event.target.value })}
                        type="number"
                        value={medication.quantity}
                      />
                      <span className="text-xs text-muted-foreground">{medication.unit}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Select
                      items={routeItems}
                      onValueChange={value => { if (value !== null) updateMedication(medication.id, { route: value }) }}
                      value={medication.route}
                    >
                      <SelectTrigger aria-label={`${medication.name}给药途径`} className="min-w-24">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {routeItems.map(item => (
                            <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Button
                      aria-label={`删除${medication.name}`}
                      onClick={() => removeMedication(medication.id)}
                      size="icon-sm"
                      title={`删除${medication.name}`}
                      variant="destructive"
                    >
                      <Trash2Icon />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>

        <CardFooter>
          <div className="flex w-full flex-wrap items-center gap-3">
            <span className="font-medium">共 {medications.length} 种药品</span>
            <span className="text-muted-foreground">预计费用</span>
            <strong className="tabular-nums">{currencyFormatter.format(total)}</strong>
            <Button
              className="ml-auto"
              disabled={medications.length === 0 || savedAsCommon}
              onClick={() => setSavedAsCommon(true)}
              variant="outline"
            >
              <HistoryIcon data-icon="inline-start" />
              {savedAsCommon ? '已保存为常用方案' : '保存为常用方案'}
            </Button>
          </div>
        </CardFooter>
      </Card>

      <Card size="sm">
        <CardHeader className="border-b">
          <CardTitle>处方结果</CardTitle>
          <CardDescription>{documentState === 'signed' ? '已进入药师审核队列' : '签署前费用为当前估算'}</CardDescription>
          <CardAction>
            <Badge variant={documentState === 'signed' ? 'success' : 'secondary'}>
              {documentState === 'signed' ? '已提交' : '未提交'}
            </Badge>
          </CardAction>
        </CardHeader>

        <CardContent className="grid gap-5 @3xl/prescription:grid-cols-[minmax(0,1.15fr)_minmax(17rem,0.85fr)]">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 @lg/prescription:grid-cols-3">
            <ResultFact label="处方编号" value="RX20250606123001" />
            <ResultFact label="处方总额" value={currencyFormatter.format(total)} />
            <ResultFact label="医保支付" value={currencyFormatter.format(insurancePayment)} />
            <ResultFact label="个人支付" value={currencyFormatter.format(patientPayment)} />
            <ResultFact label="审方状态" value={documentState === 'signed' ? '已提交药师审核' : '待提交'} />
            <ResultFact label="药房状态" value={documentState === 'signed' ? '待接方' : '尚未流转'} />
          </dl>

          <section aria-labelledby="prescription-review-title" className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <ShieldCheckIcon className="size-4 text-success" />
              <h3 className="font-medium" id="prescription-review-title">处方规则检查</h3>
            </div>
            <div className="grid gap-2">
              <ReviewRow label="药品要素" ok={isComplete} value={isComplete ? '名称、规格与用法完整' : '存在未完成项目'} />
              <ReviewRow label="库存状态" ok={medications.length > 0} value={medications.length > 0 ? '当前库存可满足' : '待添加药品'} />
              <ReviewRow label="支付项目" ok={medications.length > 0} value={medications.length > 0 ? '费用项目已匹配' : '待计算'} />
              <ReviewRow label="电子签名" ok={documentState === 'signed'} value={documentState === 'signed' ? '已完成签署' : '等待医生签署'} />
            </div>
          </section>
        </CardContent>

        <CardFooter>
          <div className="flex w-full flex-wrap items-center gap-2">
            <span aria-live="polite" className="mr-auto text-muted-foreground">
              {documentState === 'signed' ? '处方已签署并进入审方队列' : documentState === 'saved' ? '草稿已保存' : '有未保存的更改'}
            </span>
            <Button
              disabled={documentState !== 'draft'}
              onClick={() => setDocumentState('saved')}
              variant="outline"
            >
              <SaveIcon data-icon="inline-start" />
              保存草稿
            </Button>
            <Button
              disabled={!isComplete || documentState === 'signed'}
              onClick={() => setDocumentState('signed')}
            >
              <CheckCircle2Icon data-icon="inline-start" />
              {documentState === 'signed' ? '已签署' : '核对并签署'}
            </Button>
          </div>
        </CardFooter>
      </Card>

      <div className="grid gap-4 @4xl/prescription:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <Card size="sm">
          <CardHeader className="border-b">
            <CardTitle>用药说明 / 患者教育</CardTitle>
            <CardDescription>{guidePrepared ? '用药指导单已准备，可交付患者。' : '随当前处方自动整理，签署前可继续调整。'}</CardDescription>
            <CardAction>
              <Button disabled={medications.length === 0} onClick={() => setGuidePrepared(true)} variant="outline">
                <PrinterIcon data-icon="inline-start" />
                {guidePrepared ? '指导单已准备' : '准备指导单'}
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {medications.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon"><FileTextIcon /></EmptyMedia>
                  <EmptyTitle>暂无用药说明</EmptyTitle>
                  <EmptyDescription>添加药品后，这里会显示对应的患者用药指导。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ul className="flex flex-col gap-3">
                {medications.map(item => (
                  <li className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3" key={item.id}>
                    <span className="flex size-7 items-center justify-center rounded-md bg-info/10 text-info">
                      <PillIcon className="size-4" />
                    </span>
                    <div>
                      <strong className="font-medium">{item.name}</strong>
                      <p className="mt-1 leading-5 text-muted-foreground">{item.education}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader className="border-b">
            <CardTitle>处方历史 / 常用方案</CardTitle>
            <CardDescription>{lastAppliedPlan === null ? '近一年 · 3 张历史处方' : `已应用：${lastAppliedPlan}`}</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="history">
              <TabsList variant="line">
                <TabsTrigger value="history">历史处方</TabsTrigger>
                <TabsTrigger value="common">常用方案</TabsTrigger>
              </TabsList>

              <TabsContent value="history">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>日期</TableHead>
                      <TableHead>诊断</TableHead>
                      <TableHead>药品</TableHead>
                      <TableHead>金额</TableHead>
                      <TableHead className="w-20"><span className="sr-only">操作</span></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {prescriptionHistory.map(item => (
                      <TableRow key={item.date}>
                        <TableCell className="tabular-nums text-muted-foreground">{item.date}</TableCell>
                        <TableCell className="font-medium">{item.diagnosis}</TableCell>
                        <TableCell>{item.medicationIds.length} 种</TableCell>
                        <TableCell className="tabular-nums">¥ {item.amount}</TableCell>
                        <TableCell>
                          <Button onClick={() => applyPlan(`${item.date} ${item.diagnosis}`, item.medicationIds)} size="sm" variant="ghost">
                            <Undo2Icon data-icon="inline-start" />
                            复用
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TabsContent>

              <TabsContent value="common">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>方案名称</TableHead>
                      <TableHead>用途</TableHead>
                      <TableHead>药品</TableHead>
                      <TableHead className="w-20"><span className="sr-only">操作</span></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {commonPlans.map(plan => (
                      <TableRow key={plan.name}>
                        <TableCell className="font-medium">{plan.name}</TableCell>
                        <TableCell className="text-muted-foreground">{plan.description}</TableCell>
                        <TableCell>{plan.medicationIds.length} 种</TableCell>
                        <TableCell>
                          <Button onClick={() => applyPlan(plan.name, plan.medicationIds)} size="sm" variant="ghost">
                            <Undo2Icon data-icon="inline-start" />
                            应用
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function ResultFact({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate font-medium tabular-nums" title={value}>{value}</dd>
    </div>
  )
}

function ReviewRow({ label, ok, value }: { label: string; ok: boolean; value: string }): ReactElement {
  const Icon = ok ? CheckCircle2Icon : Clock3Icon

  return (
    <div className="grid grid-cols-[1rem_4.5rem_minmax(0,1fr)] items-center gap-2">
      <Icon className={ok ? 'size-4 text-success' : 'size-4 text-muted-foreground'} />
      <strong className="font-medium">{label}</strong>
      <span className="truncate text-muted-foreground" title={value}>{value}</span>
    </div>
  )
}
