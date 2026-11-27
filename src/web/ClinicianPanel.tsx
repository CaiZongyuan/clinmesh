import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { z } from 'zod';
import { assistantObservations, assistantView, observationKey, type AssistantFrame } from '../packages/agent-protocol';
import { AgentPanelShell, Badge, Button, Field, InlineConfirmBar, Input, Select, Switch, Textarea } from '../packages/ui-kit';
import { openAssistantChannel, createAmbientQueue } from './assistant-channel';
import { AssistantPushToTalk } from './modules/voice/VoiceControls';
import { createAssistantSurface } from './assistant-surface';
import { modelHeaders, useModelSettings } from './model-preferences';
import { api, ApiError, errorMessage, jsonBody, scopeKey, words, type WorkbenchPanelProps } from './workbench-api';

type Delta = Extract<AssistantFrame, { type: 'delta' }>;
type View = z.infer<typeof assistantView>;
type Input = { content?: string; requestId: string; retryOf?: string };
const receiptSchema = z.object({ clientId: z.uuid(), requestId: z.uuid(), thread: z.int().positive(), phase: z.enum(['sending', 'admitted']).default('admitted'), content: z.string().max(12000).optional(), retryOf: z.uuid().optional(), fingerprint: z.string().optional() });
async function providerFingerprint(headers: Record<string, string>) {
  const fields = Object.entries(headers).filter(([name]) => name !== 'X-ClinMesh-LLM-Api-Key').sort(([left], [right]) => left.localeCompare(right));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(fields)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
function Markdown({ body }: { body: string }) {
  return <div className="assistant-markdown">{body.split(/\n\s*\n/).map((paragraph, index) => <p key={index}>{paragraph.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((part, offset) => part.startsWith('**') ? <strong key={offset}>{part.slice(2, -2)}</strong> : part.startsWith('`') ? <code key={offset}>{part.slice(1, -1)}</code> : part)}</p>)}</div>;
}
export function ClinicianPanel({ encounter, workspace, language, children, edited }: WorkbenchPanelProps & { children: ReactNode; edited: Set<string> }) {
  const text = words(language);
  const client = useQueryClient();
  const root = useRef<HTMLDivElement>(null);
  const [surface] = useState(() => createAssistantSurface(() => root.current, edited, ['clinmesh.edited', workspace.workspaceId, workspace.epoch, encounter.id].join('.')));
  useEffect(() => surface.mount(), [surface]);
  const state = useStore(surface.state);
  const resumeKey = ['clinmesh.assistant', workspace.workspaceId, workspace.epoch, encounter.id, workspace.roleId].join('.');
  const [receipt, setReceipt] = useState(() => {
    try { return receiptSchema.safeParse(JSON.parse(sessionStorage.getItem(resumeKey) ?? 'null')).data; } catch { return undefined; }
  });
  const [open, setOpen] = useState(Boolean(receipt));
  const [started, setStarted] = useState(Boolean(receipt));
  const [ambient, setAmbient] = useState(false);
  const [message, setMessage] = useState('');
  const [title, setTitle] = useState('');
  const [ready, setReady] = useState(false);
  const [stream, setStream] = useState<Delta[]>([]);
  const [retry, setRetry] = useState<Input>();
  const seen = useRef(new Set<string>());
  const [clientId] = useState(() => receipt?.clientId ?? crypto.randomUUID());
  const binding = useMemo(() => ({ workspaceId: workspace.workspaceId, epoch: workspace.epoch, roleId: workspace.roleId, encounterId: encounter.id }), [workspace.workspaceId, workspace.epoch, workspace.roleId, encounter.id]);
  const queryKey = [...scopeKey(workspace, encounter.id, 'assistant', workspace.roleId), clientId];
  const session = useQuery({ queryKey, enabled: started && !receipt, staleTime: Infinity, queryFn: ({ signal }) => api('/api/assistant/sessions', assistantView, { ...jsonBody('POST', { ...binding, action: 'list' }), signal }) });
  const thread = receipt?.thread ?? session.data?.thread;
  const channel = useMemo(() => thread ? { ...binding, thread, clientId } : undefined, [binding, clientId, thread]);
  const manage = useMutation({ mutationFn: (request: object) => api('/api/assistant/sessions', assistantView, jsonBody('POST', { ...binding, thread, ...request })), onSuccess(view) { client.setQueryData(queryKey, view); setAmbient(false); setStream([]); setRetry(undefined); setTitle(''); } });
  const availability = useMutation({ mutationFn: () => {
    const init = jsonBody('POST', binding);
    return api('/api/assistant/availability', z.object({ available: z.literal(true), observations: assistantObservations }), { ...init, mode: 'same-origin', redirect: 'error', headers: { ...init.headers, ...modelHeaders('clinician') } });
  }, onSuccess(result) { seen.current = new Set(result.observations.map(observationKey)); setAmbient(true); } });
  const clearReceipt = () => { sessionStorage.removeItem(resumeKey); setReceipt(undefined); };
  const submit = useMutation({ mutationFn: async (input: Input) => {
    if (!channel) throw Error('ASSISTANT_BRIDGE_DISCONNECTED');
    const headers = modelHeaders('clinician');
    const secret = headers['X-ClinMesh-LLM-Api-Key'];
    if (secret && input.content?.includes(secret)) throw new ApiError(400, 'LLM_SECRET_IN_INPUT');
    const fingerprint = await providerFingerprint(headers);
    const original = receipt?.requestId === input.requestId ? receipt : undefined;
    if (original?.fingerprint && original.fingerprint !== fingerprint) throw new ApiError(409, 'LLM_REJOIN_CONFIGURATION_REQUIRED');
    const sent = original ?? { ...input, thread: channel.thread, clientId, phase: 'sending' as const, fingerprint };
    sessionStorage.setItem(resumeKey, JSON.stringify(sent)); setReceipt(sent);
    const init = jsonBody('POST', { ...channel, requestId: input.requestId, ...(sent.phase === 'sending' && { content: sent.content, retryOf: sent.retryOf }) });
    return api('/api/assistant/turn', assistantView, { ...init, mode: 'same-origin', redirect: 'error', headers: { ...init.headers, ...headers } });
  }, onMutate() { setStream([]); setRetry(undefined); }, onSuccess(view) { client.setQueryData<View>(queryKey, view); clearReceipt(); setStream([]); }, onError(error, attempt) {
    const uncertain = !(error instanceof ApiError) || (error.status >= 500 && !error.message.startsWith('LLM_')) || error.message === 'LLM_REJOIN_CONFIGURATION_REQUIRED';
    if (uncertain) setRetry(attempt);
    else { clearReceipt(); setRetry(attempt.content ? { content: attempt.content, requestId: crypto.randomUUID() } : { retryOf: attempt.requestId, requestId: crypto.randomUUID() }); }
    setAmbient(false);
  } });
  const busy = submit.isPending || manage.isPending;
  const stop = useMutation({ mutationFn: (requestId: string) => api('/api/assistant/stop', z.object({ ok: z.boolean() }), jsonBody('POST', { ...channel, requestId })) });
  const enabled = ready && !busy && Boolean(thread);
  const addDelta = useEffectEvent((frame: Delta) => setStream(chunks => {
    const last = chunks.at(-1);
    return last && last.kind === frame.kind && frame.kind !== 'tool' ? [...chunks.slice(0, -1), { ...frame, text: last.text + frame.text }] : [...chunks, frame];
  }));
  const connected = useEffectEvent((value: boolean) => {
    setReady(value);
    if (value && !submit.isPending) {
      const pending = sessionStorage.getItem(resumeKey);
      if (pending) { const parsed = receiptSchema.safeParse(JSON.parse(pending)); if (parsed.success && parsed.data.clientId === clientId && parsed.data.thread === thread) submit.mutate({ requestId: parsed.data.requestId }); }
    }
  });
  const admitted = useEffectEvent((requestId: string) => {
    const raw = sessionStorage.getItem(resumeKey);
    if (!raw) return;
    const sent = receiptSchema.safeParse(JSON.parse(raw)).data;
    if (sent?.requestId !== requestId) return;
    const accepted = { ...sent, phase: 'admitted' as const, content: undefined, retryOf: undefined };
    sessionStorage.setItem(resumeKey, JSON.stringify(accepted)); setReceipt(accepted);
  });
  useEffect(() => {
    if (!channel || typeof WebSocket === 'undefined') return;
    setReady(false);
    return openAssistantChannel(channel, surface, value => connected(value), frame => addDelta(frame), id => admitted(id));
  }, [channel, surface]);
  const observations = useQuery({ queryKey: [...queryKey, 'observations', thread], enabled: ambient,
    queryFn: ({ signal }) => api('/api/assistant/observations', assistantObservations, { ...jsonBody('POST', binding), signal }), refetchInterval: ambient ? 3000 : false });
  const observe = useEffectEvent(async (events: string[]) => {
    if (!ambient || !enabled) return;
    const content = JSON.stringify({ source: 'ambient', events: events.map(value => JSON.parse(value)), task: 'Review the finalized observations and update relevant drafts using ui_act.' });
    await submit.mutateAsync({ requestId: crypto.randomUUID(), content }).catch(() => {});
  });
  const batch = useMemo(() => ambient ? createAmbientQueue(events => observe(events)) : undefined, [ambient, thread]);
  useEffect(() => () => batch?.close(), [batch]);
  useEffect(() => { batch?.busy(!enabled); }, [batch, enabled]);
  useEffect(() => {
    if (!batch) return;
    const fresh = (observations.data ?? []).filter(event => !seen.current.has(observationKey(event)));
    for (const event of fresh) seen.current.add(observationKey(event));
    batch.add(fresh.map(event => JSON.stringify(event)));
  }, [batch, observations.data]);
  function send(content: string) { if (!enabled || !content.trim()) return; submit.mutate({ requestId: crypto.randomUUID(), content }); setMessage(''); }
  const error = submit.error ?? manage.error ?? stop.error ?? availability.error ?? session.error;
  const sessionLabel = text('Clinician Assistant', '医生助手');
  return <section className="assistant-layout" data-expanded={open}><div className="cm-agent-region" ref={root}>{children}</div>
    <aside className="assistant-rail"><Button data-agent-hidden aria-expanded={open} onClick={() => { setOpen(!open); setStarted(true); surface.state.setState({ unread: 0 }); }}>{sessionLabel} · {busy ? text('Working', '处理中') : text('Ready', '就绪')}{state.unread > 0 && ` · ${state.unread}`}</Button>
      {open && <AgentPanelShell title={sessionLabel} status={<Badge>{ready ? text('Connected', '已连接') : text('Connecting', '连接中')}</Badge>}>
        <div className="assistant-private" data-agent-hidden>{session.data && <><Field label={text('Assistant conversation', '助手会话')}><Select value={String(thread)} disabled={busy} options={session.data.threads.map(item => ({ value: String(item.id), label: item.title }))} onValueChange={id => { if (id) manage.mutate({ action: 'list', thread: Number(id) }); }}/></Field>
          <Field label={text('Conversation title', '会话名称')}><Input value={title} onValueChange={setTitle} maxLength={100}/></Field><div className="cm-actions">
          {(['new', 'rename', 'fork', 'delete'] as const).map((action, index) => <Button key={action} disabled={busy || (action === 'rename' && !title.trim())} onClick={() => manage.mutate({ action, ...(title.trim() && { title: title.trim() }) })}>{[text('New', '新建'), text('Rename', '重命名'), text('Fork', '分叉'), text('Delete', '删除')][index]}</Button>)}</div></>}
        <Switch label={text('Ambient Mode', '环境辅助模式')} checked={ambient} disabled={!ready || availability.isPending} onCheckedChange={checked => { if (checked) availability.mutate(); else setAmbient(false); }}/>
        <div className="assistant-history" aria-live="polite">{[...(session.data?.messages ?? []), ...stream.map((item, index) => ({ id: `live-${index}`, role: item.kind, text: item.text }))].map(item => item.role === 'thinking' || item.role === 'tool' ? <details key={item.id}><summary>{item.role === 'tool' ? text('Tool call', '工具调用') : text('Thinking', '思考过程')}</summary><pre>{item.text}</pre></details> : <div key={item.id}><b>{item.role === 'clinician' ? text('Clinician', '临床人员') : sessionLabel}</b><Markdown body={item.text}/></div>)}</div>
        <Field label={text('Instruction to assistant', '助手指令')}><Textarea value={message} onValueChange={setMessage} maxLength={12000}/></Field><div className="cm-actions"><Button disabled={!enabled || !message.trim()} onClick={() => send(message)}>{text('Send to assistant', '发送给助手')}</Button>
          {submit.isPending && <Button disabled={stop.isPending} onClick={() => stop.mutate(submit.variables.requestId)}>{text('Stop assistant', '停止助手')}</Button>}
          {retry && <Button disabled={!enabled} onClick={() => submit.mutate(retry)}>{text('Retry assistant', '重试助手')}</Button>}</div>
        {session.data?.review && <section role="status"><strong>{text('Check the interrupted interface action', '核对中断的界面动作')}</strong><p>{session.data.review.committed.length ? text('Committed commands', '已提交命令') : text('Check the current draft and clinical facts.', '请核对当前草稿及正式临床记录。')}</p>
          {session.data.review.committed.map((receipt, index) => <p key={index}>{receipt.operation} · {JSON.stringify(receipt.result)}</p>)}<Button disabled={busy} onClick={() => manage.mutate({ action: 'reviewed', reviewId: session.data?.review?.id })}>{text('I reviewed the outcome', '我已核对结果')}</Button></section>}
        {error && <p role="alert">{errorMessage(error, language)} {error.message.startsWith('LLM_') && <Button onClick={() => useModelSettings.setState({ open: true })}>{text('Model settings', '模型设置')}</Button>}</p>}</div>
        <AssistantPushToTalk key={thread} language={language} onText={utterance => setMessage(current => [current.trimEnd(), utterance].filter(Boolean).join(' ').slice(0, 12000))}/>
      </AgentPanelShell>}
      <div className="assistant-private" data-agent-hidden>{state.approval && <InlineConfirmBar key={state.approval.id} requested trigger="" confirmation={state.approval.message} confirm={text('Allow once', '放行一次')} cancel={text('Deny request', '拒绝请求')} onConfirm={() => state.approval?.answer(true)} onDeny={() => state.approval?.answer(false)}/>}
      {state.suggestions.map(item => <section key={item.field}><Badge tone="info">{text('Assistant suggestion', '助手建议')} · {item.label}</Badge><p>{item.args.map(String).join(' ')}</p><Button onClick={() => { void surface.accept(item); }}>{text('Accept suggestion', '采纳建议')}</Button><Button onClick={() => surface.remove(item.field)}>{text('Dismiss', '忽略')}</Button></section>)}
      </div></aside></section>;
}
