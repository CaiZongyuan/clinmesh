import { describe, expect, it } from 'vitest'
import {
  diagnosisMappingPackageProvenance,
  parseDiagnosisMappingPackage,
  resolveDiagnosisMapping,
} from '../src/application/scenario-data/diagnosis-coding-package.ts'
import { canonicalJsonHash } from '../src/application/scenario-data/canonical-json.ts'

function mappingPackage(mappings: unknown[]) {
  const content = {
    mappingSetId: 'test-diagnosis-mappings',
    mappings,
    schemaVersion: '1',
    sourceSystem: 'http://snomed.info/sct',
    sourceVersion: 'http://snomed.info/sct/version/test',
    targetSystem: 'urn:clinmesh:reference:nhsa-diagnosis',
    targetVersion: 'nhsa-diagnosis-test',
    version: 'test-1',
  }
  return parseDiagnosisMappingPackage({
    ...content,
    contentHash: canonicalJsonHash(content),
  })
}

const source = {
  code: '123456',
  display: 'Synthetic source diagnosis',
  system: 'http://snomed.info/sct',
  version: 'http://snomed.info/sct/version/test',
}

const target = {
  catalogItemId: 'diagnosis-synthetic-target',
  code: 'CM-DX-A',
  display: 'Synthetic target diagnosis',
  system: 'urn:clinmesh:reference:nhsa-diagnosis',
  version: 'nhsa-diagnosis-test',
}

function mapping(input: {
  mappingId: string
  relationship?: 'equivalent' | 'related'
  target?: typeof target
}) {
  return {
    direction: 'source-to-target',
    evidence: ['Synthetic mapping test evidence'],
    mappingId: input.mappingId,
    relationship: input.relationship ?? 'equivalent',
    source,
    status: 'active',
    target: input.target ?? target,
  }
}

describe('diagnosis coding package', () => {
  it('resolves the reviewed fever and diabetes mappings with a self-verified hash', () => {
    expect(diagnosisMappingPackageProvenance()).toMatchObject({
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      mappingSetId: 'clinmesh-synthea-nhsa-diagnosis',
      version: '2026-08-28',
    })
    expect(resolveDiagnosisMapping({
      code: '44054006',
      display: 'Diabetes mellitus type 2',
      system: 'http://snomed.info/sct',
    })).toMatchObject({
      mapping: {
        direction: 'source-to-target',
        evidence: ['ClinMesh #45 synthetic scenario clinical review'],
        relationship: 'equivalent',
        source: {
          system: 'http://snomed.info/sct',
          version: 'http://snomed.info/sct/900000000000207008/version/20250201',
        },
        status: 'active',
        target: {
          catalogItemId: 'diagnosis-type-2-diabetes-hyperglycemia',
          code: 'E11.65',
          system: 'urn:clinmesh:reference:nhsa-diagnosis',
          version: 'nhsa-diagnosis-2026-08-07',
        },
      },
      status: 'mapped',
    })
  })

  it('does not map a bare code across systems or from display text', () => {
    expect(resolveDiagnosisMapping({
      code: '44054006',
      display: 'Diabetes mellitus type 2',
      system: 'https://example.test/not-snomed',
    })).toEqual({ status: 'unmapped' })
    expect(resolveDiagnosisMapping({ display: 'Diabetes mellitus type 2' }))
      .toEqual({ status: 'unmapped' })
    expect(resolveDiagnosisMapping({
      code: '44054006',
      display: 'Diabetes mellitus type 2',
      system: 'http://snomed.info/sct',
      version: 'http://snomed.info/sct/version/wrong',
    })).toEqual({ status: 'unmapped' })
    expect(resolveDiagnosisMapping({
      code: '44054006',
      display: 'Fever',
      system: 'http://snomed.info/sct',
    })).toEqual({ status: 'display-mismatch' })
  })

  it('distinguishes ambiguous and non-equivalent reviewed relationships', () => {
    const ambiguous = mappingPackage([
      mapping({ mappingId: 'mapping-a' }),
      mapping({
        mappingId: 'mapping-b',
        target: { ...target, catalogItemId: 'diagnosis-other', code: 'CM-DX-B' },
      }),
    ])
    expect(resolveDiagnosisMapping(source, ambiguous)).toEqual({ status: 'ambiguous' })

    const notEquivalent = mappingPackage([
      mapping({ mappingId: 'mapping-related', relationship: 'related' }),
    ])
    expect(resolveDiagnosisMapping(source, notEquivalent)).toEqual({ status: 'not-equivalent' })
  })
})
