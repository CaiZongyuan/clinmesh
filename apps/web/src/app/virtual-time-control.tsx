import { scenarioStateSchema } from '@clinmesh/contracts/his'
import { advanceVirtualTimeResponseSchema } from '@clinmesh/contracts/inpatient'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { apiGet, apiMutation, newIdempotencyKey } from './api-client.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

export function VirtualTimeControl({ locale }: { locale: WorkspaceLocale }): React.JSX.Element {
  const zh = locale === 'zh-CN'
  const client = useQueryClient()
  const [target, setTarget] = useState('')
  const scenario = useQuery({ queryKey: ['scenario', 'virtual-time'],
    queryFn: ({ signal }) => apiGet('/api/sim/v1/scenario-runs/current', scenarioStateSchema, signal) })
  const advance = useMutation({ mutationFn: async () => {
    if (scenario.data === undefined || !target) throw new Error(zh ? '请指定医院虚拟时间' : 'Choose a virtual hospital time')
    return apiMutation(`/api/sim/v1/scenario-runs/${scenario.data.scenarioRunId}/actions/advance-time`, advanceVirtualTimeResponseSchema,
      { input: { expectedVirtualTime: scenario.data.virtualTime, targetVirtualTime: new Date(`${target}+08:00`).toISOString() } },
      { idempotencyKey: newIdempotencyKey() })
  }, onSuccess: async () => { await client.invalidateQueries() } })
  return <form className="m-4 rounded-lg border p-4" onSubmit={event => { event.preventDefault(); advance.mutate() }}>
    <h2 className="mb-2 font-semibold">{zh ? '场景虚拟时间' : 'Scenario virtual time'}</h2>
    <p className="mb-3 text-sm text-muted-foreground">{scenario.data ? new Date(scenario.data.virtualTime).toLocaleString(locale, { timeZone: 'Asia/Shanghai' }) : (zh ? '正在读取' : 'Loading')} · Asia/Shanghai</p>
    <FieldGroup className="grid gap-3 md:grid-cols-[1fr_auto]">
      <Field><FieldLabel htmlFor="virtual-time-target">{zh ? '推进到（北京时间）' : 'Advance to (Shanghai time)'}</FieldLabel>
        <Input id="virtual-time-target" type="datetime-local" required value={target} onChange={event => setTarget(event.currentTarget.value)} /></Field>
      <Button className="self-end" disabled={advance.isPending || scenario.data === undefined || !target} type="submit">{zh ? '推进虚拟时间' : 'Advance virtual time'}</Button>
    </FieldGroup>
    {scenario.error || advance.error ? <p role="alert">{(scenario.error ?? advance.error)?.message}</p> : null}
    {advance.isSuccess ? <p role="status">{zh ? `已推进，新增${advance.data.data.bedChargesCreated}笔床位费` : `Advanced; ${advance.data.data.bedChargesCreated} bed charges created`}</p> : null}
  </form>
}
