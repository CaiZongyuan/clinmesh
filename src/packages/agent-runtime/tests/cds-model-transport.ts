import { z } from 'zod';
import { sha256 } from '../../platform';

export const modelReplySchema = z.object({ offered: z.array(z.string()), evidence: z.record(z.string(), z.string()), foreignData: z.boolean() });
const names = ['cds_scores', 'cds_guidelines', 'cds_order_sets'];
export async function modelEvents(payload: string) {
  const body = z.object({ tools: z.array(z.object({ function: z.object({ name: z.string() }) })), messages: z.array(z.object({ role: z.string(), content: z.unknown().optional(), tool_call_id: z.string().optional() })) }).parse(JSON.parse(payload));
  const results = body.messages.filter(row => row.role === 'tool');
  const chunk = { id: 'decision-598', model: 'synthetic-model', object: 'chat.completion.chunk', created: 1800000000 };
  const evidence = await Promise.all(results.map(async row => [String(row.tool_call_id).replace(/^cds-/, ''), await sha256(z.string().parse(row.content))]));
  const delta = results.length ? { role: 'assistant', content: JSON.stringify({ offered: body.tools.map(tool => tool.function.name), evidence: Object.fromEntries(evidence), foreignData: /118\.6|Jordan Vale|hiddenHistory|Focal right lower lobe consolidation/.test(JSON.stringify(body.messages)) }) } :
    { role: 'assistant', tool_calls: names.map((name, index) => ({ index, id: `cds-${name}`, type: 'function', function: { name, arguments: '{}' } })) };
  return `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: results.length ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`;
}
