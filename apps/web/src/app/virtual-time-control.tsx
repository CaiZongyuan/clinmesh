import { scenarioStateSchema, type SessionContext } from '@clinmesh/contracts/his'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { apiGet } from './api-client.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { advanceVirtualTimeResponseSchema } from '@clinmesh/contracts/inpatient'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientWriteRecovery } from './inpatient-write-recovery.tsx'
import { DAY_MS } from './inpatient-scope.ts'
import { formatShanghaiMinute } from './workspace-format.ts'
import { WorkspaceCard } from './workspace-card-layout.tsx'

export function VirtualTimeControl({ locale, session }: { locale: WorkspaceLocale; session: SessionContext }): React.JSX.Element {
  const zh = locale === 'zh-CN'
  const client = useQueryClient()
  const [target, setTarget] = useState('')
  const scenario = useQuery({ queryKey: ['scenario', 'virtual-time'],
    queryFn: ({ signal }) => apiGet('/api/sim/v1/scenario-runs/current', scenarioStateSchema, signal) })
  const write = useInpatientWriteIntent(session, async () => { await client.invalidateQueries() })
  const normalizedTarget = target.trim().replace(' ', 'T')
  const advance = () => {
    if (scenario.data === undefined || !normalizedTarget) return
    const timestamp = Date.parse(`${normalizedTarget}+08:00`)
    write.mutation.mutate({ operation: 'scenario.advance-time', input: { expectedVirtualTime: scenario.data.virtualTime,
      targetVirtualTime: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '' } })
  }
  const messages = getWorkspaceMessages(locale)
  const error = scenario.error ?? write.storageFailure ?? write.mutation.error
  const result = write.mutation.isSuccess && write.mutation.data.command.operation === 'scenario.advance-time'
    ? advanceVirtualTimeResponseSchema.parse(write.mutation.data.response).data : undefined
  const pickPreset = (msOrNextMorning: number | 'next-morning') => {
    const baseMs = scenario.data ? Date.parse(scenario.data.virtualTime) : Date.now()
    if (!Number.isFinite(baseMs)) return
    if (msOrNextMorning === 'next-morning') {
      const nextDay = formatShanghaiMinute(new Date(baseMs + DAY_MS).toISOString()).slice(0, 10)
      setTarget(`${nextDay} 08:00`)
      return
    }
    setTarget(formatShanghaiMinute(new Date(baseMs + msOrNextMorning).toISOString()))
  }
  const parsedTargetPreview = (() => {
    const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}:\d{2})$/.exec(target.trim())
    return match ? `${match[1]}年${match[2]}月${match[3]}日 · ${match[4]}` : undefined
  })()
  return <WorkspaceCard title={zh ? '场景虚拟时间' : 'Scenario virtual time'}><form aria-label={zh ? '场景虚拟时间' : 'Scenario virtual time'} className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); advance() }}>
    <p className="mb-1 text-sm text-muted-foreground tabular-nums">{scenario.data ? formatShanghaiMinute(scenario.data.virtualTime) : (zh ? '正在读取' : 'Loading')} · {zh ? '北京时间 (UTC+8)' : 'Asia/Shanghai'}</p>
    {write.pending?.command.operation === 'scenario.advance-time' ? <InpatientWriteRecovery write={write} locale={locale} /> : null}
    <FieldSet disabled={write.blocked}><FieldGroup className="grid gap-3 md:grid-cols-[1fr_auto]">
      <Field><FieldLabel htmlFor="virtual-time-target">{zh ? '推进到（北京时间）' : 'Advance to (Shanghai time)'}</FieldLabel>
        <div className="flex flex-wrap items-center gap-2">
          <Input id="virtual-time-target" className="min-w-48 flex-1 tabular-nums" type="text" placeholder="YYYY-MM-DD HH:mm" required value={target} onChange={event => setTarget(event.currentTarget.value)} />
          {zh ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <Button size="sm" type="button" variant="outline" disabled={write.blocked || scenario.data === undefined} onClick={() => pickPreset(30 * 60_000)}>+30 分钟</Button>
              <Button size="sm" type="button" variant="outline" disabled={write.blocked || scenario.data === undefined} onClick={() => pickPreset(60 * 60_000)}>+1 小时</Button>
              <Button size="sm" type="button" variant="outline" disabled={write.blocked || scenario.data === undefined} onClick={() => pickPreset('next-morning')}>次日 08:00</Button>
            </div>
          ) : null}
        </div>
        {zh ? <p className="text-xs text-muted-foreground">{parsedTargetPreview ? `已选定 ${parsedTargetPreview}，可立即推进` : '还差：选择或输入目标日期与时间'}</p> : null}
      </Field>
      <div className="flex gap-2 self-end">
        <Button variant="outline" type="button" disabled={write.blocked || scenario.data === undefined} onClick={() => {
          if (scenario.data === undefined) return
          write.mutation.mutate({ operation: 'scenario.advance-time', input: {
            expectedVirtualTime: scenario.data.virtualTime,
            targetVirtualTime: new Date(Date.parse(scenario.data.virtualTime) + DAY_MS).toISOString(),
          } })
        }}>{zh ? '推进一天' : 'Advance one day'}</Button>
        <Button className="self-end disabled:border disabled:border-dashed disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100" disabled={write.blocked || scenario.data === undefined || !target} type="submit">{zh ? '推进虚拟时间' : 'Advance virtual time'}</Button>
      </div>
    </FieldGroup></FieldSet>
    {error ? <p role="alert">{getWorkspaceErrorMessage(error, messages)}</p> : null}
    {result !== undefined ? <p role="status">{zh ? `已推进，新增${result.bedChargesCreated}笔床位费` : `Advanced; ${result.bedChargesCreated} bed charges created`}</p> : null}
  </form></WorkspaceCard>
}
