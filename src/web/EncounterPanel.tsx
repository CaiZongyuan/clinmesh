import { useQuery } from '@tanstack/react-query';
import { useState, type ComponentType } from 'react';
import { z } from 'zod';
import { debriefSchema, type EncounterView, type WorkspaceView } from '../packages/clinical-core';
import { Badge, Button, Card, ConfirmActionButton, DetailDrawer, Dialog, Field, Select, Tabs, Textarea } from '../packages/ui-kit';
import { api, errorMessage, scopeKey, words, type Intent, type Language } from './workbench-api';
import { createEncounterDrafts, type EncounterDrafts } from './encounter-drafts';

export type WorkbenchPanelProps = { encounter: EncounterView; workspace: WorkspaceView; language: Language; submit(intent: Intent): Promise<unknown> };
export type WorkbenchPanels = Readonly<Record<string, ComponentType<WorkbenchPanelProps>>>;
type Props = WorkbenchPanelProps & { busy: boolean; panels?: WorkbenchPanels };
type Diagnosis = EncounterView['diagnoses'][number];
type Editor = Props & { drafts: EncounterDrafts };

function run(promise: Promise<unknown>, saved?: () => void) { void promise.then(saved, () => {}); }
const allowed = (props: Props, operation: string) => props.encounter.status === 'active' && props.encounter.responsibleRole === props.workspace.roleId && props.workspace.operations.some(item => item.name === operation);
const command = (props: Props, name: string, fields?: Record<string, unknown>) => props.submit({ name, targetId: props.encounter.id, version: props.encounter.version, fields });

function Consultation(props: Props) {
  const text = words(props.language);
  const [message, setMessage] = useState('');
  const { encounter } = props;
  const canAsk = allowed(props, 'consultation.question') && !encounter.replyPending;
  return <div className="clinical-panel"><ol className="consultation-turns">{encounter.turns.map(turn => <li key={turn.id}>
    <strong>{turn.speaker === 'patient' ? text('Patient', '患者') : text('Clinician', '医生')}</strong><small> · {turn.virtualAt.slice(11, 16)} UTC · {turn.channel}</small><p>{turn.content}</p>
  </li>)}</ol>
    {encounter.status === 'active' && <><Field label={text('Question for the patient', '向患者提问')}><Textarea value={message} disabled={!canAsk} onValueChange={setMessage}/></Field>
      <Button disabled={props.busy || !canAsk || !message.trim()} onClick={() => run(command(props, 'consultation.question', { content: message, channel: 'text' }), () => setMessage(''))}>{text('Send question', '发送问题')}</Button>
      {encounter.replyPending && <p role="status">{text('Awaiting the patient reply. Record and diagnosis drafts remain available.', '正在等候患者回复，可继续编辑病历和诊断草稿。')}</p>}</>}
  </div>;
}

function RecordEditor(props: Editor) {
  const { encounter, drafts, language } = props;
  const text = words(language);
  const note = drafts(state => state.note);
  const fields = { ...encounter.fields, ...note?.fields };
  const editable = allowed(props, 'record.draft');
  function save() {
    if (!note) return;
    const version = Math.max(encounter.version, drafts.getState().acknowledgedVersion);
    run(props.submit({ name: 'record.draft', targetId: encounter.id, version, fields: { fields, expectedDraftVersion: Math.max(note.version, encounter.draftVersion) } }).then(result => {
      const ack = z.object({ version: z.int(), draftVersion: z.int() }).parse(result);
      drafts.setState(current => {
        const remaining = Object.fromEntries(Object.entries(current.note?.fields ?? {}).filter(([key, value]) => note.fields[key] !== value));
        return { acknowledgedVersion: Math.max(current.acknowledgedVersion, ack.version), note: Object.keys(remaining).length ? { fields: remaining, version: ack.draftVersion } : undefined };
      });
    }));
  }
  return <div className="clinical-panel"><div className="record-fields">{encounter.template.map(field => <Field key={field.id} label={field.title[language]}>
    <Textarea required={field.required} readOnly={!editable} value={fields[field.id] ?? ''} onValueChange={value => drafts.setState({ note: { fields: { ...note?.fields, [field.id]: value }, version: note?.version ?? encounter.draftVersion } })}/>
  </Field>)}</div>
    {encounter.status === 'active' && <div className="cm-actions">
      <Button disabled={props.busy || !editable || !note} onClick={save}>{text('Save record draft', '保存病历草稿')}</Button>
      <ConfirmActionButton disabled={props.busy || !allowed(props, 'record.sign') || !!note || !encounter.draftVersion} confirmation={text('Sign this saved clinical record?', '签署当前已保存的病历？')} onClick={() => run(command(props, 'record.sign', { expectedDraftVersion: encounter.draftVersion }))}>{text('Sign record', '签署病历')}</ConfirmActionButton></div>}
    {encounter.recordRevisions.length > 0 && <Dialog title={text('Signed records', '已签病历')} triggers={[text('View signed revisions', '查看病历修订')]} close={text('Close record history', '关闭病历修订')}>
      {encounter.recordRevisions.map(item => <section key={item.id}><h3>{text('Revision', '修订')} {item.revision} · {item.signedBy}</h3><dl>{encounter.template.map(field => <div key={field.id}><dt>{field.title[language]}</dt><dd>{item.fields[field.id] || '—'}</dd></div>)}</dl></section>)}
    </Dialog>}
  </div>;
}

const codingKey = (item: { codeSystem: string; code: string }) => JSON.stringify([item.codeSystem, item.code]);
function DiagnosisEditor(props: Editor) {
  const { encounter, workspace, drafts, language } = props;
  const text = words(language);
  const draft = drafts(state => state.diagnoses);
  const selected = draft ?? encounter.diagnoses;
  function save() {
    if (!draft) return;
    const version = Math.max(encounter.version, drafts.getState().acknowledgedVersion);
    run(props.submit({ name: 'diagnosis.draft', targetId: encounter.id, version, fields: { diagnoses: draft } }).then(result => {
      const ack = z.object({ version: z.int() }).parse(result);
      drafts.setState(current => ({ acknowledgedVersion: Math.max(current.acknowledgedVersion, ack.version), diagnoses: current.diagnoses === draft ? undefined : current.diagnoses }));
    }));
  }
  const [candidate, setCandidate] = useState('');
  const editable = allowed(props, 'diagnosis.draft');
  const label = (item: Diagnosis) => `${item.code} · ${workspace.diagnoses.find(option => codingKey(option) === codingKey(item))?.display[language] ?? item.codeSystem}`;
  const available = workspace.diagnoses.filter(item => !selected.some(added => codingKey(added) === codingKey(item)));
  const add = () => {
    const item = available.find(option => codingKey(option) === candidate);
    if (!item || selected.length >= 8) return;
    drafts.setState({ diagnoses: [...selected, { codeSystem: item.codeSystem, code: item.code, primary: !selected.length }] }); setCandidate('');
  };
  return <div className="clinical-panel">
    {encounter.status === 'active' && <div className="cm-actions"><Field label={text('Diagnosis catalog', '诊断目录')}><Select value={candidate || null} disabled={!editable} options={available.map(item => ({ value: codingKey(item), label: `${item.code} · ${item.display[language]}` }))} onValueChange={value => setCandidate(value ?? '')}/></Field>
      <Button disabled={!editable || !candidate || selected.length >= 8} onClick={add}>{text('Add diagnosis', '添加诊断')}</Button></div>}
    <ul>{selected.map(item => <li key={codingKey(item)} className="diagnosis-row"><span>{label(item)}<small>{item.codeSystem}</small></span>
      {item.primary ? <Badge tone="info">{text('Primary', '主诊断')}</Badge> : editable && <Button onClick={() => drafts.setState({ diagnoses: selected.map(other => ({ ...other, primary: other === item })) })}>{text('Set primary', '设为主诊断')} · {item.code}</Button>}
      {editable && <Button onClick={() => drafts.setState({ diagnoses: selected.filter(other => other !== item) })}>{text('Remove', '移除')} · {item.code}</Button>}</li>)}</ul>
    {encounter.status === 'active' && <div className="cm-actions"><Button disabled={props.busy || !editable || !draft?.length} onClick={save}>{text('Save diagnosis draft', '保存诊断草稿')}</Button>
      <ConfirmActionButton disabled={props.busy || !allowed(props, 'diagnosis.confirm') || !!draft || !selected.length} confirmation={text('Confirm these diagnoses?', '正式确认当前诊断？')} onClick={() => run(command(props, 'diagnosis.confirm'))}>{text('Confirm diagnoses', '确认诊断')}</ConfirmActionButton></div>}
    {encounter.diagnosisRevisions.map(item => <p key={item.id}>{text('Confirmed revision', '确诊修订')} {item.revision} · {item.signedBy} · {item.diagnoses.map(entry => `${entry.primary ? '★ ' : ''}${label(entry)}`).join(' / ')}</p>)}
  </div>;
}

function PatientHeader({ encounter, language }: Pick<Props, 'encounter' | 'language'>) {
  const text = words(language);
  const { patient, triageVitals: vitals, priorHistory } = encounter;
  const sex = { female: text('Female', '女'), male: text('Male', '男'), other: text('Other', '其他'), unknown: text('Unknown', '未知') }[patient.sex];
  const allergies = priorHistory.allergies.status === 'confirmed' ? priorHistory.allergies.items.map(item => `${item.groupCode} · ${item.reaction[language]}`).join(' / ') : priorHistory.allergies.status === 'none-known' ? text('No known allergies', '无已知过敏') : text('Allergies not yet asked', '尚未询问过敏史');
  return <header className="patient-heading"><div className="cm-section-heading"><h1>{patient.name}</h1><Badge tone={encounter.status === 'completed' ? 'success' : 'info'}>{encounter.status === 'completed' ? text('Completed', '已完诊') : text('In care', '诊疗中')}</Badge></div>
    <p>{sex} · {encounter.age} {text('years', '岁')} · {patient.identifiers.map(item => `${item.issuer} / ${item.value}`).join(' · ')}</p>
    <p><Badge tone={priorHistory.allergies.status === 'confirmed' ? 'warning' : 'neutral'}>{allergies}</Badge></p>
    <dl className="vital-strip">{[[text('Temperature', '体温'), `${vitals.temperatureC} °C`], [text('Pulse', '心率'), `${vitals.heartRateBpm} /min`], [text('Blood pressure', '血压'), `${vitals.systolicMmHg}/${vitals.diastolicMmHg} mmHg`], [text('Respirations', '呼吸频率'), `${vitals.respiratoryRate} /min`], ['SpO₂', `${vitals.spo2Percent}%`]].map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
    <DetailDrawer title={text('Prior history', '既往病史')} trigger={text('View prior history', '查看既往史')} close={text('Close history', '关闭既往史')}>
      <p>{allergies}</p>{[...priorHistory.diagnoses, ...priorHistory.medications].map(item => <p key={codingKey(item)}>{item.code} · {item.codeSystem}</p>)}
      {priorHistory.observations.map(item => <p key={`${item.observedAt}-${codingKey(item.analyte)}`}>{item.observedAt} · {item.analyte.code} · {item.value} {item.unit}</p>)}
    </DetailDrawer></header>;
}

function Debrief({ workspace, encounter, language }: Props) {
  const text = words(language);
  const query = useQuery({ queryKey: scopeKey(workspace, encounter.id, 'debrief'), queryFn: ({ signal }) => api(`/api/his/encounters/${encounter.id}/debrief`, debriefSchema, { signal }), staleTime: Infinity });
  if (query.isError) return <p role="alert">{errorMessage(query.error, language)}</p>;
  if (!query.data) return <p role="status">{text('Opening debrief…', '正在打开复盘…')}</p>;
  const truth = query.data.caseTruth;
  return <section className="clinical-panel"><h2>{text('Case debrief', '病例复盘')}</h2><p>{text('Case primary diagnosis', '病例主诊断')} · {truth.primaryDiagnosis.code} · {truth.primaryDiagnosis.codeSystem}</p>
    <p>{text('Your confirmed diagnoses', '本次确认诊断')} · {query.data.diagnosisRevisions.at(-1)?.diagnoses.map(item => item.code).join(' / ')}</p>
    <ul>{[...truth.hiddenHistory, ...truth.reviewPoints].map(item => <li key={item.en}>{item[language]}</li>)}</ul>
    {truth.results.map(result => <p key={`${codingKey(result.service)}-${result.stage}-${result.revision}`}>{result.service.code} · {result.summary[language]}</p>)}
  </section>;
}

function Complete(props: Editor) {
  const dirty = props.drafts(state => Boolean(state.note || state.diagnoses));
  const text = words(props.language);
  return <Card className="completion-bar"><h2>{text('Completion checks', '完诊条件')}</h2><ul>{props.encounter.completion.checks.map(item => <li key={item.id}><Badge tone={item.passed ? 'success' : 'warning'}>{item.passed ? '✓' : '○'} {item.label[props.language]}</Badge></li>)}</ul>
    {dirty && <p>{text('Save your changes before completing this encounter.', '请先保存编辑内容。')}</p>}
    {props.encounter.status === 'active' && <ConfirmActionButton disabled={dirty || props.busy || !allowed(props, 'encounter.complete') || !props.encounter.completion.ready} confirmation={text('Complete and freeze this encounter?', '确认完诊并冻结该就诊？')} onClick={() => run(command(props, 'encounter.complete'))}>{text('Complete encounter', '确认完诊')}</ConfirmActionButton>}
  </Card>;
}

export function EncounterPanel(props: Props & { drafts?: EncounterDrafts }) {
  const [standalone] = useState(createEncounterDrafts);
  const drafts = props.drafts ?? standalone;
  const text = words(props.language);
  const tabs = [
    { value: 'consultation', label: text('Consultation', '问诊记录'), content: <Consultation {...props}/> },
    { value: 'record', label: text('Clinical record', '结构化病历'), content: <RecordEditor {...props} drafts={drafts}/> },
    { value: 'diagnosis', label: text('Diagnoses', '诊断'), content: <DiagnosisEditor {...props} drafts={drafts}/> },
    ...props.workspace.tabs.flatMap(tab => { const Panel = props.panels?.[tab.id]; return Panel ? [{ value: tab.id, label: tab.label[props.language], content: <Panel {...props}/> }] : []; }),
  ];
  if (props.encounter.status === 'completed') tabs.push({ value: 'debrief', label: text('Debrief', '复盘'), content: <Debrief {...props}/> });
  return <div className="encounter-panel"><PatientHeader {...props}/><Tabs label={text('Clinical views', '临床页签')} defaultValue="consultation" items={tabs}/><Complete {...props} drafts={drafts}/></div>;
}
