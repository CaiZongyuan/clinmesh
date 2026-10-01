import { radiologyImagingAdapter, type InstalledImagingSeries } from './imaging-asset-store.ts'
import type { ImagingCatalog, ImagingCatalogAsset } from './imaging-catalog.ts'
import { ImagingPackLibrary } from './imaging-pack-library.ts'
import { imagingAssetPublication } from './imaging-report-check.ts'

export { ImagingCatalogInvalidError } from './imaging-pack-library.ts'

/** 放射素材包的本地来源：清单、安装与缓存规则见 `ImagingPackLibrary`。 */
export class ImagingAssetLibrary extends ImagingPackLibrary<ImagingCatalogAsset, ImagingCatalog, InstalledImagingSeries[]> {
  constructor(input: { assetDirectory?: string | undefined; catalogDirectory?: string | undefined }) {
    super({ ...input, adapter: radiologyImagingAdapter })
  }

  /** 每类检查是否至少有一套已发布且已安装的素材。 */
  async readyExamCodes(): Promise<Set<ImagingCatalogAsset['examCode']>> {
    const ready = new Set<ImagingCatalogAsset['examCode']>()
    for (const asset of (await this.catalog())?.assets ?? []) {
      if (ready.has(asset.examCode) || imagingAssetPublication(asset).publishedRevisions.length === 0) continue
      if (await this.installed(asset)) ready.add(asset.examCode)
    }
    return ready
  }
}
