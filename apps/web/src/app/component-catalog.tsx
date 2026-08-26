import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@clinmesh/ui/components/alert-dialog'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldError, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Spinner } from '@clinmesh/ui/components/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { toast } from '@clinmesh/ui/components/toast'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import {
  CheckIcon,
  CircleAlertIcon,
  FilePlus2Icon,
  MoonIcon,
  SaveIcon,
  SendIcon,
  SunIcon,
  Trash2Icon,
} from 'lucide-react'
import { useState } from 'react'
import { readWebPreferences, writeWebPreferences } from './preferences.ts'

type CatalogTheme = 'light' | 'dark'

function currentDocumentTheme(): CatalogTheme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

function applyDocumentTheme(theme: CatalogTheme): void {
  const root = document.documentElement
  root.classList.toggle('dark', theme === 'dark')
  root.dataset.theme = theme
  root.style.colorScheme = theme
  writeWebPreferences({ ...readWebPreferences(), theme })
}

function ThemeControl(): React.JSX.Element {
  const [theme, setTheme] = useState(currentDocumentTheme)

  return (
    <ToggleGroup
      aria-label="预览主题"
      onValueChange={values => {
        const nextTheme = (values as CatalogTheme[])[0]
        if (nextTheme === undefined) return
        setTheme(nextTheme)
        applyDocumentTheme(nextTheme)
      }}
      size="sm"
      spacing={0}
      value={[theme]}
      variant="outline"
    >
      <ToggleGroupItem aria-label="亮色主题" title="亮色主题" value="light">
        <SunIcon aria-hidden="true" />
      </ToggleGroupItem>
      <ToggleGroupItem aria-label="暗色主题" title="暗色主题" value="dark">
        <MoonIcon aria-hidden="true" />
      </ToggleGroupItem>
    </ToggleGroup>
  )
}

function ButtonShowcase(): React.JSX.Element {
  return (
    <section aria-labelledby="catalog-buttons-heading" className="flex flex-col gap-4 border-b pb-8">
      <h2 className="text-sm font-semibold" id="catalog-buttons-heading">按钮</h2>
      <div className="flex flex-wrap items-end gap-3">
        <Button size="xs" type="button">
          <FilePlus2Icon data-icon="inline-start" />
          补录
        </Button>
        <Button size="sm" type="button">暂存</Button>
        <Button type="button">保存病历</Button>
        <Button size="lg" type="button">
          <CheckIcon data-icon="inline-start" />
          提交签署
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" type="button">次要操作</Button>
        <Button variant="outline" type="button">调整</Button>
        <Button variant="ghost" type="button">取消</Button>
        <Button variant="destructive" type="button">
          <Trash2Icon data-icon="inline-start" />
          删除草稿
        </Button>
        <Button disabled type="button">无权限</Button>
        <Button disabled type="button">
          <Spinner aria-label="正在提交" data-icon="inline-start" />
          提交中
        </Button>
      </div>
    </section>
  )
}

function FormShowcase(): React.JSX.Element {
  return (
    <section aria-labelledby="catalog-form-heading" className="flex flex-col gap-4">
      <h2 className="text-sm font-semibold" id="catalog-form-heading">临床表单</h2>
      <form id="component-catalog-form" onSubmit={event => event.preventDefault()}>
        <FieldGroup className="md:grid md:grid-cols-2">
          <Field data-disabled>
            <FieldLabel htmlFor="catalog-patient-name">患者姓名</FieldLabel>
            <Input disabled id="catalog-patient-name" value="合成患者周敏" readOnly />
          </Field>
          <Field>
            <FieldLabel htmlFor="catalog-chief-complaint">主诉</FieldLabel>
            <Input defaultValue="发热伴咳嗽三天" id="catalog-chief-complaint" />
          </Field>
          <Field data-invalid>
            <FieldLabel htmlFor="catalog-diagnosis">初步诊断</FieldLabel>
            <Input
              aria-describedby="catalog-diagnosis-error"
              aria-invalid="true"
              id="catalog-diagnosis"
              placeholder="请选择或输入诊断"
            />
            <FieldError aria-label="诊断不能为空" id="catalog-diagnosis-error">诊断不能为空</FieldError>
          </Field>
          <Field>
            <FieldLabel id="catalog-priority-label">处置优先级</FieldLabel>
            <ToggleGroup aria-labelledby="catalog-priority-label" defaultValue={['routine']} variant="outline">
              <ToggleGroupItem value="routine">常规</ToggleGroupItem>
              <ToggleGroupItem value="urgent">急查</ToggleGroupItem>
              <ToggleGroupItem disabled value="critical">危急</ToggleGroupItem>
            </ToggleGroup>
          </Field>
          <Field className="md:col-span-2">
            <FieldLabel htmlFor="catalog-history">现病史</FieldLabel>
            <Textarea
              defaultValue="患者三日前无明显诱因出现发热，最高体温三十八点六摄氏度，伴阵发性咳嗽、少量白痰，无胸痛、咯血及明显呼吸困难。"
              id="catalog-history"
            />
          </Field>
        </FieldGroup>
      </form>
    </section>
  )
}

function ClinicalShowcase(): React.JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8">
      <section aria-labelledby="catalog-status-heading" className="flex flex-col gap-4 border-b pb-8">
        <h2 className="text-sm font-semibold" id="catalog-status-heading">语义状态</h2>
        <div className="flex flex-wrap gap-2">
          <Badge>进行中</Badge>
          <Badge variant="secondary">待接诊</Badge>
          <Badge variant="success">已完成</Badge>
          <Badge variant="warning">待复核</Badge>
          <Badge variant="info">已同步</Badge>
          <Badge variant="destructive">青霉素过敏</Badge>
          <Badge variant="outline">已停用</Badge>
        </div>
      </section>
      <section aria-labelledby="catalog-table-heading" className="flex flex-col gap-4 border-b pb-8">
        <h2 className="text-sm font-semibold" id="catalog-table-heading">临床表格</h2>
        <Table aria-label="门诊检验结果">
          <TableHeader>
            <TableRow>
              <TableHead>采样时间</TableHead>
              <TableHead>检验项目</TableHead>
              <TableHead>结果</TableHead>
              <TableHead>参考范围</TableHead>
              <TableHead>状态</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell className="tabular-nums">08:42</TableCell>
              <TableCell>血常规·白细胞计数</TableCell>
              <TableCell className="font-medium tabular-nums">12.6 × 10^9/L</TableCell>
              <TableCell className="tabular-nums">3.5–9.5</TableCell>
              <TableCell><Badge variant="warning">偏高</Badge></TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="tabular-nums">08:42</TableCell>
              <TableCell>C 反应蛋白</TableCell>
              <TableCell className="font-medium tabular-nums">6.2 mg/L</TableCell>
              <TableCell className="tabular-nums">0–8</TableCell>
              <TableCell><Badge variant="success">正常</Badge></TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </section>
      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="catalog-loading-heading" className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold" id="catalog-loading-heading">加载状态</h2>
          <div aria-label="正在加载病例" className="flex flex-col gap-3" role="status">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-4/5" />
          </div>
        </section>
        <section aria-labelledby="catalog-error-heading" className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold" id="catalog-error-heading">错误状态</h2>
          <Alert aria-label="处方审查失败" variant="destructive">
            <CircleAlertIcon aria-hidden="true" />
            <AlertTitle>处方审查失败</AlertTitle>
            <AlertDescription>
              请复核同一患者在本次就诊中已开具的全部药品、既往过敏记录与当前肾功能结果后再提交处方。
            </AlertDescription>
          </Alert>
        </section>
      </div>
    </div>
  )
}

function FeedbackShowcase(): React.JSX.Element {
  return (
    <div className="mx-auto grid w-full max-w-7xl gap-8 lg:grid-cols-2">
      <section aria-labelledby="catalog-dialog-heading" className="flex flex-col items-start gap-4 border-b pb-8 lg:border-r lg:border-b-0 lg:pr-8">
        <h2 className="text-sm font-semibold" id="catalog-dialog-heading">确认弹层</h2>
        <AlertDialog>
          <AlertDialogTrigger render={<Button type="button" variant="destructive" />}>
            <Trash2Icon data-icon="inline-start" />
            删除医嘱
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogMedia><Trash2Icon aria-hidden="true" /></AlertDialogMedia>
              <AlertDialogTitle>确认删除医嘱</AlertDialogTitle>
              <AlertDialogDescription>
                删除后不会签发这条合成医嘱，当前病历中的其他内容不受影响。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消删除</AlertDialogCancel>
              <AlertDialogAction variant="destructive">
                <Trash2Icon data-icon="inline-start" />
                确认删除
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </section>
      <section aria-labelledby="catalog-toast-heading" className="flex flex-col items-start gap-4">
        <h2 className="text-sm font-semibold" id="catalog-toast-heading">操作反馈</h2>
        <div className="flex flex-wrap gap-3">
          <Button
            onClick={() => toast.add({
              description: '合成患者的门诊病历草稿已更新。',
              title: '病历已保存',
              type: 'success',
            })}
            type="button"
          >
            发送成功反馈
          </Button>
          <Button
            onClick={() => toast.add({
              description: '当前病例版本已变化，请刷新后重试。',
              title: '提交冲突',
              type: 'warning',
            })}
            type="button"
            variant="outline"
          >
            发送警告反馈
          </Button>
          <Button
            onClick={() => toast.add({
              description: '正在校验处方、检查申请和病历签署条件。',
              title: '正在提交',
              type: 'loading',
            })}
            type="button"
            variant="secondary"
          >
            发送加载反馈
          </Button>
        </div>
      </section>
    </div>
  )
}

export function ComponentCatalog(): React.JSX.Element {
  return (
    <main className="flex min-h-svh flex-col bg-background text-foreground">
      <header className="sticky top-0 z-10 flex h-[3.375rem] shrink-0 items-center border-b bg-background px-4 sm:px-6">
        <h1 className="text-base font-semibold">组件目录</h1>
        <div className="ml-auto"><ThemeControl /></div>
      </header>
      <Tabs className="min-h-0 flex-1 gap-0" defaultValue="controls">
        <div className="overflow-x-auto border-b px-4 sm:px-6">
          <TabsList aria-label="组件分类" className="h-[2.875rem]" variant="line">
            <TabsTrigger value="controls">控件与表单</TabsTrigger>
            <TabsTrigger value="clinical">临床数据与状态</TabsTrigger>
            <TabsTrigger value="feedback">弹层与反馈</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent className="p-4 sm:p-6" value="controls">
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-8">
            <ButtonShowcase />
            <FormShowcase />
          </div>
        </TabsContent>
        <TabsContent className="p-4 sm:p-6" value="clinical">
          <ClinicalShowcase />
        </TabsContent>
        <TabsContent className="p-4 sm:p-6" value="feedback">
          <FeedbackShowcase />
        </TabsContent>
      </Tabs>
      <section aria-label="固定提交区" className="sticky bottom-0 flex min-h-14 items-center justify-end gap-2 border-t bg-background px-4 py-3 sm:px-6">
        <Button form="component-catalog-form" type="button" variant="outline">
          <SaveIcon data-icon="inline-start" />
          暂存
        </Button>
        <Button form="component-catalog-form" type="submit">
          <SendIcon data-icon="inline-start" />
          提交
        </Button>
      </section>
    </main>
  )
}
