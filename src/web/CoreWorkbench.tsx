import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { z } from 'zod';
import { encounterViewSchema, type WorkspaceView } from '../packages/clinical-core';
import { summarySchema } from '../packages/patient-visit';
import { sessionSchema } from '../packages/platform';
import { Badge, Button, Dialog, Field, InlineConfirmBar, Menu, Select, WorkspaceCardLayout, useThemeFont } from '../packages/ui-kit';
import { EncounterPanel, type WorkbenchPanels } from './EncounterPanel';
import { ModelSettings } from './ModelSettings';
import { useModelSettings } from './model-preferences';
import { createEpochDrafts, type EncounterDrafts } from './encounter-drafts';
import { builtinStations } from './builtin-panels';
import { api, ApiError, currentSession, errorMessage, scopeKey, sessionKey, words, workspaceKey, write, type Intent, type Language, type Session } from './workbench-api';

const useView = create<{ queue: boolean }>(() => ({ queue: true }));
type Props = { workspace: WorkspaceView; language: Language; languageSelect: ReactNode; panels?: WorkbenchPanels; draftsFor?: (id: string) => EncounterDrafts };
export function CoreWorkbench({ workspace, language, languageSelect, panels, draftsFor: ownerDrafts }: Props) {
  const draftsFor = useMemo(() => ownerDrafts ?? createEpochDrafts(), [ownerDrafts, workspace.workspaceId, workspace.epoch]);
  const text = words(language);
  const client = useQueryClient();
  const selection = useView();
  const selectionKey = `clinmesh.encounter.${workspace.workspaceId}.${workspace.epoch}`;
  const [selectedId, setSelectedId] = useState(() => z.uuidv7().safeParse(sessionStorage.getItem(selectionKey)).data);
  const [resetPack, setResetPack] = useState(workspace.manifest.packId);
  const style = useThemeFont();
  const stations = Object.entries(builtinStations).filter(([name]) => workspace.operations.some(operation => operation.name === name));
  const clinicAvailable = !stations.length || workspace.operations.some(operation => operation.name === 'encounter.start' || operation.name === 'record.sign');
  const stationOptions = [...(clinicAvailable ? [{ value: 'clinic', label: text('Clinical workbench', '临床工作台') }] : []), ...stations.map(([value, station]) => ({ value, label: station.name[language] }))];
  const [preference, setPreference] = useState({ role: '', value: '' });
  const selected = stationOptions.find(option => preference.role === workspace.roleId && option.value === preference.value) ?? stationOptions[0]!;
  const Station = stations.find(([name]) => name === selected.value)?.[1].component;
  const listKey = scopeKey(workspace, 'encounters');
  const encounters = useQuery({ queryKey: listKey, enabled: !Station, queryFn: ({ signal }) => api('/api/his/encounters', z.array(summarySchema), { signal }) });
  const encounterId = selectedId && (!encounters.data || encounters.data.some(item => item.id === selectedId)) ? selectedId : encounters.data?.at(-1)?.id ?? '';
  const detailKey = scopeKey(workspace, encounterId, 'clinical');
  const detail = useQuery({ queryKey: detailKey, enabled: !Station && Boolean(encounterId), queryFn: ({ signal }) => api(`/api/his/encounters/${encounterId}`, encounterViewSchema, { signal }) });
  function selectEncounter(id: string) { sessionStorage.setItem(selectionKey, id); setSelectedId(id); }
  const refresh = (key: string[]) => client.invalidateQueries({ queryKey: key, exact: true });
  const sameEpoch = (sent: Session, current = client.getQueryData<Session | null>(sessionKey)) => current?.workspaceId === sent.workspaceId && current.epoch === sent.epoch;
  const change = useMutation({ mutationFn: (intent: Intent) => write(workspace, intent),
    onMutate: () => ({ workspace, encounterId }),
    async onSuccess(result, intent, sent) {
      if (!sameEpoch(sent.workspace)) return;
      const listKey = scopeKey(sent.workspace, 'encounters');
      const detailKey = scopeKey(sent.workspace, intent.encounterId ?? intent.targetId ?? sent.encounterId, 'clinical');
      if (intent.name === 'visitor.logout') { client.clear(); client.setQueryData(sessionKey, null); return; }
      if (intent.name === 'workspace.role' || intent.name === 'workspace.reset') {
        const session = sessionSchema.parse(result);
        await refresh(workspaceKey(session));
        client.setQueryData(sessionKey, session);
      } else if (intent.name === 'encounter.start') {
        selectEncounter(z.uuidv7().parse(result.encounterId)); await refresh(listKey);
      } else if (intent.name === 'workspace.advance-time') { await Promise.all([refresh(workspaceKey(sent.workspace)), refresh(detailKey)]); }
      else { await Promise.all([refresh(detailKey), ...(intent.name === 'encounter.complete' ? [refresh(listKey)] : [])]); }
    },
    async onError(error, intent, sent) {
      if (!(error instanceof ApiError) || !sent || !sameEpoch(sent.workspace)) return;
      if (error.status === 401) { client.clear(); client.setQueryData(sessionKey, null); return; }
      if (error.message === 'FIELD_NOT_IN_TEMPLATE' && intent.targetId) {
        await Promise.all([refresh(workspaceKey(sent.workspace)), refresh(scopeKey(sent.workspace, intent.targetId, 'clinical'))]);
        return;
      }
      if (error.status !== 409 && error.status !== 403) return;
      const live = await client.fetchQuery({ queryKey: sessionKey, queryFn: ({ signal }) => currentSession(signal), staleTime: 0 });
      if (!live || !sameEpoch(sent.workspace, live)) return;
      if (intent.name.startsWith('workspace.') || intent.name === 'visitor.logout' || error.status === 403) await refresh(workspaceKey(live));
      if (intent.name === 'encounter.start') await refresh(scopeKey(live, 'encounters'));
      else if (intent.targetId || sent.encounterId) await refresh(scopeKey(live, intent.encounterId ?? intent.targetId ?? sent.encounterId, 'clinical'));
    },
  });
  const allowed = (name: string) => workspace.operations.some(operation => operation.name === name);
  const role = workspace.roles.find(item => item.id === workspace.roleId)!;
  const displayName = Station ? role.name[language] : detail.data?.patient.name ?? text('No patient selected', '未选择患者');
  const queueLabel = text('Case queue', '病例队列');
  const preferences = <div className="workbench-fields">{languageSelect}
    <Field label={text('Color scheme', '主题')}><Select value={style.theme} options={[{ value: 'system', label: text('System', '跟随系统') }, { value: 'light', label: text('Light', '浅色') }, { value: 'dark', label: text('Dark', '深色') }]} onValueChange={theme => { if (theme) style.update({ theme }); }}/></Field>
    <Field label={text('Font scale', '字号')}><Select value={style.fontScale} options={[{ value: 'standard', label: text('Standard', '标准') }, { value: 'larger', label: text('Larger', '较大') }, { value: 'large', label: text('Large', '最大') }]} onValueChange={fontScale => { if (fontScale) style.update({ fontScale }); }}/></Field>
    <Field label={text('Hospital data pack', '医院数据包')}><Select value={resetPack} disabled={!allowed('workspace.reset')} options={workspace.packs.map(pack => ({ value: pack.id, label: pack.name[language] }))} onValueChange={id => { if (id) setResetPack(id); }}/></Field>
    <p>{workspace.manifest.timezone} · {workspace.manifest.currency.code} · {workspace.manifest.currency.minorUnitExponent} {text('currency decimals', '位币种精度')}</p>
    <p>{text('Virtual time', '虚拟时间')} · {workspace.virtualTime}</p>
    {allowed('workspace.advance-time') && <Button disabled={change.isPending} onClick={() => change.mutate({ name: 'workspace.advance-time', version: workspace.clockRevision, fields: { to: new Date(Date.parse(workspace.virtualTime) + 86_400_000).toISOString() } })}>{text('Advance one day', '推进一天')}</Button>}
    {allowed('workspace.reset') ? <InlineConfirmBar trigger={text('Review epoch reset', '复核世代重置')} cancel={text('Keep epoch', '保留当前世代')} confirm={text('Reset epoch', '确认重置世代')} confirmation={text('Close this epoch and open the selected hospital?', '关闭当前世代并装载所选医院？')} onConfirm={() => { change.mutate({ name: 'workspace.reset', version: workspace.clockRevision, fields: { packId: resetPack } }); }}/> : <p>{text('Switch to an administrator role to change hospitals or reset the epoch.', '切换到管理员岗位后可更换医院或重置世代。')}</p>}
    <Button onClick={() => change.mutate({ name: 'visitor.logout', version: workspace.sessionVersion })}>{text('Leave workspace', '退出工作台')}</Button>
  </div>;
  return <WorkspaceCardLayout queueVisible={!Station && selection.queue} queueLabel={queueLabel} closeQueue={text('Close queue', '关闭队列')} header={<>
    <strong>ClinMesh</strong>{!Station && <Button className="desktop-queue" onClick={() => useView.setState({ queue: !selection.queue })}>{selection.queue ? text('Hide queue', '收起队列') : text('Show queue', '展开队列')}</Button>}
    <span className="current-patient">{displayName}</span><div className="topbar-controls">
    {stationOptions.length > 1 && <Field label={text('Workbench', '工作台')}><Select options={stationOptions} value={selected.value} onValueChange={value => { if (value) setPreference({ role: workspace.roleId, value }); }}/></Field>}
    <Menu label={`${text('Role', '岗位')} · ${role.name[language]}`} items={workspace.roles.map(item => ({ value: item.id, label: item.name[language] }))} onAction={roleId => { if (roleId !== role.id) change.mutate({ name: 'workspace.role', version: workspace.sessionVersion, fields: { roleId } }); }}/>
    <ModelSettings language={language}/><Dialog title={text('Workspace settings', '工作台设置')} triggers={[workspace.manifest.name[language]]} close={text('Close settings', '关闭设置')}>{preferences}</Dialog></div>
  </>} queue={!Station && <section className="workbench-queue"><h2>{text('Fixed cases', '固定病例')}</h2>{workspace.cases.map(item => <div key={item.id}>
    <strong>{item.demographics.name}</strong><span>{item.encounterClass === 'outpatient' ? text('Outpatient', '门诊') : text('Inpatient', '住院')}</span>
    <Button disabled={change.isPending || !allowed('encounter.start')} onClick={() => change.mutate({ name: 'encounter.start', targetId: item.id, version: 0, fields: { language } })}>{text('Start', '开诊')} · {item.demographics.name}</Button>
  </div>)}<h2>{text('Encounters', '已开就诊')}</h2>{encounters.data?.map(item => <Button key={item.id} aria-current={item.id === encounterId ? 'true' : undefined} onClick={() => selectEncounter(item.id)}>{item.name} · {item.id.slice(-6)} · {item.status === 'active' ? text('Active', '进行中') : text('Completed', '已完诊')}</Button>)}</section>}>
    {change.isError && <div role="alert"><p>{errorMessage(change.error, language)}</p>{change.error.message.startsWith('LLM_') && <Button onClick={() => useModelSettings.setState({ open: true })}>{text('Configure connection', '配置连接')}</Button>}</div>}
    {encounters.isError && <p role="alert">{errorMessage(encounters.error, language)}</p>}
    {Station ? <Station workspace={workspace} language={language} submit={intent => change.mutateAsync(intent)}/> : detail.isError ? <p role="alert">{errorMessage(detail.error, language)}</p> : detail.data ? <EncounterPanel key={detail.data.id} encounter={detail.data} workspace={workspace} language={language} busy={change.isPending} submit={intent => change.mutateAsync(intent)} panels={panels} drafts={draftsFor(detail.data.id)}/> :
    <section className="workbench-empty"><Badge tone="info">{workspace.manifest.name[language]}</Badge><h1>{text('Outpatient workbench', '门诊工作台')}</h1><p>{text('Start a fixed case from the queue to open its encounter.', '从病例队列选择固定病例开诊。')}</p></section>}
  </WorkspaceCardLayout>;
}
