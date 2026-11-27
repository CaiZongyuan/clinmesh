import { useState } from 'react';
import { Button, Card, ConfirmActionButton, Field, Select, Textarea } from '../../../packages/ui-kit';
import { words, type Intent, type Language } from '../../workbench-api';

const reasons = [
  ['contraindication-or-bleeding-risk', 'Contraindication or bleeding risk', '禁忌或高出血风险'], ['outside-result-verified', 'External result verified', '已核实外院或床旁结果'],
  ['follow-up-arranged', 'Orders and follow-up arranged', '已开单并安排随访'], ['informed-refusal', 'Informed refusal', '患者知情拒绝'],
  ['specialist-judgment', 'Individual specialist judgment', '专科个体化判断'], ['emergency-priority', 'Emergency treatment takes priority', '急危重症优先处置'],
] as const;
export function OverrideBar({ intent, codes, language, submit, cancel }: { intent: Intent; codes: string[]; language: Language; submit(intent: Intent): void; cancel(): void }) {
  const text = words(language);
  const [reasonCode, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  return <Card><h3>{text('Clinical pathway alert', '临床路径警示')}</h3><p>{codes.join(' · ')}</p>
    <Field label={text('Override reason', '放行理由')}><Select value={reasonCode} onValueChange={setReason} options={reasons.map(([value, en, zh]) => ({ value, label: text(en, zh) }))}/></Field>
    <Field label={text('Clinical explanation', '医学说明')}><Textarea value={note} onValueChange={setNote}/></Field>
    <div className="cm-actions"><Button onClick={cancel}>{text('Cancel', '取消')}</Button><ConfirmActionButton confirmation={text('Sign with this audited clinical reason?', '确认记录医学理由并签发？')} disabled={!reasonCode || note.trim().length < 4} onClick={() => submit({ ...intent, fields: { ...intent.fields, clinicalOverride: { reasonCode, note: note.trim(), ruleCodes: codes } } })}>{text('Confirm clinical override', '确认临床放行')}</ConfirmActionButton></div>
  </Card>;
}
