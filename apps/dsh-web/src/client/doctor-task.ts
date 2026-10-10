import type { DoctorAgentTaskSubmission } from '@clinmesh/contracts/agent'
import { z } from 'zod'

export interface DoctorTaskRemote {
  session: { prompt(input: {
    sessionId: string
    requestId: string
    mode: 'queue'
    content: Array<{ type: 'text'; text: string }>
  }, signal: AbortSignal): Promise<unknown> }
}

export async function submitDoctorTask(
  remote: DoctorTaskRemote, task: DoctorAgentTaskSubmission, signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  const response = await fetch('/clinmesh-doctor-task', {
    method: 'POST', credentials: 'same-origin', signal,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ permit: task.permit }),
  })
  if (!response.ok || !z.object({ data: z.object({ registered: z.literal(true) }) }).safeParse(await response.json()).success) {
    throw new Error('助手任务未能登记，尚未提交。')
  }
  signal.throwIfAborted()
  let raw: unknown
  try {
    raw = await remote.session.prompt({ sessionId: task.dshSessionId,
      requestId: task.rpcId, mode: 'queue', content: [{ type: 'text', text: task.content }] }, signal)
  } catch (error) {
    throw new Error('助手任务提交结果尚未确认，请先查看会话状态。', { cause: error })
  }
  const parsed = z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value: z.object({ accepted: z.literal(true) }) }),
    z.object({ ok: z.literal(false), error: z.unknown() }),
  ]).safeParse(raw)
  if (!parsed.success) throw new Error('助手任务提交结果尚未确认，请先查看会话状态。')
  if (!parsed.data.ok) throw new Error('助手未接受任务，请查看会话状态后再决定是否重新提交。')
}
