# Synthea 患者生成的 macOS 兼容性核验

核验日期：2026-10-13。仓库基线：`87783c4b9182a75a07bbb94e08dc5157e77cb750`。本记录核对当前镜像发行、Docker 官方平台能力与 ClinMesh 的运行合同，不定义新平台支持方案。尚未取得同事 MacBook 的芯片型号、Docker Desktop 配置、失败命令和实际错误，不能据此认定其个案根因。

## 已确定的结论

当前固定的 ClinMesh Synthea Provider **只含 `linux/amd64`**；中国化 localizer 的同一固定 digest **同时含 `linux/amd64` 与 `linux/arm64`**。若目标是 Apple Silicon 上的原生运行，缺失的是 ClinMesh Provider 的 arm64 发行，而不是两个依赖都缺 arm64。这一结论来自 GHCR 的实际 manifest 与 config 查询，不只来自部署文档。

Docker Desktop 官方支持 Linux 虚拟机及跨架构模拟，因此“镜像只有 amd64”不能单独证明所有 Apple Silicon Mac 都必然无法运行。当前仓库文档只承诺原生 amd64 部署，要求 arm64 等待原生发行；代码没有阻止 Docker 自行尝试模拟的架构门禁。平台支持合同、Docker 能否启动及该同事实际失败是三件需要分别判断的事。

## 当前锁定镜像的实际发行

[standalone Compose](../../compose.synthea-provider.yaml)固定两个镜像；[完整 Compose](../../compose.synthea.yaml)通过 `extends` 复用它们，没有另一组 Mac 镜像。

| 服务 | 当前固定 digest | GHCR 返回类型与已核实平台 |
| --- | --- | --- |
| `synthea-provider` | `sha256:d93c5797b58ba9aa564cae0ce726a35430c5c8b053f4dcbff46f00b0bd2bf5a2` | 单一 `application/vnd.docker.distribution.manifest.v2+json`；对应 config 的 `os=linux`、`architecture=amd64`，没有 arm64 子 manifest |
| `cn-health-localizer` | `sha256:8b716811d6912b4502168bd23e2cf5f8c25b2f7dcc64caae6706eb1b45262448` | `application/vnd.oci.image.index.v1+json`；运行子 manifest 分别为 `linux/amd64` 和 `linux/arm64`，两个 config 的架构与 index 声明相符 |

Provider 对应 config digest 为 `sha256:1da76a261b31cacaa385d860a2ae77c97803881db2bf6b4ee7160432eefd9c56`。localizer 的 amd64 子 manifest 为 `sha256:a61134863be0ff4cd991a907967488800b93ca72daa525f8f59153022fe6ec90`，arm64 子 manifest 为 `sha256:d0a84723a1e60872142c1eb9fdd4bb3640eb8abdc6a9961c45f412d3c6f0334a`；对应 config digest 分别为 `sha256:4c948d0c136c01b6bb44655084d57b8ee52ab4f98ee4aecc4ca23d39709cca10`、`sha256:7b59f0d764e8d871dd583b5059ec1ffc533c9df12a06f67fcd8d312d1f435320`。index 另有两项 `unknown/unknown`，其 `vnd.docker.reference.type=attestation-manifest`，是供应链证明，不是另外两个可运行平台。

本轮实际执行以下两个只读查询，均成功：

```sh
docker buildx imagetools inspect ghcr.io/caizongyuan/clinmesh-synthea-provider@sha256:d93c5797b58ba9aa564cae0ce726a35430c5c8b053f4dcbff46f00b0bd2bf5a2
docker buildx imagetools inspect ghcr.io/caizongyuan/cn-health-synthea-localizer@sha256:8b716811d6912b4502168bd23e2cf5f8c25b2f7dcc64caae6706eb1b45262448
```

随后以 GHCR 匿名 pull token 在内存中完成第二次核对：请求固定 digest 的 manifest，继续读取 Provider config，以及 localizer 的两个运行子 manifest/config。没有下载镜像层、启动容器或输出 token。第一方查询地址分别为 [Provider manifest](https://ghcr.io/v2/caizongyuan/clinmesh-synthea-provider/manifests/sha256:d93c5797b58ba9aa564cae0ce726a35430c5c8b053f4dcbff46f00b0bd2bf5a2)与 [localizer index](https://ghcr.io/v2/caizongyuan/cn-health-synthea-localizer/manifests/sha256:8b716811d6912b4502168bd23e2cf5f8c25b2f7dcc64caae6706eb1b45262448)；直接打开 Registry API 可能要求按其认证 challenge 获取匿名 token。

[Provider 发行 workflow](../../.github/workflows/synthea-provider.yml)明确以 `platforms: linux/amd64` 构建、验证后发布。它的命令测试矩阵只有 Ubuntu 与 Windows，镜像组合测试在 Ubuntu 运行；该 workflow 不包含 macOS 或原生 arm64 验收。[Docker 合同测试](../../apps/server/tests/synthea-docker-contract.test.ts)也明确要求该 workflow 不出现 `linux/arm64`。因此补齐原生支持不仅是改变一个本地启动参数，还会涉及发行及相应合同。

历史[一键运行时 Note](../decisions/implemented/architecture/2026-09-03-one-command-synthea-runtime.md)列出的 Provider `8018b3ea…` 已不是当前 Compose 的固定 digest。本轮查询使用当前 Compose 的 `d93c5797…`，不能使用历史 digest 推断当前发行。

## Docker 官方能力与 Mac 的区别

| 环境 | 第一方资料能够证明什么 | 对 ClinMesh 的含义 |
| --- | --- | --- |
| Intel Mac | Docker 提供 Intel 版 Desktop；Desktop 使用 Linux 虚拟机运行 Linux 容器 | CPU 架构与 `linux/amd64` 镜像匹配，没有 Apple Silicon 的跨 CPU 架构问题；仍可能因 Desktop 未运行、镜像网络、资源或服务配置失败，不能由型号证明服务健康 |
| Apple Silicon Mac | Docker 提供 Apple Silicon 版 Desktop；官方多平台文档说明 Desktop 默认支持模拟运行和构建跨架构镜像 | localizer 已有原生 arm64 版本；Provider 若能运行仍是 amd64 模拟，不是已经交付原生 arm64 支持。是否选择/成功模拟需核对实际 Docker 版本、设置及错误 |
| Apple Virtualization framework | 官方设置提供 Rosetta x86_64/amd64 模拟加速选项 | 有可用的加速路径，不能把“缺 arm64 镜像”解释为操作系统绝对无法运行 amd64 程序；本轮未启用或实测该设置 |
| Docker VMM | 官方当前说明不支持 Rosetta，amd64 模拟较慢 | 两台同为 Apple Silicon 的 Mac 也可能有不同模拟表现；不能忽略 VMM 配置，更不能仅据超时判断生成逻辑错误 |

第一方来源：[Mac 安装要求](https://docs.docker.com/desktop/setup/install/mac-install/)、[多平台镜像与模拟](https://docs.docker.com/build/building/multi-platform/)、[Desktop 设置](https://docs.docker.com/desktop/settings-and-maintenance/settings/)、[Virtual Machine Manager](https://docs.docker.com/desktop/features/vmm/)。本轮实际读取 Docker 官方文档仓库的 [Mac 安装源码](https://github.com/docker/docs/blob/main/content/manuals/desktop/setup/install/mac-install.md)、[多平台源码](https://github.com/docker/docs/blob/main/content/manuals/build/building/multi-platform.md)、[设置源码](https://github.com/docker/docs/blob/main/content/manuals/desktop/settings-and-maintenance/settings.md)与 [VMM 源码](https://github.com/docker/docs/blob/main/content/manuals/desktop/features/vmm.md)，并对多平台及 VMM 公开页面核对 HTTP 200 与正文。

模拟可能增加计算开销是官方平台层面的限制；本轮没有测量本镜像在 Mac 上的启动耗时、生成耗时或正确性，不把这种可能性写成同事已经发生的故障。

## 项目支持合同与实现的差异

[部署指南](../deployment.md#6-synthea-患者生成)原文是：“当前 Provider 镜像只发布 `linux/amd64`。arm64 主机不自动启用模拟运行，必须等待对应的原生镜像发行。”这定义了当前产品支持范围，不是 Docker 本身的能力限制。

实际 [runtime 脚本](../../scripts/synthea-runtime.ts)没有 `process.arch` 或 Docker 服务端架构判断，只检查 `docker --version` 是否可执行，然后调用 Compose。当前 Compose 没有 `platform:`，也没有禁止模拟的配置。因此不能把文档描述解释为“代码在发现 M 系列 Mac 时一定明确拒绝”，也不能把 Docker 偶然模拟成功提升为受项目支持的 Mac 验收。

当前 `up` 拉取并启动两个服务，以 `--wait --wait-timeout 180` 等待 Compose 健康，再读取 Provider `/health`；Provider 健康响应读取另有 5 秒上限。启动失败时脚本尝试停止并移除这两个部分启动服务。`doctor` 先核对健康，再在 Provider 容器中执行一次全模块单患者 smoke；它不是只看端口是否能连通。该脚本和 [Provider Dockerfile](../../apps/synthea-provider/Dockerfile)拥有具体启动、健康检查与 smoke 合同。

`docker --version` 成功只证明 CLI 存在，不能证明 Docker Desktop 的 daemon 已就绪。脚本缺失 CLI 时的提示提到 WSL，即使发生在 Mac 也不能据这段通用文字断言同事是在 WSL 环境失败。

## 需要区分的失败阶段

| 实际失败点 | 当前应查的 owner | 不能直接推出的结论 |
| --- | --- | --- |
| `pnpm synthea:up` 拉取、创建或健康等待失败 | [runtime 脚本](../../scripts/synthea-runtime.ts)、[Compose](../../compose.synthea-provider.yaml)、Docker Desktop/Registry 响应 | 不能直接归为患者病历生成逻辑错误；需要具体 daemon、架构、网络、资源与健康错误 |
| Provider 健康，但“生成患者”任务失败 | [Synthea HTTP adapter](../../apps/server/src/infrastructure/scenario-generation/synthea-provider.ts)、[生成任务服务](../../apps/server/src/application/scenario-data/scenario-data-service.ts)、[ProviderServer](../../apps/synthea-provider/ProviderServer.java) | 需要区分连接、超时、定向条件不满足、无合格本次就诊、响应或来源合同校验；不能只因主页面能打开就认定 Provider 可用 |
| 患者已生成，“生成患者档案”或 Brief 失败 | [Patient Persona 服务](../../apps/server/src/application/patient-persona-service.ts)、[运行时模型装配](../../apps/server/src/runtime.ts)、[部署的 AI 阶段](../deployment.md) | 这是后续 AI 模型配置、调用或输出验证阶段，不能直接归因于 Synthea 镜像平台 |
| Brief 已成功，但不能开始门诊 | [病例就诊服务](../../apps/server/src/application/synthetic-case-visit-service.ts)及当前病例状态 | 需要看病例 revision、档案选择和业务错误；不属于 Docker 平台证明能够解决的问题 |

## 当前 Linux 基线的实际验证

本地 Docker daemon 为 `linux/x86_64`，执行验证前两个既有服务均为 `running`、`healthy`。没有为本轮验证启动、停止或重新配置容器。

| 实际命令 | 实际结果 | 耗时与证据范围 |
| --- | --- | --- |
| `pnpm_config_verify_deps_before_run=error pnpm synthea:doctor` | 退出码 0；健康响应声明固定 Synthea commit `d9d07a6eef91ee5144293b42ab64224d84d124f8`、profile `synthea-cn@2026-08-29.r4`、242 个模块；打印 `Provider smoke passed` 与全模块单患者 smoke 通过 | 未单独计时；证明当前已运行的 Linux/x86_64 Provider 与 localizer 组合能够完成 smoke，不是 Mac 实机证据 |
| `pnpm_config_verify_deps_before_run=error pnpm exec vitest run scripts/synthea-runtime.spec.ts` | 退出码 0，实际输出 2 个文件、24 项测试通过 | Vitest `Duration 228ms`；证明本机命令合同测试通过，不证明 Apple Silicon 原生或模拟兼容 |

全模块 smoke 未向 ClinMesh HIS 业务库新增患者，也未输出 FHIR Bundle。本地健康与成功样本可以作为排除“当前固定发行在任何环境都不能生成”的基线，不能代替同事报错及 Mac 环境核验。

## 定位个案需要的信号

以下是按报错选择检查方向的依据，不是已经观察到的同事错误。当前只有“MacBook 无法生成患者”的描述，没有可重现其原故障的输入，因此本轮未对该机器进行修复验收。

| 同事的实际信号 | 可以支持的检查方向 |
| --- | --- |
| 架构不匹配、`exec format error` 或对应平台 manifest 缺失 | 核对 Docker daemon 架构、固定 Provider manifest 和模拟运行环境；缺少原生 arm64 发行已独立确认，但仍须关联其实际启动错误 |
| `Cannot connect to the Docker daemon`，或找不到 `docker` | 检查 Docker CLI、daemon/context 与 Desktop 是否就绪，先恢复容器运行条件 |
| 镜像拉取失败或认证/网络错误 | 检查 GHCR 连接与该固定 digest 的可达性；同一镜像在本机可以查询不能证明同事网络可用 |
| 容器已创建但健康等待超时 | 分别查看 Provider/localizer 的健康和退出状态，区分资源、启动异常和模拟性能；当前启动等待 180 秒与健康读取 5 秒有各自边界 |
| 健康检查通过但业务任务失败 | 根据 `PROVIDER_TIMEOUT`、`PROVIDER_REQUEST_FAILED`、`KEEP_NOT_SATISFIED`、`INDEX_ENCOUNTER_NOT_FOUND` 等实际业务码追踪生成阶段，不以 Mac 型号替代判断 |
| 患者已经生成，之后 Brief 失败 | 单独检查 AI Provider 与模型访问、超时或输出验证；不把 AI 档案阶段的失败归为 Synthea 未生成 |

只读主机与容器检查，以及现有生成 smoke 的入口如下；这些命令用于取得同事端证据，本轮只在上述 Linux 基线上执行过相应验证，未在 Mac 实机运行：

```sh
uname -m
docker info --format '{{.OSType}}/{{.Architecture}}'
docker compose -f compose.synthea-provider.yaml ps -a
pnpm synthea:doctor
```

`synthea:doctor` 会执行一个真实合成患者生成 smoke，不向 HIS 业务库新增患者。失败输出只需保留命令、错误和安全元数据，不收集凭据或患者正文。CLI 缺失、daemon 不可达或 Provider 未启动时应先处理对应阶段；本记录不要求为了诊断停止既有服务。

## 处理方向

若需要让 Apple Silicon 原生运行，建议发布并组合验证 ClinMesh Provider 的 `linux/arm64` 版本，保留 amd64，随后将 Compose 锁定到对应的新发行并更新当前架构合同与文档。localizer 当前已含原生 arm64，可按现有固定发行验证，无须仅因 Mac 问题同时升级它。目标主机或原生 arm64 runner 的组合生成证据仍不可省略；本轮没有构建或发布该修复。

临时使用远端 amd64 Provider 在接口上可行，因为 Server 通过 `CLINMESH_SYNTHEA_PROVIDER_URL` 消费 HTTP 协议。但现有 standalone Compose 仅发布本机回环地址，需要先建立受控可达路径；直接把另一台机器的 IP 写入配置不会改变其监听范围。配置变更后还需让实际 Server 进程读取新的来源，再核对健康与生成。本轮没有改动监听地址或建立远端连接。来源：[配置 owner](../../apps/server/src/config.ts)、[Compose](../../compose.synthea-provider.yaml)及[Provider HTTP adapter](../../apps/server/src/infrastructure/scenario-generation/synthea-provider.ts)。

Docker 的 amd64 模拟可以作为另行验证的运行路径，当前项目没有相应 Mac 验收证据，不将开启 Rosetta、强制平台或增大超时直接当作已验证修复。Intel Mac 如失败则按实际错误检查，无须因“MacBook”名称要求更换 CPU 架构。

## 证据边界与未决信息

已获得真实 GHCR 固定发行信息和 Docker 第一方文档，并在既有 Linux 服务执行生成 smoke；未取得同事实际 Mac 或失败日志。本轮只新增核验记录与可复用工程记忆，没有更改 Compose、镜像 digest、发行 workflow、程序、测试或 Docker daemon 设置，没有启动或停止服务，没有输出凭据、患者正文、影像像素或 `references/` 内容。

下一步诊断所需的最小输入是失败命令/页面步骤、完整非敏感错误和 Apple Silicon/Intel 类型。其后再决定核对 Docker Desktop daemon 与平台、Provider 启动/health、患者生成任务或 AI Brief；不能在这些信息缺失时宣称已复现或已修复 Mac 问题。
