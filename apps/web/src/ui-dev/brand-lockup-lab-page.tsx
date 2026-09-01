import { ClipboardPlusIcon, MonitorIcon } from 'lucide-react'
import clinmeshMarkUrl from '../assets/clinmesh-mark.webp'
import clinmeshWordmarkUrl from '../assets/clinmesh-wordmark.webp'

type BrandVariant = 'chinese-first' | 'compact' | 'horizontal' | 'split' | 'stacked'

const candidates = [
  {
    id: 'horizontal',
    label: 'A 横向签名',
    note: '完整英文标识居首，中文品牌信息独立成行。',
  },
  {
    id: 'chinese-first',
    label: 'B 中文主品牌',
    note: '强化中文识别，英文文字标作为品牌签名。',
  },
  {
    id: 'stacked',
    label: 'C 原版纵向',
    note: '延续源图的上下结构，使用更高的品牌区。',
  },
  {
    id: 'split',
    label: 'D 分栏锁定',
    note: '图形标独立成栏，三层文字严格左对齐。',
  },
  {
    id: 'compact',
    label: 'E 单行紧凑',
    note: '保持最小高度，用分隔线建立清晰层级。',
  },
] as const satisfies ReadonlyArray<{ id: BrandVariant; label: string; note: string }>

function Mark({ className }: { className: string }): React.JSX.Element {
  return <img alt="科灵脉智标志" className={className} src={clinmeshMarkUrl} />
}

function Wordmark({ className }: { className: string }): React.JSX.Element {
  return <img alt="Clinmesh" className={className} src={clinmeshWordmarkUrl} />
}

function ExpandedBrand({ variant }: { variant: BrandVariant }): React.JSX.Element {
  if (variant === 'horizontal') {
    return (
      <div className="flex w-full flex-col gap-1.5 px-1">
        <div className="flex items-center gap-2">
          <Mark className="size-9 shrink-0" />
          <Wordmark className="h-6 w-auto max-w-32" />
        </div>
        <div className="flex items-center justify-center gap-2 whitespace-nowrap text-[0.625rem] leading-none">
          <strong>科灵脉智</strong>
          <span aria-hidden="true" className="h-2.5 w-px bg-border" />
          <span className="text-muted-foreground">医疗智能体平台</span>
        </div>
      </div>
    )
  }

  if (variant === 'chinese-first') {
    return (
      <div className="flex w-full items-center gap-2 px-1">
        <Mark className="size-10 shrink-0" />
        <div className="min-w-0">
          <strong className="block text-sm leading-tight">科灵脉智</strong>
          <span className="block text-[0.625rem] text-muted-foreground">医疗智能体平台</span>
          <Wordmark className="mt-1 h-3.5 w-auto max-w-24" />
        </div>
      </div>
    )
  }

  if (variant === 'stacked') {
    return (
      <div className="flex w-full flex-col items-center gap-1 py-1">
        <Mark className="size-10" />
        <Wordmark className="h-5 w-auto max-w-28" />
        <div className="flex items-center gap-1.5 whitespace-nowrap text-[0.625rem] leading-none">
          <strong>科灵脉智</strong>
          <span className="text-muted-foreground">医疗智能体平台</span>
        </div>
      </div>
    )
  }

  if (variant === 'split') {
    return (
      <div className="grid w-full grid-cols-[2.75rem_minmax(0,1fr)] items-center px-1">
        <div className="flex h-11 items-center border-r pr-2">
          <Mark className="size-9 shrink-0" />
        </div>
        <div className="min-w-0 pl-2">
          <Wordmark className="h-5 w-auto max-w-24" />
          <strong className="mt-0.5 block text-[0.6875rem] leading-none">科灵脉智</strong>
          <span className="mt-1 block whitespace-nowrap text-[0.5625rem] leading-none text-muted-foreground">医疗智能体平台</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex w-full items-center gap-2 px-1">
      <Mark className="size-9 shrink-0" />
      <Wordmark className="h-5 w-auto max-w-24 shrink-0" />
      <span aria-hidden="true" className="h-7 w-px shrink-0 bg-border" />
      <div className="min-w-0 whitespace-nowrap leading-none">
        <strong className="block text-[0.625rem]">科灵脉智</strong>
        <span className="mt-1 block text-[0.5rem] text-muted-foreground">医疗智能体平台</span>
      </div>
    </div>
  )
}

function SidebarPreview({ collapsed, variant }: { collapsed: boolean; variant: BrandVariant }): React.JSX.Element {
  return (
    <div className={`${collapsed ? 'w-14' : 'w-[220px]'} flex h-44 shrink-0 flex-col overflow-hidden border bg-sidebar text-sidebar-foreground`}>
      <div className={`flex shrink-0 items-center ${variant === 'stacked' && !collapsed ? 'min-h-24' : 'min-h-16'} px-2`}>
        {collapsed ? <Mark className="size-8 shrink-0" /> : <ExpandedBrand variant={variant} />}
      </div>
      <div className="border-t px-2 py-3">
        {collapsed ? null : <div className="mb-2 px-2 text-[0.6875rem] text-muted-foreground">岗位工作台</div>}
        <div className={`flex h-8 items-center rounded-md bg-primary/10 text-primary ${collapsed ? 'justify-center' : 'gap-2 px-2'}`}>
          <ClipboardPlusIcon className="size-4 shrink-0" />
          {collapsed ? null : <span className="text-xs font-medium">门诊挂号</span>}
        </div>
      </div>
    </div>
  )
}

export function BrandLockupLabPage(): React.JSX.Element {
  return (
    <main className="min-h-svh bg-muted/30 px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6 flex items-center gap-3 border-b pb-5">
          <div className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <MonitorIcon className="size-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">侧栏品牌锁定</h1>
            <p className="text-sm text-muted-foreground">220 px 展开态与 56 px 折叠态</p>
          </div>
        </header>
        <section aria-label="品牌候选" className="grid gap-4 lg:grid-cols-2">
          {candidates.map(candidate => (
            <article className="overflow-hidden rounded-md border bg-background" key={candidate.id}>
              <div className="border-b px-4 py-3">
                <h2 className="text-sm font-semibold">{candidate.label}</h2>
                <p className="mt-1 text-xs text-muted-foreground">{candidate.note}</p>
              </div>
              <div className="flex items-start gap-3 overflow-x-auto p-4">
                <div>
                  <div className="mb-2 text-[0.6875rem] font-medium text-muted-foreground">展开</div>
                  <SidebarPreview collapsed={false} variant={candidate.id} />
                </div>
                <div>
                  <div className="mb-2 text-[0.6875rem] font-medium text-muted-foreground">折叠</div>
                  <SidebarPreview collapsed variant={candidate.id} />
                </div>
              </div>
            </article>
          ))}
        </section>
      </div>
    </main>
  )
}
