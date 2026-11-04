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
import { WorkspaceCard } from './workspace-card-layout.tsx'

export function VirtualTimeControl({ locale, session }: { locale: WorkspaceLocale; session: SessionContext }): React.JSX.Element {
  const zh = locale === 'zh-CN'
  const client = useQueryClient()
  const [target, setTarget] = useState('')
  const scenario = useQuery({ queryKey: ['scenario', 'virtual-time'],
    queryFn: ({ signal }) => apiGet('/api/sim/v1/scenario-runs/current', scenarioStateSchema, signal) })
  const write = useInpatientWriteIntent(session, async () => { await client.invalidateQueries() })
  const advance = () => {
    if (scenario.data === undefined || !target) return
    const timestamp = Date.parse(`${target}+08:00`)
    write.mutation.mutate({ operation: 'scenario.advance-time', input: { expectedVirtualTime: scenario.data.virtualTime,
      targetVirtualTime: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '' } })
  }
  const messages = getWorkspaceMessages(locale)
  const error = scenario.error ?? write.storageFailure ?? write.mutation.error
  const result = write.mutation.isSuccess && write.mutation.data.command.operation === 'scenario.advance-time'
    ? advanceVirtualTimeResponseSchema.parse(write.mutation.data.response).data : undefined
  return <WorkspaceCard title={zh ? '场景虚拟时间' : 'Scenario virtual time'}><form aria-label={zh ? '场景虚拟时间' : 'Scenario virtual time'} className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); advance() }}>
    <p className="mb-3 text-sm text-muted-foreground">{scenario.data ? new Date(scenario.data.virtualTime).toLocaleString(locale, { timeZone: 'Asia/Shanghai' }) : (zh ? '正在读取' : 'Loading')} · Asia/Shanghai</p>
    {write.pending?.command.operation === 'scenario.advance-time' ? <InpatientWriteRecovery write={write} locale={locale} /> : null}
    <FieldSet disabled={write.blocked}><FieldGroup className="grid gap-3 md:grid-cols-[1fr_auto]">
      <Field><FieldLabel htmlFor="virtual-time-target">{zh ? '推进到（北京时间）' : 'Advance to (Shanghai time)'}</FieldLabel>
        <Input id="virtual-time-target" type="datetime-local" required value={target} onChange={event => setTarget(event.currentTarget.value)} /></Field>
      <div className="flex gap-2 self-end">
        <Button variant="outline" type="button" disabled={write.blocked || scenario.data === undefined} onClick={() => {
          if (scenario.data === undefined) return
          write.mutation.mutate({ operation: 'scenario.advance-time', input: {
            expectedVirtualTime: scenario.data.virtualTime,
            targetVirtualTime: new Date(Date.parse(scenario.data.virtualTime) + DAY_MS).toISOString(),
          } })
        }}>{zh ? '推进一天' : 'Advance one day'}</Button>
        <Button className="self-end" disabled={write.blocked || scenario.data === undefined || !target} type="submit">{zh ? '推进虚拟时间' : 'Advance virtual time'}</Button>
      </div>
    </FieldGroup></FieldSet>
    {error ? <p role="alert">{getWorkspaceErrorMessage(error, messages)}</p> : null}
    {result !== undefined ? <p role="status">{zh ? `已推进，新增${result.bedChargesCreated}笔床位费` : `Advanced; ${result.bedChargesCreated} bed charges created`}</p> : null}
  </form></WorkspaceCard>
}
