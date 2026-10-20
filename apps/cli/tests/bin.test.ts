import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('clinmesh process entrypoint', () => {
  it('forwards arguments through the repository root entrypoint', () => {
    const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
    const result = spawnSync('pnpm', ['clinmesh', '--help'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: process.env,
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).not.toContain('"ok": false')
    expect(result.stdout).toContain('Usage: clinmesh')
  })

  it('prints help successfully', () => {
    const tsx = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url))
    const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url))
    const result = spawnSync(tsx, [entry, '--help'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('Usage: clinmesh')
  })

  it('runs local operation discovery without credentials or network', () => {
    const tsx = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url))
    const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url))
    const result = spawnSync(tsx, [entry, 'operations', 'list'], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
      },
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    const envelope = JSON.parse(result.stdout)
    expect(envelope).toMatchObject({ ok: true, schemaVersion: 1 })
    expect(envelope.data.operations).toHaveLength(124)
    expect(envelope.data.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'doctor.document-quality.get' }),
      expect.objectContaining({ id: 'doctor.document-quality.check' }),
      expect.objectContaining({ id: 'doctor.document-quality.retain' }),
      expect.objectContaining({ id: 'inpatient.surgery.catalog', version: 1 }),
      expect.objectContaining({ id: 'inpatient.surgery.read', version: 1 }),
      expect.objectContaining({ id: 'inpatient.surgery.request', version: 1 }),
      expect.objectContaining({ id: 'inpatient.surgery.check-preop', version: 1 }),
      expect.objectContaining({ id: 'inpatient.surgery.confirm-consent', version: 1 }),
      expect.objectContaining({ id: 'inpatient.surgery.cancel', version: 1 }),
      expect.objectContaining({ id: 'inpatient.surgery.execute', version: 1 }),
      expect.objectContaining({ id: 'inpatient.order.issue', version: 2 }),
      expect.objectContaining({id:'inpatient.investigation.catalog',version:1}),
      expect.objectContaining({id:'inpatient.investigation.read',version:1}),
      expect.objectContaining({id:'inpatient.transfer.catalog',version:1}),
      expect.objectContaining({id:'inpatient.transfer.read',version:1}),
      expect.objectContaining({id:'inpatient.transfer.incoming',version:1}),
      expect.objectContaining({id:'inpatient.investigation.issue',version:1}),
      expect.objectContaining({id:'inpatient.investigation.send',version:1}),
      expect.objectContaining({id:'inpatient.investigation.cancel',version:1}),
      expect.objectContaining({id:'inpatient.investigation.retry',version:1}),
      expect.objectContaining({id:'inpatient.investigation.acknowledge',version:1}),
      expect.objectContaining({id:'inpatient.transfer.request',version:1}),
      expect.objectContaining({id:'inpatient.transfer.handover',version:1}),
      expect.objectContaining({id:'inpatient.transfer.receive',version:1}),
      expect.objectContaining({id:'inpatient.transfer.cancel',version:1}),
      expect.objectContaining({ id: 'inpatient.catalog', version: 2 }),
      expect.objectContaining({ id: 'inpatient.admission.list', version: 2 }),
      expect.objectContaining({ id: 'inpatient.admission.read', version: 2 }),
      expect.objectContaining({ id: 'inpatient.admission.register', version: 2 }),
      expect.objectContaining({ id: 'inpatient.admission.receive', version: 1 }),
      expect.objectContaining({ id: 'inpatient.admission.move-bed', version: 1 }),
      expect.objectContaining({ id: 'inpatient.admission.swap-bed', version: 1 }),
      expect.objectContaining({ id: 'inpatient.referral.list', version: 1 }),
      expect.objectContaining({ id: 'inpatient.referral.issue', version: 1 }),
    ]))
  })
})
