import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Progress } from '@clinmesh/ui/components/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { cn } from '@clinmesh/ui/lib/utils'
import {
  CircleCheckIcon,
  FileCheck2Icon,
  MicroscopeIcon,
  PlusIcon,
  SyringeIcon,
  TestTube2Icon,
} from 'lucide-react'
import { useState } from 'react'

const requests = [
  { fasting: '否', name: '血常规（五分类）', priority: '常规', sample: '全血', status: '已采样', time: '09:16' },
  { fasting: '否', name: 'C 反应蛋白（CRP）', priority: '常规', sample: '血清', status: '已出报告', time: '09:16' },
  { fasting: '是', name: '肝功能（八项）', priority: '常规', sample: '血清', status: '已出报告', time: '09:16' },
  { fasting: '是', name: '肾功能三项', priority: '常规', sample: '血清', status: '检验中', time: '09:16' },
  { fasting: '否', name: '尿常规', priority: '常规', sample: '尿液', status: '待采样', time: '09:16' },
  { fasting: '否', name: '甲/乙流抗原', priority: '常规', sample: '鼻咽拭子', status: '待采样', time: '09:16' },
] as const

const results = [
  { flag: '—', item: '白细胞（WBC）', reference: '3.50-9.50', unit: '10^9/L', value: '8.62' },
  { flag: '偏高', item: '中性粒细胞%（NE%）', reference: '40.0-75.0', unit: '%', value: '78.6 ↑' },
  { flag: '偏低', item: '淋巴细胞%（LY%）', reference: '20.0-50.0', unit: '%', value: '15.1' },
  { flag: '升高', item: 'C 反应蛋白（CRP）', reference: '0-8', unit: 'mg/L', value: '18.7 ↑' },
  { flag: '偏高', item: '血糖（GLU）', reference: '3.90-6.10', unit: 'mmol/L', value: '6.28' },
  { flag: '升高', item: 'ALT（谷丙转氨酶）', reference: '7-40', unit: 'U/L', value: '46 ↑' },
  { flag: '阳性', item: '尿蛋白（PRO）', reference: '阴性', unit: '—', value: '1+' },
  { flag: '—', item: '尿白细胞（LEU）', reference: '阴性', unit: '—', value: '阴性' },
] as const

export function LaboratoryPage(): React.JSX.Element {
  const [added, setAdded] = useState(false)

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 2xl:grid-cols-[46%_minmax(0,54%)]">
        <section className="overflow-hidden rounded-md border bg-background">
          <PageHeader
            action={<div className="flex gap-2"><Button onClick={() => setAdded(true)} size="xs"><PlusIcon data-icon="inline-start" />{added ? '已新增检验' : '新增检验'}</Button><Button size="xs" variant="outline">套餐模板</Button></div>}
            title="检验申请"
          />
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow><TableHead>检验项目</TableHead><TableHead>标本</TableHead><TableHead>空腹</TableHead><TableHead>优先级</TableHead><TableHead>申请时间</TableHead><TableHead>状态</TableHead></TableRow></TableHeader>
              <TableBody>{requests.map(item => <TableRow key={item.name}><TableCell className="whitespace-nowrap text-xs font-medium">{item.name}</TableCell><TableCell className="text-xs">{item.sample}</TableCell><TableCell className="text-xs">{item.fasting}</TableCell><TableCell className="text-xs">{item.priority}</TableCell><TableCell className="whitespace-nowrap text-xs tabular-nums">05-06 {item.time}</TableCell><TableCell><Badge variant={statusVariant(item.status)}>{item.status}</Badge></TableCell></TableRow>)}</TableBody>
            </Table>
          </div>
          <div className="border-t px-3 py-2 text-xs text-muted-foreground">共 {added ? 7 : 6} 项</div>
        </section>

        <section className="overflow-hidden rounded-md border bg-background">
          <PageHeader action={<Button size="xs" variant="link">查看报告单</Button>} aside="报告时间：2025-05-06 10:25" title="检验结果" />
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow><TableHead>检验项目</TableHead><TableHead>结果值</TableHead><TableHead>单位</TableHead><TableHead>参考范围</TableHead><TableHead>异常</TableHead><TableHead>状态</TableHead></TableRow></TableHeader>
              <TableBody>{results.map(item => <TableRow key={item.item}><TableCell className="whitespace-nowrap text-xs font-medium">{item.item}</TableCell><TableCell className={cn('whitespace-nowrap text-xs tabular-nums', item.flag === '—' ? '' : 'font-medium text-destructive')}>{item.value}</TableCell><TableCell className="text-xs">{item.unit}</TableCell><TableCell className="whitespace-nowrap text-xs">{item.reference}</TableCell><TableCell>{item.flag === '—' ? <span className="text-xs text-muted-foreground">—</span> : <Badge variant="destructive">{item.flag}</Badge>}</TableCell><TableCell><Badge variant="success">已审核</Badge></TableCell></TableRow>)}</TableBody>
            </Table>
          </div>
        </section>
      </div>

      <div className="grid gap-3 2xl:grid-cols-[36%_minmax(0,64%)]">
        <section className="rounded-md border bg-background">
          <PageHeader title="异常指标汇总" />
          <dl className="grid gap-2 p-3">
            <AbnormalFact label="C 反应蛋白" reference="0-8 mg/L" value="18.7 mg/L" />
            <AbnormalFact label="中性粒细胞%" reference="40.0-75.0%" value="78.6%" />
            <AbnormalFact label="ALT" reference="7-40 U/L" value="46 U/L" />
            <AbnormalFact label="尿蛋白" reference="阴性" value="1+" />
          </dl>
        </section>

        <section className="rounded-md border bg-background">
          <PageHeader title="采样与报告进度" />
          <div className="flex items-center justify-center gap-6 border-b p-3 text-xs">
            <Stage icon={FileCheck2Icon} label="已开立" />
            <span className="text-muted-foreground">→</span>
            <Stage icon={SyringeIcon} label="已采样" />
            <span className="text-muted-foreground">→</span>
            <Stage icon={MicroscopeIcon} label="检验中" />
            <span className="text-muted-foreground">→</span>
            <Stage icon={CircleCheckIcon} label="已出报告" />
          </div>
          <div className="p-3">
            <ProgressRow label="血常规（五分类）" progress={100} status="已出报告" time="2025-05-06 09:28" />
            <ProgressRow label="C 反应蛋白（CRP）" progress={100} status="已出报告" time="2025-05-06 09:28" />
            <ProgressRow label="肝功能（八项）" progress={100} status="已出报告" time="2025-05-06 10:25" />
            <ProgressRow label="肾功能三项" progress={66} status="检验中" time="—" />
            <ProgressRow label="尿常规" progress={20} status="待采样" time="—" />
          </div>
        </section>
      </div>
    </div>
  )
}

function PageHeader({ action, aside, title }: { action?: React.ReactNode; aside?: string; title: string }): React.JSX.Element {
  return <header className="flex min-h-11 items-center gap-3 border-b px-3"><h3 className="text-sm font-semibold">{title}</h3>{aside === undefined ? null : <span className="text-xs text-muted-foreground">{aside}</span>}<div className="ml-auto">{action}</div></header>
}

function statusVariant(status: string): 'info' | 'success' | 'warning' {
  if (status === '已出报告' || status === '已采样') return 'success'
  if (status === '检验中') return 'info'
  return 'warning'
}

function AbnormalFact({ label, reference, value }: { label: string; reference: string; value: string }): React.JSX.Element {
  return <div className="grid grid-cols-[minmax(0,1fr)_5rem] items-center gap-3 rounded-md border p-2 text-xs"><div><dt className="font-medium">{label}</dt><dd className="mt-1 text-muted-foreground">参考 {reference}</dd></div><strong className="text-right tabular-nums text-destructive">{value}</strong></div>
}

function Stage({ icon: Icon, label }: { icon: typeof TestTube2Icon; label: string }): React.JSX.Element {
  return <span className="flex items-center gap-1.5"><Icon className="size-4 text-primary" /><strong className="font-medium">{label}</strong></span>
}

function ProgressRow({ label, progress, status, time }: { label: string; progress: number; status: string; time: string }): React.JSX.Element {
  return <div className="grid grid-cols-[9rem_minmax(0,1fr)_7rem_5rem] items-center gap-3 border-b py-2 text-xs last:border-b-0"><span className="font-medium">{label}</span><Progress value={progress} /><span className="tabular-nums text-muted-foreground">{time}</span><Badge variant={statusVariant(status)}>{status}</Badge></div>
}
