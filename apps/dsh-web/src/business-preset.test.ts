import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { Group } from '@deepseek-ai/cordis-plugin-loader'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import '@deepseek-ai/dsh-agent-preset-registry'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import Llm, { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import { expect, it } from 'vitest'

it('mounts the deployment business preset and sends doctor reply rules through fresh sessions', async () => {
  const ctx = new Context()
  ctx.baseUrl = new URL('../', import.meta.url).href
  try {
    await ctx.plugin(Loader)
    ctx.loader.builtins.group = Group
    await ctx.plugin(SystemPrompt, {
      personaPrefix: 'You are a coding agent.',
      personaSuffix: 'Your working directory is {{cwd}}.',
    })
    await ctx.plugin(Sessions)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(Llm)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(Tools)
    await ctx.plugin(UserQuestions)
    await ctx.plugin(Agents)
    await ctx.plugin(AgentLoop, { agents: [] })

    const patches = loadOverlayPatches('ClinMesh preset test',
      fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
    const declarations = composeEntries([
      [{ insert: [{ id: 'agent-preset-registry',
        name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'standard' } }] }],
      patches,
    ]).filter(row => row.name === '@deepseek-ai/dsh-agent-preset'
      || row.name === '@deepseek-ai/dsh-agent-preset-registry')
    await ctx.loader.root.update(declarations)
    await ctx.loader.await()

    const key = {}
    const scope = createScope(ctx, key)
    expect(ctx.agentPresets.defaultId).toBe('clinmesh-assistant')
    expect(await ctx.agentPresets.mount(scope.ctx)).toEqual({ id: 'clinmesh-assistant' })

    scope.ctx.get('tools')!.register(defineTool({
      name: 'clinmesh_read_current_context',
      description: 'Read the authorized synthetic hospital page.',
      parameters: {},
      output: {
        schema: { type: 'object', properties: {}, additionalProperties: false },
        render: () => [{ type: 'text', text: '{}' }],
      },
      execute: async () => ({}),
    }))
    const assembled = await ctx.systemPrompt.assemble({ scope: key })
    expect(assembled.tools.map(tool => tool.name).sort()).toEqual([
      'ask_user_question', 'clinmesh_read_current_context',
    ])
    const persona = assembled.sections.map(section => section.text).join('\n')
    expect(persona).toContain('ClinMesh 医院工作台助手')
    expect(persona).toContain('人工审阅')
    expect(persona).toContain('超时')
    expect(persona).toContain('clinmesh_select_doctor_section')
    expect(persona).toContain('clinmesh_ask_virtual_patient')
    expect(persona).toContain('真实身份或任务意图冲突')
    expect(persona).toContain('不要求用户手动刷新')
    expect(persona).toContain('每个用户回合')
    expect(persona).toContain('不从历史调用复制绑定')
    expect(persona).toContain('纯查询只提交业务参数，不填写页面绑定')
    expect(persona).toContain('没有许可时只提示医生补充')
    expect(persona).toContain('不能据此断言没有问诊记录')
    expect(persona).not.toContain('You are a coding agent')
    expect(persona).not.toContain('Your working directory')
    expect((await ctx.systemPrompt.assemble()).tools).toEqual([])

    const responses = new Map<string, string[]>()
    ctx.on('session/event', (session, event) => {
      if (event.type === 'assistant/message') {
        responses.set(String(session.id), event.data.message.content
          .filter(block => block.type === 'text').map(block => block.text))
      }
    })
    class ScriptedModel extends LlmAdapter {
      readonly requests: GenerateOptions[] = []
      override async resolveModel(provider: string, model: string) {
        return { provider, id: model, name: model }
      }
      override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
        this.requests.push(request)
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: '合成会话回复。' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '合成会话回复。' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const model = new ScriptedModel()
    ctx.llm.registerAdapter(['scripted'], model)
    for (const { sessionId, text } of [
      { sessionId: 'doctor-brief-reply', text: '请简要说明你能提供哪些帮助。' },
      { sessionId: 'doctor-teaching-reply', text: '请解释你能如何辅助医生，并说明适用边界。' },
    ]) {
      const { agent } = await ctx.agents.create({
        sessionId: SessionId(sessionId),
        agentOptions: { provider: 'scripted', model: 'reply-contract' },
        setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx) },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text }],
        source: { kind: 'user', rpcId: sessionId } }))
      await agent.whenIdle()
      const request = model.requests.at(-1)
      expect(request?.messages).toContainEqual(expect.objectContaining({
        role: 'user', content: [{ type: 'text', text }],
      }))
      expect(responses.get(sessionId)).toEqual(['合成会话回复。'])
      const systemPrompt = request?.messages.filter(message => message.role === 'system')
        .flatMap(message => message.content).filter(block => block.type === 'text')
        .map(block => block.text).join('\n')
      expect(systemPrompt).toContain('简洁、专业')
      expect(systemPrompt).toContain('先说明结果或当前状态')
      expect(systemPrompt).toContain('仅在医生明确追问或提出教学请求时展开')
      expect(systemPrompt).toContain('常规后台整理、建议刷新和质控提示通过业务页面体现')
      expect(systemPrompt).toContain('需要医生决定或核实')
      expect(systemPrompt).toContain('无法安全恢复')
      expect(systemPrompt).toContain('正式业务提交通过工作台的人工审阅完成')
      expect(systemPrompt).not.toContain('You are a coding agent')
    }
    expect(model.requests).toHaveLength(2)
  } finally {
    await ctx.fiber.dispose()
  }
})
