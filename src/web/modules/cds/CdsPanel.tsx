import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { z } from 'zod';
import { guidelinesSchema, orderSetsSchema, scoreViewSchema } from '../../../packages/mod-cds';
import { labViewSchema } from '../../../packages/mod-lab';
import { Badge, Button, Card, Checkbox, ConfirmActionButton, Dialog, Field, Input, Select } from '../../../packages/ui-kit';
import { api, errorMessage, scopeKey, words, type WorkbenchPanelProps } from '../../workbench-api';

type Scores = z.infer<typeof scoreViewSchema>;
type Template = z.infer<typeof orderSetsSchema>[number];
const booleanFields = { cardiacArrestOnAdmission: ['Cardiac arrest at admission', '入院时心搏骤停'], stSegmentDeviation: ['Bedside ST deviation', '床旁 ST 段偏移'], aspirinUsedLast7Days: ['Aspirin in last 7 days', '7 日内使用阿司匹林'], familyHistoryPrematureCad: ['Premature CAD in family', '早发冠心病家族史'], knownCoronaryRevascularizationOrStenosisGe50: ['Known revascularization or ≥50% stenosis', '已知血运重建或狭窄 ≥50%'], pciDaptIndication: ['PCI / DAPT indication', 'PCI 或双抗指征'], acuteChestPain: ['Acute chest pain', '急性胸痛'], hypertensionHistory: ['Hypertension history', '高血压史'], diabetesHistory: ['Diabetes history', '糖尿病史'], dyslipidemiaHistory: ['Dyslipidemia history', '血脂异常史'] } as const;
const numbers = { weightKg: ['Weight (kg)', '体重（kg）'], heightCm: ['Height (cm)', '身高（cm）'], anginaEpisodes24h: ['Angina episodes in 24 h', '24 小时内心绞痛次数'], cadOnsetAgeYears: ['Age at CAD onset', '冠心病发病年龄'], severeAscvdEventCount: ['Severe ASCVD event count', '严重 ASCVD 事件数'] } as const;
const choices = { killipClass: ['Killip', 'Killip 分级', ['I', 'II', 'III', 'IV']], priorBleedingHistory: ['Bleeding history', '出血史', ['spontaneous', 'non-spontaneous', 'negative']], smokingStatus: ['Smoking history', '吸烟史', ['current', 'former', 'never']], ckdLt30Chronicity: ['Chronic eGFR <30', '慢性 eGFR <30', ['confirmed', 'excluded']], ckdLt60Chronicity: ['Chronic eGFR <60', '慢性 eGFR <60', ['confirmed', 'excluded']] } as const;

function Assessment({ data, props }: { data: Scores; props: WorkbenchPanelProps }) {
  const text = words(props.language);
  const [fields, setFields] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(data.bedside).map(([key, value]) => [key, String(value)])));
  const revision = useMutation({ mutationFn: async () => {
    const values = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== '').map(([key, value]) => [key, Object.hasOwn(booleanFields, key) ? value === 'true' : Object.hasOwn(numbers, key) ? Number(value) : value]));
    return props.submit({ name: 'cds.risk-assessment', targetId: props.encounter.id, version: props.encounter.version, fields: { fields: values, expectedRevision: data.revision } });
  } });
  const select = (key: string, label: string, options: { value: string; label: string }[]) => <Field key={key} label={label}><Select value={fields[key] || 'unknown'} options={[{ value: 'unknown', label: text('Not recorded', '未记录') }, ...options]} onValueChange={value => setFields({ ...fields, [key]: value === 'unknown' ? '' : value ?? '' })}/></Field>;
  return <Dialog title={text('Bedside risk assessment', '床旁风险评估')} triggers={[text('Record risk assessment', '录入床旁风险评估')]} close={text('Close assessment', '关闭床旁评估')}>
    <div className="record-fields">{Object.entries(booleanFields).map(([key, [en, zh]]) => select(key, text(en, zh), [{ value: 'true', label: text('Yes', '是') }, { value: 'false', label: text('No', '否') }]))}
    {Object.entries(choices).map(([key, [en, zh, values]]) => select(key, text(en, zh), values.map(value => ({ value, label: value }))))}
    {Object.entries(numbers).map(([key, [en, zh]]) => <Field key={key} label={text(en, zh)}><Input type="number" value={fields[key] ?? ''} onValueChange={value => setFields({ ...fields, [key]: value })}/></Field>)}</div>
    {revision.isError && <p role="alert">{errorMessage(revision.error, props.language)}</p>}
    <ConfirmActionButton confirmation={text('Sign this bedside assessment revision?', '确认签署床旁风险评估修订？')} disabled={revision.isPending} onClick={() => revision.mutate()}>{text('Sign assessment', '签署床旁评估')}</ConfirmActionButton>
  </Dialog>;
}

function OrderSet({ template, props }: { template: Template; props: WorkbenchPanelProps }) {
  const text = words(props.language);
  const client = useQueryClient();
  const [selected, setSelected] = useState<string[]>(() => template.members.flatMap(member => member.status === 'ready' && member.catalogId ? [member.catalogId] : []));
  const stage = useMutation({ mutationFn: async () => {
    const members = template.members.flatMap(member => member.catalogId && selected.includes(member.catalogId) && ['ready', 'needs-review'].includes(member.status) ? [{ ...member, catalogId: member.catalogId }] : []);
    const labPath = `/api/his/encounters/${props.encounter.id}/lab`;
    if (props.workspace.operations.some(item => item.name === 'lab.save-draft') && template.members.some(item => item.kind === 'services')) {
      const lab = await api(labPath, labViewSchema);
      const previous = props.drafts?.getState().orderSet;
      const replaced = previous?.templateId === template.id ? previous.members.map(item => item.catalogId) : [];
      const ids = new Set(lab.draft.items.filter(item => !replaced.includes(item.serviceId)).map(item => item.serviceId));
      for (const member of members) if (lab.services.some(service => service.id === member.catalogId)) ids.add(member.catalogId);
      await props.submit({ name: 'lab.save-draft', targetId: props.encounter.id, version: lab.draft.version, fields: { serviceIds: [...ids] } });
      await client.invalidateQueries({ queryKey: scopeKey(props.workspace, props.encounter.id, 'lab') });
    }
    props.drafts?.setState({ orderSet: { templateId: template.id, members } });
  } });
  return <Dialog title={template.name[props.language]} triggers={[template.name[props.language]]} close={text('Close order set', '关闭组套')}>
    <p>{text('Catalog version', '目录版本')} {template.version}</p>{template.members.map(member => <div key={`${member.kind}/${member.codeSystem}/${member.code}`}>
      <Checkbox label={member.display[props.language]} disabled={!member.catalogId || !['ready', 'needs-review'].includes(member.status)} checked={Boolean(member.catalogId && selected.includes(member.catalogId))} onCheckedChange={checked => { if (member.catalogId) setSelected(current => checked ? [...current, member.catalogId!] : current.filter(id => id !== member.catalogId)); }}/>
      <Badge>{member.status}</Badge> {member.reason}</div>)}
    {stage.isSuccess && <p role="status">{text('Draft ready for review in the order editor.', '草稿已灌入，请到开单页核对。')}</p>}{stage.isError && <p role="alert">{errorMessage(stage.error, props.language)}</p>}
    <Button disabled={stage.isPending || props.encounter.status !== 'active' || props.workspace.roleId !== props.encounter.responsibleRole} onClick={() => stage.mutate()}>{text('Fill draft', '灌入草稿')}</Button>
  </Dialog>;
}

export default function CdsPanel(props: WorkbenchPanelProps) {
  const { workspace, encounter, language } = props;
  const text = words(language);
  const prefix = `/api/his/encounters/${encounter.id}/cds/`;
  const key = scopeKey(workspace, encounter.id, 'cds', workspace.roleId, String(encounter.version), String(workspace.clockRevision));
  const scores = useQuery({ queryKey: [...key, 'scores'], queryFn: ({ signal }) => api(`${prefix}scores`, scoreViewSchema, { signal }) });
  const topics = useQuery({ queryKey: [...key, 'guidelines'], queryFn: ({ signal }) => api(`${prefix}guidelines`, guidelinesSchema, { signal }) });
  const sets = useQuery({ queryKey: [...key, 'order-sets'], queryFn: ({ signal }) => api(`${prefix}order-sets`, orderSetsSchema, { signal }) });
  const error = scores.error ?? topics.error ?? sets.error;
  if (error) return <p role="alert">{errorMessage(error, language)}</p>;
  if (!scores.data || !topics.data || !sets.data) return <p role="status">{text('Reading clinical evidence…', '正在读取临床依据…')}</p>;
  return <section className="clinical-panel"><div className="cm-section-heading"><h2>{text('Clinical risk scores', '临床风险评分')}</h2>{encounter.status === 'active' && workspace.operations.some(op => op.name === 'cds.risk-assessment') && <Assessment key={scores.data.revision} data={scores.data} props={props}/>}</div>
    <div className="catalog-columns">{scores.data.scores.map(score => <Card key={score.id}><h3>{language === 'en' ? score.titleEn : score.titleZh}</h3><p>{language === 'en' ? score.summaryEn : score.summaryZh}</p></Card>)}</div>
    <Card><h3>{text('Guideline topics', '指南专题')} · {topics.data.population}</h3>{topics.data.topics.map(topic => <section key={topic.id}><h4>{topic.id}</h4><blockquote>{topic.verbatim}</blockquote>{topic.qualifiers.map(qualifier => <p key={qualifier}>{qualifier}</p>)}<small>{topic.source} · {topic.version} · p. {topic.physicalPage}</small></section>)}
    <p>{topics.data.observations.map(item => `${item.code} ${item.value} ${item.unit}`).join(' · ')}</p>{topics.data.missingInputs.length > 0 && <p>{text('Missing evidence', '缺少依据')} · {topics.data.missingInputs.join(', ')}</p>}</Card>
    <Card><h3>{text('Order sets', '医嘱组套')}</h3>{sets.data.length ? sets.data.map(template => <OrderSet key={`${template.id}/${template.version}/${template.members.map(member => member.status).join(',')}`} template={template} props={props}/>) : <p>{text('No applicable order sets.', '暂无适用组套。')}</p>}</Card>
  </section>;
}
