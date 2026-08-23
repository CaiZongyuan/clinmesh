import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'

describe('Web static application', () => {
  let webRoot: string

  beforeAll(async () => {
    webRoot = await mkdtemp(join(tmpdir(), 'clinmesh-web-'))
    await writeFile(
      join(webRoot, 'index.html'),
      '<!doctype html><html><body><div id="root">ClinMesh</div></body></html>',
      'utf8',
    )
  })

  afterAll(async () => {
    await rm(webRoot, { recursive: true })
  })

  it('returns the SPA entry point when a browser route is refreshed', async () => {
    const response = await createApp({ webRoot }).request('/registration')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toContain('<div id="root">ClinMesh</div>')
  })

  it('keeps service paths and missing assets outside the SPA fallback', async () => {
    const responses = await Promise.all([
      createApp({ webRoot }).request('/api/missing'),
      createApp({ webRoot }).request('/fhir/R5/Patient'),
      createApp({ webRoot }).request('/assets/missing.js'),
    ])

    expect(responses.map(response => response.status)).toEqual([404, 404, 404])
  })
})
