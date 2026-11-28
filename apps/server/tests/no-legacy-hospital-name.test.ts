import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createHospitalBaseline } from '../src/application/scenario-data/hospital-baseline.ts'
import { syntheticNhsaMedicationProductSnapshot } from '../src/application/scenario-data/medication-product-snapshot.ts'
import {
  syntheticNhcMedicalServiceSnapshot,
  syntheticWstValueSetSnapshot,
} from '../src/application/scenario-data/medical-service-snapshot.ts'

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const LEGACY_HOSPITAL_NAME = '仁' + '和'
const BINARY_EXTENSIONS = new Set([
  '.db',
  '.dcm',
  '.gif',
  '.gz',
  '.ico',
  '.jpeg',
  '.jpg',
  '.otf',
  '.pdf',
  '.png',
  '.sqlite',
  '.svs',
  '.tar',
  '.ttf',
  '.webp',
  '.woff',
  '.woff2',
  '.zip',
])

function listTrackedTextFiles(): string[] {
  const output = execFileSync('git', ['ls-files', '--stage', '-z'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  const files: string[] = []
  for (const entry of output.split('\0')) {
    if (entry === '') continue
    const tabIndex = entry.indexOf('\t')
    if (tabIndex === -1) continue
    const metadata = entry.slice(0, tabIndex)
    const relativePath = entry.slice(tabIndex + 1)
    // Skip git submodules (160000) and symlinks (120000) as well as binary assets.
    if (metadata.startsWith('160000 ') || metadata.startsWith('120000 ')) continue
    if (BINARY_EXTENSIONS.has(extname(relativePath).toLowerCase())) continue
    files.push(relativePath)
  }
  return files
}

describe('ClinMesh synthetic hospital & manufacturer naming guard', () => {
  it('contains zero occurrences of the retired synthetic hospital name across tracked files', () => {
    const trackedFiles = listTrackedTextFiles()
    expect(trackedFiles.length).toBeGreaterThan(100)
    const offendingFiles: string[] = []
    for (const relativePath of trackedFiles) {
      const absolutePath = resolve(REPOSITORY_ROOT, relativePath)
      if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) continue
      const content = readFileSync(absolutePath, 'utf8')
      if (content.includes(LEGACY_HOSPITAL_NAME)) {
        offendingFiles.push(relativePath)
      }
    }
    expect(offendingFiles).toEqual([])
  })

  it('uses ClinMesh naming for the synthetic hospital baseline and synthetic medication manufacturers', () => {
    const baseline = createHospitalBaseline(
      syntheticNhsaMedicationProductSnapshot,
      syntheticNhcMedicalServiceSnapshot,
      syntheticWstValueSetSnapshot,
    )
    expect(baseline.hospital.name).toBe('ClinMesh 临床仿真医院')
    for (const product of syntheticNhsaMedicationProductSnapshot) {
      expect(product.manufacturer).not.toContain(LEGACY_HOSPITAL_NAME)
      expect(product.manufacturer).toMatch(/^ClinMesh 仿真制药/)
    }
    const syntheticMedications = baseline.catalog.medications.filter(medication => [
      'medication-acetaminophen',
      'medication-metformin',
      'medication-amlodipine',
      'medication-oseltamivir',
    ].includes(medication.id))
    expect(syntheticMedications).toHaveLength(4)
    for (const medication of baseline.catalog.medications) {
      expect(medication.product.manufacturer).not.toContain(LEGACY_HOSPITAL_NAME)
    }
    for (const medication of syntheticMedications) {
      expect(medication.product.manufacturer).toMatch(/^ClinMesh 仿真制药/)
    }
  })
})
