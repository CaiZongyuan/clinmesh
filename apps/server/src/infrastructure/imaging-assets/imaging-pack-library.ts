import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  imagingPackAssetInstalled,
  imagingPackAssetVerified,
  installedImagingPackFingerprint,
  type ImagingIngestAdapter,
  type ImagingPackAsset,
} from './imaging-pack-store.ts'

export class ImagingCatalogInvalidError extends Error {
  constructor(cause: unknown) {
    super(`The imaging asset catalog cannot be loaded: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'ImagingCatalogInvalidError'
  }
}

/**
 * 一个素材包的本地来源：仓库中的清单目录加上部署目录里已安装的文件，格式由摄取适配器定义。
 * 解析后的清单和已打开的素材按文件的 inode、大小与修改时间缓存；清单更新或素材安装、损坏、修复后
 * 指纹随之变化，无需重启即可反映。目录未配置或不存在时视为没有素材。
 */
export class ImagingPackLibrary<Asset extends ImagingPackAsset, Catalog extends { assets: Asset[] }, Opened> {
  readonly #adapter: ImagingIngestAdapter<Asset, Catalog, Opened>
  readonly #assetDirectory: string | undefined
  readonly #catalogDirectory: string | undefined
  #catalog: { catalog: Catalog; fingerprint: string } | undefined
  readonly #opened = new Map<string, { fingerprint: string; opened: Promise<Opened | undefined>; output: unknown }>()

  constructor(input: {
    adapter: ImagingIngestAdapter<Asset, Catalog, Opened>
    assetDirectory?: string | undefined
    catalogDirectory?: string | undefined
  }) {
    this.#adapter = input.adapter
    this.#assetDirectory = input.assetDirectory
    this.#catalogDirectory = input.catalogDirectory
  }

  async catalog(): Promise<Catalog | undefined> {
    const directory = this.#catalogDirectory
    if (directory === undefined) return undefined
    try {
      // 先取指纹再读取：读取期间文件变化时，下次指纹不同会重新读取。目录不存在时以 ENOENT 抛出。
      const files = (await readdir(directory, { recursive: true, withFileTypes: true }))
        .filter(entry => entry.isFile())
        .map(entry => join(entry.parentPath, entry.name))
        .toSorted()
      const fingerprint = (await Promise.all(files.map(async (file) => {
        const { ctimeNs, ino, mtimeNs, size } = await stat(file, { bigint: true })
        return `${file}:${ino}:${size}:${mtimeNs}:${ctimeNs}`
      }))).join('\n')
      if (this.#catalog?.fingerprint !== fingerprint) {
        this.#catalog = { catalog: await this.#adapter.loadCatalog(directory), fingerprint }
      }
      return this.#catalog.catalog
    } catch (error) {
      this.#catalog = undefined
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw new ImagingCatalogInvalidError(error)
    }
  }

  /** 快速就绪判断，用于目录与确认已阅等高频读取。 */
  async installed(asset: Asset): Promise<boolean> {
    return this.#assetDirectory !== undefined
      && await imagingPackAssetInstalled({ adapter: this.#adapter, asset, assetDirectory: this.#assetDirectory })
  }

  /** 逐字节核对已安装文件，用于报告发布前的确认。 */
  async verified(asset: Asset): Promise<boolean> {
    return this.#assetDirectory !== undefined
      && await imagingPackAssetVerified({ adapter: this.#adapter, asset, assetDirectory: this.#assetDirectory })
  }

  /**
   * 打开一个已安装素材；未安装、安装与清单不一致或文件哈希不符时返回 undefined。
   * 逐字节核对每个安装指纹只做一次：文件被改动（包括大小不变的改写）会改变指纹并重新核对。
   */
  async open(asset: Asset): Promise<Opened | undefined> {
    if (this.#assetDirectory === undefined || asset.output === undefined) return undefined
    const input = { adapter: this.#adapter, asset, assetDirectory: this.#assetDirectory }
    const fingerprint = await installedImagingPackFingerprint(input)
    const cached = this.#opened.get(asset.assetId)
    if (cached !== undefined && cached.fingerprint === fingerprint && isDeepStrictEqual(cached.output, asset.output)) {
      return await cached.opened
    }
    this.#opened.delete(asset.assetId)
    if (fingerprint === undefined) return undefined
    // 缓存进行中的核对，并发的像素块请求共用同一次逐字节核对；核对失败的结果同样按指纹缓存，修复后指纹变化再重新核对。
    const directory = join(this.#assetDirectory, 'installed', asset.assetId)
    const output = asset.output as NonNullable<Asset['output']>
    const opened = imagingPackAssetVerified(input)
      .then(verified => verified ? this.#adapter.open(directory, output) : undefined)
    this.#opened.set(asset.assetId, { fingerprint, opened, output: asset.output })
    try {
      return await opened
    } catch (error) {
      if (this.#opened.get(asset.assetId)?.opened === opened) this.#opened.delete(asset.assetId)
      throw error
    }
  }
}
