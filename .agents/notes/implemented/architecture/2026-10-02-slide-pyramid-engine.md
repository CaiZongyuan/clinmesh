# Agent Note: 病理切片阅片引擎选用 OpenSeadragon

Status: implemented

## Problem

病理切片是多层 RGB 瓦片金字塔，一张原生 20× 切片有数万个 JPEG 瓦片，阅片需要平移、连续缩放、导航小图和倍率读数。[胸片与胸部 CT 阅片闭环](2026-10-01-chest-imaging-reading-loop.md) 的阅片外壳按序列 `kind` 取引擎，已有的灰度堆叠引擎按帧读取整幅图像，不适用于瓦片。

新引擎要同时满足三个约束。DSH Surface 的 Client 是一个不压缩依赖、不能有动态 chunk 的 lazy-CJS 文件，体积预算 4,100,000 字节，宿主提供 React 18.3.1，standalone Web 使用 React 19.2。瓦片属于受认证、不缓存的本院检查读取，必须经外壳给出的读取函数取得，切换切片或病例后旧瓦片不能显示。切片层级之间不逐级减半：原生 20× 切片的层级是 20×、10×、5×，之后跳到 1.25×。

本决策由 [issue #142](https://github.com/CaiZongyuan/clinmesh/issues/142) 交付，规格见 [issue #135](https://github.com/CaiZongyuan/clinmesh/issues/135)。当前行为的详细归属是 [前端架构的阅片器](../../../../docs/frontend-architecture.md#阅片器)；本记录只保留取舍和实测数据。

## Decision

**`tiled-pyramid` 引擎使用 OpenSeadragon 6.1.1（BSD-3-Clause）。** 它通过了 DSH 产物的三项检查，平移、连续缩放、触控手势、导航小图和瓦片调度不需要自行实现。

| 检查 | 结果 |
| --- | --- |
| 产物体积（预算 4,100,000 字节） | 引入前 3,369,054；引用压缩构建后 3,917,951，增加 548,897，余量 182,049 |
| lazy-CJS 加载 | 产物中没有 `import.meta`，`require` 只有允许的五个模块；在带 React 18 的浏览器页面中用模拟的模块加载器执行产物，工厂函数正常返回，没有错误，也没有写入全局 `OpenSeadragon` |
| React 18/19 双版本合同 | 合成金字塔场景在两个版本下通过 |

**引用压缩构建，不引用包的默认入口。** Surface 构建器不压缩依赖。默认入口是未压缩源码，引入后产物为 4,109,187 字节，超出预算；压缩构建经构建器重新排版后仍比默认入口小约 19 万字节。压缩构建没有类型声明，`apps/web/src/app/imaging/openseadragon-min.d.ts` 把它指向包内类型，`apps/dsh-web/tsconfig.json` 显式包含该声明文件。

**瓦片读取完全由引擎接管。** 引擎构造自定义瓦片源并覆盖 `downloadTileStart` 与 `downloadTileAbort`：位置交给外壳的 `loadBlock`，JPEG 字节用 `createImageBitmap` 解码，画到每个瓦片自己的 canvas 后立即 `close()`，再以 `context2d` 类型交给 OpenSeadragon。`getTileUrl` 的返回值只作缓存键。内置导航按钮会从 `prefixUrl` 请求图片，因此关闭，按钮由引擎自己渲染。浏览器合同断言阅片器没有发起任何 `fetch`、XHR 或资源请求。

**取消和并发由引擎自己的闸门保证。** 每个瓦片请求有自己的 `AbortController`；引擎卸载（外壳切换切片或病例时重建引擎）先取消全部请求再销毁阅片器，已取消的瓦片即使解码完成也不交给 OpenSeadragon。导航小图是另一个阅片器实例，不受 `imageLoaderLimit` 约束，因此并发上限由引擎内的闸门统一执行：主视图与导航小图合计最多六个请求。主视图的解码缓存预算 64 MiB，按瓦片 RGBA 字节折算为 `maxImageCacheCount`（256 像素瓦片约 256 个，240 像素瓦片约 291 个）。两个数值经真实切片在两个通道实测确认，结果见 Consequences。

**几何规则在 `core`，OpenSeadragon 只负责调度和绘制。** OpenSeadragon 默认假定层级逐级减半。引擎覆盖瓦片源的层级比例、瓦片数、瓦片位置和点到瓦片的换算，全部调用 `@clinmesh/core/imaging-pyramid` 的纯函数；层级选择阈值 `minLevelPixelOnScreen` 同时作为 OpenSeadragon 的 `minPixelRatio`，浏览器合同用画面像素验证两者选出同一层。倍率读数和缩放上限也来自同一模块，最高 20×。

**使用二维 canvas 绘制。** 瓦片缓存就是每瓦片一个 canvas，淘汰时由 OpenSeadragon 归零释放；主视图与导航小图不占用 WebGL 上下文，浏览器合同可以直接读取画面像素做聚合统计。

## Alternatives considered

**自行实现轻量 canvas 瓦片引擎。** 产物体积几乎不变，层级选择完全由 `core` 决定。代价是自行实现惯性平移、以指针为中心的连续缩放、触控捏合、键盘操作、导航小图及其拖动、瓦片优先级和层间过渡，并长期维护。OpenSeadragon 通过了全部检查，因此不走这条路；它仍是同一登记条目下的备选，产物余量不足时可以换回约 54 万字节。

**引用 OpenSeadragon 的默认入口。** 写法最直接并自带类型，但产物超出预算约 9 千字节。

**让 OpenSeadragon 按 URL 读取瓦片（`loadTilesWithAjax` 加凭证）。** 接入最少，但瓦片请求会绕过外壳的读取函数：DSH 通道的代理路径、统一的错误处理和取消都要在引擎里重做一遍，管理员复核预览等其他调用方也无法复用同一引擎。

**把 `ImageBitmap` 直接交给 OpenSeadragon。** 二维 canvas 绘制只接受 `context2d`，OpenSeadragon 会自行转换，但它没有为 `ImageBitmap` 登记释放函数；补上需要修改全局转换器。引擎自己完成转换并释放，不依赖全局状态。

**使用 WebGL 绘制。** 大视口下合成更快，但主视图与导航小图各占一个 WebGL 上下文，浏览器对上下文总数有上限，画面像素也不能直接读取验证。首期瓦片数量下二维 canvas 足够。

## Consequences

DSH 产物的体积余量从约 73 万字节降到约 18 万字节。后续向 Surface 增加依赖或大段代码前先看 `verify-artifact.ts` 的结果；余量不足时优先考虑把本引擎换成轻量实现。

OpenSeadragon 随 Surface 一起加载和初始化，不阅片的页面也承担这部分解析开销。它在模块初始化时探测 canvas 支持，jsdom 下的 Web 测试会因此打印 `getContext` 未实现的提示，不影响结果。产物中包含 OpenSeadragon 的图像转换 Worker 源码，当前配置不会启动它。

层级选择阈值与 OpenSeadragon 的 `minPixelRatio` 绑定。修改 `minLevelPixelOnScreen`、升级 OpenSeadragon 或改用其他绘制方式后，需要重新运行合成金字塔的浏览器合同。OpenSeadragon 的动画和瓦片调度按真实渲染帧推进，该合同用 Playwright 的真实时钟运行，不使用 Chrome 的虚拟时间。

边缘瓦片若按完整瓦片尺寸编码，JPEG 色度上采样会让填充色渗入有效范围最外侧一两列像素。引擎在解码后裁掉填充部分，但已经渗入的颜色无法去除；摄取时填充色应接近切片背景色。

导航小图的解码缓存不计入 64 MiB 预算；它只读取能铺满小图的低分辨率层级。

真实切片没有比 1.25×（或 2.5×）更低的层级，打开切片时主视图和导航小图各自读完整个最低层级：首批 7 张切片的最低层级为 48–195 个瓦片，首屏瓦片请求数是它的两倍。瓦片响应为 `private, no-store`，两个阅片器实例不共享已读取的字节。

并发上限 6 与缓存预算 64 MiB 的实测（本机回环，`tcga-brca-he-01`，最低层级 120 个瓦片，1600×1000 视口）：

| 通道 | 首屏瓦片请求 | 首屏字节 | 首屏耗时 | 单瓦片耗时 P50 / P95 | 同时在途峰值 |
| --- | ---: | ---: | ---: | ---: | ---: |
| standalone Web | 240 | 约 6.9 MB | 约 2.0 s | 8 ms / 21 ms | 6 |
| DSH（经宿主代理） | 240 | 约 6.7 MB | 约 2.0 s | 10 ms / 30 ms | 6 |

DSH 代理为每个瓦片增加约 2 ms。从首屏连续放大到 20× 的过程中两个通道各读取 53–65 个瓦片，单瓦片 P95 都是 10 ms。首屏的全部瓦片少于缓存条目上限，放大后淘汰的是不在画面内的瓦片。这些是跨机器不稳定的时间指标，只在真实入口验证中记录，不作为门禁；门禁由 Server HTTP 合同持有（每个瓦片请求固定的只读语句数、零写入、零 Audit Event、零 Action Trace）。
