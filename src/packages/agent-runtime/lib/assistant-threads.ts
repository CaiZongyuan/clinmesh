import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc, type Conversation, type ConversationId, type Harness } from '@earendil-works/pi-durable';
import { z } from 'zod';
import { assistantSessionCommand, assistantView } from '../../agent-protocol';
import { CoreError } from '../../platform';

const context = BACKGROUND_CONTEXT;
const directory = defineDoc({ scope: 'session', kind: 'clinmesh.assistant-threads', version: 1, initial: (): { threads: { id: number; roleId: string; title: string }[] } => ({ threads: [] }), checkpointWhen: () => true });
const admission = defineDoc({ scope: 'conversation', history: 'latest', fork: 'initial', kind: 'clinmesh.assistant-admission', version: 1, initial: () => ({ requestId: '', clientId: '', provider: '', content: '' }), checkpointWhen: () => true });
export function admitTurn(conversation: Conversation, input: { requestId: string; clientId: string; content?: string }, provider: string) {
  return conversation.commit(async tx => {
    const previous = await tx.doc(admission, conversation.id);
    if (previous.requestId === input.requestId) {
      if (previous.clientId !== input.clientId || previous.provider !== provider || (input.content && previous.content !== input.content)) throw new CoreError(409, 'LLM_REJOIN_CONFIGURATION_REQUIRED');
      return previous.content;
    }
    if (!input.content) throw new CoreError(409, 'ASSISTANT_REJOIN_REQUIRED');
    Object.assign(previous, { requestId: input.requestId, clientId: input.clientId, content: input.content, provider });
    return input.content;
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
