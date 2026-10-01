import {
  imagingAssetInstalled,
  imagingAssetVerified,
  openInstalledImagingAsset,
  type InstalledImagingSeries,
} from './imaging-asset-store.ts'
import { loadImagingCatalog, type ImagingCatalog, type ImagingCatalogAsset } from './imaging-catalog.ts'
import { imagingAssetPublication } from './imaging-report-check.ts'

export class ImagingCatalogInvalidError extends Error {
  constructor(cause: unknown) {
    super(`The imaging asset catalog cannot be loaded: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'ImagingCatalogInvalidError'
  }
}

/**
 * 本地影像素材来源：仓库中的素材清单加上部署目录里已安装的像素。
 * 每次都读取磁盘，清单更新或素材安装、损坏、修复后无需重启即可反映；目录未配置或不存在时视为没有素材。
 */
export class ImagingAssetLibrary {
  readonly #assetDirectory: string | undefined
  readonly #catalogDirectory: string | undefined

  constructor(input: { assetDirectory?: string | undefined; catalogDirectory?: string | undefined }) {
    this.#assetDirectory = input.assetDirectory
    this.#catalogDirectory = input.catalogDirectory
  }

  async catalog(): Promise<ImagingCatalog | undefined> {
    if (this.#catalogDirectory === undefined) return undefined
    try {
      return await loadImagingCatalog(this.#catalogDirectory)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw new ImagingCatalogInvalidError(error)
    }
  }

  /** 快速就绪判断，用于目录与确认已阅等高频读取。 */
  async installed(asset: ImagingCatalogAsset): Promise<boolean> {
    return this.#assetDirectory !== undefined
      && await imagingAssetInstalled({ asset, assetDirectory: this.#assetDirectory })
  }

  /** 逐字节核对已安装像素，用于报告发布前的确认。 */
  async verified(asset: ImagingCatalogAsset): Promise<boolean> {
    return this.#assetDirectory !== undefined
      && await imagingAssetVerified({ asset, assetDirectory: this.#assetDirectory })
  }

  /** 打开一个已安装素材的各序列；未安装或安装与清单不一致时返回 undefined。 */
  async open(asset: ImagingCatalogAsset): Promise<InstalledImagingSeries[] | undefined> {
    if (this.#assetDirectory === undefined || !await this.installed(asset)) return undefined
    return (await openInstalledImagingAsset({ assetDirectory: this.#assetDirectory, assetId: asset.assetId })).series
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
