import { describe, expect, it } from 'vitest'
import { generatePatientPersona } from '../src/application/patient-persona-service.ts'
import { OpenAIChatCompletionsClient } from '../src/infrastructure/ai/openai-chat-completions.ts'

const hiddenResources = [{
  code: {
    coding: [{
      code: 'SYNTHETIC-HIDDEN-001',
      display: '合成隐匿诊断占位',
      system: 'urn:clinmesh:synthetic-test',
    }],
  },
  id: 'synthetic-hidden-condition',
  resourceType: 'Condition',
}]

const validPersonaContent = {
  chiefComplaint: '反复头晕伴头痛加重3个月',
  knownHistorySummary: '既往偶有头晕,未系统诊治。',
  medicationMemory: '自行服用止痛药,效果一般。',
  openingStatement: '医生您好,我最近总是头晕。',
  persona: {
    attitude: '就医积极',
    character: '开朗',
    healthLiteracy: '了解一些常见病知识',
    speechStyle: '语速平缓',
  },
  symptomExperience: '近三个月反复头晕,最近一周加重,还有点视物模糊。',
}

describe('generatePatientPersona', () => {
  it('skips a schema-invalid tool-call result and completes via the prompt strategy', async () => {
    const bodies: unknown[] = []
    const provider = new OpenAIChatCompletionsClient({
      apiKey: 'test-secret-that-must-not-escape',
      baseUrl: 'https://openrouter.example/api/v1',
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        if (bodies.length === 1) return new Response('{}', { status: 400 })
        if (bodies.length === 2) {
          return Response.json({
            choices: [{
              message: {
                content: null,
                tool_calls: [{
                  function: { arguments: '{}', name: 'patient_persona' },
                  type: 'function',
                }],
              },
            }],
          })
        }
        return Response.json({
          choices: [{ message: { content: JSON.stringify(validPersonaContent) } }],
          model: 'resolved-prompt-model',
        })
      },
    })

    const result = await generatePatientPersona({
      hiddenResources,
      model: 'fake-brief-model',
      payload: { caseType: 'new-problem' },
      provider,
      visibleResources: [],
    })

    expect(result.content).toEqual(validPersonaContent)
    expect(result.model).toBe('resolved-prompt-model')
    expect(result.promptVersion).toBe('patient-persona-v2')
    expect(bodies).toHaveLength(3)
  })
})
