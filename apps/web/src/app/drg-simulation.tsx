import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import {
  simCatalogSchema, simViewSchema, preparedSearchSchema,
  type SimAction, type SimAssessment, type SimCase, type SimClinical, type SimDraftLine, type SimMapping,
} from '@clinmesh/contracts/drg'
import type { SessionContext } from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@clinmesh/ui/components/card'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@clinmesh/ui/components/dialog'
import { Field, FieldGroup, FieldLabel, FieldSet, FieldLegend } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Progress } from '@clinmesh/ui/components/progress'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { Table, TableHeader, TableHead, TableRow, TableBody, TableCell } from '@clinmesh/ui/components/table'
import { apiGet, apiMutation, newIdempotencyKey } from './api-client.ts'
import { WorkspaceSelect } from './workspace-select.tsx'

const base = '/api/sim/v1/drg'
const responseSchema = z.object({ data: simViewSchema }).loose()
const fen = (value: number | null | undefined) => value == null ? '待补全' : `¥${(value / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const percent = (value: number | null) => value === null ? '待补全' : `${(value * 100).toFixed(1)}%`
const errorText = (error: unknown) => error instanceof Error ? error.message : '请求失败，请重试'

export function DrgSimulation({ session }: { session: SessionContext }) {
  const scope = ['drg', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId]
  const queryClient = useQueryClient()
  const [selection, setSelection] = useState<string | null>(null)
  const [createKey, setCreateKey] = useState(newIdempotencyKey)
  const catalog = useQuery({ queryKey: [...scope, 'catalog'], queryFn: ({ signal }) => apiGet(`${base}/catalog`, simCatalogSchema, signal) })
  const selected = selection ?? catalog.data?.cases[0]?.id ?? null
  const create = useMutation({ mutationFn: () => apiMutation(`${base}/cases`, responseSchema, {}, { idempotencyKey: createKey }),
    onSuccess: async response => { setCreateKey(newIdempotencyKey()); setSelection(response.data.case.id); await queryClient.invalidateQueries({ queryKey: [...scope, 'catalog'] }) } })
  return <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 md:p-6" aria-label="住院 DRG 模拟">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-xl font-semibold">住院 DRG 动态模拟</h1><p className="text-sm text-muted-foreground">合成病例 · 模拟院内价格 · 模拟分组与支付参数</p></div>
      <Button onClick={() => create.mutate()} disabled={create.isPending || catalog.data?.reference == null}>新建合成住院病例</Button>
    </div>
    <Alert><AlertTitle>模拟用途</AlertTitle><AlertDescription>目录内容来自已清洗资料；院内编码、规格、收费、成本和 SIM 病组金额均为合成配置。全程不设置 90% 管理目标。成本显示已覆盖部分估算，不能作为实际住院盈亏结论。</AlertDescription></Alert>
    {(catalog.error || create.error) && <ErrorAlert error={catalog.error ?? create.error} />}
    {catalog.isPending && <p role="status">正在读取参考版本…</p>}
    {catalog.data?.reference === null && <Alert><AlertTitle>五类参考资料尚未就绪</AlertTitle><AlertDescription>请按项目部署说明发布清洗后的参考数据，再刷新此页。</AlertDescription></Alert>}
    {catalog.data?.reference && <Tabs defaultValue="case" className="flex flex-col gap-4">
      <TabsList><TabsTrigger value="case">病例与费用</TabsTrigger><TabsTrigger value="reference">参考数据与模拟映射</TabsTrigger></TabsList>
      <TabsContent value="case" className="flex flex-col gap-4">
        <Field><FieldLabel htmlFor="drg-case">模拟住院病例</FieldLabel><WorkspaceSelect id="drg-case" value={selected}
          items={catalog.data.cases.map(item => ({ value: item.id, label: item.name }))} onValueChange={setSelection} placeholder="请新建合成病例" /></Field>
        {selected && <CasePanel key={selected} id={selected} scope={scope} catalog={catalog.data} />}
        {!selected && <p>新建病例后，可确认诊断与操作、编辑医嘱并观察费用变化。</p>}
      </TabsContent>
      <TabsContent value="reference"><ReferencePanel catalog={catalog.data} scope={scope} /></TabsContent>
    </Tabs>}
  </div>
}

function ErrorAlert({ error }: { error: unknown }) {
  return <Alert variant="destructive" role="alert"><AlertTitle>操作未完成</AlertTitle><AlertDescription>{errorText(error)}</AlertDescription></Alert>
}
function Block({ title, description, children }: { title: string, description?: string, children: ReactNode }) {
  return <Card><CardHeader><CardTitle>{title}</CardTitle>{description && <CardDescription>{description}</CardDescription>}</CardHeader><CardContent>{children}</CardContent></Card>
}

function CasePanel({ id, scope, catalog }: { id: string, scope: (string | undefined)[], catalog: z.infer<typeof simCatalogSchema> }) {
  const query = useQuery({ queryKey: [...scope, 'case', id], queryFn: ({ signal }) => apiGet(`${base}/cases/${id}`, simViewSchema, signal), refetchInterval: 5000 })
  if (query.error) return <ErrorAlert error={query.error} />
  if (!query.data) return <p role="status">正在读取病例…</p>
  return <CaseEditor key={id} state={query.data.case} assessment={query.data.assessment} scope={scope} catalog={{ ...catalog, mappings: query.data.case.configuration.mappings }} />
}

function CaseEditor({ state, assessment, scope, catalog }: {
  state: SimCase, assessment: SimAssessment, scope: (string | undefined)[], catalog: z.infer<typeof simCatalogSchema>,
}) {
  const queryClient = useQueryClient()
  const [clinicalDraft, setClinical] = useState<SimClinical | null>(null)
  const clinical = clinicalDraft ?? state.clinical
  const changed = JSON.stringify(clinical) !== JSON.stringify(state.clinical)
  const [draft, setDraft] = useState<SimDraftLine[]>([])
  const [mappingId, setMappingId] = useState<string | null>(catalog.mappings[0]?.id ?? null)
  const [preflight, setPreflight] = useState<{ revision: number, lines: SimDraftLine[], assessment: SimAssessment, idempotencyKey: string } | null>(null)
  const [notice, setNotice] = useState('')
  const caseKey = [...scope, 'case', state.id]
  const change = useMutation({
    mutationFn: (input: { action: SimAction, expectedRevision: number, idempotencyKey?: string }) => apiMutation(`${base}/cases/${state.id}/actions/change`, responseSchema,
      { action: input.action, expectedRevision: input.expectedRevision }, { idempotencyKey: input.idempotencyKey ?? newIdempotencyKey() }),
    onSuccess: async (response, input) => {
      await queryClient.cancelQueries({ queryKey: caseKey })
      const current = queryClient.getQueryData<z.infer<typeof simViewSchema>>(caseKey)
      if (current === undefined || response.data.case.revision >= current.case.revision) queryClient.setQueryData(caseKey, response.data)
      if (input.action.kind === 'issue') { setDraft([]); setPreflight(null) }
      if (input.action.kind === 'confirm-clinical') setClinical(null)
      setNotice(response.data.case.history.at(-1)?.action ?? '已更新')
      await queryClient.invalidateQueries({ queryKey: [...scope, 'catalog'] })
    }, onError: async () => { await queryClient.invalidateQueries({ queryKey: caseKey }) },
  })
  const preview = useQuery({
    queryKey: [...scope, 'preview', state.id, state.revision, draft],
    queryFn: ({ signal }) => apiMutation(`${base}/cases/${state.id}/preview`, simViewSchema, { expectedRevision: state.revision, lines: draft }, { signal }),
    enabled: draft.length > 0,
  })
  const clinicalPreview = useQuery({
    queryKey: [...scope, 'clinical-preview', state.id, state.revision, clinical],
    queryFn: ({ signal }) => apiMutation(`${base}/cases/${state.id}/preview`, simViewSchema, { expectedRevision: state.revision, lines: [], clinical }, { signal }),
    enabled: changed,
  })
  const opening = useMutation({ mutationFn: async () => {
    const lines = structuredClone(draft)
    const result = await apiMutation(`${base}/cases/${state.id}/preview`, simViewSchema, { expectedRevision: state.revision, lines })
    return { revision: state.revision, lines, assessment: result.assessment, idempotencyKey: newIdempotencyKey() }
  }, onSuccess: setPreflight })
  const pending = change.isPending || opening.isPending
  const quoted = draft.length === 0 ? assessment : preview.data?.assessment
  const run = (action: SimAction) => change.mutate({ action, expectedRevision: state.revision })
  const updateLine = (index: number, patch: Partial<SimDraftLine>) => setDraft(draft.map((line, row) => row === index ? { ...line, ...patch } : line))
  return <>
    <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{assessment.group?.code ?? '暂无模拟分组'}</Badge><span className="text-sm text-muted-foreground">病例版本 {state.revision} · 临床版本 {state.clinicalRevision} · 模拟日期 {state.simulationDate}</span></div>
    {notice && <p role="status">{notice}</p>}
    {(change.error || preview.error || clinicalPreview.error || opening.error) && <ErrorAlert error={change.error ?? preview.error ?? clinicalPreview.error ?? opening.error} />}
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <Block title="诊断与已完成操作" description="草稿只作推演，确认后才更新当前分组。新增费用不会改变临床事实。">
        <FieldGroup>
          <Field><FieldLabel htmlFor="drg-main">主诊断</FieldLabel><WorkspaceSelect id="drg-main" value={clinical.mainDiagnosisId}
            items={catalog.diagnoses.map(item => ({ value: item.id, label: `${item.code} ${item.name}` }))}
            onValueChange={value => value && setClinical({ ...clinical, mainDiagnosisId: value, secondaryDiagnosisIds: clinical.secondaryDiagnosisIds.filter(id => id !== value) })} /></Field>
          <FieldSet><FieldLegend>已确认并发症或其他诊断</FieldLegend>{catalog.diagnoses.filter(item => item.id !== clinical.mainDiagnosisId).map(item => <Field key={item.id} orientation="horizontal">
            <Checkbox id={`secondary-${item.id}`} checked={clinical.secondaryDiagnosisIds.includes(item.id)} onCheckedChange={checked => setClinical({ ...clinical,
              secondaryDiagnosisIds: checked ? [...clinical.secondaryDiagnosisIds, item.id] : clinical.secondaryDiagnosisIds.filter(id => id !== item.id) })} />
            <FieldLabel htmlFor={`secondary-${item.id}`}>{item.code} {item.name}</FieldLabel>
          </Field>)}</FieldSet>
          <FieldSet><FieldLegend>已完成并待确认的操作</FieldLegend>{catalog.procedures.map(item => <Field key={item.id} orientation="horizontal">
            <Checkbox id={`procedure-${item.id}`} checked={clinical.completedProcedureIds.includes(item.id)} onCheckedChange={checked => setClinical({ ...clinical,
              completedProcedureIds: checked ? [...clinical.completedProcedureIds, item.id] : clinical.completedProcedureIds.filter(id => id !== item.id) })} />
            <FieldLabel htmlFor={`procedure-${item.id}`}>{item.code} {item.name}</FieldLabel>
          </Field>)}</FieldSet>
          {changed && <Alert><AlertTitle>待确认推演</AlertTitle><AlertDescription>{clinicalPreview.data ? `${clinicalPreview.data.assessment.group?.name ?? '未匹配模拟规则'}，参考额 ${fen(clinicalPreview.data.assessment.group?.referenceFen)}；当前参考额仍为 ${fen(assessment.group?.referenceFen)}。` : '正在推演…'}</AlertDescription></Alert>}
          <Button disabled={!changed || pending || !clinicalPreview.data} onClick={() => run({ kind: 'confirm-clinical', clinical })}>确认临床变化并重新分组</Button>
          {changed && <Button variant="outline" onClick={() => setClinical(null)}>放弃临床草稿</Button>}
        </FieldGroup>
      </Block>
      <Block title="当前费用与本次增量" description={assessment.group?.reason ?? '缺少模拟规则，暂不显示确定参考额。'}>
        {quoted ? <Assessment assessment={quoted} /> : <p role="status">正在重新报价…</p>}
      </Block>
    </div>
    <Block title="模拟处方与服务医嘱" description="数量是本次计价总数量；剂量、频次、疗程用于记录，系统不再乘一次疗程。服务按床日计价，药品按包装计价。">
      <div className="flex flex-col gap-4">
        <FieldGroup className="md:flex-row md:items-end">
          <Field><FieldLabel htmlFor="drg-mapping">院内模拟项目</FieldLabel><WorkspaceSelect id="drg-mapping" value={mappingId} onValueChange={setMappingId}
            items={catalog.mappings.map(item => ({ value: item.id, label: `${item.name} · ${item.unit}` }))} /></Field>
          <Button variant="outline" disabled={!mappingId || draft.length >= 20 || pending} onClick={() => mappingId && setDraft([...draft, { mappingId, quantity: 1, dose: '', frequency: '', days: 1 }])}>加入本次草稿</Button>
        </FieldGroup>
        {draft.map((line, index) => <DraftRow key={index} line={line} mapping={catalog.mappings.find(item => item.id === line.mappingId)!} index={index} update={patch => updateLine(index, patch)} remove={() => setDraft(draft.filter((_, row) => row !== index))} />)}
        <Button disabled={draft.length === 0 || pending || changed || !preview.data || preview.isFetching} onClick={() => opening.mutate()}>开具前预览</Button>
      </div>
    </Block>
    <Block title="已开具医嘱与费用事实" description="药品开具直接模拟记费，服务先形成承诺。记费和成本执行独立；临床撤回保留费用，未执行项目经确认冲销后才释放。">
      {state.lines.length === 0 ? <p>尚无已开具医嘱。</p> : <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>项目与冻结价格</TableHead><TableHead>数量与金额</TableHead><TableHead>收费 / 成本</TableHead><TableHead>动作</TableHead></TableRow></TableHeader><TableBody>
        {state.lines.map(line => <TableRow key={line.id}>
          <TableCell>{line.mapping.name}<p className="text-xs text-muted-foreground">{line.mapping.priceVersion} · {line.mapping.specification}</p></TableCell>
          <TableCell>{line.quantity} {line.mapping.unit}<p>收费 {fen(line.chargeFen)} / 成本 {fen(line.costFen)}</p></TableCell>
          <TableCell>{({ incurred: '已发生', committed: '待记费', reversed: '已冲销' })[line.chargeState]} / {({ incurred: '已发生', committed: '待执行', released: '已释放' })[line.costState]}{line.withdrawn && <p>临床已撤回</p>}</TableCell>
          <TableCell><div className="flex flex-wrap gap-2">
            {line.chargeState === 'committed' && !line.withdrawn && <Button size="sm" variant="outline" disabled={pending || line.chargeFen === null} onClick={() => run({ kind: 'record-charge', lineId: line.id })}>确认记费</Button>}
            {line.costState === 'committed' && !line.withdrawn && <Button size="sm" variant="outline" disabled={pending} onClick={() => run({ kind: 'execute', lineId: line.id })}>确认执行</Button>}
            {!line.withdrawn && <Button size="sm" variant="outline" disabled={pending} onClick={() => run({ kind: 'withdraw', lineId: line.id })}>临床撤回</Button>}
            {line.withdrawn && line.costState === 'committed' && line.chargeState !== 'reversed' && <Button size="sm" variant="outline" disabled={pending} onClick={() => run({ kind: 'reverse', lineId: line.id })}>确认未执行冲销</Button>}
          </div></TableCell>
        </TableRow>)}
      </TableBody></Table></div>}
    </Block>
    <Block title="评估历史与固定版本" description={`${state.referenceReleaseId} · ${state.mappingVersion} · ${state.ruleVersion} · ${state.paymentVersion}`}>
      <div className="flex flex-col gap-3">{state.history.toReversed().map(entry => <details key={entry.revision}><summary>版本 {entry.revision} · {entry.action} · {entry.assessment.group?.code ?? '规则待补全'} · 收费 {fen(entry.assessment.totalChargeFen)}</summary>
        <p className="text-sm">{entry.at} · 临床版本 {entry.clinicalRevision} · 参考额 {fen(entry.assessment.group?.referenceFen)} · 已发生收费 {fen(entry.assessment.incurredChargeFen)} · 已覆盖成本 {fen(entry.assessment.totalCostFen)}</p>
        <pre className="max-h-64 overflow-auto text-xs">{JSON.stringify(entry, null, 2)}</pre>
      </details>)}</div>
    </Block>
    <Dialog open={preflight !== null} onOpenChange={open => { if (!open) setPreflight(null) }}><DialogContent className="max-h-[90svh] overflow-y-auto"><DialogHeader><DialogTitle>开具前费用预览</DialogTitle><DialogDescription>服务端已按病例版本和固定价格重新测算。可返回调整，或继续模拟开具。</DialogDescription></DialogHeader>
      {preflight && <><p>{preflight.lines.map(line => `${catalog.mappings.find(item => item.id === line.mappingId)?.name} × ${line.quantity}`).join('；')}</p><Assessment assessment={preflight.assessment} />
        {(preflight.revision !== state.revision || JSON.stringify(preflight.lines) !== JSON.stringify(draft)) && <p role="alert">病例或草稿已变化，请关闭后重新预览。</p>}
        {change.error && <ErrorAlert error={change.error} />}
        <DialogFooter><Button variant="outline" onClick={() => setPreflight(null)}>返回调整</Button><Button disabled={pending || preflight.revision !== state.revision || JSON.stringify(preflight.lines) !== JSON.stringify(draft)} onClick={() => change.mutate({ action: { kind: 'issue', lines: preflight.lines }, expectedRevision: preflight.revision, idempotencyKey: preflight.idempotencyKey })}>继续模拟开具</Button></DialogFooter>
      </>}
    </DialogContent></Dialog>
  </>
}

function DraftRow({ line, mapping, index, update, remove }: { line: SimDraftLine, mapping: SimMapping, index: number, update: (patch: Partial<SimDraftLine>) => void, remove: () => void }) {
  return <div className="flex flex-col gap-3 rounded-lg border p-3"><p>{mapping.name} · {mapping.specification} · 收费 {mapping.chargePrice ?? '待补全'} 元/{mapping.unit}</p>
    <FieldGroup className="md:flex-row">
      <Field><FieldLabel htmlFor={`drg-quantity-${index}`}>计价总数量（{mapping.unit}）</FieldLabel><Input id={`drg-quantity-${index}`} type="number" min={1} max={10000} value={line.quantity} onChange={event => update({ quantity: Math.max(1, Math.min(10000, Number(event.target.value) || 1)) })} /></Field>
      <Field><FieldLabel htmlFor={`drg-dose-${index}`}>单次剂量</FieldLabel><Input id={`drg-dose-${index}`} maxLength={100} value={line.dose} onChange={event => update({ dose: event.target.value })} /></Field>
      <Field><FieldLabel htmlFor={`drg-frequency-${index}`}>频次</FieldLabel><Input id={`drg-frequency-${index}`} maxLength={100} value={line.frequency} onChange={event => update({ frequency: event.target.value })} /></Field>
      <Field><FieldLabel htmlFor={`drg-days-${index}`}>疗程（天）</FieldLabel><Input id={`drg-days-${index}`} type="number" min={1} max={365} value={line.days} onChange={event => update({ days: Math.max(1, Math.min(365, Number(event.target.value) || 1)) })} /></Field>
    </FieldGroup><Button size="sm" variant="outline" onClick={remove}>移除本行</Button>
  </div>
}

function Assessment({ assessment: a }: { assessment: SimAssessment }) {
  return <div className="flex flex-col gap-3" aria-label="费用评估">
    <dl className="grid grid-cols-2 gap-3">
      <div><dt className="text-sm text-muted-foreground">DRG 模拟参考额</dt><dd className="text-xl font-semibold">{fen(a.group?.referenceFen)}</dd></div>
      <div><dt className="text-sm text-muted-foreground">开具后预计收费</dt><dd className="text-xl font-semibold">{a.totalChargeFen === null ? '不完整' : fen(a.totalChargeFen)}</dd></div>
      <div><dt>收费进度</dt><dd>{percent(a.chargeProgress)}</dd></div><div><dt>参考额未占用金额</dt><dd>{fen(a.remainingFen)}</dd></div>
    </dl>
    <Progress aria-label="相对模拟参考额的收费进度" value={a.chargeProgress === null ? null : Math.min(100, a.chargeProgress * 100)} />
    {a.remainingFen !== null && a.remainingFen < 0 && <Alert><AlertTitle>预计收费超过参考额 {fen(-a.remainingFen)}</AlertTitle><AlertDescription>按临床需要决策，可继续模拟开具。</AlertDescription></Alert>}
    <dl className="grid grid-cols-2 gap-2 text-sm"><dt>已发生收费（含未缴费）</dt><dd>{fen(a.incurredChargeFen)}</dd><dt>已开立待记费</dt><dd>{fen(a.committedChargeFen)}</dd><dt>本次草稿增量</dt><dd>{fen(a.draftChargeFen)}</dd><dt>独立后续治疗预留</dt><dd>{fen(a.reserveChargeFen)}</dd></dl>
    <p className="text-sm">已覆盖成本估算 {a.totalCostFen === null ? '待核算' : fen(a.totalCostFen)} · 估算结余 {a.costBalanceFen === null ? '待核算' : fen(a.costBalanceFen)} · 比例 {percent(a.costBalanceRatio)}</p>
    {a.costBalanceFen !== null && a.costBalanceFen < 0 && <p role="status">已覆盖成本已超出模拟参考收入 {fen(-a.costBalanceFen)}</p>}
    {a.missing.length > 0 && <Alert><AlertTitle>数据不完整</AlertTitle><AlertDescription>{a.missing.join('；')}。已知收费小计 {fen(a.knownChargeFen)}，已知成本小计 {fen(a.knownCostFen)}，缺项未按零估算。</AlertDescription></Alert>}
    <p className="text-xs text-muted-foreground">{a.coverage}</p>
  </div>
}

function ReferencePanel({ catalog, scope }: { catalog: z.infer<typeof simCatalogSchema>, scope: (string | undefined)[] }) {
  const [tableKey, setTableKey] = useState('icd10/records')
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [dataset = 'icd10', table = 'records'] = tableKey.split('/')
  const reference = useQuery({ queryKey: [...scope, 'reference', tableKey, query, page], queryFn: ({ signal }) => apiGet(`${base}/references?${new URLSearchParams({ dataset, table, query, page: String(page) })}`, preparedSearchSchema, signal) })
  return <div className="flex flex-col gap-4">
    <Block title="已发布的来源参考数据" description={`${catalog.reference?.releaseId} · 清单 SHA256 ${catalog.reference?.manifestSha256}`}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">原始字段和用途状态保留在每条记录内。来源参考可查询，不代表已通过当地分组、现行价格或院内启用验收。</p>
        <FieldGroup className="md:flex-row"><Field><FieldLabel htmlFor="drg-reference-table">目录与数据表</FieldLabel><WorkspaceSelect id="drg-reference-table" value={tableKey} onValueChange={value => { if (value) { setTableKey(value); setPage(1) } }}
          items={catalog.reference?.tables.map(item => ({ value: `${item.dataset}/${item.table}`, label: `${item.dataset}/${item.table} · ${item.count} 条` })) ?? []} /></Field>
          <Field><FieldLabel htmlFor="drg-reference-query">编码或名称</FieldLabel><Input id="drg-reference-query" value={input} maxLength={100} onChange={event => setInput(event.target.value)} /></Field>
          <Button variant="outline" onClick={() => { setQuery(input); setPage(1) }}>查询来源记录</Button>
        </FieldGroup>
        {reference.error && <ErrorAlert error={reference.error} />}
        {reference.isFetching && <p role="status">正在查询…</p>}
        {reference.data && <><p>共 {reference.data.total.toLocaleString()} 条 · 第 {page} 页</p>
          {reference.data.items.map(item => <details key={item.id}><summary>{item.code ?? item.id} {item.name || '层级或关系记录'} · {item.sourceVersion}</summary><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(item.payload, null, 2)}</pre></details>)}
          <div className="flex gap-2"><Button variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</Button><Button variant="outline" disabled={page * 30 >= reference.data.total} onClick={() => setPage(page + 1)}>下一页</Button></div>
        </>}
      </div>
    </Block>
    <Block title="独立的院内模拟映射" description="SIM 编码、规格、计价单位、收费价与成本均为合成配置，真实院内字段仍保留待补全。">
      <div className="flex flex-col gap-3">{catalog.mappings.map(item => <details key={item.id}><summary>{item.id} · {item.name} · {item.unit} · 收费 {item.chargePrice ?? '待补全'} / 成本 {item.costPrice ?? '待核算'}</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(item, null, 2)}</pre></details>)}</div>
    </Block>
  </div>
}
