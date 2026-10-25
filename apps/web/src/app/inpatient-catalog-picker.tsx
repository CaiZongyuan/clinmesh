import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { inpatientCatalogSearchSchema, type InpatientCatalogMissingField } from '@clinmesh/contracts/inpatient-clinical'
import type { SessionContext } from '@clinmesh/contracts/his'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { apiGet } from './api-client.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'

interface Props {
  kind: 'medication' | 'laboratory'
  session: SessionContext
  locale: WorkspaceLocale
  disabled: boolean
  onSelect: (id: string) => void
}

export function InpatientCatalogPicker(props: Props) {
  const { kind, locale } = props, zh = locale === 'zh-CN', noun = kind === 'medication' ? '药品' : '检验'
  const [open, setOpen] = useState(false), [text, setText] = useState(''), [query, setQuery] = useState('')
  return <>
    <Button type="button" variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>
      {zh ? `${open ? '收起' : '搜索'}共享${noun}目录` : `${open ? 'Hide' : 'Search'} shared ${kind} catalog`}
    </Button>
    {open ? <section aria-label={zh ? `共享${noun}目录` : `Shared ${kind} catalog`} className="flex flex-col gap-3">
      <form onSubmit={event => { event.preventDefault(); setQuery(text.trim()) }}>
        <FieldGroup className="flex flex-wrap items-end gap-2">
          <Field><FieldLabel htmlFor={`inpatient-${kind}-search`}>{zh ? `${noun}搜索词` : `Search ${kind}`}</FieldLabel>
            <Input id={`inpatient-${kind}-search`} value={text} maxLength={200} onChange={event => setText(event.currentTarget.value)} /></Field>
          <Button type="submit">{zh ? `搜索${noun}` : 'Search'}</Button>
        </FieldGroup>
      </form>
      {(['hospital', 'reference'] as const).map(source => <CatalogPage key={`${source}:${query}`} {...props} query={query} source={source} />)}
    </section> : null}
  </>
}

function CatalogPage({ kind, session, locale, disabled, onSelect, source, query }: Props & { source: 'hospital' | 'reference'; query: string }) {
  const [page, setPage] = useState(1), zh = locale === 'zh-CN', noun = kind === 'medication' ? '药品' : '检验'
  const label = zh ? `${source === 'hospital' ? '院内' : '参考'}${noun}` : `${source === 'hospital' ? 'Hospital' : 'Reference'} ${kind}`
  const results = useQuery({
    queryKey: ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, 'catalog-search', kind, source, query, page],
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/catalog-search?${new URLSearchParams({ kind, source, query, page: String(page), pageSize: '20' })}`, inpatientCatalogSearchSchema, signal),
  })
  return <section aria-label={label} className="flex flex-col gap-2 rounded-md border p-3">
    <h4>{label}</h4>
    {results.isPending ? <p role="status">{zh ? '正在查询目录' : 'Loading catalog'}</p> : null}
    {results.error ? <Alert variant="destructive"><AlertDescription>
      {zh ? '目录查询失败：' : 'Catalog query failed: '}{getWorkspaceErrorMessage(results.error, getWorkspaceMessages(locale))}
      <Button type="button" variant="outline" onClick={() => void results.refetch()}>{zh ? '重试目录查询' : 'Retry catalog query'}</Button>
    </AlertDescription></Alert> : null}
    {results.data?.items.map(item => <article key={item.id} className="flex flex-col gap-2">
      <p>{item.display}</p>
      <p>{item.status === 'available' ? zh ? '可使用' : 'Available' : item.status === 'inactive' ? zh ? '已停用' : 'Inactive' : zh ? '待补资料' : 'Incomplete'}</p>
      {item.missingFields.length > 0 ? <p>{item.missingFields.map(field => missingFieldLabel(field, zh, kind)).join(zh ? '、' : ', ')}</p> : null}
      <Button type="button" variant="outline" disabled={disabled || item.status !== 'available'}
        onClick={() => { if (item.status === 'available' && item.catalogItemId) onSelect(item.catalogItemId) }}>{zh ? `选择${item.display}` : `Select ${item.display}`}</Button>
    </article>)}
    {results.data?.items.length === 0 ? <p>{zh ? '没有匹配项目' : 'No matching items'}</p> : null}
    {results.data ? <div className="flex flex-wrap items-center gap-2">
      <p>{zh ? `第 ${page} 页，共 ${results.data.total} 项` : `Page ${page}, ${results.data.total} items`}</p>
      <Button type="button" variant="outline" disabled={page === 1 || results.isFetching} onClick={() => setPage(page - 1)}>{zh ? '上一页' : 'Previous'}</Button>
      <Button type="button" variant="outline" disabled={page * results.data.pageSize >= results.data.total || results.isFetching} onClick={() => setPage(page + 1)}>{zh ? '下一页' : 'Next'}</Button>
    </div> : null}
  </section>
}

function missingFieldLabel(field: InpatientCatalogMissingField, zh: boolean, kind: Props['kind']) {
  const labels: Record<InpatientCatalogMissingField, [string, string]> = {
    product: ['缺具体产品或包装资料', 'Missing product or packaging'], strength: ['缺规格', 'Missing strength'], unit: kind === 'medication' ? ['缺发药单位', 'Missing dispensing unit'] : ['缺计价单位', 'Missing billing unit'],
    price: ['缺院内价格', 'Missing hospital price'], 'inpatient-scope': ['未配置住院开展范围', 'Inpatient scope not configured'],
    'dose-limit': ['缺每次用量上限', 'Missing dose limit'], frequency: ['缺可用频次', 'Missing frequencies'], indication: ['缺适应症规则', 'Missing indication rules'],
    combination: ['缺药品组合规则', 'Missing combination rules'], conversion: ['剂量换算配置不完整', 'Incomplete dose conversion'],
    billing: ['缺计费触发规则', 'Missing billing rule'], 'hospital-mapping': ['尚未建立院内项目', 'No hospital mapping'],
    'ambiguous-mapping': ['院内映射不唯一', 'Ambiguous hospital mapping'], 'laboratory-definition': ['缺已发布检验定义', 'Missing published laboratory definition'],
    'not-orderable': ['该子项不可独立开立', 'Component cannot be ordered independently'],
  }
  return labels[field][zh ? 0 : 1]
}
