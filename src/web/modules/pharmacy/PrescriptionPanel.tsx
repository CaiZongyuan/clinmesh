import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { z } from 'zod';
import { checkPrescription, prescribingViewSchema, type Medication, type PrescriptionLine } from '../../../packages/mod-pharmacy';
import { Badge, Button, Card, ConfirmActionButton, DetailDrawer, Field, Input, Select, Switch, Textarea } from '../../../packages/ui-kit';
import type { WorkbenchPanelProps } from '../../EncounterPanel';
import { api, ApiError, errorMessage, scopeKey, words, type Intent, type Language } from '../../workbench-api';
import { OverrideBar } from '../cds/OverrideBar';
import { consumeStagedMembers } from '../../encounter-drafts';

const drugKey = ({ code, codeSystem }: { code: string; codeSystem: string }) => JSON.stringify([codeSystem, code]);
type View = z.infer<typeof prescribingViewSchema>;
const issueLabels: Record<string, [string, string]> = {
  PHARMACY_RULES_UNAVAILABLE: ['This pack needs pharmacy rules before signing.', '此数据包需要配置药事规则后方可签发。'],
  MEDICATION_ALLERGY_CONFLICT: ['Confirmed drug allergy', '与已确认的药物过敏冲突'], PRESCRIPTION_ROUTE_NOT_ALLOWED: ['Route is not allowed', '给药途径超出允许范围'],
  PRESCRIPTION_DUPLICATE_MEDICATION: ['Duplicate active ingredient', '存在重复有效成分'], PRESCRIPTION_CLASS_CONFLICT: ['Incompatible medication classes', '药理类别互斥'],
  PRESCRIPTION_SINGLE_DOSE_LIMIT: ['Single dose outside the permitted range', '单次剂量超出范围'], PRESCRIPTION_DAILY_DOSE_LIMIT: ['Check daily frequency and dose limit', '核对每日频次和极量'],
  PRESCRIPTION_COURSE_LIMIT: ['Course must be 1–30 days', '疗程须为 1–30 天'], PRESCRIPTION_QUANTITY_LIMIT: ['Dispense quantity outside the permitted range', '发药总量超出范围'],
  PRESCRIPTION_INDICATION_MISMATCH: ['No matching confirmed indication', '与最新确认诊断的适应证不符'], PRESCRIPTION_LINE_COUNT: ['Choose 1–8 medication lines', '请选择 1–8 条药品'],
};

function Insert({ item, language }: { item: Medication; language: Language }) {
  const text = words(language);
  return <DetailDrawer title={item.display[language]} trigger={`${text('Package insert', '说明书摘要')} · ${item.display[language]}`} close={text('Close insert', '关闭说明书')}>
    <Badge tone="warning">{text('Synthetic teaching reference', '合成教学参考')}</Badge><p>{item.packageInsertSummary[language]}</p>
    <p>{text('Allowed routes', '允许途径')} · {item.routeCodes.allowed.join(' / ')}</p>
  </DetailDrawer>;
}

function Directions({ line, item, language, change, remove }: { line: PrescriptionLine; item: Medication; language: Language; change(line: PrescriptionLine): void; remove(): void }) {
  const text = words(language);
  const fields = [['dose', `${text('Single dose', '单次剂量')} (${item.inpatientDoseBasis.unit})`], ['timesPerDay', text('Times per day', '每日次数')], ['days', text('Course days', '疗程天数')], ['quantity', text('Total units', '发药总量')]] as const;
  return <Card><div className="cm-section-heading"><h4>{item.display[language]}</h4><Button onClick={remove}>{text('Remove', '移除')} · {item.display[language]}</Button></div>
    <div className="record-fields">{fields.map(([key, label]) => <Field key={key} label={`${label} · ${item.display[language]}`}><Input type="number" step={key === 'dose' ? 'any' : '1'} value={line[key] ? String(line[key]) : ''} onValueChange={value => change({ ...line, [key]: Number(value) })}/></Field>)}
      <Field label={`${text('Route', '给药途径')} · ${item.display[language]}`}><Select value={line.routeCode} options={item.routeCodes.allowed.map(value => ({ value, label: value }))} onValueChange={routeCode => { if (routeCode) change({ ...line, routeCode }); }}/></Field>
    </div></Card>;
}

function Withdrawal({ rx, language, busy, replace, commit }: { rx: View['prescriptions'][number]; language: Language; busy: boolean; replace: boolean; commit(reason: string, noMedicationReason?: string): void }) {
  const [reason, setReason] = useState('');
  const [replacement, setReplacement] = useState('');
  const text = words(language);
  const number = rx.prescriptionId.slice(-8);
  return <div className="workbench-fields"><Field label={`${text('Withdrawal reason', '撤回理由')} · ${number}`}><Input value={reason} onValueChange={setReason}/></Field>
    {replace && <Field label={text('Reason for no medication after withdrawal', '撤回后的无需用药理由')}><Textarea value={replacement} onValueChange={setReplacement}/></Field>}
    <ConfirmActionButton confirmation={replace ? text('Withdraw and record the reviewed no-medication conclusion?', '确认撤回并签署无需用药结论？') : text('Withdraw this prescription?', '确认撤回此处方？')} disabled={busy || !reason.trim() || (replace && !replacement.trim())} onClick={() => commit(reason.trim(), replace ? replacement.trim() : undefined)}>{replace ? text('Withdraw and confirm no medication', '撤回并确认无需用药') : text('Withdraw prescription', '撤回处方')} · {number}</ConfirmActionButton></div>;
}

function Prescribing({ view, language, encounter, workspace, submit, drafts }: WorkbenchPanelProps & { view: View }) {
  const text = words(language);
  const client = useQueryClient();
  const [source, setSource] = useState<Medication['source']>('internal');
  const [search, setSearch] = useState('');
  const [noMedication, setNoMedication] = useState(false);
  const [reason, setReason] = useState('');
  const [lines, setDraftLines] = useState<PrescriptionLine[]>(() => (drafts?.getState().orderSet?.members ?? []).flatMap(member => {
    const item = view.catalog.find(item => item.code === member.code && item.codeSystem === member.codeSystem);
    return member.kind === 'medications' && item ? [{ codeSystem: item.codeSystem, code: item.code, dose: item.inpatientDoseBasis.amount, routeCode: item.routeCodes.default, timesPerDay: 1, days: 1, quantity: 1 }] : [];
  }));
  const writes = useMutation({ mutationFn: submit, onSettled: () => client.invalidateQueries({ queryKey: scopeKey(workspace, encounter.id, 'prescriptions') }) });
  function setLines(next: PrescriptionLine[]) { writes.reset(); setDraftLines(next); }
  const allowed = encounter.responsibleRole === workspace.roleId && workspace.operations.some(op => op.name === 'prescription.sign');
  const canPrescribe = allowed && encounter.status === 'active' && !view.noMedication;
  const liveRx = view.prescriptions.some(rx => rx.status !== 'withdrawn');
  const matches = view.catalog.filter(item => item.source === source && [item.code, item.display.en, item.display.zh].some(value => value.toLowerCase().includes(search.trim().toLowerCase())));
  const issues = checkPrescription(view.catalog, lines, view.context);
  const blocking = issues.filter(issue => issue !== 'PRESCRIPTION_INDICATION_MISMATCH' || !workspace.enabledModules.includes('mod-cds'));
  const apply = (intent: Intent) => writes.mutate(intent, { onSuccess: () => { consumeStagedMembers(drafts, member => member.kind === 'medications' && lines.some(line => drugKey(line) === drugKey(member))); setDraftLines([]); setReason(''); setNoMedication(false); } });
  const commit = (name: string, fields: Intent['fields']) => apply({ name, targetId: encounter.id, version: encounter.version, fields });
  const rejected = writes.variables;
  const alert = rejected?.name === 'prescription.sign' && rejected.targetId === encounter.id && rejected.version === encounter.version && rejected.fields?.lines === lines && writes.error instanceof ApiError && writes.error.message === 'CLINICAL_QUALITY_ALERT' ? writes.error : undefined;
  return <section className="clinical-panel"><h2>{text('Prescribing', '用药结论')}</h2>
    {view.context.allergies.length > 0 && <Badge tone="destructive">{text('Confirmed allergies', '已确认过敏')} · {view.context.allergies.join(', ')}</Badge>}
    {view.noMedication && <Card><strong>{text('No medication recorded', '已确认无需用药')}</strong><p>{view.noMedication.reason}</p></Card>}
    {canPrescribe && <><Switch label={text('No medication needed', '无需用药')} disabled={liveRx || Boolean(lines.length)} checked={noMedication} onCheckedChange={setNoMedication}/>
      {noMedication ? <><Field label={text('Reason for no medication', '无需用药理由')}><Textarea value={reason} onValueChange={setReason}/></Field>
        <ConfirmActionButton disabled={!reason.trim() || writes.isPending} confirmation={text('Record a formal no-medication decision?', '确认记录正式无需用药结论？')} onClick={() => commit('prescription.no-medication', { reason: reason.trim() })}>{text('Confirm no medication', '确认无需用药')}</ConfirmActionButton></> : <>
        <div className="record-fields"><Field label={text('Prescription source', '处方来源')}><Select value={source} disabled={Boolean(lines.length)} options={[{ value: 'internal', label: text('Hospital pharmacy', '本院药房') }, { value: 'external', label: text('External pharmacy', '外配处方') }]} onValueChange={next => { if (next) setSource(next); }}/></Field>
        <Field label={text('Find medication', '检索药品')}><Input value={search} onValueChange={setSearch}/></Field></div>
        {matches.length === 0 && <p>{text('No matching medications.', '未找到匹配药品。')}</p>}
        {matches.map(item => <div className="cm-actions" key={drugKey(item)}><Button disabled={lines.length >= 8 || lines.some(line => drugKey(line) === drugKey(item))} onClick={() => setLines([...lines, { codeSystem: item.codeSystem, code: item.code, routeCode: item.routeCodes.default, dose: item.inpatientDoseBasis.amount, timesPerDay: 1, days: 1, quantity: 1 }])}>{text('Add', '加入')} · {item.display[language]}</Button><Insert item={item} language={language}/></div>)}
        {lines.map(line => <Directions key={drugKey(line)} item={view.catalog.find(item => drugKey(item) === drugKey(line))!} line={line} language={language}
          change={next => setLines(lines.map(current => current === line ? next : current))} remove={() => setLines(lines.filter(current => current !== line))}/>)}
        {lines.length > 0 && issues.map(issue => <p role="alert" key={issue}>{issueLabels[issue] ? text(...issueLabels[issue]) : issue}</p>)}
        <ConfirmActionButton disabled={Boolean(blocking.length) || writes.isPending} confirmation={text('Sign all reviewed medication lines?', '确认签发全部已核对药品？')} onClick={() => commit('prescription.sign', { lines })}>{text('Sign prescription', '签发处方')}</ConfirmActionButton>
        {alert && rejected && <OverrideBar key={writes.submittedAt} intent={rejected} codes={String(alert.details?.ruleCodes).split(',')} language={language} submit={apply} cancel={writes.reset}>
          <strong>{encounter.patient.name} · {encounter.patientId}</strong><ul>{lines.map(line => {
            const drug = view.catalog.find(item => drugKey(item) === drugKey(line))!;
            return <li key={drugKey(line)}>{drug.display[language]} ({line.code}) · {line.dose} {drug.inpatientDoseBasis.unit} · {line.routeCode} · {line.timesPerDay}×/{text('day', '日')} · {line.days} {text('days', '天')} · {line.quantity} {text('units', '制剂单位')}</li>;
          })}</ul>
        </OverrideBar>}
      </>}</>}
    {view.prescriptions.map(rx => <Card key={rx.prescriptionId}><div className="cm-section-heading"><h3>{text('Prescription', '处方')} · {rx.prescriptionId.slice(-8)}</h3><Badge>{rx.source === 'internal' ? text('Hospital', '本院') : text('External', '外配')} · {rx.status === 'signed' ? text('Signed', '已签发') : rx.status === 'withdrawn' ? text('Withdrawn', '已撤回') : text('Dispensed', '已发药')}</Badge></div>
      {rx.lines.map(line => <p key={line.orderId}>{line.display[language]} · {line.dose} {line.doseUnit} · {line.routeCode} · {line.timesPerDay}×/{text('day', '日')} · {line.days} {text('days', '天')} · {line.quantity} {text('units', '制剂单位')}</p>)}
      {rx.withdrawalReason && <p>{rx.withdrawalReason}</p>}
      {allowed && rx.status === 'signed' && <Withdrawal rx={rx} language={language} busy={writes.isPending} replace={encounter.status === 'completed' && view.prescriptions.filter(item => item.status !== 'withdrawn').length === 1} commit={(reason, noMedicationReason) => writes.mutate({ name: 'prescription.withdraw', targetId: rx.prescriptionId, encounterId: encounter.id, version: rx.version, fields: { reason, noMedicationReason } })}/>}
    </Card>)}
  </section>;
}

export function PrescriptionPanel(props: WorkbenchPanelProps) {
  const { workspace, encounter, language } = props;
  const query = useQuery({ queryKey: scopeKey(workspace, encounter.id, 'prescriptions', workspace.roleId, String(encounter.version)),
    enabled: encounter.encounterClass === 'outpatient', queryFn: ({ signal }) => api(`/api/his/encounters/${encounter.id}/prescriptions`, prescribingViewSchema, { signal }) });
  if (encounter.encounterClass !== 'outpatient') return <p>{words(language)('Outpatient prescriptions only.', '此处方页用于门诊就诊。')}</p>;
  if (query.isError) return <p role="alert">{errorMessage(query.error, language)}</p>;
  return query.data ? <Prescribing {...props} view={query.data}/> : <p role="status">{words(language)('Loading prescriptions…', '正在读取处方…')}</p>;
}
