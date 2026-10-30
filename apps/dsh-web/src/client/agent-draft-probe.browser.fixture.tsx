import { useState } from 'react'
import { useAgentPageRegistration } from '../../../web/src/app/agent-page-context.tsx'

/** 从页面公开的 Agent action 入口驱动真实表单；授权与回执由服务端 HTTP 合同验证。 */
export function AgentDraftProbe({ operation, input, label = '助手填写' }: {
  operation: string
  input: unknown
  label?: string
}) {
  const registration = useAgentPageRegistration()
  const action = registration?.actions[operation]
  const [result, setResult] = useState('')
  return <>
    <button disabled={action === undefined || action.enabled === false} onClick={async () => {
      try {
        if (action === undefined) throw new Error('页面工具尚未注册')
        await action.execute(input, new AbortController().signal)
        setResult('填写完成')
      } catch (error) { setResult(error instanceof Error ? error.message : '填写失败') }
    }}>{label}</button>
    <output aria-label="助手填写结果">{result}</output>
  </>
}
