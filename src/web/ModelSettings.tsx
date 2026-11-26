import { useMutation } from '@tanstack/react-query';
import { useEffect } from 'react';
import { z } from 'zod';
import { reasoningEffort, type AgentRole } from '../packages/agent-protocol';
import { Badge, Button, Dialog, Field, Input, Select, Switch } from '../packages/ui-kit';
import { modelHeaders, saveModelSettings, useModelSettings } from './model-preferences';
import { api, errorMessage, words, type Language } from './workbench-api';

export function ModelSettings({ language }: { language: Language }) {
  const { values, open } = useModelSettings();
  const text = words(language);
  const test = useMutation({ mutationFn: (role: AgentRole) => api('/api/agents/providers/test', z.object({ ok: z.literal(true) }), { method: 'POST', mode: 'same-origin', redirect: 'error', headers: { 'content-type': 'application/json', ...modelHeaders(role) }, body: JSON.stringify({ role }) }) });
  useEffect(() => {
    const sync = () => { if (location.hash === '#model-settings') useModelSettings.setState({ open: true }); };
    sync(); window.addEventListener('hashchange', sync); return () => window.removeEventListener('hashchange', sync);
  }, []);
  const update = (change: Parameters<typeof saveModelSettings>[0]) => { test.reset(); saveModelSettings(change); };
  return <>{values.mock && <Badge tone="warning">Mock Mode</Badge>}
    <Dialog title={text('Model and provider settings', '模型与 Provider 设置')} triggers={[text('Model settings', '模型设置')]} close={text('Close model settings', '关闭模型设置')} open={open} onOpenChange={next => {
      useModelSettings.setState({ open: next }); if (!next && location.hash === '#model-settings') history.replaceState(null, '', location.pathname + location.search);
    }}><div className="workbench-fields">
      <Field label="Provider"><Select value={values.provider || 'host'} options={[{ value: 'host', label: text('Server default', '服务端默认') }, { value: 'openai', label: 'OpenAI-compatible' }, { value: 'anthropic', label: 'Anthropic' }, { value: 'gemini', label: 'Gemini' }]} onValueChange={provider => { if (provider) update({ provider: provider === 'host' ? '' : provider, apiKey: '', baseUrl: '' }); }}/></Field>
      <Field label="Base URL"><Input value={values.baseUrl} onValueChange={baseUrl => update({ baseUrl })}/></Field>
      <Field label={text('API key', 'API 密钥')} description={text('Stored in this browser. Sent only with a model request.', '仅保存在本浏览器，随模型请求发送。')}><Input type="password" data-agent-secret autoComplete="off" value={values.apiKey} onValueChange={apiKey => update({ apiKey })}/></Field>
      <Field label={text('Default model', '默认模型')}><Input value={values.model} onValueChange={model => update({ model })}/></Field>
      {(['patient', 'clinician'] as const).map(agent => <fieldset key={agent}><legend>{agent === 'patient' ? text('Patient Agent', '患者智能体') : text('Clinician Assistant', '临床助手')}</legend>
        <Field label={agent === 'patient' ? text('Patient model override', '患者模型覆写') : text('Clinician model override', '助手模型覆写')}><Input value={values[agent].model} onValueChange={model => update({ [agent]: { ...values[agent], model } })}/></Field>
        <Field label={agent === 'patient' ? text('Patient reasoning', '患者思考强度') : text('Clinician reasoning', '助手思考强度')}><Select value={values[agent].effort || 'default'} options={[{ value: 'default', label: text('Default', '默认') }, ...reasoningEffort.options.map(value => ({ value, label: value }))]} onValueChange={effort => { if (effort) update({ [agent]: { ...values[agent], effort: effort === 'default' ? '' : effort } }); }}/></Field>
        <Button disabled={test.isPending} onClick={() => test.mutate(agent)}>{agent === 'patient' ? text('Test patient provider', '测试患者模型连接') : text('Test clinician provider', '测试助手模型连接')}</Button>
      </fieldset>)}
      <Switch label="Mock Mode" checked={values.mock} onCheckedChange={mock => update({ mock })}/>
      {test.isError && <p role="alert">{errorMessage(test.error, language)}</p>}{test.isSuccess && <p role="status">{text('Connection successful.', '连接成功。')}</p>}
    </div></Dialog></>;
}
