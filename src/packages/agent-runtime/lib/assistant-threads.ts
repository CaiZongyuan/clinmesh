import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc, defineDocFamily, type Conversation, type ConversationId, type Harness } from '@earendil-works/pi-durable';
import { z } from 'zod';
import { assistantSessionCommand, assistantView } from '../../agent-protocol';
import { CoreError } from '../../platform';

const context = BACKGROUND_CONTEXT;
const directory = defineDoc({ scope: 'session', kind: 'clinmesh.assistant-threads', version: 1, initial: (): { threads: { id: number; roleId: string; title: string }[] } => ({ threads: [] }), checkpointWhen: () => true });
const admission = defineDoc({ scope: 'conversation', history: 'latest', fork: 'initial', kind: 'clinmesh.assistant-admission', version: 1, initial: () => ({ requestId: '', clientId: '', provider: '', content: '' }), checkpointWhen: () => true });
const receipts = defineDocFamily({ scope: 'session', family: true, kind: 'clinmesh.assistant-receipt', version: 1, initial: () => ({ clientId: '', provider: '', content: '', error: '', status: 0 }), checkpointWhen: () => true });
const browserAction = defineDoc({ scope: 'conversation', history: 'latest', fork: 'initial', kind: 'clinmesh.browser-action', version: 1, initial: () => ({ token: '' }), checkpointWhen: () => true });
export function pendingBrowserAction(conversation: Conversation) { return conversation.commit(async tx => (await tx.doc(browserAction, conversation.id)).token, context); }
export function reserveBrowserAction(conversation: Conversation) {
  return conversation.commit(async tx => {
    const action = await tx.doc(browserAction, conversation.id);
    if (action.token) throw new CoreError(409, 'ASSISTANT_UI_REVIEW_REQUIRED');
    return action.token = crypto.randomUUID();
  }, context);
}
export function settleBrowserAction(conversation: Conversation, token: string) {
  return conversation.commit(async tx => {
    const action = await tx.doc(browserAction, conversation.id);
    if (!token || action.token !== token) throw new CoreError(409, 'ASSISTANT_UI_REVIEW_CHANGED');
    action.token = '';
  }, context);
}
const status = z.union([z.literal(400), z.literal(401), z.literal(403), z.literal(404), z.literal(409), z.literal(422), z.literal(429), z.literal(502), z.literal(503), z.literal(504)]);
export function failTurn(conversation: Conversation, requestId: string, failure: CoreError) {
  return conversation.commit(async tx => { const receipt = await tx.doc(receipts, `${conversation.id}/${requestId}`, null); if (!receipt.error) { receipt.error = failure.code; receipt.status = failure.status; } }, context);
}
export function markTurnStopped(conversation: Conversation, input: { requestId: string; clientId: string }) {
  return conversation.commit(async tx => {
    const submission = await tx.submissionByRequest(conversation.id, input.requestId);
    const receipt = await tx.doc(receipts, `${conversation.id}/${input.requestId}`, null);
    if (!receipt.clientId) throw new CoreError(404, 'ASSISTANT_REQUEST_NOT_FOUND');
    if (receipt.clientId !== input.clientId) throw new CoreError(403, 'ASSISTANT_CLIENT_MISMATCH');
    if (receipt.error === 'ASSISTANT_STOPPED') return;
    if (receipt.error || submission?.status === 'done' || submission?.status === 'unanswered') throw new CoreError(409, 'ASSISTANT_REQUEST_SETTLED');
    receipt.status = 409; receipt.error = 'ASSISTANT_STOPPED';
  }, context);
}
export async function drainStoppedTurn(harness: Harness, conversation: Conversation, requestId?: string) {
  const state = await harness.inspect(context);
  if (state.submissions.length !== 1) return state;
  const [pending] = state.submissions;
  if (!pending?.requestId || pending.conversationId !== conversation.id || (requestId && pending.requestId !== requestId)) return state;
  const stopped = await conversation.commit(async tx => (await tx.doc(receipts, `${conversation.id}/${pending.requestId}`, null)).error === 'ASSISTANT_STOPPED', context);
  if (!stopped) return state;
  await conversation.abort(context);
  return harness.inspect(context);
}
export function admitTurn(conversation: Conversation, input: { requestId: string; clientId: string; content?: string; retryOf?: string }, provider: string) {
  return conversation.commit(async tx => {
    const receipt = await tx.doc(receipts, `${conversation.id}/${input.requestId}`, null);
    if (receipt.clientId) {
      if (receipt.clientId !== input.clientId || (input.content && receipt.content !== input.content)) throw new CoreError(409, 'LLM_REJOIN_CONFIGURATION_REQUIRED');
      if (receipt.error) throw new CoreError(status.parse(receipt.status), receipt.error);
      if (receipt.provider !== provider) throw new CoreError(409, 'LLM_REJOIN_CONFIGURATION_REQUIRED');
      return receipt.content;
    }
    const previous = await tx.doc(admission, conversation.id);
    let content = input.content;
    if (previous.requestId === input.requestId) {
      if (previous.clientId !== input.clientId || previous.provider !== provider || (input.content && previous.content !== input.content)) throw new CoreError(409, 'LLM_REJOIN_CONFIGURATION_REQUIRED');
      content = previous.content;
    }
    if (input.retryOf) {
      const prior = await tx.doc(receipts, `${conversation.id}/${input.retryOf}`, null);
      if (prior.clientId !== input.clientId || !prior.error) throw new CoreError(409, 'ASSISTANT_RETRY_UNAVAILABLE');
      content = prior.content;
    }
    if (!content) throw new CoreError(409, 'ASSISTANT_REJOIN_REQUIRED');
    Object.assign(receipt, { clientId: input.clientId, content, provider });
    return content;
  }, context);
}
async function directoryFor(harness: Harness, roleId: string) {
  return harness.commit(async tx => (await tx.doc(directory)).threads.filter(thread => thread.roleId === roleId).map(thread => ({ id: thread.id, title: thread.title })), context);
}
export async function boundThread(harness: Harness, roleId: string, id: number) {
  const threads = await directoryFor(harness, roleId);
  const thread = threads.find(item => item.id === id);
  const conversation = thread && await harness.conversation(thread.id as ConversationId, context);
  if (!conversation) throw new CoreError(404, 'ASSISTANT_THREAD_NOT_FOUND');
  return conversation;
}
export async function threadView(harness: Harness, input: z.infer<typeof assistantSessionCommand>) {
  const { roleId, title, action } = input;
  const previous = await directoryFor(harness, roleId);
  let id = input.thread ?? previous.at(-1)?.id;
  let selected = id === undefined ? undefined : await boundThread(harness, roleId, id);
  if (action === 'reviewed') {
    if (!selected || !input.reviewId) throw new CoreError(400, 'ASSISTANT_REVIEW_REQUIRED');
    await settleBrowserAction(selected, input.reviewId);
  }
  if (action === 'delete' || action === 'rename') {
    if (!selected || (action === 'rename' && !title)) throw new CoreError(400, 'ASSISTANT_THREAD_REQUIRED');
    await harness.commit(async tx => {
      const doc = await tx.doc(directory);
      const index = doc.threads.findIndex(item => item.id === id && item.roleId === roleId);
      if (action === 'delete') doc.threads.splice(index, 1); else doc.threads[index]!.title = title!;
    }, context);
    if (action === 'delete') {
      id = previous.filter(item => item.id !== id).at(-1)?.id;
      selected = id === undefined ? undefined : await boundThread(harness, roleId, id);
    }
  }
  if (!selected || action === 'new' || action === 'fork') {
    if (previous.length >= 64 && action !== 'delete') throw new CoreError(409, 'ASSISTANT_THREAD_LIMIT');
    const latest = selected && action === 'fork' ? await selected.commit(tx => tx.latestEntryId(selected!.id), context) : undefined;
    const options = { ownership: { kind: 'ownerless' as const } };
    selected = selected && latest ? await selected.fork(latest, options, context) : await harness.createConversation(options, context);
    const thread = { id: Number(selected.id), roleId, title: title ?? (action === 'fork' ? 'Fork' : 'Consultation notes') };
    await harness.commit(async tx => { (await tx.doc(directory)).threads.push(thread); }, context);
  }
  const messages = await threadMessages(selected);
  return assistantView.parse({ threads: await directoryFor(harness, roleId), thread: selected.id, messages });
}
async function threadMessages(conversation: Conversation) {
  const page = await conversation.entries({ order: 'descending' }, 128, undefined, context);
  const messages = [];
  for (const entry of page.items.toReversed()) {
    for (const message of entry.model ?? []) {
      if (message.role === 'user') messages.push({ id: `${entry.id}/user`, role: 'clinician', text: typeof message.content === 'string' ? message.content : message.content.filter(item => item.type === 'text').map(item => item.text).join('') });
      if (message.role === 'assistant') for (const [index, block] of message.content.entries()) {
        const role = block.type === 'toolCall' ? 'tool' : block.type === 'thinking' ? 'thinking' : 'assistant';
        const text = block.type === 'toolCall' ? `${block.name} ${JSON.stringify(block.arguments)}` : block.type === 'thinking' ? block.thinking : block.type === 'text' ? block.text : '';
        if (text) messages.push({ id: `${entry.id}/${index}`, role, text });
      }
    }
  }
  return messages;
}
