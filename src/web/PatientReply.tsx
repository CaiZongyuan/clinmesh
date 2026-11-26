import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { replyEvent, replyState, type ReplyProgress } from '../packages/agent-protocol';
import { Button } from '../packages/ui-kit';
import { modelHeaders, useModelSettings } from './model-preferences';
import { api, ApiError, errorMessage, scopeKey, words, type WorkbenchPanelProps } from './workbench-api';

type Reply = z.infer<typeof replyState>;
async function follow(run: Reply, signal: AbortSignal, show: (event: z.infer<typeof replyEvent>) => void) {
  let cursor = '';
  let delay = 200;
  while (!signal.aborted) {
    try {
      const response = await fetch(`/api/agents/sessions/${run.sessionId}/events?questionId=${run.questionId}`, { signal, mode: 'same-origin', redirect: 'error', headers: { ...modelHeaders('patient'), ...(cursor ? { 'last-event-id': cursor } : {}) } });
      if (!response.ok) throw new ApiError(response.status, z.object({ code: z.string() }).parse(await response.json()).code);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const lines = buffer.slice(0, boundary).split('\n');
            buffer = buffer.slice(boundary + 2);
            const data = lines.find(line => line.startsWith('data: '));
            if (!data) continue;
            const event = replyEvent.parse(JSON.parse(data.slice(6)));
            if (event.questionId !== run.questionId || event.sessionId !== run.sessionId || event.attempt !== run.attempt) return;
            cursor = lines.find(line => line.startsWith('id: '))?.slice(4) ?? cursor;
            show(event);
            if (event.status !== 'running' && event.status !== 'progress' && event.status !== 'text') return;
          }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch (error) { if ((error instanceof ApiError && error.status < 500) || (error instanceof Error && error.message === 'LLM_HTTPS_REQUIRED')) throw error; }
    if (signal.aborted) return;
    await new Promise(resolve => setTimeout(resolve, delay));
    delay = Math.min(3000, delay * 2);
  }
}

function ReplyFailure({ code, language }: { code: string; language: WorkbenchPanelProps['language'] }) {
  return <><p role="alert">{errorMessage(new Error(code), language)}</p>{code.startsWith('LLM_') && <Button onClick={() => useModelSettings.setState({ open: true })}>{words(language)('Edit reply provider', '调整患者回复模型')}</Button>}</>;
}

function LiveReply({ run, refresh, language }: { run: Reply; refresh(): void; language: WorkbenchPanelProps['language'] }) {
  const [content, setContent] = useState('');
  const [activity, setActivity] = useState<ReplyProgress>();
  const [error, setError] = useState<Error>();
  const settings = useModelSettings(state => state.open);
  const { sessionId, questionId, attempt } = run;
  useEffect(() => {
    if (settings) return;
    const controller = new AbortController();
    void follow({ sessionId, questionId, attempt, status: 'running', code: null }, controller.signal, event => {
      if (controller.signal.aborted) return;
      setError(undefined);
      if (event.status === 'text') setContent(event.content);
      if (event.status === 'progress') setActivity(event);
    }).then(() => { if (!controller.signal.aborted) refresh(); }, error => { if (!controller.signal.aborted) setError(error); });
    return () => controller.abort();
  }, [sessionId, questionId, attempt, settings, refresh]);
  const text = words(language);
  return <>{!content && activity && <p role="status">{activity.phase === 'checking' ? text('Checking the patient reply.', '正在校验患者回复。') : text('Receiving the patient reply', '正在接收患者回复')} {activity.phase === 'receiving' && `· ${activity.chunks}`}</p>}{content && <p aria-live="polite">{content}</p>}{error && <ReplyFailure code={error.message} language={language}/>}</>;
}

export function PatientReply(props: WorkbenchPanelProps & { busy: boolean; editable: boolean }) {
  const { encounter, workspace, language, editable } = props;
  const text = words(language);
  const client = useQueryClient();
  const lastQuestion = encounter.turns.findLast(turn => turn.speaker === 'clinician');
  const key = scopeKey(workspace, encounter.id, 'reply');
  const latest = useQuery({ queryKey: [...key, encounter.version], enabled: !!lastQuestion && encounter.status === 'active', queryFn: ({ signal }) => api(`/api/his/encounters/${encounter.id}/consultation/reply`, replyState.nullable(), { signal }) });
  const run = latest.data;
  const refresh = useCallback(() => { void client.invalidateQueries({ queryKey: [workspace.workspaceId, workspace.epoch, encounter.id] }); }, [client, workspace.workspaceId, workspace.epoch, encounter.id]);
  if (!run || !editable || encounter.status !== 'active') return null;
  const command = (action: 'stop' | 'retry') => { void props.submit({ name: `consultation.${action}`, targetId: encounter.id, version: encounter.version, fields: { questionId: run.questionId, attempt: run.attempt } }).catch(() => {}); };
  if (run.status === 'running' || (encounter.replyPending && run.attempt > 0)) return <><LiveReply key={`${run.questionId}/${run.attempt}`} run={run} refresh={refresh} language={language}/><Button disabled={props.busy || run.status !== 'running'} onClick={() => command('stop')}>{text('Stop patient reply', '停止患者回复')}</Button></>;
  if (run.status === 'failed' || run.status === 'stopped') return <>{run.code ? <ReplyFailure code={run.code} language={language}/> : <p role="status">{text('Patient reply stopped.', '患者回复已停止。')}</p>}
    <Button disabled={props.busy} onClick={() => command('retry')}>{text('Retry patient reply', '重试患者回复')}</Button></>;
  return null;
}
