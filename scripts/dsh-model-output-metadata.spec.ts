import { describe, expect, it } from 'vitest'
import { modelBridgeResponseMetadata, repairValidationMetadata, summarizeModelOutput } from './dsh-model-output-metadata.ts'

const privateText = 'synthetic-private-sentinel-do-not-publish'

describe('safe model output metadata', () => {
  it('keeps only known field types and array lengths without model text or unknown values', () => {
    const output = JSON.stringify({ issues: [{ message: privateText }], agentFactChecks: [], secret: privateText })
    const metadata = summarizeModelOutput(output)
    expect(metadata).toMatchObject({ characters: output.length, startsWithObject: true, endsWithObject: true,
      startsWithArray: false, endsWithArray: false, jsonParsed: true,
      fields: { issues: { type: 'array', length: 1 }, agentFactChecks: { type: 'array', length: 0 } } })
    expect(JSON.stringify(metadata)).not.toContain(privateText)
    expect(JSON.stringify(metadata)).not.toContain('secret')
  })

  it('records wrong field types, JSON fences and parse failure without accepting or repairing them', () => {
    expect(summarizeModelOutput('{"issues":null,"agentFactChecks":{}}')).toMatchObject({
      jsonParsed: true, fields: { issues: { type: 'null' }, agentFactChecks: { type: 'object' } },
    })
    expect(summarizeModelOutput('```json\n{"issues":[],"agentFactChecks":[]}\n```')).toMatchObject({
      startsWithJsonFence: true, endsWithJsonFence: true, jsonParsed: false,
    })
    const invalid = summarizeModelOutput(`{"issues": ["${privateText}"], "agentFactChecks": }`)
    expect(invalid).toMatchObject({ jsonParsed: false })
    expect(summarizeModelOutput('{bad')).toMatchObject({ jsonParsed: false, syntaxPosition: 1, syntaxLine: 1, syntaxColumn: 2 })
    expect(JSON.stringify(invalid)).not.toContain(privateText)
    expect(invalid).not.toHaveProperty('message')
    expect(invalid).not.toHaveProperty('cause')
  })

  it('extracts only repair code/path and rejects malformed feedback', () => {
    const prompt = `Original instructions.\nThe previous response failed validation: [{"code":"invalid_type","path":"issues.0.documentQuote","message":"${privateText}"}]. Generate a corrected JSON object using the original data and schema.`
    expect(repairValidationMetadata(prompt)).toEqual([{ code: 'invalid_type', path: 'issues.0.documentQuote' }])
    expect(repairValidationMetadata('No feedback')).toEqual([])
    expect(repairValidationMetadata('The previous response failed validation: [invalid]. Generate a corrected JSON object')).toEqual([])
  })

  it('reads a response copy within the existing limit and leaves the original response intact', async () => {
    const body = JSON.stringify({ model: 'synthetic', content: JSON.stringify({ issues: [], agentFactChecks: [] }) })
    const response = new Response(body)
    expect(await modelBridgeResponseMetadata(response, 1024)).toMatchObject({ jsonParsed: true,
      fields: { issues: { type: 'array', length: 0 }, agentFactChecks: { type: 'array', length: 0 } } })
    expect(await response.text()).toBe(body)
    const oversized = new Response(privateText)
    expect(await modelBridgeResponseMetadata(oversized, 4)).toEqual({ unavailable: 'response-limit' })
    expect(await oversized.text()).toBe(privateText)
    const unknown = new Response(JSON.stringify({ secret: privateText }))
    expect(await modelBridgeResponseMetadata(unknown, 1024)).toEqual({ unavailable: 'invalid-bridge-envelope' })
    expect(await modelBridgeResponseMetadata(oversized, 1024)).toEqual({ unavailable: 'response-unavailable' })
  })
})
