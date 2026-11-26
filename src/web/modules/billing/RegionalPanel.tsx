import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';
import type { WorkspaceView } from '../../../packages/clinical-core';
import { formatMinor, type BillingAccount } from '../../../packages/mod-billing';
import { claimSchema, projectionSchema } from '../../../packages/mod-drg-cn';
import { Badge, Button, Card, ConfirmActionButton, Field, Meter, Select } from '../../../packages/ui-kit';
import { api, errorMessage, scopeKey, words, type Language } from '../../workbench-api';
import type { CashierAction } from './use-cashier';

type Props = { workspace: WorkspaceView; language: Language; bill: BillingAccount; act: CashierAction; busy: boolean };
export default function RegionalPanel({ workspace, language, bill, act, busy }: Props) {
  const text = words(language);
  const money = (value: number) => formatMinor(value, bill.currency);
  const [chosen, choose] = useState('');
  const [quote, setQuote] = useState<z.infer<typeof claimSchema> | null>(null);
  const [error, setError] = useState('');
  const query = useQuery({ queryKey: scopeKey(workspace, 'cashier', workspace.roleId, bill.encounterId, 'payer'), queryFn: ({ signal }) => api(`/api/his/encounters/${bill.encounterId}/payer`, projectionSchema, { signal }) });
  if (query.isError) return <p role="alert">{errorMessage(query.error, language)}</p>;
  if (!query.data) return <p role="status">{text('Loading regional summary…', '正在读取地区摘要…')}</p>;
  const { plans, claims, costs, group, progress, archive } = query.data;
  const planId = chosen || plans[0]?.id || '';
  const coveredIds = new Set(claims.flatMap(claim => claim.chargeIds));
  const chargeIds = bill.charges.filter(line => !line.netPaidMinor && !line.cancelled && !line.pending && !coveredIds.has(line.id) && (bill.settlement ? line.payerPending : line.netMinor > 0)).map(line => line.id);
  const run = (work: () => Promise<unknown>) => { setError(''); void work().catch(error => setError(error.message)); };
  return <Card><h3>{text('Patient benefits', '患者医保待遇')}</h3><Field label={text('Annual plan', '年度参保方案')}><Select value={planId} options={plans.map(plan => ({ value: plan.id, label: plan.name[language] }))} onValueChange={value => { if (value) { choose(value); setQuote(null); } }}/></Field>
    <Button disabled={busy || bill.pending || !chargeIds.length} onClick={() => run(async () => setQuote(claimSchema.parse(await act('benefit.preview', { planId, chargeIds }))))}>{text('Preview patient benefits', '预览待遇分摊')}</Button>
    {quote && <div><p>{quote.year} · {text('Fund / personal account / cash', '统筹／个人账户／现金')} · {[quote.allocations.fundMinor, quote.allocations.accountMinor, quote.allocations.cashMinor].map(money).join(' / ')}</p><ul>{quote.allocations.items.map(item => <li key={item.chargeId}>{bill.charges.find(line => line.id === item.chargeId)?.description} · {item.tier} · {money(item.cashMinor)}</li>)}</ul>
      <ConfirmActionButton confirmation={text('Confirm reviewed benefits', '确认复核的待遇分摊')} disabled={busy} onClick={() => run(async () => { await act('benefit.confirm', { planId: quote.planId, chargeIds: quote.allocations.items.map(item => item.chargeId), fingerprint: quote.fingerprint }); setQuote(null); })}>{text('Confirm patient benefits', '确认患者待遇')}</ConfirmActionButton></div>}
    {claims.map(claim => <p key={claim.id}>{claim.year} · {claim.planId} · {money(claim.fundMinor + claim.accountMinor)} {(!bill.settlement || bill.payerPending) && <ConfirmActionButton disabled={busy || bill.pending} confirmation={text('Cancel this original claim', '撤销所选原待遇记录')} onClick={() => run(() => act('benefit.cancel', { claimId: claim.id, annualVersion: claim.annualVersion }))}>{text('Cancel benefit allocation', '撤销待遇分摊')}</ConfirmActionButton>}</p>)}
    {bill.encounterClass === 'inpatient' && <><h3>{text('DRG payment reference', 'DRG 支付参考')}</h3><p>{text('For cost comparison only. Not a profit measure or clinical spending limit.', '仅供费用比较，非盈亏指标、非临床上限。')}</p><p>{text('Incurred / committed / remaining reserve / planned', '已发生／未记费承诺／预留余量／计划增量')} · {[costs.incurredMinor, costs.committedMinor, costs.reservedMinor, costs.plannedMinor].map(money).join(' / ')}</p>
      {costs.projectedMinor === null ? <p>{text('Incomplete prices', '价格资料不完整')}</p> : <p>{text('Projected total', '预计总收费')} · {money(costs.projectedMinor)}</p>}
      {group && costs.projectedMinor !== null ? <><Meter label={`${group.group} · ${money(group.referenceMinor)}`} value={Math.min(costs.projectedMinor, group.referenceMinor)} max={group.referenceMinor}/><Badge tone={progress === 'within' ? 'info' : 'warning'}>{progress === 'over' ? text('Above reference', '高于参考') : progress === 'near' ? text('Near reference', '接近参考') : text('Within reference', '参考范围内')}</Badge></> : <p>{text('Awaiting an unambiguous grouping', '待明确诊断及主操作后分组')}</p>}
      {archive.archived && <><p>{text('Archived settlement', '已归档核账')} · {archive.frozenMinor === null ? '—' : money(archive.frozenMinor)} · {archive.reconciled ? text('Financially reconciled', '资金已核对') : text('Needs review', '待核对')}</p><p>{archive.determination ? `${text('Payer determination', '医保办核定')} · ${archive.determination.group} · ${text('Reference', '参考额')} ${money(archive.determination.referenceMinor)} · ${text('Approved', '核定额')} ${money(archive.determination.approvedMinor)}` : text('Awaiting payer determination', '待医保办核定')}</p></>}</>}
    {error && <p role="alert">{error}</p>}</Card>;
}
