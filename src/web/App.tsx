import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect, useState } from 'react';
import { create } from 'zustand';
import logo from '../../assets/logo.webp';
import { workspaceSchema } from '../packages/clinical-core';
import { sessionSchema } from '../packages/platform';
import { Button, Card, Field, Input, Select } from '../packages/ui-kit';
import { CoreWorkbench } from './CoreWorkbench';
import type { WorkbenchPanels } from './EncounterPanel';
import { api, currentSession, errorMessage, jsonBody, sessionKey, words, workspaceKey, type Language, type Session } from './workbench-api';

const useLocale = create<{ language?: Language; choose(language: Language): void }>(set => ({ choose: language => set({ language }) }));
function LanguageSelect({ language }: { language: Language }) {
  useLayoutEffect(() => { document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'; }, [language]);
  return <Field label={words(language)('Language', '界面语言')}><Select value={language} options={[{ value: 'en', label: 'English' }, { value: 'zh', label: '简体中文' }]} onValueChange={value => { if (value) useLocale.getState().choose(value); }} /></Field>;
}

function VisitorGate({ language }: { language: Language }) {
  const text = words(language);
  const [passcode, setPasscode] = useState('');
  const client = useQueryClient();
  const enter = useMutation({ mutationFn: () => api('/api/auth/visitor/enter', sessionSchema, jsonBody('POST', { passcode })), onSuccess: session => { client.setQueryData(sessionKey, session); } });
  return <main className="gate-page"><div className="gate-shell">
    <header className="gate-brand"><img src={logo} alt="" width="38" height="38"/><strong>ClinMesh</strong><LanguageSelect language={language}/></header>
    <Card className="gate-card"><h1>{text('Enter your workspace', '进入临床工作台')}</h1>
      <p>{text('Your workspace keeps your teaching cases and clinical records separate from other visitors.', '每位访客拥有独立的教学病例和诊疗记录。')}</p>
      <form onSubmit={event => { event.preventDefault(); enter.mutate(); }}><Field label={text('Visitor passcode', '访客口令')}><Input type="password" autoComplete="current-password" data-agent-secret value={passcode} onValueChange={setPasscode}/></Field>
        <Button type="submit" disabled={enter.isPending} data-variant="solid">{text('Enter workspace', '进入工作台')}</Button></form>
      {enter.isError && <p role="alert">{errorMessage(enter.error, language)}</p>}
    </Card>
  </div></main>;
}

function WorkspaceLoader({ session, preferred, panels }: { session: Session; preferred?: Language; panels?: WorkbenchPanels }) {
  const state = useQuery({ queryKey: workspaceKey(session), queryFn: ({ signal }) => api('/api/workspace', workspaceSchema, { signal }), staleTime: 15 * 60_000 });
  if (state.isError) return <p role="alert">{errorMessage(state.error, preferred ?? 'en')}</p>;
  if (!state.data) return <p role="status">{words(preferred ?? 'en')('Opening workspace…', '正在打开工作台…')}</p>;
  const language = preferred ?? (state.data.manifest.defaultLocale.startsWith('zh') ? 'zh' : 'en');
  return <CoreWorkbench key={state.data.epoch} workspace={{ ...state.data, sessionVersion: session.sessionVersion }} language={language} languageSelect={<LanguageSelect language={language}/>} panels={panels}/>;
}

export function App({ panels }: { panels?: WorkbenchPanels } = {}) {
  const preferred = useLocale(state => state.language);
  const session = useQuery({ queryKey: sessionKey, queryFn: ({ signal }) => currentSession(signal), staleTime: 60_000 });
  if (session.isError) return <p role="alert">{errorMessage(session.error, preferred ?? 'en')}</p>;
  if (session.isPending) return <p role="status">{words(preferred ?? 'en')('Checking session…', '正在检查会话…')}</p>;
  return session.data ? <WorkspaceLoader session={session.data} preferred={preferred} panels={panels}/> : <VisitorGate language={preferred ?? 'en'}/>;
}
