import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { Group } from '@deepseek-ai/cordis-plugin-loader'
import '@deepseek-ai/dsh-agent-preset-registry'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import Llm from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import Sessions from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import { expect, it } from 'vitest'

it('mounts the deployment business preset with scoped hospital tools and no development tools', async () => {
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
    expect(persona).not.toContain('You are a coding agent')
    expect(persona).not.toContain('Your working directory')
    expect((await ctx.systemPrompt.assemble()).tools).toEqual([])
  } finally {
    await ctx.fiber.dispose()
  }
})
