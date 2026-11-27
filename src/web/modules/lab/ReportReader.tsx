import { useState } from 'react';
import type { LabOrder } from '../../../packages/mod-lab';
import { Badge, Button, Card, ConfirmActionButton, Table } from '../../../packages/ui-kit';
import { words, type Intent, type Language } from '../../workbench-api';

type Report = LabOrder['reports'][number];
type Props = { orders: LabOrder[]; name(order: LabOrder): string; language: Language; busy: boolean; canReview: boolean; canAmend: boolean; send(intents: Intent[]): void };
function ReportRevision({ report, language }: { report: Report; language: Language }) {
  const text = words(language);
  const meanings = { normal: text('Normal', '正常'), low: text('Low', '偏低'), high: text('High', '偏高'), abnormal: text('Abnormal', '异常') };
  return <Card><h3>{text('Report version', '报告版本')} {report.version}</h3>
    <p>{report.signedAt} · {report.acknowledged ? `${text('Acknowledged by', '已阅岗位')} ${report.acknowledged.role} · ${report.acknowledged.at}` : text('Awaiting acknowledgement', '待确认已阅')}</p>
    {report.amendmentReason && <p>{text('Reason for correction', '更正原因')} · {report.amendmentReason[language]}</p>}
    <p>{report.summary[language]}</p>
    {report.observations.length > 0 && <Table caption={text('Findings', '检查结果')}><thead><tr><th>{text('Measurement', '项目')}</th><th>{text('Result', '结果')}</th><th>{text('Interpretation', '判读')}</th></tr></thead>
      <tbody>{report.observations.map(item => <tr key={`${item.codeSystem}|${item.code}`}><th scope="row">{item.display[language]}</th><td>{item.value} {item.unit}</td><td>{meanings[item.interpretation]} {item.critical && <Badge tone="destructive">{text('Critical', '危急值')}</Badge>}</td></tr>)}</tbody></Table>}
  </Card>;
}

export function ReportReader({ orders, name, language, busy, canReview, canAmend, send }: Props) {
  const text = words(language);
  const [selectedId, setSelectedId] = useState('');
  const [opened, setOpened] = useState<string[]>([]);
  const released = orders.flatMap(order => {
    const latest = order.reports.at(-1);
    return latest ? [{ order, latest }] : [];
  });
  const selected = released.find(item => item.latest.id === selectedId);
  const reviewable = released.filter(({ order, latest }) => order.status === 'reported' && opened.includes(latest.id));
  const reviewIntent = (action: string, order: LabOrder, latest: Report) => ({ name: `lab.${action}`, version: order.version, targetId: latest.id, fields: { reportVersion: latest.version } });
  return <div className="clinical-panel"><div className="cm-actions">{released.map(({ order, latest }) => <Button key={latest.id} aria-pressed={selectedId === latest.id} onClick={() => {
    setSelectedId(latest.id); setOpened(prior => prior.includes(latest.id) ? prior : [...prior, latest.id]);
  }}>{text('Read', '阅读')} · {name(order)} · {order.id.slice(-6)} · v{latest.version}</Button>)}</div>
    {selected && <section><h2>{name(selected.order)}</h2><div className="catalog-columns">{selected.order.reports.toReversed().map(report => <ReportRevision key={report.id} report={report} language={language}/>)}</div>
      {canAmend && <ConfirmActionButton confirmation={text('Publish the next authored correction?', '签发下一版已编写的更正报告？')} disabled={busy} onClick={() => send([reviewIntent('amend', selected.order, selected.latest)])}>{text('Publish correction', '签发更正报告')}</ConfirmActionButton>}</section>}
    {canReview && <ConfirmActionButton confirmation={text('Acknowledge the opened report versions?', '确认已阅本次打开的报告版本？')} disabled={busy || !reviewable.length} onClick={() => send(reviewable.map(({ order, latest }) => reviewIntent('acknowledge', order, latest)))}>{text('Acknowledge opened reports', '集中确认已阅')}</ConfirmActionButton>}
  </div>;
}
