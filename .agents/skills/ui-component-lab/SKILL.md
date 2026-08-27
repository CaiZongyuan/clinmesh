---
name: ui-component-lab
description: 基于 React、shadcn/ui 与 Base UI 的参考驱动 UI 探索工作流。用于设计、重设计、优化、对比或挑选组件/页面方案，以及用户提供自然语言、截图、图片、网页、GitHub/源码或现有组件作为 UI 参考时。先读取当前项目与参考，形成设计解读，在隔离的 /ui-dev 中生成多个结构上明显不同的可运行候选，让用户视觉选择并迭代；只有明确批准后才提升到生产代码。适合“做几个版本让我选”“参考这个组件/网站/截图”“这个 UI 不好看，探索一下”等任务。
---

# UI Component Lab

把 UI 设计变成“理解 → 参考 → 多方案 → 视觉选择 → 收敛 → 落地”的工作流。默认尊重现有 shadcn/ui + Base UI，不凭空重建设计系统。

## 核心原则

- **Reference-first**：优先从现有项目、用户参考和可读源码中提取设计模式，再生成方案。
- **先探索，后生产**：除非用户明确要求直接修改，否则不要先覆盖生产组件。
- **视觉探索 ≠ 业务重构**：保留业务逻辑、数据契约、可访问性与必要测试钩子，只探索允许变化的 UI。
- **候选必须结构不同**：不要只换颜色、圆角、阴影；应在结构、信息密度、交互或 motion 上形成明显差异。
- **事实自己查，偏好才问**：能从代码、配置、参考或工具中获得的信息不要问用户。
- **看着选优于抽象问卷**：偏好不明确时，用差异化候选帮助用户判断。
- **保持项目原生**：沿用现有 tokens、主题、目录、组件 API 与 primitive；不要无故引入第二套基础 UI 系统。

## 工作流

### 1. DISCOVER — 读取项目

先检查项目，而不是询问用户：

- `package.json`、`components.json`、路由与目录结构。
- shadcn/ui、Base UI、Tailwind、aliases、motion 依赖。
- 已有 tokens、主题、组件与代码规范。

若项目已使用 Base UI，不要为了复刻参考而引入 Radix、MUI、Ant Design 等第二套 primitive 系统；把参考改写到当前技术栈。

### 2. DESIGN READ — 形成设计解读

在动手前，用一两句话判断：

- 这是什么组件/页面，谁在什么场景使用。
- 当前产品的视觉气质与信息密度。
- 本次设计最重要的目标是什么。

能从上下文判断就直接继续，不要把这些判断重新变成问卷。

### 3. CONTEXT — 划定可变边界

重设计已有组件时先区分：

**必须保留**
- props / data contract
- 业务行为与状态
- accessibility
- analytics / test hooks（若存在）
- 已有 design tokens

**可以探索**
- layout / composition
- information hierarchy
- density
- interaction presentation
- progressive disclosure
- motion / transition
- visual treatment

所有候选尽量共享真实 props 或同一份 mock data。

### 4. PREFERENCE — 只问高信息增益问题

仅当答案会显著改变候选空间、且无法从项目/参考/上下文推断时再问。

- 默认 **0 个问题**。
- 必要时 **1 个问题**。
- 极少情况最多 **2 个问题**。
- 每个问题给出推荐答案。
- 不问圆角、阴影、动画毫秒数等 Agent 可自行探索的细节。
- 用户说“你先做”“不知道”“先给我看看”时，立即停止追问并进入探索。

不要等所有偏好都明确；候选 UI 本身就是获取偏好的方式。

### 5. REFERENCES — 拆解参考

参考优先级：

1. 当前项目已有组件与已通过方案。
2. 用户本次提供的参考。
3. 可访问源码的 UI 项目或 registry。
4. 其他外部参考。
5. 纯模型生成。

优先读源码，并提取设计 DNA：

- layout / composition
- information hierarchy
- interaction model
- progressive disclosure
- motion / transition
- visual treatment
- states / accessibility

不要机械复制。若用户只喜欢参考的一部分，明确拆分“保留什么 / 不要什么”。遵守来源许可。

### 6. EXPLORE — 展开设计空间

默认生成 **4–6 个**可运行候选；复杂任务可增加到 6–8 个。

主动拉开三个轴：

- **Structure**：布局、信息组织、交互模型。
- **Density**：紧凑、平衡、解释充分。
- **Motion**：静态克制、细微反馈、较强状态连续性。

要求：

- 所有候选使用相同数据与业务语义。
- 至少有 3 个候选在结构或交互模型上真正不同。
- 不要为了凑数量只做主题换皮。
- 不要为了显得“设计过”自动加入无依据的渐变、毛玻璃、glow、大圆角、卡片套卡片、装饰性动效或无意义 badge。
- 优先延续项目设计语言；参考用于突破默认模式，而不是制造装饰。
- 不要为了候选引入大量一次性依赖。

每个候选只标注简短名称、核心差异和主要参考。

### 7. CANDIDATE GATE — 渲染前检查

确认：

- 候选是否真的结构不同，而非换皮？
- 是否使用相同数据比较？
- 是否遵循当前 shadcn / Base UI / tokens？
- 是否避免无必要的新依赖？
- 是否保留目标组件的业务契约？

不满足就先修正，不要把低质量候选交给用户筛选。

### 8. RENDER — 创建 `/ui-dev`

创建只用于开发探索的逻辑入口：

```text
/ui-dev
```

根据当前框架选择实际文件路径，不硬编码 Next.js 或某一种 Router。

要求：

- 与生产 UI 隔离。
- 在同一 experiment 中展示全部候选。
- 渲染真实 React 组件，不用静态截图代替。
- 共享统一 mock/真实数据。
- 避免 `/ui-dev` 意外成为正式产品功能。

完成后只告诉用户：访问入口、候选数量、每个候选一句话差异，然后等待视觉反馈。

### 9. LEARN / REFINE — 根据选择收敛

把用户的选择与否定视为偏好信号。例如“B 最好，但要 C 的头部；A 太像传统 SaaS”应理解为：

- B = 主结构
- C = header treatment
- 拒绝 traditional SaaS card appearance

下一轮只生成少量收敛版本（如 R1–R3），不要重新随机扩散。

一次选择只视为当前 experiment 偏好；只有用户明确声明或多次稳定选择后，才把它视为项目级规则。

### 10. PROMOTE — 批准后进入生产

只有用户明确说“用这个 / 就这个 / promote”后才：

1. 整理为正式生产组件。
2. 接回真实 state、数据与业务逻辑。
3. 保持或合理迁移现有 API。
4. 补齐 default、loading、empty、error、overflow、disabled、responsive。
5. 检查键盘操作、focus、语义与 Base UI accessibility。
6. 做最小必要验证：能编译、路由可访问、主要交互可用。
7. 避免无关重构和大规模测试，除非用户要求。

默认暂时保留 experiment，方便回退；用户要求清理时再删除失败候选和临时代码。

## 快速决策

- 只是 padding、颜色、文案等微调 → 直接修改，不启动完整 UI Lab。
- 涉及重新设计、视觉方向或交互选择 → 启动完整流程。
- 参考已很明确 → 少问或不问，直接生成候选。
- 用户偏好模糊 → 生成对比，不继续盘问。
- 用户已选方案 → 收敛，不再扩散。
- 用户未明确批准 → 不覆盖生产组件。
