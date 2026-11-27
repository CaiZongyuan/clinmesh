import { createStore } from 'zustand/vanilla';
import { z } from 'zod';
import type { AssistantBinding, BrowserRequest } from '../packages/agent-protocol';
import { captureAssistantCommands } from './assistant-command';
import { createClinMeshUiAgent, mountClinMeshWebMCP } from '../packages/ui-kit';

type Suggestion = { field: string; ref: string; action: string; args: unknown[]; label: string };
type SurfaceState = { suggestions: Suggestion[]; approval?: { id: string; message: string; answer(value: boolean): void }; protected: string[]; unread: number };
export function createAssistantSurface(root: () => HTMLElement | null, edited: Set<string>, storageKey?: string) {
  if (storageKey) {
    try { for (const field of z.array(z.string().max(250)).parse(JSON.parse(sessionStorage.getItem(storageKey) ?? '[]'))) edited.add(field); } catch {}
  }
  function mark(field: string) {
    if (edited.has(field)) return;
    edited.add(field);
    if (storageKey) sessionStorage.setItem(storageKey, JSON.stringify([...edited].filter(id => /^(record|diagnosis|investigation|prescription):/.test(id))));
  }
  const state = createStore<SurfaceState>(() => ({ suggestions: [], protected: [], unread: 0 }));
  const fieldKey = (element: Element | null | undefined, fallback?: string) => element?.closest<HTMLElement>('[data-assistant-field]')?.dataset.assistantField || fallback;
  let agentTarget: HTMLElement | undefined;
  const agentOwnsFocus = (element: Element | null) => Boolean(element && agentTarget && (agentTarget.contains(element) || (fieldKey(agentTarget) && fieldKey(agentTarget) === fieldKey(element))));
  const protectedFields = () => {
    const focused = document.activeElement;
    const field = !agentOwnsFocus(focused) && root()?.contains(focused) && (focused?.matches('input, textarea, [role="combobox"], [contenteditable]') || focused?.closest('[data-assistant-field]')) ? fieldKey(focused, focused?.getAttribute('aria-label') ?? focused?.closest('[data-part="root"]')?.textContent?.trim()) : undefined;
    state.setState({ protected: [...new Set([...edited, ...(field ? [field] : [])])] });
  };
  let accepted: Suggestion | undefined;
  let capture: ReturnType<typeof captureAssistantCommands> | undefined;
  let alive = true;
  let glow: ReturnType<typeof setTimeout> | undefined;
  const agent = createClinMeshUiAgent({ within: () => alive ? root() : null,
    beforeAction(step, element) {
      capture?.disarm();
      const field = fieldKey(element, step.label || step.ref)!;
      const focus = document.activeElement;
      const adopted = accepted?.ref === step.ref && accepted.action === step.action && JSON.stringify(accepted.args) === JSON.stringify(step.args);
      if (adopted) accepted = undefined;
      const focused = focus && !agentOwnsFocus(focus) && ((element.contains(focus) && focus.matches('textarea,input,[role="combobox"]')) || fieldKey(focus) === field);
      if (!step.confirm && ['setValue', 'clear', 'increment', 'decrement', 'setChecked', 'toggle', 'press'].includes(step.action) && !adopted && (edited.has(field) || focused)) {
        const suggestion = { field, ref: step.ref, action: step.action, args: step.args, label: step.label ?? field };
        state.setState(current => ({ suggestions: [...current.suggestions.filter(item => item.field !== field), suggestion], unread: current.unread + 1 }));
        return false;
      }
      agentTarget = element;
      const region = root();
      if (region) { region.dataset.agentActive = 'true'; clearTimeout(glow); glow = setTimeout(() => { region.dataset.agentActive = 'false'; }, 1500); }
      return true;
    },
    requestApproval(message, { signal }) {
      if (signal.aborted || !alive) return false;
      return new Promise<boolean>(resolve => {
        const answer = (value: boolean) => { signal.removeEventListener('abort', abort); state.setState({ approval: undefined }); if (value && alive && !signal.aborted) capture?.approve(); resolve(value && alive && !signal.aborted); };
        const abort = () => answer(false);
        state.getState().approval?.answer(false); signal.addEventListener('abort', abort, { once: true });
        state.setState({ approval: { id: crypto.randomUUID(), message, answer } });
      });
    } });
  const remove = (field: string) => state.setState(current => ({ suggestions: current.suggestions.filter(item => item.field !== field) }));
  return { state, agent, remove,
    mount() {
      alive = true;
      protectedFields();
      const unregister = mountClinMeshWebMCP(agent);
      const unobserve = agent.subscribe(change => {
        const element = agent.elementOf(change.ref);
        if (!root()?.contains(element) || !['value', 'checked', 'pressed'].includes(change.key)) return;
        if (change.source === 'agent') { state.setState(current => ({ unread: current.unread + 1 })); return; }
        const field = fieldKey(element);
        if (field && ['keyboard', 'pen', 'mouse', 'touch', 'virtual'].includes(change.source)) { mark(field); protectedFields(); }
      });
      function humanIntent() { agentTarget = undefined; capture?.disarm(); protectedFields(); }
      function input(event: Event) { if (event.target instanceof Element && root()?.contains(event.target) && (event.isTrusted || !agentOwnsFocus(event.target))) { const key = fieldKey(event.target); if (key) { mark(key); protectedFields(); } } }
      function editList(event: Event) { humanIntent(); if (event.target instanceof Element && event.target.closest('button') && event.target.closest('[data-assistant-list]') && !event.target.closest('[data-agent-confirm]')) input(event); }
      document.addEventListener('pointerdown', editList, true);
      document.addEventListener('keydown', humanIntent, true);
      document.addEventListener('input', input, true); document.addEventListener('focusin', protectedFields); document.addEventListener('focusout', protectedFields);
      return () => { alive = false; state.getState().approval?.answer(false); clearTimeout(glow); unobserve(); unregister(); document.removeEventListener('pointerdown', editList, true); document.removeEventListener('keydown', humanIntent, true); document.removeEventListener('input', input, true); document.removeEventListener('focusin', protectedFields); document.removeEventListener('focusout', protectedFields); };
    },
    async accept(suggestion: Suggestion) {
      const target = agent.elementOf(suggestion.ref);
      if (!target || !root()?.contains(target) || fieldKey(target, suggestion.label) !== suggestion.field) return;
      accepted = suggestion;
      const { ref, action, args } = suggestion;
      try { const result = await agent.act({ steps: [{ ref, action, args }] }); if (result.ok) remove(suggestion.field); } finally { accepted = undefined; }
    },
    async call(request: BrowserRequest, signal: AbortSignal, confirmation?: { binding: AssistantBinding; token: string }) {
      if (!alive || !root() || signal.aborted) return { error: 'ASSISTANT_BINDING_CHANGED' };
      if (request.tool === 'ui_act') {
        const commands = confirmation && captureAssistantCommands(confirmation.binding, confirmation.token);
        capture = commands;
        try {
          const { ok, error } = await agent.act(request.args, { signal });
          const reviewRequired = await commands?.finish();
          return { ok, ...(error && { error }), ...(reviewRequired && { reviewRequired }) };
        } catch (error) { await commands?.finish(); throw error; }
        finally { if (capture === commands) capture = undefined; }
      }
      const result = request.tool === 'ui_snapshot' ? agent.snapshot() : await agent.query(request.args);
      return Array.isArray(result) ? result.slice(0, 48).map(({ ref, label, component, actions, items, confirm, value }) => ({ ref, label, component, actions, items: items?.slice(0, 12), confirm, value })) : result;
    },
  };
}
export type AssistantSurface = ReturnType<typeof createAssistantSurface>;
