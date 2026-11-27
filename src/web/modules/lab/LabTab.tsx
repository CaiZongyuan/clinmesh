import { formatMinor } from '../../../packages/mod-billing';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { issueReceipt, labViewSchema, type LabOrder, type LabView } from '../../../packages/mod-lab';
import { Badge, Button, Card, ConfirmActionButton, Dialog } from '../../../packages/ui-kit';
import type { WorkbenchPanelProps } from '../../EncounterPanel';
import { api, errorMessage, scopeKey, words, type Intent } from '../../workbench-api';
import { ReportReader } from './ReportReader';

export function LabTab(props: WorkbenchPanelProps) {
  const { workspace, encounter, language } = props;
  const labKey = scopeKey(workspace, encounter.id, 'lab', workspace.roleId, String(workspace.clockRevision));
  const query = useQuery({ queryKey: labKey, queryFn: ({ signal }) => api(`/api/his/encounters/${encounter.id}/lab`, labViewSchema, { signal }) });
  if (query.isError) return <p role="alert">{errorMessage(query.error, language)}</p>;
  if (!query.data) return <p role="status">{words(language)('Loading investigations…', '正在读取检验检查…')}</p>;
  return <LabWorkspace key={`${workspace.epoch}:${encounter.id}:${workspace.roleId}`} {...props} data={query.data}/>;
}

function LabWorkspace({ workspace, encounter, language, submit, data }: WorkbenchPanelProps & { data: LabView }) {
  const text = words(language);
  const client = useQueryClient();
  const allowed = (name: string) => encounter.status === 'active' && workspace.operations.some(entry => entry.name === `lab.${name}`);
  const responsible = workspace.roleId === encounter.responsibleRole;
  const canSave = responsible && allowed('save-draft');
  const services = new Map(data.services.map(service => [service.id, service]));
  const serviceName = (id: string) => services.get(id)?.display[language] ?? id;
  const orderName = (order: LabOrder) => serviceName(order.serviceId);
  const mutation = useMutation({
    mutationFn: async (commands: Intent[]) => {
      const errors: string[] = [];
      for (const command of commands) {
        try {
          const response = await submit(command);
          if (command.name === 'lab.issue') for (const result of issueReceipt.parse(response).results) {
            if ('error' in result) errors.push(`${serviceName(result.serviceId)} · ${errorMessage(Error(result.error), language)}`);
          }
        } catch (error) { errors.push(errorMessage(error instanceof Error ? error : Error('REQUEST_FAILED'), language)); }
      }
      return errors;
    },
    onSettled: () => client.invalidateQueries({ queryKey: scopeKey(workspace, encounter.id) }),
  });
  const ids = data.draft.items.map(item => item.serviceId);
  const edit = (serviceIds: string[]) => mutation.mutate([{ name: 'lab.save-draft', targetId: encounter.id, version: data.draft.version, fields: { serviceIds } }]);
  const money = (amount: number, code: string, minorUnitExponent: number) => formatMinor(amount, { code, minorUnitExponent });
  const statuses: Record<LabOrder['status'], string> = { issued: text('Issued', '已开立'), accepted: text('Accepted', '已受理'), 'in-progress': text('In progress', '执行中'), reported: text('Reported', '待阅报告'), acknowledged: text('Acknowledged', '已确认审阅'), cancelled: text('Cancelled', '已取消'), 'generation-failed': text('Report generation failed', '报告生成失败') };
  const action = (order: LabOrder, operation: string, label: string) => allowed(operation) && <ConfirmActionButton disabled={mutation.isPending} confirmation={`${label} · ${orderName(order)}?`} onClick={() => mutation.mutate([{ name: `lab.${operation}`, targetId: order.id, version: order.version }])}>{label} · {orderName(order)} · {order.id.slice(-6)}</ConfirmActionButton>;
  return <div className="clinical-panel" data-assistant-field="investigation:draft" data-assistant-list>
    {mutation.data?.map(message => <p key={message} role="alert">{message}</p>)}
    <div className="catalog-columns">{(['lab', 'examination'] as const).map(kind => <Card key={kind}><h3>{kind === 'lab' ? text('Laboratory', '实验室检验') : text('Functional examinations', '功能检查')}</h3>
      <ul>{data.services.filter(service => service.kind === kind).map(service => <li key={service.id} className="diagnosis-row"><span>{service.display[language]}<small>{service.code} · {money(service.unitPriceMinor, service.currencyCode, service.currencyExponent)}</small></span>
        {canSave && <Button aria-label={`${text('Add', '添加')} · ${service.display[language]}`} disabled={mutation.isPending || ids.includes(service.id) || ids.length >= 20} onClick={() => edit([...ids, service.id])}>{text('Add', '添加')}</Button>}</li>)}</ul></Card>)}</div>
    <Card><h3>{text('Saved order list', '待开清单')} · {ids.length}</h3>
      <ul>{data.draft.items.map(item => <li key={item.serviceId} className="diagnosis-row"><span>{serviceName(item.serviceId)}<small>{money(item.unitPriceMinor, item.currencyCode, item.currencyExponent)} · v{item.catalogVersion}</small></span>
        {canSave && <Button aria-label={`${text('Remove', '移除')} · ${serviceName(item.serviceId)}`} disabled={mutation.isPending} onClick={() => edit(ids.filter(id => id !== item.serviceId))}>{text('Remove', '移除')}</Button>}</li>)}</ul>
      {responsible && allowed('issue') && <ConfirmActionButton confirmation={text('Issue the saved investigations at the displayed prices?', '按列示价格正式开立待开项目？')} disabled={mutation.isPending || !ids.length} onClick={() => mutation.mutate([{ name: 'lab.issue', targetId: encounter.id, version: data.draft.version, fields: { items: data.draft.items } }])}>{text('Issue saved orders', '批量确认开立')}</ConfirmActionButton>}</Card>
    <Card><h3>{text('Investigation requests', '检验检查申请')} · {data.orders.length}</h3>
      {data.orders.toReversed().map(order => <div key={order.id} className="clinical-panel"><strong>{orderName(order)} · {order.id.slice(-6)}</strong><div><Badge tone={order.status === 'generation-failed' ? 'destructive' : order.status === 'acknowledged' ? 'success' : 'info'}>{order.status === 'reported' && order.reports.some(report => report.acknowledged) ? text('Revised report awaiting review', '修订待重阅') : statuses[order.status]}</Badge> {order.issuedAt}</div>
        {order.dueAt && <p>{text('Expected report time', '预计报告时间')} · {order.dueAt}</p>}
        <div className="cm-actions">{order.status === 'issued' && action(order, 'accept', text('Accept', '受理'))}{order.status === 'accepted' && action(order, 'start', text('Start test', '开始检查'))}
          {order.status === 'in-progress' && action(order, 'report-now', text('Report now', '立即出报告'))}
          {responsible && ['issued', 'accepted', 'in-progress', 'generation-failed'].includes(order.status) && action(order, 'cancel', text('Cancel request', '取消申请'))}</div></div>)}
      {data.orders.some(order => order.reports.length) && <Dialog title={text('Investigation reports', '连续报告阅读')} triggers={[text('Read reports', '阅读报告')]} close={text('Close reports', '关闭报告')}>
        <ReportReader orders={data.orders} name={orderName} language={language} busy={mutation.isPending} canReview={responsible && allowed('acknowledge')} canAmend={allowed('amend')} send={mutation.mutate}/>
      </Dialog>}</Card>
  </div>;
}
