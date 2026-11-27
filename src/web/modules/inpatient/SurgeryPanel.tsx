import { lazy, Suspense, useState } from 'react';
import { z } from 'zod';
import { catalogSchema, medicationSchema } from '../../../packages/data-pack';
import type { WardView } from '../../../packages/mod-inpatient';
import { Button, Card, Checkbox } from '../../../packages/ui-kit';
import { words } from '../../workbench-api';
import { Choice, Entry, namedOptions, selected, WardAction, type StageProps } from './controls';

type Surgery = WardView['surgeries'][number];
const PostoperativeOrder = lazy(() => import('./clinical').then(module => ({ default: module.OrderComposer })));
function selector(panel: StageProps, kind: string) { return panel.directory.items.filter(item => item.kind === kind).map(item => ({ value: item.id, label: item.display[panel.language] })); }
function Request(panel: StageProps) {
  const text = words(panel.language);
  const [item, choose] = useState(''), [reason, setReason] = useState(''), [scheduled, setScheduled] = useState(panel.workspace.virtualTime), [urgency, setUrgency] = useState('elective');
  const [location, setLocation] = useState(''), [anesthesia, setAnesthesia] = useState(''), [surgeon, setSurgeon] = useState(''), [assistant, setAssistant] = useState('none'), [policy, setPolicy] = useState(''), [standby, setStandby] = useState(false);
  const options = selector(panel, 'procedures'), procedureId = selected(item, options);
  const catalog = panel.directory.items.find(item => item.id === procedureId);
  if (!catalog) return null;
  const definition = catalogSchema.shape.procedures.element.parse(catalog.definition);
  const org = panel.directory.organization;
  const team = org.practitioners.filter(person => org.practitionerRoles.some(role => role.id === person.roleId && role.capabilities.includes('sign'))).map(person => ({ value: person.id, label: person.name[panel.language] }));
  const lead = selected(surgeon, team);
  return <Card><h3>{text('New procedure request', '新手术申请')}</h3><div className="workbench-fields">
    <Choice label={text('Procedure', '计划术式')} options={options} value={procedureId} change={value => { choose(value); setPolicy(''); setAnesthesia(''); setLocation(''); }}/><Choice label={text('Procedure type', '手术类型')} options={namedOptions(['elective', 'urgent', 'emergency', 'day'])} value={urgency} change={setUrgency}/>
    <Entry label={text('Planned time (UTC)', '计划时间（UTC）')} value={scheduled} change={setScheduled}/><Choice label={text('Operating site', '手术地点')} value={location || definition.defaultLocation} options={[...org.departments, ...org.wards].map(site => ({ value: site.id, label: site.name[panel.language] }))} change={setLocation}/>
    <Choice label={text('Primary surgeon', '主刀医师')} value={lead} options={team} change={setSurgeon}/><Choice label={text('First assistant', '第一助手')} value={assistant} options={[{ value: 'none', label: text('None', '无') }, ...team.filter(person => person.value !== lead)]} change={setAssistant}/>
    <Entry label={text('Anesthesia', '麻醉方式')} value={anesthesia || definition.defaultAnesthesia} change={setAnesthesia}/><Choice label={text('Preoperative order policy', '术前医嘱停续策略')} options={namedOptions(['continue-active', 'stop-on-completion'])} value={policy || definition.defaultPreopOrderPolicy} change={setPolicy}/>
    <Entry label={text('Procedure indication', '手术指征')} value={reason} change={setReason}/><Checkbox label={text('Standby for same-session PCI', '备选同台 PCI')} checked={standby} onCheckedChange={checked => setStandby(checked === true)}/>
    <WardAction panel={panel} name="surgery.request" label={text('Sign procedure request', '签发手术申请')} disabled={!reason.trim() || !lead} fields={{ procedureId, type: urgency, plannedAt: scheduled, location: location || definition.defaultLocation, surgeon: lead, ...(assistant !== 'none' && { assistant }), anesthesia: anesthesia || definition.defaultAnesthesia, reason, preopOrderPolicy: policy || definition.defaultPreopOrderPolicy, standbyAdHocPci: standby }}/>
  </div></Card>;
}
function Procedure(panel: StageProps & { surgery: Surgery }) {
  const { surgery } = panel, text = words(panel.language);
  const [signer, setSigner] = useState(''), [risks, setRisks] = useState(''), [check, setCheck] = useState(''), [note, setNote] = useState('');
  const [chosen, choose] = useState(''), [amount, setAmount] = useState('1'), [next, setNext] = useState(''), [planned, setPlanned] = useState(false), [fingerprint, setFingerprint] = useState('');
  const [drugChoice, setDrug] = useState(''), [dose, setDose] = useState(''), [routeCode, setRoute] = useState('');
  const [postopIndex, setPostopIndex] = useState<number | null>(null);
  const stage = surgery.stages.at(-1)!;
  const postoperative = surgery.postoperative.flatMap(member => panel.directory.items.filter(item => item.kind === member.kind && item.code === member.code && item.definition.codeSystem === member.codeSystem));
  const proposed = postopIndex === null ? undefined : postoperative[postopIndex];
  const items = selector(panel, 'materials'), itemId = selected(chosen, items), quantity = Number(amount);
  const procedures = selector(panel, 'procedures').filter(row => row.value !== surgery.plan.procedureId), procedureId = selected(next, procedures);
  const drugs = selector(panel, 'medications'), drugId = selected(drugChoice, drugs);
  const drug = medicationSchema.safeParse(panel.directory.items.find(item => item.id === drugId)?.definition).data;
  const routes = namedOptions(drug?.routeCodes.allowed ?? []);
  const fields = { requestId: surgery.id }, label = panel.directory.items.find(item => item.id === stage.procedureId)?.display[panel.language];
  const action = (name: string, label: string, body = {}, disabled = false) => <WardAction panel={panel} name={`surgery.${name}`} fields={{ ...fields, ...body }} label={`${label} · ${surgery.id.slice(-6)}`} disabled={disabled}/>;
  return <Card><h3>{label} · {surgery.status}</h3><p>{surgery.plan.plannedAt} · {surgery.plan.location} · {surgery.plan.surgeon} · {surgery.plan.anesthesia} · {surgery.plan.preopOrderPolicy}</p>
    {surgery.status === 'requested' && <>{panel.allowed('ward.surgery.consent') && !surgery.preparations.some(item => item.kind === 'consent') && <><Entry label={text('Consent signer', '知情同意签署人')} value={signer} change={setSigner}/><Entry label={text('Individual risks discussed', '个体化风险说明')} value={risks} change={setRisks}/>{action('consent', text('Confirm signed consent', '核认已签知情同意书'), { signer, risks, diagnosisRevision: panel.ward.diagnosisRevision }, !signer.trim() || !risks.trim())}</>}
      {panel.allowed('ward.surgery.check') && !surgery.preparations.some(item => item.kind === 'nursing') && <><Entry label={text('Preoperative checks', '术前核查项目')} value={check} change={setCheck}/>{action('check', text('Confirm preoperative check', '完成术前核查'), { checklist: check }, !check.trim())}</>}</>}
    {surgery.preparations.map(item => <p key={item.kind}>{item.kind} · {item.signedBy} · {item.at}</p>)}
    {surgery.report && <div><strong>{surgery.report.summary?.[panel.language] ?? text('Angiography findings unavailable', '缺少造影结果依据')}</strong><p>{surgery.report.observations.map(obs => `${obs.code} ${obs.value} ${obs.unit}`).join(' · ')}</p>{!surgery.report.acknowledged && action('acknowledge', text('Acknowledge angiography report', '确认造影报告已阅'))}</div>}
    {panel.allowed('ward.surgery.start') && ['requested', 'ready', 'in-progress', 'standby-pci'].includes(surgery.status) && <div className="workbench-fields">
      <Entry label={text('Medical explanation for deviations', '偏离医学说明')} value={note} change={setNote}/>
      {surgery.status === 'requested' && action('cancel', text('Cancel procedure request', '取消手术申请'), { reason: note }, !note.trim())}
      {['ready', 'in-progress', 'standby-pci'].includes(surgery.status) && <><Choice label={text('Material', '选择耗材')} options={items} value={itemId} change={choose}/><Entry label={text('Material units', '耗材数量')} value={amount} change={setAmount}/></>}
      {surgery.status === 'standby-pci' && <><Choice label={text('PCI procedure', 'PCI 术式')} options={procedures} value={procedureId} change={setNext}/><Checkbox label={text('Include selected material in plan', '预留所选耗材')} checked={planned} onCheckedChange={checked => setPlanned(checked === true)}/>{action('convert-to-pci', text('Convert to same-session PCI', '同台转 PCI'), { procedureId, materials: planned ? [{ itemId, quantity }] : [] })}</>}
      {surgery.status === 'standby-pci' || surgery.status === 'ready' && stage.stage === 'ad-hoc-pci' ? action('finalize-standby', text('Finalize standby', '结束备选介入'), note ? { note } : {}) : null}
      {surgery.status === 'ready' && <>{action('start', text('Start procedure', '开始手术'))}<Checkbox label={text('Use selected material on execution', '一次实施时使用所选耗材')} checked={planned} onCheckedChange={checked => setPlanned(checked === true)}/>{action('execute', text('Execute procedure', '一次性实施手术'), { materials: planned ? [{ itemId, quantity }] : [], ...(note && { note }) })}</>}
      {surgery.status === 'in-progress' && <>{action('record-material', text('Record actual material', '登记实际耗材'), { itemId, quantity, ...(note && { note }) })}
        <Choice label={text('Intraoperative medication', '术中用药')} options={drugs} value={drugId} change={setDrug}/><Entry label={text('Intraoperative dose', '术中单次剂量')} value={dose} change={setDose}/><Choice label={text('Intraoperative route', '术中给药途径')} options={routes} value={selected(routeCode, routes)} change={setRoute}/>
        {action('record-medication', text('Confirm intraoperative medication', '确认术中给药'), { itemId: drugId, dose: Number(dose), route: selected(routeCode, routes) }, !(Number(dose) > 0))}
        {stage.supplies.flatMap(row => row.uses.filter(use => use.quantity > 0).map(use => <div key={use.id}>{row.lotNumber} × {use.quantity}{action('correct-material', `${text('Correct material use', '耗材更正')} ${use.id.slice(-6)}`, { useId: use.id, quantity, note }, !note.trim())}</div>))}
        <Button disabled={panel.busy} onClick={() => { void panel.run({ name: 'ward.surgery.preview-completion', targetId: panel.ward.encounterId, version: panel.ward.version, fields }).then(value => setFingerprint(z.object({ fingerprint: z.string() }).parse(value).fingerprint), () => {}); }}>{text('Preview completion', '核实完成清单')}</Button>
        {action('complete', text('Complete reviewed procedure', '确认手术完成'), { fingerprint, ...(note && { note }) }, !fingerprint)}</>}
    </div>}
    {postoperative.length > 0 && <><p>{text('Postoperative order set', '术后成套医嘱')} · {postoperative.map(row => row.display[panel.language]).join(' · ')}</p>
      {panel.ward.status === 'admitted' && panel.allowed('ward.order.sign') && stage.executionId && (proposed ? <Suspense fallback={null}><PostoperativeOrder key={proposed.id} {...panel} proposed={{ itemId: proposed.id, executionId: stage.executionId }} onSigned={() => setPostopIndex(index => index !== null && index + 1 < postoperative.length ? index + 1 : null)}/></Suspense> : <Button onClick={() => setPostopIndex(0)}>{text('Review postoperative order set', '逐项重整术后医嘱')}</Button>)}</>}
  </Card>;
}
export default function SurgeryPanel(panel: StageProps) {
  return <div className="clinical-panel">{panel.allowed('ward.surgery.request') && panel.ward.status === 'admitted' && <Request {...panel}/>}{panel.ward.surgeries.map(surgery => <Procedure key={surgery.id} {...panel} surgery={surgery}/>)}</div>;
}
