import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  FORBIDDEN_DISEASE_PACK_IDS,
  findHardcodedPackIdViolations,
  scanSourceTextForHardcodedPackIds,
} from '../../../scripts/verify-no-hardcoded-pack-ids.ts'

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

describe('DSAP static hardcoded disease pack ID guardrail', () => {
  it('finds zero hardcoded disease pack IDs across non-test platform/application source files', () => {
    expect(findHardcodedPackIdViolations(REPOSITORY_ROOT)).toEqual([])
  })

  it('dynamically includes disk pack and topic IDs and detects hardcoded topic slugs too', () => {
    expect(FORBIDDEN_DISEASE_PACK_IDS).toContain('coronary-cad')
    expect(FORBIDDEN_DISEASE_PACK_IDS).toContain('t2dm-renal-care')
    expect(FORBIDDEN_DISEASE_PACK_IDS).toContain('pci-stent')
    expect(FORBIDDEN_DISEASE_PACK_IDS).toContain('t2dm-renal-medication')
    for (const packId of FORBIDDEN_DISEASE_PACK_IDS) {
      const hit = scanSourceTextForHardcodedPackIds(
        'apps/server/src/application/example-service.ts',
        `if (packId === '${packId}') return true`,
      )
      expect(hit).toEqual([
        {
          line: 1,
          packId,
          path: 'apps/server/src/application/example-service.ts',
        },
      ])
    }

    expect(
      scanSourceTextForHardcodedPackIds(
        'apps/server/tests/example.test.ts',
        "const id = 'coronary-cad'",
      ),
    ).toEqual([])
    expect(
      scanSourceTextForHardcodedPackIds(
        'packages/core/src/phenotype-synthetic-kb.ts',
        "packId: 'familial-hypercholesterolemia'",
      ),
    ).toEqual([])
  })
})
