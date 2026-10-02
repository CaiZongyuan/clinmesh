import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadImagingCatalog } from '../src/infrastructure/imaging-assets/imaging-catalog.ts'
import { checkImagingReport } from '../src/infrastructure/imaging-assets/imaging-report-check.ts'

const catalogDirectory = resolve(import.meta.dirname, '../../../imaging-assets')

describe('repository imaging catalog', () => {
  it('records hashes, source annotations and consistent report drafts for every asset', async () => {
    // 读取时同时校验适配规则只引用清单中检查相符的素材。
    const { assets, matching } = await loadImagingCatalog(catalogDirectory)

    expect(matching?.profiles.length).toBeGreaterThan(0)

    for (const asset of assets) {
      expect(asset.output, `${asset.assetId} output`).toBeDefined()
      expect(asset.source.series.every(series => series.instances !== undefined), `${asset.assetId} instances`).toBe(true)
      expect(asset.annotation, `${asset.assetId} annotation`).toBeDefined()
      expect(asset.reports?.length ?? 0, `${asset.assetId} reports`).toBeGreaterThan(0)
      for (const report of asset.reports ?? []) {
        expect(checkImagingReport(asset, report).issues, `${asset.assetId} revision ${report.revision}`).toEqual([])
        expect(existsSync(join(catalogDirectory, 'prompts', `${report.draft.promptVersion}.md`))).toBe(true)
      }
    }
  })
})
