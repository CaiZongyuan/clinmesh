import { afterEach, expect, it, vi } from 'vitest'
import { submitDoctorTask } from './doctor-task.ts'

afterEach(() => vi.unstubAllGlobals())
const task = { content: '了解近两周用药情况', dshSessionId: 'session-1', rpcId: 'rpc-1',
  taskId: 'task-1', permit: 'synthetic-signed-permit-at-least-32-characters' }

it('registers the permit before submitting the scope to the native session without exposing the permit', async () => {
  const registered: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    expect(url).toBe('/clinmesh-doctor-task')
    expect(JSON.parse(init.body)).toEqual({ permit: task.permit })
    registered.push('registered')
    return Response.json({ data: { registered: true } })
  }))
  const prompt = vi.fn(async input => {
    expect(registered).toEqual(['registered'])
    expect(input).toEqual({ sessionId: 'session-1', requestId: 'rpc-1', mode: 'queue',
      content: [{ type: 'text', text: '了解近两周用药情况' }] })
    return { ok: true, value: { accepted: true } }
  })
  await expect(submitDoctorTask({ session: { prompt } }, task, new AbortController().signal)).resolves.toBeUndefined()
  expect(prompt).toHaveBeenCalledTimes(1)
})

it('does not enqueue a task when permit registration fails or cancellation occurs', async () => {
  const prompt = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'DOCTOR_TASK_INVALID' } }, { status: 409 })))
  await expect(submitDoctorTask({ session: { prompt } }, task, new AbortController().signal)).rejects.toThrow('尚未提交')
  const controller = new AbortController()
  vi.stubGlobal('fetch', vi.fn(async () => {
    controller.abort()
    return Response.json({ data: { registered: true } })
  }))
  await expect(submitDoctorTask({ session: { prompt } }, task, controller.signal)).rejects.toThrow()
  expect(prompt).not.toHaveBeenCalled()
})

it('does not repeat a prompt whose acceptance response is lost', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: { registered: true } })))
  const prompt = vi.fn(async () => { throw new Error('Response lost') })
  await expect(submitDoctorTask({ session: { prompt } }, task, new AbortController().signal)).rejects.toThrow('提交结果尚未确认')
  expect(prompt).toHaveBeenCalledOnce()
})
