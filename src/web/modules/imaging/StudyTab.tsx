import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { studyViewSchema, type StudyKind, type StudyView } from '../../../packages/diagnostic-studies';
import { Badge, Card, ConfirmActionButton, Dialog, Field, Select } from '../../../packages/ui-kit';
import { api, errorMessage, scopeKey, words, type Intent, type WorkbenchPanelProps } from '../../workbench-api';
import { ReportReview } from './ReportReview';

type Props = WorkbenchPanelProps & { kind: StudyKind };
export const RadiologyTab = (props: WorkbenchPanelProps) => <StudyTab {...props} kind="imaging"/>;
export const PathologyTab = (props: WorkbenchPanelProps) => <StudyTab {...props} kind="pathology"/>;

function StudyTab(props: Props) {
  const { workspace, encounter, kind, language } = props;
  const allowed = workspace.operations.some(entry => entry.name === `${kind}.read`);
  const query = useQuery({ queryKey: scopeKey(workspace, encounter.id, kind, workspace.roleId, String(workspace.clockRevision)), enabled: allowed,
    queryFn: ({ signal }) => api(`/api/his/encounters/${encounter.id}/${kind}`, studyViewSchema, { signal }) });
  if (!allowed) return <p>{errorMessage(Error('ROLE_FORBIDDEN'), language)}</p>;
  if (query.isError) return <p role="alert">{errorMessage(query.error, language)}</p>;
  if (!query.data) return <p role="status">{words(language)('Loading requests…', '正在读取申请…')}</p>;
  return <StudyWorkspace key={`${workspace.epoch}:${encounter.id}:${workspace.roleId}`} {...props} data={query.data}/>;
}

function StudyWorkspace({ workspace, encounter, language, kind, submit, data }: Props & { data: StudyView }) {
  const text = words(language);
  const client = useQueryClient();
  const mutation = useMutation({ mutationFn: (intent: Intent) => submit(intent), onSettled: () => client.invalidateQueries({ queryKey: scopeKey(workspace, encounter.id) }) });
  const operations = new Set(workspace.operations.map(entry => entry.name));
  const active = encounter.status === 'active';
  const responsible = workspace.roleId === encounter.responsibleRole;
  const allowed = (action: string) => active && operations.has(`${kind}.${action}`);
  const send = (action: string, targetId: string, version: number, fields?: Intent['fields']) => mutation.mutate({ name: `${kind}.${action}`, targetId, version, fields });
  const [surgery, setSurgery] = useState('');
  const surgeries = encounter.priorHistory.surgeries ?? [];
  const surgeryLabel = (id: string) => surgeries.find(item => item.id === id)?.description[language];
  const statuses = { issued: text('Issued', '已开立'), accepted: text('Accepted', '已受理'), 'in-progress': text('In progress', '执行中'), reported: text('Reported', '已签发'), acknowledged: text('Acknowledged', '已阅'), cancelled: text('Cancelled', '已取消'), 'generation-failed': text('No authored result', '缺少预置结果') };
  return <div className="clinical-panel">{mutation.isError && <p role="alert">{errorMessage(mutation.error, language)}</p>}
    <Card><h3>{text('Request a study', '开立检查申请')}</h3>{kind === 'pathology' && (surgeries.length ? <Field label={text('Related prior surgery', '关联既往手术')}><Select value={surgery || null} onValueChange={value => setSurgery(value ?? '')} options={surgeries.map(item => ({ value: item.id, label: `${item.performedOn} · ${item.description[language]}` }))}/></Field> : <p>{text('No prior surgery is documented for this case.', '本病例没有可关联的既往手术。')}</p>)}
      <ul>{data.services.map(({ display, quote }) => { const name = display[language];
        const price = new Intl.NumberFormat(language, { style: 'currency', currency: quote.currencyCode, minimumFractionDigits: quote.currencyExponent, maximumFractionDigits: quote.currencyExponent }).format(quote.unitPriceMinor / 10 ** quote.currencyExponent);
        return <li key={quote.serviceId} className="diagnosis-row"><span>{name}<small>{price}</small></span>{responsible && allowed('issue') && <ConfirmActionButton disabled={mutation.isPending || (kind === 'pathology' && !surgery)} confirmation={`${text('Issue', '开立')} · ${name} · ${price}?`} onClick={() => send('issue', encounter.id, encounter.version, { item: quote, ...(kind === 'pathology' && { priorSurgeryId: surgery }) })}>{text('Issue', '开立')} · {name}</ConfirmActionButton>}</li>;
      })}</ul></Card>
    {data.orders.toReversed().map(order => {
      const name = data.services.find(item => item.quote.serviceId === order.serviceId)?.display[language] ?? order.serviceId;
      const latest = order.reports.at(-1);
      const action = (operation: string, label: string) => allowed(operation) && <ConfirmActionButton disabled={mutation.isPending} confirmation={`${label} · ${name}?`} onClick={() => send(operation, order.id, order.version)}>{label} · {name}</ConfirmActionButton>;
      return <Card key={order.id}><h3>{name} · {order.id.slice(-6)}</h3><Badge>{statuses[order.status]}</Badge> {order.issuedAt}
        {order.priorSurgeryId && <p>{surgeryLabel(order.priorSurgeryId)}</p>}{order.dueAt && <p>{text('Expected report time', '预计报告时间')} · {order.dueAt}</p>}
        <div className="cm-actions">{order.status === 'issued' && action('accept', text('Accept', '受理'))}{order.status === 'accepted' && action('start', text('Start study', '开始检查'))}
          {order.status === 'in-progress' && action('report-now', text('Report now', '立即出报告'))}
          {responsible && ['issued', 'accepted', 'in-progress', 'generation-failed'].includes(order.status) && action('cancel', text('Cancel request', '取消申请'))}</div>
        {order.reports.toReversed().map(report => { const title = `${name} · v${report.version}`;
          return <Dialog key={report.id} title={title} triggers={[`${text('Read', '阅读')} · ${title}`]} close={text('Close report', '关闭报告')}><ReportReview session={workspace} encounterId={encounter.id} kind={kind} report={report} language={language} busy={mutation.isPending}
            canView={responsible && operations.has(`${kind}.frames`)} acknowledge={report === latest && !report.acknowledged && responsible && allowed('acknowledge') ? mode => send('acknowledge', report.id, order.version, { reportVersion: report.version, mode }) : undefined}
            amend={report === latest && allowed('amend') ? () => send('amend', report.id, order.version, { reportVersion: report.version }) : undefined}/></Dialog>;
        })}</Card>;
    })}
  </div>;
}
