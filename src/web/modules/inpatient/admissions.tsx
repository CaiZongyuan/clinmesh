import { useState } from 'react';
import { z } from 'zod';
import { Button, Card } from '../../../packages/ui-kit';
import { words } from '../../workbench-api';
import { Action, Choice, Entry, selected, WardAction, type Commands, type StageProps } from './controls';

export function Registration(props: Commands & { caseId?: string; choose(id: string): void }) {
  const { directory, language } = props;
  const text = words(language);
  const [wardChoice, setWard] = useState('');
  const [caseChoice, setCase] = useState(props.caseId ?? '');
  const [reason, setReason] = useState('');
  const wards = directory.organization.wards.map(item => ({ value: item.id, label: item.name[language] }));
  const cases = props.workspace.cases.map(item => ({ value: item.id, label: item.demographics.name }));
  const ward = selected(wardChoice, wards), patient = selected(caseChoice, cases);
  const opened = (result: unknown) => props.choose(z.object({ encounterId: z.uuidv7() }).parse(result).encounterId);
  if (!props.allowed('ward.register') && !props.allowed('ward.certificate.issue')) return null;
  return <Card><h2>{text('Admission desk', '住院登记')}</h2><div className="workbench-fields">
    <Choice label={text('Receiving ward', '收治病区')} options={wards} value={ward} change={setWard}/>
    {props.allowed('ward.register') && <><Choice label={text('Patient for admission', '待住院患者')} options={cases} value={patient} change={setCase}/><Action commands={props} targetId={patient} version={0} name="ward.register" fields={{ ward }} label={text('Register direct admission', '办理直接入院')} confirmation={`${text('Register direct admission', '办理直接入院')} · ${cases.find(row => row.value === patient)?.label} · ${wards.find(row => row.value === ward)?.label}`} done={opened}/></>}
    {props.allowed('ward.certificate.issue') && directory.outpatients.length > 0 && <><Entry label={text('Referral indication', '转住院指征')} value={reason} change={setReason}/>{directory.outpatients.map(visit => <Action key={visit.id} commands={props} targetId={visit.id} version={visit.version} fields={{ ward, reason }} disabled={!reason.trim()} label={`${text('Issue admission certificate', '开住院证')} · ${visit.patient}`} name="ward.certificate.issue"/>)}</>}
    {directory.referrals.map(cert => <Action key={cert.id} commands={props} targetId={cert.id} version={0} fields={{}} label={`${text('Redeem certificate', '核销住院证')} · ${cert.patient}`} name="ward.certificate.redeem" done={opened}/>)}
  </div></Card>;
}
export function Beds(panel: StageProps) {
  const { ward, directory, language } = panel;
  const text = words(language);
  const [bedChoice, setBed] = useState('');
  const [wardChoice, setWard] = useState('');
  const [expanded, setExpanded] = useState(false);
  const org = directory.organization;
  const available = (wardId: string) => org.beds.filter(item => item.wardId === wardId && !directory.admissions.some(admission => admission.bed === item.id)).map(item => ({ value: item.id, label: item.name[language] }));
  const beds = available(ward.ward), bed = selected(bedChoice, beds);
  const targets = org.wards.filter(item => item.id !== ward.ward).map(item => ({ value: item.id, label: item.name[language] }));
  const target = selected(wardChoice, targets), receiving = available(ward.transfer?.to ?? '');
  return <Card><h2>{text('Bed assignment', '床位安排')}</h2>
    {panel.allowed('ward.bed.assign') && ['registered', 'admitted'].includes(ward.status) && <><Choice label={text('Available bed', '可用床位')} options={beds} value={bed} change={setBed}/><WardAction panel={panel} name="bed.assign" disabled={!bed} fields={{ bed }} label={text('Confirm bed assignment', '确认分床或转床')}/></>}
    {ward.status === 'admitted' && <><Button onClick={() => setExpanded(!expanded)}>{text('Bed swaps and transfers', '床位互换与转科')}</Button>{expanded && <>
      {directory.admissions.filter(row => row.encounterId !== ward.encounterId && row.ward === ward.ward && row.status === 'admitted').map(row => <WardAction key={row.encounterId} panel={panel} name="bed.swap" fields={{ otherEncounterId: row.encounterId, otherVersion: row.version }} label={`${text('Swap beds with', '互换床位')} · ${row.patient}`}/>)}
      {panel.allowed('ward.transfer.request') && !ward.transfer && <><Choice label={text('Transfer destination', '转入病区')} options={targets} value={target} change={setWard}/><WardAction panel={panel} name="transfer.request" fields={{ ward: target }} disabled={!target} label={text('Request transfer', '申请转科')}/></>}
      {ward.transfer && <p>{ward.transfer.from} → {ward.transfer.to} · {ward.transfer.status}</p>}
      {ward.transfer?.status === 'requested' && <WardAction panel={panel} name="transfer.handover" label={text('Hand over patient', '原病区交接')}/>}
      {ward.transfer?.status === 'handed-over' && <><Choice label={text('Receiving bed', '接收床位')} options={receiving} value={selected(bedChoice, receiving)} change={setBed}/><WardAction panel={panel} name="transfer.receive" fields={{ bed: selected(bedChoice, receiving) }} label={text('Receive transfer', '目标病区接收')}/></>}
    </>}</>}
  </Card>;
}
