import { describe, expect, it } from 'vitest'
import { canonicalJsonHash } from '../src/application/scenario-data/canonical-json.ts'
import {
  medicationMappingPackageProvenance,
  parseMedicationMappingPackage,
  resolveMedicationMapping,
} from '../src/application/scenario-data/medication-coding-package.ts'

function mappingPackage(mappings: unknown[]) {
  const content = {
    mappingSetId: 'test-medication-mappings',
    mappings,
    schemaVersion: '1',
    sourceSystem: 'http://www.nlm.nih.gov/research/umls/rxnorm',
    sourceVersion: 'rxnorm-test',
    targetSystem: 'urn:clinmesh:reference:drug-concept',
    targetVersion: 'drug-concepts-test',
    version: 'test-1',
  }
  return parseMedicationMappingPackage({
    ...content,
    contentHash: canonicalJsonHash(content),
  })
}

const source = {
  code: '123456',
  display: 'Synthetic RxNorm drug',
  system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
  version: 'rxnorm-test',
}

const target = {
  code: 'CM-DRUG-TEST',
  conceptId: 'drug-concept-test',
  display: 'Synthetic drug concept',
  kind: 'drug-concept',
  system: 'urn:clinmesh:reference:drug-concept',
  version: 'drug-concepts-test',
}

function mapping(input: {
  mappingId: string
  relationship?: 'equivalent' | 'related'
  target?: typeof target
}) {
  return {
    direction: 'source-to-target',
    evidence: ['Synthetic medication mapping evidence'],
    mappingId: input.mappingId,
    relationship: input.relationship ?? 'equivalent',
    source,
    status: 'active',
    target: input.target ?? target,
  }
}

describe('medication concept coding package', () => {
  it('maps RxNorm only to a versioned drug concept and verifies the package hash', () => {
    expect(medicationMappingPackageProvenance()).toMatchObject({
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      mappingSetId: 'clinmesh-rxnorm-drug-concepts',
      version: '2026-08-28',
    })
    const resolution = resolveMedicationMapping({
      code: '198440',
      display: 'Acetaminophen 500 MG Oral Tablet',
      system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
    })
    expect(resolution).toMatchObject({
      mapping: {
        relationship: 'equivalent',
        status: 'active',
        target: {
          code: 'CM-DRUG-ACETAMINOPHEN-500MG-ORAL-TABLET',
          conceptId: 'drug-concept-acetaminophen-500mg-oral-tablet',
          kind: 'drug-concept',
          system: 'urn:clinmesh:reference:drug-concept',
          version: 'clinmesh-drug-concepts-2026-08-28',
        },
      },
      status: 'mapped',
    })
    if (resolution.status !== 'mapped') throw new Error('Expected an active medication mapping')
    expect(resolution.mapping.target).not.toHaveProperty('catalogItemId')
    expect(resolution.mapping.target).not.toHaveProperty('productId')
  })

  it('does not map a bare RxNorm code across systems or from display text', () => {
    expect(resolveMedicationMapping({
      code: '198440',
      display: 'Acetaminophen 500 MG Oral Tablet',
      system: 'https://example.test/not-rxnorm',
    })).toEqual({ status: 'unmapped' })
    expect(resolveMedicationMapping({ display: 'Acetaminophen 500 MG Oral Tablet' }))
      .toEqual({ status: 'unmapped' })
    expect(resolveMedicationMapping({
      code: '198440',
      display: 'Metformin hydrochloride 500 MG Oral Tablet',
      system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
    })).toEqual({ status: 'display-mismatch' })
  })

  it('distinguishes ambiguous and non-equivalent medication mappings', () => {
    const ambiguous = mappingPackage([
      mapping({ mappingId: 'mapping-a' }),
      mapping({
        mappingId: 'mapping-b',
        target: { ...target, code: 'CM-DRUG-OTHER', conceptId: 'drug-concept-other' },
      }),
    ])
    expect(resolveMedicationMapping(source, ambiguous)).toEqual({ status: 'ambiguous' })

    const notEquivalent = mappingPackage([
      mapping({ mappingId: 'mapping-related', relationship: 'related' }),
    ])
    expect(resolveMedicationMapping(source, notEquivalent)).toEqual({ status: 'not-equivalent' })
  })
})
