import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import { directorySchema, wardViewSchema } from '../../../packages/mod-inpatient';
import { Badge, Card, ConfirmActionButton, Tabs } from '../../../packages/ui-kit';
import { api, ApiError, errorMessage, scopeKey, words, type Intent, type WorkbenchStationProps } from '../../workbench-api';
import { Beds, Registration } from './admissions';
import { readWardSelection, rememberWardSelection } from '../../ward-selection';
import { Choice, Entry, type Commands } from './controls';

const Orders = lazy(() => import('./clinical').then(module => ({ default: module.Orders })));
const Investigations = lazy(() => import('./clinical').then(module => ({ default: module.Investigations })));
const Surgery = lazy(() => import('./SurgeryPanel'));
const Discharge = lazy(() => import('./closure').then(module => ({ default: module.Discharge })));
const Chart = lazy(() => import('./closure').then(module => ({ default: module.Chart })));
const phases = [['beds', 'Beds and transfers', '入科分床', Beds], ['orders', 'Diagnoses and orders', '诊断医嘱', Orders], ['investigations', 'Investigations', '检查检验', Investigations],
  ['surgery', 'Surgery', '手术', Surgery], ['discharge', 'Discharge', '出院', Discharge], ['chart', 'Medical record', '病案', Chart]] as const;

export default function WardStation(props: WorkbenchStationProps) {
  const { workspace, language } = props;
  const text = words(language);
  const client = useQueryClient();
  const root = scopeKey(workspace, 'inpatient');
  const directory = useQuery({ queryKey: [...root, 'directory', workspace.roleId], queryFn: ({ signal }) => api('/api/his/ward', directorySchema, { signal }) });
  const [chosen, setChosen] = useState(() => readWardSelection(workspace));
  const [stage, setStage] = useState('beds');
  const [rationale, setRationale] = useState('');
  const patients = (directory.data?.admissions ?? []).map(row => ({ value: row.encounterId, label: `${row.patient} · ${row.bed ?? row.ward} · ${row.status}` }));
  const encounterId = chosen.encounterId ?? (!chosen.caseId && patients.length === 1 ? patients[0]!.value : '');
  function choose(encounterId: string) {
    const selection = { ...chosen, encounterId };
    rememberWardSelection(workspace, selection);
    setChosen(selection);
  }
  const detail = useQuery({ queryKey: [...root, encounterId, workspace.roleId, workspace.clockRevision], enabled: Boolean(encounterId), queryFn: ({ signal }) => api(`/api/his/ward/${encounterId}`, wardViewSchema, { signal }) });
  const mutation = useMutation({ mutationFn: props.submit, async onSettled(_, __, intent) {
    await Promise.all([client.invalidateQueries({ queryKey: root }), client.invalidateQueries({ queryKey: scopeKey(workspace, intent.encounterId ?? encounterId) }), client.invalidateQueries({ queryKey: scopeKey(workspace, 'encounters'), exact: true })]);
  } });
  const error = directory.error ?? detail.error ?? mutation.error;
  const alert = mutation.error instanceof ApiError && mutation.error.message === 'CLINICAL_QUALITY_ALERT' && typeof mutation.error.details?.ruleCodes === 'string' && mutation.variables?.targetId === encounterId ? mutation.error.details.ruleCodes.split(',') : undefined;
  if (!directory.data) return <p role={error ? 'alert' : 'status'}>{error ? errorMessage(error, language) : text('Loading ward…', '正在读取病区…')}</p>;
  const commands: Commands = { ...props, directory: directory.data, busy: mutation.isPending, allowed: name => workspace.operations.some(op => op.name === name), run: (intent: Intent) => mutation.mutateAsync(intent) };
  const ward = detail.data;
  return <section className="clinical-panel"><h1>{text('Inpatient ward', '住院工作台')}</h1>
    {error && <p role="alert">{errorMessage(error, language)}</p>}
    {alert && mutation.variables && <Card><h2>{text('Clinical pathway review', '临床路径警示复核')}</h2><p>{alert.join(' · ')}</p><Entry label={text('Specialist rationale', '专科判断的医学理由')} value={rationale} change={setRationale}/>
      <ConfirmActionButton confirmation={text('Apply the reviewed exception and sign?', '按已审核的医学理由签发？')} disabled={mutation.isPending || rationale.trim().length < 4} onClick={() => {
        const intent = mutation.variables!;
        mutation.mutate({ ...intent, fields: { ...intent.fields, clinicalOverride: { reasonCode: 'specialist-judgment', note: rationale, ruleCodes: alert } } }, { onSuccess: () => setRationale('') });
      }}>{text('Approve pathway exception', '确认临床路径偏离')}</ConfirmActionButton></Card>}
    <Registration {...commands} caseId={chosen.caseId} choose={choose}/>
    {patients.length > 0 && <Choice label={text('Ward patient', '住院患者')} value={encounterId} options={patients} change={choose}/>}
    {ward && <><Card className="cm-actions"><strong>{ward.patient}</strong><span>{ward.ward} · {ward.bed ?? text('Unassigned', '未占床')}</span><Badge>{ward.status}</Badge><span>{ward.clinical} · {ward.finance.locked ? text('Settled', '已结算') : text('Open account', '账户开放')} · {ward.chart.state}</span></Card>
      <Tabs label={text('Inpatient phases', '住院阶段')} value={stage} onValueChange={value => { if (value) setStage(value); }} items={phases.map(([value, en, zh, Panel]) => ({ value, label: text(en, zh), content: stage === value ? <Suspense fallback={<p role="status">{text('Loading…', '正在加载…')}</p>}><Panel key={`${workspace.roleId}:${encounterId}`} {...commands} ward={ward}/></Suspense> : null }))}/></>}
  </section>;
}
