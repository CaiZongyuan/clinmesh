import type { PathologyExamCode } from '@clinmesh/contracts/pathology'
import { ImagingPackLibrary } from './imaging-pack-library.ts'
import { pathologyImagingAdapter, type InstalledPathologySlide } from './pathology-asset-store.ts'
import type { PathologyCatalog, PathologyCatalogAsset } from './pathology-catalog.ts'
import { pathologyAssetFacts, pathologyProfile } from './pathology-matching.ts'
import { pathologyAssetPublication } from './pathology-report-check.ts'

/** 病理切片素材包的本地来源：清单、安装与缓存规则见 `ImagingPackLibrary`；与放射素材包各自独立。 */
export class PathologyAssetLibrary extends ImagingPackLibrary<PathologyCatalogAsset, PathologyCatalog, InstalledPathologySlide> {
  constructor(input: { assetDirectory?: string | undefined; catalogDirectory?: string | undefined }) {
    super({ ...input, adapter: pathologyImagingAdapter })
  }

  /** 每项会诊是否至少有一份已发布、已安装且能形成适配条目的切片素材。 */
  async readyExamCodes(): Promise<Set<PathologyExamCode>> {
    const ready = new Set<PathologyExamCode>()
    const catalog = await this.catalog()
    for (const service of catalog?.matching?.services ?? []) {
      for (const asset of catalog!.assets) {
        if (pathologyProfile(service, pathologyAssetFacts(asset.clinical)) === undefined) continue
        if (pathologyAssetPublication(asset).publishedRevisions.length === 0 || !await this.installed(asset)) continue
        ready.add(service.examCode)
        break
      }
    }
    return ready
  }
}
