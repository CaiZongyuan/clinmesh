import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { encounterViewSchema } from '../../../packages/clinical-core';
import { medicationSchema } from '../../../packages/data-pack';
import { Button, Card } from '../../../packages/ui-kit';
import { RecordEditor } from '../../EncounterPanel';
import { createEncounterDrafts } from '../../encounter-drafts';
import { api, scopeKey, words } from '../../workbench-api';
import { LabTab } from '../lab/LabTab';
import { Choice, Entry, WardAction, namedOptions, selected, type StageProps } from './controls';

function Diagnoses(panel: StageProps) {
  const text = words(panel.language);
  const [chosen, setChosen] = useState('');
  const [poa, setPoa] = useState('Y');
  const [staged, setStaged] = useState(panel.ward.diagnoses);
  const entries = panel.workspace.diagnoses.map(entry => ({ value: JSON.stringify([entry.codeSystem, entry.code]), label: `${entry.code} · ${entry.display[panel.language]}`, entry }));
  const selectedCode = selected(chosen, entries);
  const candidate = entries.find(item => item.value === selectedCode)?.entry;
  const signed = staged.map((entry, index) => ({ ...entry, primary: index === 0, ordinal: index + 1 }));
  return <Card><h3>{text('Admission diagnoses', '住院诊断')}</h3>{panel.ward.diagnoses.map(row => <p key={row.ordinal}>{row.ordinal}. {row.code} · POA {row.poa}</p>)}
    {panel.allowed('ward.diagnose') && panel.ward.status === 'admitted' && <><Choice label={text('Diagnosis', '诊断条目')} options={entries} value={selectedCode} change={setChosen}/><Choice label={text('Present on admission', '入院病情 POA')} options={namedOptions(['Y', 'N', 'U', 'W', '1'])} value={poa} change={setPoa}/>
      <Button disabled={!candidate || staged.length >= 8 || staged.some(item => item.code === candidate.code && item.codeSystem === candidate.codeSystem)} onClick={() => { if (candidate) setStaged([...signed, { code: candidate.code, codeSystem: candidate.codeSystem, primary: !signed.length, ordinal: signed.length + 1, poa }]); }}>{text('Add diagnosis', '加入诊断')}</Button>
      {signed.map(row => <Button key={row.ordinal} onClick={() => setStaged(signed.filter(item => item.ordinal !== row.ordinal))}>{text('Remove', '移除')} {row.ordinal}. {row.code} · {row.poa}</Button>)}
      <WardAction panel={panel} name="diagnose" fields={{ diagnoses: signed }} disabled={!signed.length} label={text('Confirm ordered diagnoses and POA', '确认诊断排序与 POA')}/></>}
  </Card>;
}
export function OrderComposer(panel: StageProps & { proposed?: { itemId: string; executionId: string }; onSigned?(): void }) {
  const text = words(panel.language);
  const [choice, setChoice] = useState(panel.proposed?.itemId ?? ''), [frequency, setFrequency] = useState('ONCE'), [dose, setDose] = useState(''), [route, setRoute] = useState(''), [duration, setDuration] = useState('long');
  const [execution, setExecution] = useState(panel.proposed?.executionId ?? '');
  const eligible = panel.directory.items.filter(item => item.kind === 'medications' || item.definition.kind === 'nursing' && item.id !== panel.directory.bedDayId);
  const options = eligible.map(item => ({ value: item.id, label: item.display[panel.language] }));
  const itemId = selected(choice, options), item = eligible.find(item => item.id === itemId);
  const drug = item?.kind === 'medications' ? medicationSchema.parse(item.definition) : undefined;
  const routes = namedOptions(drug?.routeCodes.allowed ?? []);
  const surgeryOptions = [{ value: 'none', label: text('Independent order', '常规医嘱') }, ...panel.ward.surgeries.flatMap(surgery => surgery.stages.flatMap(stage => stage.executionId ? [{ value: stage.executionId, label: `${text('Postoperative', '术后')} · ${stage.executionId.slice(-6)}` }] : []))];
  const source = selected(execution, surgeryOptions);
  return <Card><h3>{text('Sign a ward order', '签发住院医嘱')}</h3><Choice label={text('Medication or nursing service', '药品或护理项目')} options={options} value={itemId} change={id => { setChoice(id); setDose(''); setRoute(''); }}/>
    {drug && <><Entry label={`${text('Dose', '单次剂量')} (${drug.inpatientDoseBasis.unit})`} value={dose} change={setDose}/><Choice label={text('Administration route', '给药途径')} options={routes} value={selected(route, routes)} change={setRoute}/></>}
    <Choice label={text('Order frequency', '医嘱频次')} options={namedOptions(['ONCE', ...panel.directory.frequencies, 'PRN'])} value={frequency} change={setFrequency}/>
    {frequency === 'PRN' && <Choice label={text('PRN duration', '按需医嘱期限')} options={namedOptions(['long', 'temporary'])} value={duration} change={setDuration}/>}
    {surgeryOptions.length > 1 && <Choice label={text('Supporting procedure', '关联术后执行')} options={surgeryOptions} value={source} change={setExecution}/>}
    <WardAction panel={panel} name="order.sign" label={text('Sign ward order', '签发医嘱')} disabled={!itemId || !!drug && !(Number(dose) > 0)} done={panel.onSigned} fields={{ itemId, frequency, duration: frequency === 'ONCE' ? 'temporary' : frequency === 'PRN' ? duration : 'long', ...(drug && { dose: Number(dose), route: selected(route, routes) }), ...(source !== 'none' && { surgeryExecutionId: source }) }}/>
  </Card>;
}
export function Orders(panel: StageProps) {
  const text = words(panel.language);
  const [reason, setReason] = useState('');
  const name = (id: string) => panel.directory.items.find(item => item.id === id)?.display[panel.language] ?? id;
  return <div className="clinical-panel"><Diagnoses {...panel}/>{panel.allowed('ward.order.sign') && panel.ward.status === 'admitted' && <OrderComposer {...panel}/>}
    <Card><h3>{text('Signed orders', '已签医嘱')}</h3>{panel.ward.orders.map(order => <div className="cm-actions" key={order.id}><strong>{name(order.itemId)}</strong><span>{order.frequency} · {order.duration} · {order.status}</span>
      {['admitted', 'discharge-pending'].includes(panel.ward.status) && <>{['signed', 'verified'].includes(order.status) && <WardAction panel={panel} name="order.request-stop" fields={{ orderIds: [order.id] }} label={`${text('Request stop', '申请停嘱')} · ${name(order.itemId)}`}/>}
        {order.frequency === 'PRN' && order.status === 'verified' && panel.allowed('ward.task.request-prn') && <><Entry label={`${text('PRN reason', '按需执行理由')} · ${name(order.itemId)}`} value={reason} change={setReason}/><WardAction panel={panel} name="task.request-prn" fields={{ orderId: order.id, reason }} disabled={!reason.trim()} label={`${text('Request PRN task', '发起按需执行')} · ${name(order.itemId)}`}/></>}</>}
    </div>)}{(['signed', 'stop-requested'] as const).map(status => { const ids = panel.ward.orders.filter(row => row.status === status).slice(0, 20).map(row => row.id); return ids.length ? <WardAction key={status} panel={panel} name={status === 'signed' ? 'order.verify' : 'order.verify-stop'} fields={{ orderIds: ids }} label={status === 'signed' ? text('Verify signed orders', '集中校对新医嘱') : text('Verify stop requests', '集中核停医嘱')}/> : null; })}</Card>
    <Card><h3>{text('Nursing and pharmacy tasks', '护理与药房执行单')}</h3>{panel.ward.tasks.map(task => { const order = panel.ward.orders.find(order => order.id === task.orderId)!; const caption = `${name(order.itemId)} · ${task.dueAt} · ${task.id.slice(-6)}`;
      const action = task.status === 'dispensed' ? 'administer' : task.status === 'pending' ? order.kind === 'medication' ? 'dispense' : 'complete' : undefined;
      return <div key={task.id}><span>{caption} · {task.status} {task.lots.map(lot => `${lot.lotNumber} × ${lot.quantity}`).join(', ')}</span>{action && <WardAction panel={panel} name={`task.${action}`} fields={{ taskIds: [task.id] }} label={`${action === 'dispense' ? text('Dispense batch', '批次发药') : action === 'administer' ? text('Confirm administration', '核实给药') : text('Complete nursing', '完成护理')} · ${caption}`}/>}</div>;
    })}</Card></div>;
}
export function Investigations(panel: StageProps) {
  const { workspace, ward, language } = panel;
  const text = words(language);
  const encounter = useQuery({ queryKey: scopeKey(workspace, ward.encounterId, 'clinical'), queryFn: ({ signal }) => api(`/api/his/encounters/${ward.encounterId}`, encounterViewSchema, { signal }) });
  const [drafts] = useState(createEncounterDrafts);
  const [note, setNote] = useState(false);
  return <div className="clinical-panel">{encounter.data && <>
    {panel.allowed('record.sign') && <><Button onClick={() => setNote(!note)}>{text('Admission assessment', '入院评估文书')}</Button>{note && <RecordEditor {...panel} submit={panel.run} encounter={encounter.data} drafts={drafts}/>}</>}
    {workspace.enabledModules.includes('mod-lab') && <LabTab {...panel} submit={panel.run} encounter={encounter.data}/>}</>}
    {ward.specimens.map(card => <Card key={card.tube}><h3>{card.tube}</h3><p>{card.orderIds.length} · {text('items awaiting dispatch', '项待送检')}</p><WardAction panel={panel} name="investigation.dispatch" fields={{ orderIds: card.orderIds }} label={`${text('Dispatch specimen', '核实送检')} · ${card.tube}`}/></Card>)}
  </div>;
}
