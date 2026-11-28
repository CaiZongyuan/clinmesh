import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@clinmesh/ui/components/popover'
import { useQuery } from '@tanstack/react-query'
import { BanIcon, CheckCircle2Icon, LoaderCircleIcon, ShieldAlertIcon, ShieldCheckIcon } from 'lucide-react'
import { useState } from 'react'
import { getAgentCapabilities } from '../agent-sessions-api.ts'

export function AssistantCapabilitiesMenu({ zh }: { zh: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)

  const capabilitiesQuery = useQuery({
    queryKey: ['agent-capabilities'],
    queryFn: ({ signal }) => getAgentCapabilities(signal),
    enabled: open,
    staleTime: 60_000,
    retry: false,
  })

  const manifest = capabilitiesQuery.data

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <Button
            aria-label={zh ? '查看助手能力事件清单与黑名单红线' : 'Inspect assistant capabilities & policy'}
            data-testid="assistant-capabilities-trigger"
            size="icon-sm"
            title={zh ? '能力清单与权限红线' : 'Capabilities & Policy'}
            type="button"
            variant="ghost"
          />
        }
      >
        <ShieldCheckIcon aria-hidden="true" className="size-4" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-[76vh] w-[22rem] overflow-y-auto p-3 text-xs"
        data-testid="assistant-capabilities-popover"
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <PopoverTitle className="text-sm font-semibold">
            {zh ? '助手事件清单与权限红线' : 'Assistant Capabilities & Guardrails'}
          </PopoverTitle>
          <Badge className="px-1.5 py-0 text-[0.625rem]" variant="secondary">
            {zh ? '黑名单制 · 默认放行' : 'Blacklist · Default-Allow'}
          </Badge>
        </div>

        {capabilitiesQuery.isLoading ? (
          <div className="flex items-center gap-2 py-4 text-muted-foreground">
            <LoaderCircleIcon aria-hidden="true" className="size-3.5 animate-spin" />
            <span>{zh ? '正在读取角色能力清单…' : 'Loading capability manifest…'}</span>
          </div>
        ) : capabilitiesQuery.isError || !manifest ? (
          <p className="py-2 text-destructive">
            {zh ? '暂无法读取能力清单，请稍后重试。' : 'Unable to load capability manifest.'}
          </p>
        ) : (
          <div className="space-y-3">
            <p className="leading-relaxed text-muted-foreground">
              {zh ? manifest.summaryZh : manifest.summaryEn}
            </p>

            <div className="grid grid-cols-3 gap-1.5 text-center">
              <div className="rounded-md border border-border/80 bg-muted/40 px-2 py-1.5">
                <div className="text-sm font-semibold tabular-nums text-foreground">
                  {manifest.counts.defaultAllowedOperations}
                </div>
                <div className="text-[0.625rem] text-muted-foreground">
                  {zh ? '默认放行 HIS' : 'Auto-Allowed'}
                </div>
              </div>
              <div className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5">
                <div className="text-sm font-semibold tabular-nums text-foreground">
                  {manifest.counts.confirmationGatedOperations}
                </div>
                <div className="text-[0.625rem] text-muted-foreground">
                  {zh ? '一键确认红线' : 'Approval Gate'}
                </div>
              </div>
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5">
                <div className="text-sm font-semibold tabular-nums text-foreground">
                  {manifest.blacklist.length}
                </div>
                <div className="text-[0.625rem] text-muted-foreground">
                  {zh ? '硬黑名单规则' : 'Hard Denies'}
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="font-semibold text-foreground">
                {zh ? '支持的活动事件清单' : 'Supported Activity Events'}
              </div>
              <ul className="space-y-1.5">
                {manifest.events.map(ev => (
                  <li
                    className="rounded-md border border-border/70 bg-background/80 p-2"
                    key={ev.id}
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="inline-flex items-center gap-1 font-medium text-foreground">
                        {ev.permission === 'confirm'
                          ? <ShieldAlertIcon aria-hidden="true" className="size-3.5 text-warning" />
                          : <CheckCircle2Icon aria-hidden="true" className="size-3.5 text-primary" />}
                        {zh ? ev.titleZh : ev.titleEn}
                      </span>
                      <Badge
                        className="px-1.5 py-0 text-[0.625rem]"
                        variant={ev.permission === 'confirm' ? 'outline' : 'secondary'}
                      >
                        {ev.permission === 'confirm'
                          ? (zh ? '需医生确认' : 'Confirm')
                          : (zh ? '默认放行' : 'Allowed')}
                      </Badge>
                    </div>
                    <p className="mt-1 text-[0.6875rem] leading-snug text-muted-foreground">
                      {zh ? ev.descriptionZh : ev.descriptionEn}
                    </p>
                  </li>
                ))}
              </ul>
            </div>

            <details className="rounded-md border border-destructive/30 bg-destructive/5 p-2">
              <summary className="flex cursor-pointer items-center gap-1 font-semibold text-foreground">
                <BanIcon aria-hidden="true" className="size-3.5 text-destructive" />
                {zh ? `硬黑名单（${manifest.blacklist.length} 条）` : `Hard Blacklist (${manifest.blacklist.length})`}
              </summary>
              <ul className="mt-2 space-y-1.5">
                {manifest.blacklist.map(rule => (
                  <li className="text-[0.6875rem]" key={rule.id}>
                    <div className="font-medium text-foreground">
                      {zh ? rule.titleZh : rule.titleEn}
                      <span className="ml-1 font-mono text-[0.625rem] text-muted-foreground">({rule.pattern})</span>
                    </div>
                    <p className="text-muted-foreground">{zh ? rule.reasonZh : rule.reasonEn}</p>
                  </li>
                ))}
              </ul>
            </details>

            <details className="rounded-md border border-warning/40 bg-warning/10 p-2">
              <summary className="flex cursor-pointer items-center gap-1 font-semibold text-foreground">
                <ShieldAlertIcon aria-hidden="true" className="size-3.5 text-warning" />
                {zh
                  ? `高危确认红线操作（${manifest.confirmationOperations.length} 项）`
                  : `Confirmation-Gated Ops (${manifest.confirmationOperations.length})`}
              </summary>
              <ul className="mt-2 max-h-40 space-y-1 overflow-auto font-mono text-[0.625rem] text-muted-foreground">
                {manifest.confirmationOperations.map(op => (
                  <li key={op.operationId}>
                    <span className="font-semibold text-foreground">{op.operationId}</span> — {op.summary}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
