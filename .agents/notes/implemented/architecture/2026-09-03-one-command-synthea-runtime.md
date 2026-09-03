# Agent Note: 一键 Synthea 运行时

Status: implemented

## Problem

Synthea 患者生成依赖固定 Java 生成器、中国 profile、姓名/地理/人口数据和临床显示目录。让部署者 clone 数据仓库、安装贡献者工具链、构建 profile、调整 Release 路径和配置宿主 UID/GID，会把发行实现暴露成产品部署接口，也无法保证不同部署使用相同输入。

本决策由 [issue #76](https://github.com/CaiZongyuan/clinmesh/issues/76) 交付，并局部取代[可选 Synthea 生成 Provider](./2026-08-26-optional-synthea-provider.md)与[cn-health 数据和 Synthea 中国本地化接入](./2026-08-30-cn-health-synthea-localization.md)中的本地镜像构建、宿主数据挂载和 UID/GID 配置机制。两份原决策的任务协议、中国化所有权、provenance、失败隔离和业务数据语义继续有效。

## Decision

部署接口只有 `pnpm synthea:up`、`pnpm synthea:doctor` 和 `pnpm synthea:down`。`up` 通过 `compose.synthea-provider.yaml` 幂等拉取并启动 `cn-health-localizer` 与 `synthea-provider`，限定这两个服务并等待 Compose 健康后读取有界 Provider `/health`；`doctor` 先验证同一健康合同，再在 Provider 内执行一次全模块单患者 smoke；`down` 只停止并移除这两个容器，不调用 Compose `down`，不删除 volume、ClinMesh SQLite 或其他服务。

Compose 只消费不可变镜像 digest。cn-health localizer 固定为 `ghcr.io/caizongyuan/cn-health-synthea-localizer@sha256:8b716811d6912b4502168bd23e2cf5f8c25b2f7dcc64caae6706eb1b45262448`，来源是上游 [`synthea-cn-2026-08-29.r4-preview.1`](https://github.com/CaiZongyuan/cn-health-data/releases/tag/synthea-cn-2026-08-29.r4-preview.1)，内置 `synthea-cn@2026-08-29.r4`、匹配的三个 r2 Candidate 和 `experimental-preview` 临床显示目录。ClinMesh Provider 固定为 `ghcr.io/caizongyuan/clinmesh-synthea-provider@sha256:5ce7fe5f7223a21a31a58794a504fa94f058812d8815ee2448eb0592184910f8`，内置相同 profile、固定 Synthea JAR、模块清单、ProviderServer 以及上游 LICENSE 和 DATA-NOTICE。两者以非 root、只读文件系统和有界 tmpfs 运行，宿主不挂载 profile、Candidate、翻译目录或 Docker socket。

Provider 镜像只发布当前部署支持的 `linux/amd64`，并在原生 amd64 runner 上构建。Provider build stage 在发布阶段下载固定 Synthea 源码与上游 profile 归档并校验 SHA-256；运行时不访问 GitHub、Registry 或其他构建来源。Provider 镜像 workflow 可在 pull request 上构建和组合 smoke，维护者显式 dispatch 才把同一份已验证镜像发布到 GHCR，并附加 SBOM 与 build provenance。

ClinMesh Server 只通过 `CLINMESH_SYNTHEA_PROVIDER_URL` 消费 Provider HTTP 接口；本地默认地址是 `http://127.0.0.1:51878`，完整 Compose 使用容器 DNS。Server 启动不等待 Provider，Provider 缺失、停止或失败只影响新的患者生成任务。生成请求、持久任务、重启重排队、Profile/Case 原子保存、Patient Brief 和开始门诊就诊合同不因部署收敛而改变。

## Alternatives considered

**把 Provider 与 localizer 合并为一个容器。** 这会减少内部容器数，但需要合并 Java 与 Python 进程管理或复制中国化实现。Compose 已把内部拓扑隐藏在一个命令后，合并不能进一步缩小部署者接口。

**继续从源码构建并挂载宿主数据。** 这保留本地可修改性，但要求部署者承担贡献者工具链、Release 对齐、路径和权限配置，无法作为稳定消费路径。

**使用可变镜像 tag。** tag 更易阅读，但同一部署声明可能在不同时间解析到不同字节，破坏复现和审计，因此 Compose 只接受 digest。

**让 Server 启动 Provider 或依赖其健康。** 这可以少运行一个命令，却需要 Docker socket 或扩大主进程供应链，并让可选生成能力阻塞普通 HIS。

## Consequences

全新 checkout 启用患者生成只需要 Docker 与一条 `pnpm synthea:up`；宿主不需要第二个仓库、JDK、Python、Rust、`uv` 或手工配置文件。首次启动需要拉取固定镜像，后续启动复用本地内容寻址层。

升级 Synthea、profile、Candidate、catalog 或 Provider 时必须发布新镜像并更新 digest；不能原地覆盖旧部署身份。临床显示仍是 `experimental-preview`，不得描述为正式术语发行物。

停止运行时不影响已保存的 Synthetic Patient Profile、Synthetic Case Instance、Patient Brief 或正在进行的本院 Encounter。需要生成新患者时重新执行 `pnpm synthea:up` 即可。
