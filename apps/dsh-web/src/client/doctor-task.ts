import type { DoctorAgentChatInput, DoctorAgentTaskSubmission, DoctorRecordingSourceInput } from '@clinmesh/contracts/agent'
import { z } from 'zod'
import type { ClientSessionBindingPort, ClientSessionInputPort } from './host-ports.ts'

export function createDoctorInputBridge(
  ports: { current: ClientSessionBindingPort['adapter']['current']; sessions: ClientSessionInputPort },
  accept: (input: DoctorAgentChatInput, signal: AbortSignal) => Promise<DoctorAgentTaskSubmission>,
  record?: (input: DoctorRecordingSourceInput, signal: AbortSignal) => Promise<void>,
): () => void {
  let session: NonNullable<ReturnType<ClientSessionInputPort['binding']>>['session'] | undefined
  let detach = () => {}
  const bind = (): void => {
    const key = ports.current.getSnapshot().key
    const nextSession = key === undefined ? undefined : ports.sessions.binding(key)?.session
    if (nextSession === session) return
    detach()
    session = nextSession
    if (nextSession === undefined || key === undefined) return
    const controller = new AbortController()
    const seen = new Set(nextSession.getSnapshot().pendingSubmissions.map(input => input.requestId))
    const unsubscribe = nextSession.subscribe(() => {
      const snapshot = nextSession.getSnapshot()
      if (snapshot.sessionId !== key || controller.signal.aborted) return
      for (const submission of snapshot.pendingSubmissions) {
        if (seen.has(submission.requestId)) continue
        seen.add(submission.requestId)
        if (submission.attachments.length !== 0 || submission.text.length > 2000
          || submission.text.trim() === '' || submission.requestId === '') continue
        void register({ content: submission.text, dshSessionId: key, rpcId: submission.requestId }, controller.signal).catch(() => {
          // 未登记的输入由 Host 拒绝，不泄露聊天正文或底层异常。
        })
      }
    })
    detach = () => { controller.abort(); unsubscribe() }
  }
  async function register(input: DoctorAgentChatInput, signal: AbortSignal): Promise<void> {
    const task = await accept(input, signal)
    signal.throwIfAborted()
    if (task.content !== input.content || task.dshSessionId !== input.dshSessionId || task.rpcId !== input.rpcId) {
      throw new Error('助手未能核实本次医生输入。')
    }
    const source = record === undefined ? Promise.resolve() : recordSource(task, input, signal)
    const registration = registerTask(task, signal)
    await Promise.all([source, registration])
  }
  async function registerTask(task: DoctorAgentTaskSubmission, signal: AbortSignal): Promise<void> {
    const response = await fetch('/clinmesh-doctor-task', {
      method: 'POST', credentials: 'same-origin', signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ permit: task.permit }),
    })
    if (!response.ok || !z.object({ data: z.object({ registered: z.literal(true) }) }).safeParse(await response.json()).success) {
      throw new Error('助手未能核实本次医生输入。')
    }
  }
  async function recordSource(task: DoctorAgentTaskSubmission, input: DoctorAgentChatInput, signal: AbortSignal): Promise<void> {
    const response = await fetch('/clinmesh-doctor-source', { method: 'POST', credentials: 'same-origin', signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ permit: task.permit }) })
    if (!response.ok) throw new Error('助手未能核实本次医生补充。')
    const { data } = z.object({ data: z.object({ sourceProof: z.string().min(32).max(8192) }).strict() }).strict().parse(await response.json())
    signal.throwIfAborted()
    await record!({ ...input, sourceProof: data.sourceProof }, signal)
  }
  const unsubscribeCurrent = ports.current.subscribe(bind)
  bind()
  return () => { unsubscribeCurrent(); detach() }
}
