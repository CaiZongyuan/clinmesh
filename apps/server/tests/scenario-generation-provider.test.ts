import { scenarioGenerationRequestSchema } from '@clinmesh/contracts/scenario'
import { describe, expect, it } from 'vitest'
import { BuiltInScenarioGenerationProvider } from '../src/infrastructure/scenario-generation/builtin-provider.ts'

describe('Scenario generation Provider contract', () => {
  it('replays a fixed built-in population without changing clinical facts', async () => {
    const provider = new BuiltInScenarioGenerationProvider()
    const request = scenarioGenerationRequestSchema.parse({
      modules: ['fever'],
      name: '合成发热门诊数据',
      population: {
        age: { maximum: 65, minimum: 18 },
        count: 1,
        gender: 'any',
      },
      providerId: 'builtin',
      seeds: { clinical: 7331, population: 4242 },
      timeRange: { end: '2026-08-01', start: '2020-01-01' },
      timeZone: 'Asia/Shanghai',
    })

    const first = await provider.generate(request)
    const replay = await provider.generate(request)

    expect(replay).toEqual(first)
    expect(first.content.patients).toEqual([expect.objectContaining({
      birthDate: '1962-01-01',
      gender: 'male',
      id: 'synthetic-patient-5eb27dffe7f2',
      name: '王晓明',
      physiologyBaseline: {
        oxygenSaturationPct: 98,
        temperatureC: 38.6,
      },
    })])
    expect(first.content.reproduction).toEqual({
      clinicalSeed: 7331,
      generator: 'clinmesh-builtin-v1',
      modules: ['fever'],
      populationSeed: 4242,
      timeRange: { end: '2026-08-01', start: '2020-01-01' },
      timeZone: 'Asia/Shanghai',
    })
  })
})
