import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import { encounterViewSchema } from '../../../packages/clinical-core';
import { RecordEditor } from '../../EncounterPanel';
import { createEncounterDrafts } from '../../encounter-drafts';
import { Badge, Card } from '../../../packages/ui-kit';
import { api, scopeKey, words } from '../../workbench-api';
import { Action, Entry, WardAction, type StageProps } from './controls';

const Billing = lazy(() => import('../billing/BillingPanel'));
export function Discharge(panel: StageProps) {
  const { workspace, ward, language } = panel;
  const text = words(language), [reason, setReason] = useState('');
  const cashier = panel.allowed('billing.account');
  const encounter = useQuery({ queryKey: scopeKey(workspace, ward.encounterId, 'clinical'), enabled: cashier, queryFn: ({ signal }) => api(`/api/his/encounters/${ward.encounterId}`, encounterViewSchema, { signal }) });
  return <Card><h3>{text('Discharge and settlement', '出院与结算')}</h3><p>{ward.status} · {ward.bed} · {ward.finance.locked ? text('First settlement frozen', '已冻结首次结算') : text('Open account', '账户开放')}</p>
    {ward.status === 'admitted' && <WardAction panel={panel} name="discharge.issue" label={text('Issue discharge order', '签发出院医嘱')}/>}
    {ward.status === 'discharge-pending' && <WardAction panel={panel} name="discharge.depart" label={text('Confirm physical departure', '办理实际出区')}/>}
    {['departed', 'discharge-pending'].includes(ward.status) && !ward.finance.locked && panel.allowed('ward.discharge.recall') && <><Entry label={text('Recall reason', '召回原因')} value={reason} change={setReason}/><WardAction panel={panel} name="discharge.recall" fields={{ reason }} disabled={!reason.trim()} label={text('Recall to ward', '召回病区')}/></>}
    {ward.status === 'departed' && <WardAction panel={panel} name="discharge.clear" disabled={!ward.finance.canClearBed} label={text('Release occupied bed', '清床释放床位')}/>}
    {cashier && encounter.data && <Suspense fallback={<p>{text('Loading account…', '正在读取账本…')}</p>}><Billing {...panel} encounter={encounter.data}/></Suspense>}
  </Card>;
}
export function Chart(panel: StageProps) {
  const { ward, language } = panel, text = words(language);
  const [drafts] = useState(createEncounterDrafts);
  const completing = ward.status === 'cleared' && ward.clinical === 'active' && panel.allowed('encounter.complete');
  const clinical = useQuery({ queryKey: scopeKey(panel.workspace, ward.encounterId, 'clinical'), enabled: completing, queryFn: ({ signal }) => api(`/api/his/encounters/${ward.encounterId}`, encounterViewSchema, { signal }) });
  const last = ward.chart.revisions.at(-1);
  const [summary, setSummary] = useState(last?.fields.summary ?? ''), [disposition, setDisposition] = useState(last?.fields.disposition ?? ''), [followUp, setFollowUp] = useState(last?.fields.followUp ?? ''), [coding, setCoding] = useState('');
  return <Card><h3>{text('Medical record front page', '病案首页')}</h3><Badge>{ward.chart.state} · v{ward.chart.revision}</Badge>
    {completing && clinical.data && <><RecordEditor {...panel} encounter={clinical.data} submit={panel.run} drafts={drafts}/><ul>{clinical.data.completion.checks.map(check => <li key={check.id}>{check.passed ? '✓' : '○'} {check.label[language]}</li>)}</ul><Action commands={panel} name="encounter.complete" targetId={ward.encounterId} version={clinical.data.version} disabled={!clinical.data.completion.ready} label={text('Complete clinical encounter', '正式临床完诊')} confirmation={`${text('Complete clinical encounter', '正式临床完诊')} · ${ward.patient} · ${ward.ward}`}/></>}
    {ward.chart.revisions.map(revision => <p key={revision.id}>v{revision.revision} · {revision.fields.summary} · {revision.fields.disposition} · {revision.fields.followUp} · {revision.submittedBy}</p>)}
    {ward.status === 'cleared' && ward.chart.state !== 'archived' && <>{panel.allowed('ward.chart.submit') && <><Entry label={text('Hospital course', '住院经过')} value={summary} change={setSummary}/><Entry label={text('Disposition', '出院去向')} value={disposition} change={setDisposition}/><Entry label={text('Follow-up plan', '随访计划')} value={followUp} change={setFollowUp}/><WardAction panel={panel} name="chart.submit" fields={{ summary, disposition, followUp }} disabled={!summary.trim() || !disposition.trim() || !followUp.trim()} label={text('Submit revised front page', '提交首页修订')}/></>}
      {ward.chart.state === 'submitted' && panel.allowed('ward.chart.review') && <><Entry label={text('Coding review', '编码审核意见')} value={coding} change={setCoding}/><WardAction panel={panel} name="chart.review" disabled={!coding.trim()} fields={{ revision: ward.chart.revision, coding }} label={text('Approve coding review', '确认编码审核')}/></>}
      {ward.chart.state === 'reviewed' && <WardAction panel={panel} name="chart.archive" disabled={ward.clinical !== 'completed'} fields={{ revision: ward.chart.revision }} label={text('Archive immutable record', '归档不可变病案')}/>}</>}
  </Card>;
}
