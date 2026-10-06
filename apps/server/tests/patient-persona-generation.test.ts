import { describe, expect, it } from 'vitest'
import { generatePatientPersona, type PersonaResource } from '../src/application/patient-persona-service.ts'
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
  const diabetes = {
    code: { coding: [{ code: '44054006', display: '2 型糖尿病（疾病）' }] },
    id: 'synthetic-diabetes',
    resourceType: 'Condition',
  }

  function generateWithHistory(knownHistorySummary: string, visibleResources: PersonaResource[]) {
    return generatePatientPersona({
      hiddenResources: [diabetes],
      model: 'fake-brief-model',
      payload: { caseType: 'new-problem' },
      provider: {
        completeJson: async () => ({
          content: JSON.stringify({ ...validPersonaContent, knownHistorySummary }),
          model: 'fake-brief-model',
        }),
      },
      visibleResources,
    })
  }

  const prediabetes = {
    code: { coding: [{ code: '714628002', display: '糖尿病前期（临床所见）' }] },
    id: 'synthetic-prediabetes',
    resourceType: 'Condition',
  }

  it('allows the documented prediabetes history without treating it as a new diabetes diagnosis', async () => {
    const result = await generateWithHistory('以前医生说我是糖尿病前期。', [prediabetes])
    expect(result.content.knownHistorySummary).toBe('以前医生说我是糖尿病前期。')
  })

  it('still rejects newly disclosed diabetes alongside the documented prediabetes history', async () => {
    await expect(generateWithHistory('既往糖尿病前期，这次确诊了糖尿病。', [prediabetes]))
      .rejects.toMatchObject({ code: 'PERSONA_DIAGNOSIS_LEAK' })
  })

  it.each(['，', '。', '；', '\n', '！', ','])('does not join clauses across %j to exempt a hidden diagnosis', async separator => {
    await expect(generateWithHistory(`我得了糖尿病${separator}前期需要控制饮食。`, [prediabetes]))
      .rejects.toMatchObject({ code: 'PERSONA_DIAGNOSIS_LEAK' })
  })

  it('allows spacing within a complete known diagnosis name', async () => {
    const result = await generateWithHistory('以前医生说我是糖尿病 前期。', [prediabetes])
    expect(result.content.knownHistorySummary).toBe('以前医生说我是糖尿病 前期。')
  })

  it('still rejects a hidden diagnosis split by punctuation', async () => {
    await expect(generateWithHistory('我得了糖，尿病。', [prediabetes]))
      .rejects.toMatchObject({ code: 'PERSONA_DIAGNOSIS_LEAK' })
  })

  it('recognizes diabetes already named by a documented diabetic complication', async () => {
    const result = await generateWithHistory('我有二型糖尿病，以前说已经影响到神经。', [{
      code: { coding: [{ code: '368581000119106', display: '2型糖尿病引起的神经病（疾病）' }] },
      id: 'synthetic-diabetic-neuropathy',
      resourceType: 'Condition',
    }])
    expect(result.content.knownHistorySummary).toContain('二型糖尿病')
  })

  it('does not exempt a new diabetes diagnosis solely because prediabetes is documented', async () => {
    await expect(generateWithHistory('我有2型糖尿病。', [prediabetes]))
      .rejects.toMatchObject({ code: 'PERSONA_DIAGNOSIS_LEAK' })
  })

  it('still blocks an undisclosed diagnosis code', async () => {
    await expect(generateWithHistory('以前医生说过44054006。', [prediabetes]))
      .rejects.toMatchObject({ code: 'PERSONA_DIAGNOSIS_LEAK' })
  })

  it('does not hide a newly disclosed subtype inside the name of a known generic diagnosis', async () => {
    await expect(generateWithHistory('我有2型糖尿病。', [{
      code: { coding: [{ code: '73211009', display: '糖尿病（疾病）' }] },
      id: 'synthetic-unspecified-diabetes',
      resourceType: 'Condition',
    }])).rejects.toMatchObject({ code: 'PERSONA_DIAGNOSIS_LEAK' })
  })

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
