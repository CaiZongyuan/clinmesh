import { z } from 'zod';
export * from './assistant';

export const providerName = z.enum(['openai', 'anthropic', 'gemini']);
export const reasoningEffort = z.enum(['off', 'minimal', 'low', 'medium', 'high']);
export const replyState = z.object({ questionId: z.uuidv7(), sessionId: z.uuidv7(), attempt: z.int().nonnegative(), status: z.enum(['running', 'done', 'stopped', 'failed']), code: z.string().nullable() });
export const replyProgress = z.object({ phase: z.enum(['receiving', 'checking']), pass: z.union([z.literal(1), z.literal(2)]), chunks: z.int().nonnegative() });
export type ReplyProgress = z.infer<typeof replyProgress>;
export const replyEvent = z.union([replyState, replyState.extend({ status: z.literal('progress'), ...replyProgress.shape }), replyState.extend({ status: z.literal('text'), content: z.string().max(8000) })]);
export const receiptSchema = z.object({ turnId: z.uuidv7(), sessionId: z.uuidv7(), attempt: z.int().positive(), version: z.int().positive() });
export type AgentRole = 'patient' | 'clinician';

export function permitsProviderKey(origin: URL) {
  return origin.protocol === 'https:' || (origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname));
}
