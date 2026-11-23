import type { SessionContext } from '@clinmesh/contracts/his'
import { commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations-runtime'
import { authoredCasePackPrepareResponseSchema, authoredCasePackSummarySchema } from '@clinmesh/contracts/inpatient-pci-data'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiClientError, apiGet, apiMutation, newIdempotencyKey } from './api-client.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

const endpoint = '/api/sim/v1/admin/pathology-case-pack'
const operationId = 'admin.authored-case-pack.prepare'
interface PendingPreparation { idempotencyKey: string; expectedEpoch: string; packageId: string; packageVersion: string }

export function pathologyAdministratorScope(session: SessionContext) {
  return [session.user.id, session.actor.actorId, session.actor.practitionerRoleId, session.actor.workspaceId, session.actor.epoch, session.actor.scenarioRunId]
}

/** 人工准备固定合成病例；只在当前页面会话保留未知意图，不将患者或准备回执写入浏览器存储。 */
export function PathologyCasePackPreparation({ locale, session }: { locale: WorkspaceLocale; session: SessionContext }) {
  return <ScopedPathologyCasePackPreparation key={JSON.stringify(pathologyAdministratorScope(session))} locale={locale} session={session} />
}

function ScopedPathologyCasePackPreparation({ locale, session }: { locale: WorkspaceLocale; session: SessionContext }) {
  const zh = locale === 'zh-CN', client = useQueryClient(), scope = pathologyAdministratorScope(session)
  const packKey = ['administrator-pathology-case-pack', ...scope]
  const pendingKey = ['administrator-pathology-case-pack-pending', ...scope]
  const pack = useQuery({ queryKey: packKey, queryFn: ({ signal }) => apiGet(endpoint, authoredCasePackSummarySchema, signal) })
  const pending = useQuery<PendingPreparation | null>({ queryKey: pendingKey, queryFn: () => Promise.resolve(null),
    enabled: false, initialData: null, gcTime: Infinity })
  const prepare = useMutation({ mutationFn: async (recover: boolean) => {
    let intent = client.getQueryData<PendingPreparation | null>(pendingKey)
    if (!recover) {
      if (intent || !pack.data) throw new ApiClientError(409, 'PATHOLOGY_CASE_PACK_PENDING', 'Recover the original preparation first')
      intent = { idempotencyKey: newIdempotencyKey(), expectedEpoch: session.actor.epoch, packageId: pack.data.packageId, packageVersion: pack.data.packageVersion }
      client.setQueryData(pendingKey, intent)
    }
    if (!intent) throw new ApiClientError(409, 'PATHOLOGY_CASE_PACK_PENDING', 'The original preparation is not available')
    const original = intent
    const verify = (value: unknown) => {
      const result = authoredCasePackPrepareResponseSchema.parse(value)
      if (result.data.packageId !== original.packageId || result.data.packageVersion !== original.packageVersion) {
        throw new ApiClientError(409, 'PATHOLOGY_CASE_PACK_RECEIPT_MISMATCH', 'The original receipt belongs to another case pack')
      }
      return result
    }
    if (recover) {
      try {
        const query = new URLSearchParams({ operationId, idempotencyKey: original.idempotencyKey })
        const receipt = await apiGet(`/api/his/v1/command-receipts?${query}`, commandReceiptLookupSchema)
        if (receipt.operationId !== operationId || receipt.idempotencyKey !== original.idempotencyKey || receipt.status !== 'completed') {
          throw new ApiClientError(409, 'PATHOLOGY_CASE_PACK_PENDING', 'The original preparation is not confirmed')
        }
        return verify(receipt.response)
      } catch (error) {
        if (!(error instanceof ApiClientError) || error.status !== 404 || error.code !== 'COMMAND_RECEIPT_NOT_FOUND') throw error
      }
    }
    return verify(await apiMutation(`${endpoint}/prepare`, authoredCasePackPrepareResponseSchema,
      { input: { expectedEpoch: original.expectedEpoch } }, { idempotencyKey: original.idempotencyKey }))
  }, onSuccess: async response => {
    client.setQueryData(packKey, response.data)
    client.setQueryData(pendingKey, null)
    await client.invalidateQueries({ queryKey: ['synthetic-patient-profiles'] })
    await client.invalidateQueries({ queryKey: ['administrator-pathology'] })
  } })
  const status = (value?: string) => value === 'brief-ready' ? (zh ? '已就绪' : 'Ready') : value === 'started'
    ? (zh ? '已开始，保留就诊' : 'Started; visit retained') : value === 'completed' ? (zh ? '已完成' : 'Completed') : (zh ? '待准备' : 'Not prepared')
  return <section aria-label={zh ? '病理病例包准备' : 'Pathology case pack preparation'} className="flex flex-col gap-3 text-sm">
    <h3 className="font-semibold">{zh ? '结直肠与甲状腺会诊病例' : 'Colorectal and thyroid consultations'}</h3>
    <p className="text-muted-foreground">{zh ? '准备两例合成患者及既往取材记录，不调用模型。重复准备保留病例修订和已开始的就诊；阅片还需配置服务并准备相容切片。' : 'Prepare two synthetic patients and prior specimen histories without a model. Repeats preserve revisions and started visits; reading also requires the service and compatible slides.'}</p>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={!pack.data || pending.data !== null || prepare.isPending}
        onClick={() => prepare.mutate(false)}>{zh ? `准备病理病例包（${pack.data?.totalCount ?? 2} 例）` : `Prepare pathology pack (${pack.data?.totalCount ?? 2})`}</Button>
      <Button size="sm" variant="ghost" disabled={pack.isFetching} onClick={() => void pack.refetch()}>{zh ? '刷新病例状态' : 'Refresh cases'}</Button>
    </div>
    {pack.isError ? <p role="alert">{zh ? '无法读取病理病例包，请刷新病例状态。' : 'Unable to load the pathology case pack.'}</p> : null}
    {prepare.isPending ? <p role="status">{zh ? '正在确认病例准备结果…' : 'Confirming preparation…'}</p> : null}
    {pack.data ? <div className="rounded-md border p-3">
      <p role="status" className="font-medium">{zh ? `${pack.data.readyCount}/${pack.data.totalCount} 例已就绪` : `${pack.data.readyCount}/${pack.data.totalCount} ready`}</p>
      <ul className="mt-2 space-y-2">{pack.data.cases.map(item => <li className="flex flex-wrap items-center justify-between gap-2" key={item.draftId}>
        <span>{zh ? item.title : item.titleEn}</span><Badge variant="outline">{status(item.case?.status)}</Badge>
      </li>)}</ul>
    </div> : null}
    {pending.data !== null && !prepare.isPending ? <Alert><AlertTitle>{zh ? '原病例准备结果待确认' : 'Original preparation needs recovery'}</AlertTitle><AlertDescription>
      <p>{zh ? '请先查询原操作；仅在原回执不存在时，使用原包、原参数和原操作键继续。' : 'Recover the original result first; only a missing receipt permits resending the original intent.'}</p>
      <Button className="mt-2" size="sm" variant="outline" onClick={() => prepare.mutate(true)}>{zh ? '恢复原病理病例准备' : 'Recover pathology preparation'}</Button>
    </AlertDescription></Alert> : null}
    {prepare.isError ? <p role="alert">{zh ? '无法确认准备结果，请恢复原病理病例准备。' : 'The preparation result is unconfirmed. Recover the original operation.'}</p> : null}
  </section>
}
