import { createContext, useContext, useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { EncounterView } from '../../../packages/clinical-core';
import { Badge, Button, ConfirmActionButton, Dialog, Field, Input, Select, Switch } from '../../../packages/ui-kit';
import { errorMessage, words, type Language } from '../../workbench-api';
import { createVoiceDesk } from './voice-desk';
import type { Binding } from './bailian-client';

const Desk = createContext<ReturnType<typeof createVoiceDesk> | null>(null);
export function VoiceWorkbench({ epoch, encounterId, children }: Binding & { children: ReactNode }) {
  const [desk] = useState(() => createVoiceDesk({ epoch, encounterId }));
  useEffect(() => () => desk.close(), [desk]);
  return <Desk.Provider value={desk}>{children}</Desk.Provider>;
}
type Controls = { desk: ReturnType<typeof createVoiceDesk>; language: Language };
function VoiceSettings({ desk, language }: Controls) {
  const settings = useStore(desk.state, state => state.settings);
  const text = words(language);
  return <Dialog title={text('Voice settings', '语音设置')} triggers={[text('Voice settings', '语音设置')]} close={text('Close voice settings', '关闭语音设置')}><div className="workbench-fields">
    <Field label={text('Voice engine', '语音引擎')}><Select options={[{ value: 'bailian', label: text('Bailian', '百炼') }, { value: 'browser', label: 'Browser Web Speech' }]} value={settings.engine} onValueChange={engine => { if (engine) desk.configure({ engine }); }}/></Field>
    <Field label={text('Bailian voice key', '百炼语音密钥')} description={text('Stored in this browser. Leave empty to use the host key.', '密钥仅存本浏览器。留空使用宿主密钥。')}><Input type="password" data-agent-secret autoComplete="off" maxLength={2048} value={settings.token} onValueChange={token => desk.configure({ token })}/></Field>
    <Switch label={text('Read patient replies aloud', '播报患者回复')} checked={settings.aloud} onCheckedChange={aloud => desk.configure({ aloud })}/>
  </div></Dialog>;
}

type ConsultationProps = { language: Language; encounter: EncounterView; busy: boolean; ask(text: string): Promise<unknown>; recover(text: string): void };
export function ConsultationMic(props: ConsultationProps) {
  const desk = useContext(Desk);
  return desk && <MainMic {...props} desk={desk}/>;
}
function MainMic({ desk, language, encounter, busy, ask, recover }: ConsultationProps & Controls) {
  const state = useStore(desk.state);
  const text = words(language), lang = language === 'en' ? 'en-US' : 'zh-CN';
  const active = state.mic === 'consultation' && !state.finishing;
  const [finals, setFinals] = useState<string[]>([]);
  const sending = useRef(false);
  const latestPatient = encounter.turns.findLast(turn => turn.speaker === 'patient');
  const heard = useRef(latestPatient?.id);
  const deliver = useEffectEvent(async (utterance: string) => {
    if (sending.current) return;
    sending.current = true;
    try { await ask(utterance); } catch { recover(utterance); }
    finally { sending.current = false; setFinals(queue => queue.slice(1)); }
  });
  useEffect(() => { if (finals[0] && !busy && !encounter.replyPending) void deliver(finals[0]); }, [busy, encounter.replyPending, finals]);
  useEffect(() => {
    if (!latestPatient || heard.current === latestPatient.id) return;
    heard.current = latestPatient.id;
    void desk.speak(latestPatient.content, lang);
  }, [desk, lang, latestPatient]);
  useEffect(() => () => { desk.mute('consultation'); desk.interrupt(); }, [desk]);
  return <section aria-label={text('Consultation voice', '诊室语音')}><div className="cm-actions voice-actions">
    <Badge tone={active && state.ready ? 'success' : 'warning'}>{active ? state.ready ? text('Consultation mic live', '诊室主麦采集中') : text('Opening consultation mic', '正在开启诊室主麦') : text('Consultation mic muted', '诊室主麦已静音')}</Badge>
    <span>{state.settings.engine === 'browser' ? 'Browser Web Speech' : text('Bailian', '百炼')}</span>
    {active ? <Button onClick={() => desk.release('consultation')}>{text('Mute consultation mic', '静音诊室主麦')}</Button> : <ConfirmActionButton confirmation={text('Start recording clinician questions?', '开始录制医生问诊？')} disabled={state.mic === 'assistant'} onClick={() => desk.start('consultation', lang, utterance => setFinals(queue => [...queue, utterance]))}>{text('Start consultation mic', '开启诊室主麦')}</ConfirmActionButton>}
    <Button disabled={!state.playing} onClick={desk.interrupt}>{text('Interrupt patient audio', '打断患者播报')}</Button><VoiceSettings desk={desk} language={language}/>
  </div>{active && state.partial && <p aria-live="polite">{state.partial}</p>}{state.errorChannel === 'consultation' && state.error && <p role="alert">{errorMessage(Error(state.error), language)}</p>}</section>;
}

export function AssistantPushToTalk({ language, onText }: { language: Language; onText(text: string): void }) {
  const desk = useContext(Desk);
  return desk && <AssistantMic desk={desk} language={language} onText={onText}/>;
}
function AssistantMic({ desk, language, onText }: Controls & { onText(text: string): void }) {
  const state = useStore(desk.state), text = words(language);
  const active = state.mic === 'assistant';
  const start = () => { if (desk.state.getState().mic !== 'assistant') desk.start('assistant', language === 'en' ? 'en-US' : 'zh-CN', onText); };
  const release = () => desk.release('assistant');
  useEffect(() => () => desk.mute('assistant'), [desk]);
  return <div><Button data-agent-confirm={text('Dictate a private assistant instruction?', '听写助手专用指令？')} aria-pressed={active && !state.finishing}
    onPointerDown={event => { if (event.button === 0) { event.currentTarget.setPointerCapture?.(event.pointerId); start(); } }} onPointerUp={release} onLostPointerCapture={release} onPointerCancel={() => desk.mute('assistant')}
    onKeyDown={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); if (!event.repeat) start(); } }} onKeyUp={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); release(); } }} onBlur={release}
    onClick={(event, details) => { if (details.source === 'agent' || event.detail === 0) { if (active) release(); else start(); } }}>
    {text('Hold to dictate to assistant', '按住向助手说话')}</Button>
    {active && <p role="status">{state.finishing ? text('Finishing assistant dictation', '正在完成助手转写') : state.ready ? text('Assistant mic live', '助手麦采集中') : text('Opening assistant mic', '正在开启助手麦')} {state.partial}</p>}
    {state.errorChannel === 'assistant' && state.error && <p role="alert">{errorMessage(Error(state.error), language)}</p>}
  </div>;
}
