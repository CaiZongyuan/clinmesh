import { z } from 'zod';

export const assistantBinding = z.strictObject({ workspaceId: z.uuidv7(), epoch: z.uuidv7(), encounterId: z.uuidv7(), roleId: z.string().min(1).max(128) });
export type AssistantBinding = z.infer<typeof assistantBinding>;
export const assistantObservation = z.discriminatedUnion('type', [
  z.object({ type: z.literal('consultation.final'), id: z.uuidv7(), ordinal: z.int().positive(), question: z.string(), answer: z.string() }),
  z.object({ type: z.literal('report.signed'), kind: z.enum(['lab', 'imaging', 'pathology']), id: z.uuidv7(), version: z.int().positive(), summary: z.string() }),
]);
export const assistantObservations = z.array(assistantObservation);
export type AssistantObservation = z.infer<typeof assistantObservation>;
export const observationKey = (event: AssistantObservation) => event.type === 'consultation.final' ? `${event.type}/${event.ordinal}/${event.id}` : `${event.kind}/${event.id}/${event.version}`;
export const assistantThread = z.object({ id: z.int().positive(), title: z.string().trim().min(1).max(100) });
export const assistantSessionCommand = assistantBinding.extend({ action: z.enum(['list', 'new', 'rename', 'delete', 'fork', 'reviewed']), thread: assistantThread.shape.id.optional(), title: assistantThread.shape.title.optional(), reviewId: z.uuid().optional() });
export const assistantMessage = z.object({ id: z.string(), role: z.enum(['clinician', 'assistant', 'thinking', 'tool']), text: z.string() });
export const assistantView = z.object({ threads: z.array(assistantThread), thread: assistantThread.shape.id, messages: z.array(assistantMessage), review: z.object({ id: z.uuid(), committed: z.array(z.object({ operation: z.string(), result: z.json() })) }).optional() });
export const maxUiCommands = 24;
export const uiCommandKey = (token: string, index: number) => `assistant-ui:${token}:${index}`;
export const assistantChannel = assistantBinding.extend({ clientId: z.uuid(), thread: assistantThread.shape.id });
export type AssistantChannel = z.infer<typeof assistantChannel>;
export const assistantStop = assistantChannel.extend({ requestId: z.uuid() });
export const assistantTurn = assistantChannel.extend({ requestId: z.uuid(), content: z.string().trim().min(1).max(12000).optional(), retryOf: z.uuid().optional() }).refine(input => !(input.content && input.retryOf) && input.requestId !== input.retryOf);
export const uiStep = z.strictObject({ ref: z.string().min(1).max(250), action: z.string().min(1).max(64), args: z.array(z.union([z.string().max(12000), z.number(), z.boolean(), z.null()])).max(8).optional() });
export const browserTools = {
  ui_snapshot: z.strictObject({}),
  ui_query: z.strictObject({ text: z.string().max(250).optional(), within: z.string().max(250).optional(), kind: z.string().max(64).optional(), from: z.int().nonnegative().optional() }),
  ui_act: z.strictObject({ steps: z.array(uiStep).min(1).max(12) }),
};
export const browserRequest = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('ui_snapshot'), args: browserTools.ui_snapshot }), z.object({ tool: z.literal('ui_query'), args: browserTools.ui_query }), z.object({ tool: z.literal('ui_act'), args: browserTools.ui_act }),
]);
export type BrowserRequest = z.infer<typeof browserRequest>;
export const assistantServerFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }), z.object({ type: z.literal('admitted'), requestId: z.uuid() }), z.object({ type: z.literal('call'), id: z.uuid(), request: browserRequest, commandToken: z.uuid().optional() }),
  z.object({ type: z.literal('delta'), kind: z.enum(['assistant', 'thinking', 'tool']), text: z.string().max(32000) }),
  z.object({ type: z.literal('cancel') }),
]);
export const assistantBrowserFrame = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('result'), id: z.uuid(), result: z.json() }),
  z.strictObject({ type: z.literal('protected'), fields: z.array(z.string().max(250)).max(256) }),
]);
export type AssistantFrame = z.infer<typeof assistantServerFrame>;
