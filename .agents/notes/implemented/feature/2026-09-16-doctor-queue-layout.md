# Agent Note: 医生队列分组与弹性工作区

Status: implemented

## Problem

医生页面的活动诊疗和完诊导航分散在顶部与病例队列中，有限的 Surface 宽度和高度没有优先分配给病例处理。未分页前统一筛选时，客户端按当前页分类会产生空页和不准确的组内总数。

## Decision

依据 [Issue #112](https://github.com/CaiZongyuan/clinmesh/issues/112)，左侧统一提供在诊、待诊和完诊。待诊包含 `awaiting-doctor`、`awaiting-revisit`；在诊包含 `first-visit`、`awaiting-report`、`revisit-draft`。医生队列的可选 `view` 参数在数据库计数和分页前筛选，不提供参数时保持原有完整队列。完诊使用既有只读查询和修订入口，候选患者保留在待诊区域。

工作区按实际容器尺寸分配空间，队列宽度为 240px，中间区域占据剩余空间，低于 720px 时使用列表与详情切换；病例上下文在空间不足时使用既有抽屉。工作区使用父容器高度，列表和详情各自滚动，缩放不卸载病例编辑器。Web 和 DSH Surface 复用相同组件。

## Alternatives considered

- 仅将原队列和候选患者改名为在诊与待诊：不能反映已挂号病例的真实接诊状态。
- 在客户端筛选当前页：组内总数错误，并可能漏掉其他页的待诊病例。
- 保留顶部导航与完诊双栏表格：重复导航和较宽的列表继续挤占病例处理空间。

## Consequences

Operation Catalog 与医生 Skill 显式描述可选筛选，旧调用仍可取得完整活动队列。HTTP 测试负责状态与分页语义，页面集成测试负责导航与修订回跳，浏览器负责实际容器尺寸与编辑器保留。更新源码后必须重建用户实际使用的 Web 与 DSH 产物。
