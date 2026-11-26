import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import { accountSchema, cashierQueueSchema, formatMinor, type BillingAccount } from '../../../packages/mod-billing';
import { z } from 'zod';
import { ConfirmActionButton, Field, Select } from '../../../packages/ui-kit';
import type { WorkbenchPanelProps } from '../../EncounterPanel';
import { api, ApiError, errorMessage, scopeKey, words } from '../../workbench-api';
import { CashierDesk } from './CashierDesk';
import { useCashier } from './use-cashier';

const RegionalPanel = lazy(() => import('./RegionalPanel'));
function AccountActions({ workspace, language, bill }: Pick<WorkbenchPanelProps, 'workspace' | 'language'> & { bill: BillingAccount }) {
  const command = useCashier(workspace, bill.encounterId, bill.version);
  const text = words(language);
  const region = workspace.operations.some(op => op.name === 'drg.summary');
  return <>{command.error && <p role="alert">{errorMessage(command.error, language)}</p>}{command.saved && !command.busy && <ConfirmActionButton confirmation={text('Check the original request', '核对原请求回执')} onClick={command.retry}>{text('Resume interrupted request', '恢复中断请求')}</ConfirmActionButton>}
    <CashierDesk bill={bill} language={language} busy={command.busy || Boolean(command.saved)} act={command.act}>{region && <Suspense fallback={<p role="status">{text('Loading benefit rules…', '正在加载待遇规则…')}</p>}><RegionalPanel workspace={workspace} language={language} bill={bill} act={command.act} busy={command.busy || Boolean(command.saved)}/></Suspense>}</CashierDesk></>;
}
function Queue({ workspace, encounter, language }: WorkbenchPanelProps) {
  const text = words(language);
  const [mode, setMode] = useState(encounter.encounterClass);
  const [chosen, setChosen] = useState(encounter.id);
  const queue = useQuery({ queryKey: scopeKey(workspace, 'cashier', workspace.roleId, 'queue'), queryFn: ({ signal }) => api('/api/his/billing/queue', cashierQueueSchema, { signal }) });
  const options = queue.data?.filter(item => item.encounterClass === mode) ?? [];
  const id = options.find(item => item.encounterId === chosen)?.encounterId ?? options[0]?.encounterId ?? '';
  const result = useQuery({ queryKey: scopeKey(workspace, 'cashier', workspace.roleId, id, 'account'), enabled: Boolean(id), queryFn: ({ signal }) => api(`/api/his/encounters/${id}/billing`, accountSchema, { signal }) });
  const issue = result.error instanceof ApiError && result.error.message === 'BILLING_CURRENCY_MISMATCH' ? z.object({ amountMinor: z.int(), currencyCode: z.string().length(3), minorUnitExponent: z.int().min(0).max(9) }).safeParse(result.error.details).data : undefined;
  return <div className="clinical-panel"><Field label={text('Cashier queue', '收费队列')}><Select value={mode} options={[{ value: 'outpatient', label: text('Outpatient', '门诊') }, { value: 'inpatient', label: text('Inpatient', '住院') }]} onValueChange={value => { if (value) setMode(value); }}/></Field>
    <Field label={text('Encounter account', '就诊账本')}><Select value={id} options={options.map(item => ({ value: item.encounterId, label: `${item.name} · ${item.encounterId.slice(-6)}` }))} onValueChange={value => { if (value) setChosen(value); }}/></Field>
    {issue ? <p role="alert">{text('Currency review required. Original amount', '币种或精度待核，原账金额')} {formatMinor(issue.amountMinor, { code: issue.currencyCode, minorUnitExponent: issue.minorUnitExponent })}</p> : queue.isError || result.isError ? <p role="alert">{errorMessage((queue.error ?? result.error)!, language)}</p> : result.data ? <AccountActions key={`${workspace.roleId}:${id}`} workspace={workspace} language={language} bill={result.data}/> : <p role="status">{queue.isPending || id ? text('Loading account…', '正在读取账本…') : text('No encounters in this queue.', '队列中暂无就诊。')}</p>}
  </div>;
}
export default function BillingPanel(props: WorkbenchPanelProps) {
  if (!props.workspace.operations.some(op => op.name === 'billing.account')) return <p>{words(props.language)('Switch to a cashier role to open the ledger.', '切换至收费岗位可查看账本。')}</p>;
  return <Queue key={`${props.workspace.epoch}:${props.workspace.roleId}`} {...props}/>;
}
