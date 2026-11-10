# 浏览器与演示证据

验证真实布局与滚动，或交付预览、录屏和剪辑证据时查阅。浏览器验证要求由[测试策略](../testing.md#用户界面验证)拥有，演示和交付要求由[Agent 工程开发](../agent-development.md#实施与交付)拥有。真实影像验证使用文字快照与聚合量，具体操作见[临床数据经验](clinical-data.md)。

其他操作经验见[工程记忆入口](memory.md)。

## 布局、滚动与像素聚合

- **原型对照硬门禁（防“做出来与原型不一致”）**：修改任何已有原型的窗口前，实施者（含并行子 Agent）必须先打开对应 `.prototypes/` HTML 源码核对 DOM 层次、CSS 类、区块顺序、列对齐、按钮文案与隐藏/收起条件，不得只按文字规格摘要自由发挥；修改后必须用 Playwright 在真实产品入口截出与原型相同场景、相同视口（`1600 / 1280` 宿主对应 Surface `1101 / 826`，浅色/深色）及长页滚动分段（`s0 / s1`）的截图，并排逐项比对。凡是“旧字段或旧按钮没删干净、列表/卡片多包一层边框、主次按钮层级或数量不对、空态/完成态/错误态未按原型切换”均视为未完成，不得提交或标为已修复。此外须遵守四条铁律：(1) **替换而非叠加**——原型废弃的旧面板、旧按钮、旧内部 ID（UUID、`v1`、`Composition/...`）必须彻底移除或移出可视流，禁止把新步骤做成可选 Tab 而默认仍停在旧面板；(2) **禁止写死假数据或兜底值**——原型中的示例数字仅表达字段布局，正式代码必须绑定真实接口字段，报告未回传或接口无值时按原型留空/显示真实占位，禁止写死假生命体征或测量兜底值；(3) **旧测试让位于已批准原型**——当既有单测或 E2E 断言的是旧 UI 结构时，必须将测试更新到原型新合同，严禁为了过旧测试把已对齐原型的 UI 改回旧样或保留旧可见 DOM；(4) **提交前强制逐条复核与打回重做闭环**——禁止仅凭子 Agent 汇报或局部抽查就提交；提交前必须拿磁盘实际源码与 `.prototypes/` 对所有审计条目从头到尾逐一核对，发现任何漏改、半改、写反或旧可见节点残留必须反思并打回重做，直到全量条目逐条核对无误后才能执行 `git commit`。

- 按已确认原型重排多岗位工作台时，以“岗位 × 页签 × 关键状态”逐项核对正文顺序、默认展开内容、主操作和次级入口。默认页的截图矩阵只能证明该页和共享外框，不能证明其他页已按原型完成；对尚未覆盖的页面保留未验收状态。先定位原型的具体正文，再对当前实现做 DOM 与关键交互验收，不能用 CI 全绿或外框相同替代内容结构；住院依据见[结构决策](../decisions/implemented/architecture/2026-11-03-inpatient-prototype-composition.md)。

- 队列侧栏底部露出画布时，同时测量队列容器、直接子元素和白色卡片的边界；外层等高不表示卡片已铺满。若[队列样式](../../apps/web/src/app/workspace-card-layout.css)只将撑高规则施加给直接子元素，额外的语义 section 可能截断 Flex 高度传递；在浏览器临时补齐包装层与卡片的 Flex 布局，撤销后核对缺口是否恢复，以区分结构问题与加载状态。

- 原位确认的焦点回归同时覆盖 Escape、取消、成功、身份切换和原触发器消失。DOM 节点仍连接不表示仍属原身份；恢复前须核对作用域。成功后触发器禁用但仍需返回焦点时，可复用 Base UI `focusableWhenDisabled`，并验证 Enter 和指针都不会触发额外写入；查询结果刷新会删除触发器时，先等账本更新，再关闭确认并回到同卡入口。参考[收费双版本合同](../../apps/dsh-web/src/client/billing-card.browser.test.ts)。

- 真实 Surface fixture 需注入 `PortalContainerProvider`，否则目录和确认可能渲染到 ShadowRoot 外，测试通过也不能证明宿主内可操作。受控 input 的捕获阶段若立即更新来源元数据，会触发重渲染并还原旧值；先让输入 handler 读取当前值，再清理来源，并以真实键盘输入验证值和标记两者。原位审阅还须暂缓 decision gate 后修改表单，核对实际 Command 仍提交人类审阅的快照。

- 容器无横向滚动不能证明窄屏可用。患者卡和展开的多行页签可能把主区压成几十像素；在真实父布局测量主区与可滚动祖先的裁切交集，再滚动并实际操作末尾字段，避免 `scrollIntoView` 滚动隐藏祖先掩盖高度问题。文字超出 tablist 内边距或单个按钮边界也不一定被裁切；继续核对所有实际裁切祖先的交集，以及首尾文字位置的真实命中和焦点，再判断是否需要修改。

- TanStack Query 轮询时，`isFetching` 会在已有结果上反复切换；按它插入或移除普通文档流中的提示会让整块结果周期性跳动。提示隐藏时保留其真实换行高度，不能只预留单行高度。窄视口不保证短提示实际换行，应先用 DOM Range 核对至少两行，并确认隐藏时高度超过一行，再暂缓真实 HTTP 响应，比较请求前、进行中和完成后的分组及费用相对坐标；复用 [DRG 轮询布局旅程](../../apps/web/e2e/inpatient-drg-polling.journey.ts)覆盖 Web 与 React 18/19 ShadowRoot。

- 医保审阅等逐项明细弹窗须用完整多项目病例验证。限制内容最大高度并提供内部滚动，断言弹窗留在视口内，再真实点击末尾提交；小病例的可见文本断言会漏掉长费用清单撑出视口的问题，见 [PCI 黄金旅程](../../apps/web/e2e/inpatient-pci.journey.ts)。

- 窄屏与 CSS zoom 组合验证前，按 `viewport / zoom` 核有效 CSS 宽度，并读取全局 `body` 的 computed `min-width`；低于产品最小宽度会使 Portal 等空容器也表现为横向溢出。组件验收分别覆盖受支持窄屏和缩放，用 DOM 尺寸区分全局宽度下限与组件溢出；不要为局部回归改写全站宽度合同。住院收款入口的文字与聚合尺寸证据见 [真实入口测试](../../apps/web/e2e/inpatient-discharge.spec.ts)。

- Base UI 的可换行 TabsList 使用 `h-auto!` 覆盖 `group-data-horizontal/tabs:h-8`；普通 `h-auto` 的优先级不足，英文大字号窄屏下可能遮挡后续按钮。需要多行显示的筛选页签还应在调用处允许 Trigger 文字换行和长词断行，让高度按完整内容计算。浏览器回归验证文字边界、实际行数及真实指针命中；短单词被挤成逐字纵排即使完整可见也不适合阅读，参见[来源页签布局合同](../../apps/dsh-web/src/client/non-doctor-filter-layout.browser.test.ts)。

- 模态审阅弹窗内的写入失败须在弹窗内展示；页面背景的全局 Alert 会被模态可访问性隔离遮住。资金请求丢回执后，只在请求仍进行时禁用关闭；持久原意图待恢复时应允许退出审阅，再从原 receipt 恢复，不能把全部关闭按钮随 pending intent 永久禁用。用真实[结算后退款旅程](../../apps/web/e2e/inpatient-discharge.spec.ts)验证错误可见、刷新只查原回执且只发送一次资金请求。

- 异步清空草稿的确认窗须同时在 `onOpenChange` 阻止请求期间关闭，并禁用取消按钮；只禁用确认按钮仍会允许取消或 Escape 关闭，后台删除继续执行。回归暂停真实 DELETE，检查取消与 Escape 均受保护，再分别验证成功关闭、失败在窗内可见且恢复退出能力；见[门诊放射草稿回归](../../apps/web/e2e/outpatient-imaging-batch.spec.ts)。

- 浏览器高光坐标测试应比较目标的可见部分；headless Chrome 的默认视口可能裁掉目标底部，不能把完整 `getBoundingClientRect()` 与已按视口裁剪的边框直接比较。保留裁剪断言，不通过放大窗口掩盖差异。

- 底部输入区的浏览器布局回归须加载实际 Surface 样式和完整父布局，包含承载成功提示的中间容器；只有 `min-height` 的中间层不能为子级百分比高度建立可靠约束。覆盖窄宽度下输入区完整可见、消息区仍可滚动以及启用后的发送按钮可命中；滚动分区还须检查头部坐标不变和末尾操作可达。跳过生产容器直接挂载内部布局会漏掉高度链断裂。父容器使用 `overflow-hidden` 时，内容区须同时具备受约束的高度和自身的 `overflow-y-auto`；`min-h-full` 只有高度下限，不能提供滚动。共用父布局的不同详情分支应各自验证末尾内容可达。

- 依赖真实渲染帧的组件（OpenSeadragon 的动画与瓦片调度）在 Chrome `--virtual-time-budget` 下不可靠，这类浏览器合同用 Playwright 的真实时钟并有界轮询。合成 JPEG 瓦片带填充色时，色度上采样会让填充色渗入相邻一两列有效像素；按像素统计验证时为图像边缘留出小于 0.5% 的容差。

- Base UI Select 的长选项换行须同时处理 ItemText 的 `whitespace-nowrap`、`shrink-0`，以及选中值的单行限制与 Trigger 固定高度；ItemText 默认渲染为 `div`，不要凭其他组件的结构假定为 `span`。使用真实 DOM 核对文字宽高和裁切，覆盖窄窗口中的菜单与选中状态。

- 表格里的 `sr-only` 标签虽然被视觉裁剪，仍可能因 Field 直属子项的宽度规则扩大单元格 `scrollWidth`。定位无可见内容的横向溢出时同时测量隐藏标签的实际盒子；已有列表头能说明字段时，用表头和控件完整的 `aria-label` 保留可访问名称，避免绝对定位隐藏盒子撑宽。验证批次与数量时同时覆盖长药名、826px 和浅深主题，不靠截图中看不见内容就判定没有溢出。

- 固定宽度的状态标签须验证中英文与三档应用字号。仅检查 Badge 或列表项边界会漏掉被 `overflow-hidden` 裁切的文字；浏览器回归用 DOM Range 检查各行文字边界，并验证内部换行后业务区末尾仍可滚动到达。字号偏好通过实际应用根的 `data-clinmesh-app` 与 `data-font-size` 生效，fixture 须沿用这些属性并核对实际计算字号变化，防止空根标记或无效字号让矩阵退回同一默认样式。

- 验证独立滚动时只设置目标区域的 `scrollTop` 或使用真实滚轮，等待页签切换和滚动后的渲染帧，并将末尾边界与实际宿主比较。`scrollIntoView` 会滚动 `overflow-hidden` 祖先，可能掩盖内容已被固定头部挤出宿主的问题；头部 fixture 同时覆盖多条过敏、长文本、矮屏和大字号。

- 刷新队列并连续选择下一条时，查询失效刷新可能先于 mutation 的 success 通知移走旧行。应保留完成操作前的行位置，待本次写入确认后再选择该位置的下一条；不能在每次查询更新时先覆盖旧队列。用至少两条真实执行验证自动选择与清空后的交接，单条成功用例无法证明连续选择。参考[住院原型共享旅程](../../apps/web/e2e/inpatient-prototype-layout.journey.ts)。

- 新增带优先级的业务操作栏时，真实入口回归还须覆盖零待办、无草稿且无历史尝试的患者，验证该空环节不会覆盖接诊、换床等原操作的完成反馈或虚报完成。成功断言优先匹配具体患者与实际动作的通知，并回读原业务事实；只查任意 `role=status` 的通用成功文案会混淆其他保留挂载的环节。参考[住院接诊旅程](../../apps/web/e2e/inpatient-admission.spec.ts)。

- 多个 `keepMounted` 分区复用表单时，固定 `id` 会使后挂载标签关联到隐藏实例；只用控件 locator 填写会漏掉真实标签点击和读屏名称问题。实例 ID 用 `useId`，Agent 高亮用稳定语义属性，并在两个分区往返后真实点击标签验证焦点和各自输入保留。当前依据见[住院结构决策](../decisions/implemented/architecture/2026-11-03-inpatient-prototype-composition.md)。

- 字号属性更新后，按钮仍可能处于约 150 毫秒的 `font-size` 过渡；若干渲染帧不保证结束，布局断言须先等实际 computed 字号到达目标，不能禁用动画或固定 sleep。复用[住院细节旅程](../../apps/web/e2e/inpatient-review-layout.journey.ts)同时核对放大与恢复字号。

## 预览文件与浏览器会话

- 验证响应丢失后的恢复时，除刷新和组件重挂载，还须通过真实退出、同身份重新登录及原回执查询覆盖账号清理边界；退出前同时保留一项未提交草稿，分别断言草稿清除、原操作仍可恢复、请求与费用未重复。仅重挂载不会执行 `signOut` 的存储清理，相关回归见[门诊检查真实入口](../../apps/web/e2e/investigation-workspace.spec.ts)。

- 本地 HTTP 预览服务可能随会话结束或重启停止。交付自包含 HTML 时同时保留文件入口；面向 Windows 用户提供并校验用户侧持久目录中的副本，不能将临时服务 URL 作为唯一交付入口。

- 将构建后的 JavaScript 或 CSS 内嵌到单文件 HTML 时，`String.replace` 使用返回正文的函数作为 replacement。直接传正文字符串会把其中的 `$$`、`$&` 等解释为替换标记并损坏产物；导出后用浏览器从本地文件打开，验证渲染与交互。

- `agent-browser record start` 会创建新标签页并保留旧标签页。录制 DSH 原生 Tools 前关闭本次验证的旧标签页，再打开 Surface；同一 Session 的多个页面实例可能让 Tool 作用于非录制页面。只关闭自己创建的验证标签页，不关闭用户标签页。

- `agent-browser click` 对滚动容器外的 ref 可能返回成功但页面未发生变化。先 `scrollintoview` 再点击，并以预期页面状态确认结果；异步 mutation 后的即时 snapshot 可能仍是旧状态。

- PowerShell 调用 `agent-browser` 时给 snapshot ref 加单引号，例如 `click '@e74'`；裸 `@e74` 会被解释为变量 splatting，导致参数消失，表现为缺少 selector 或把后续参数当成 selector。用新 snapshot 和 `get attr '@e74' href` 核对目标，再检查操作后的页面状态。

- Windows 的 `agent-browser eval --stdin` 若返回 `null` 且脚本未执行，改用 UTF-8 Base64 与 `eval -b`，并读取预期 DOM 状态确认执行；返回 `null` 本身不能证明注入成功。视频录制期间保持 viewport 尺寸不变，窄屏另开录制，避免编码器把不同宽度画面拉伸到初始尺寸。

- `agent-browser record start` 会在现有命名会话中新增录制 tab，原 tab 仍可保有 DSH Surface leader lease。录制 DSH browser Tools 时必须关闭旧 tab，等待录制 tab 取得 `active` lease，再让 Agent 读取新的 Page Context；否则 Tool 可能正确更新旧 leader，而录制 tab 只显示未变化的 contender Surface。

- `agent-browser record start` 创建 fresh context 后，`eval`/`click` 可能仍作用于旧 tab，成片只有空白帧。start 之后必须显式 `open` 目标 URL，并用 `tab list` 与页面状态（tab 文本、队列条数）确认操作落在录制 tab 上；随后再注入点击高亮脚本。

- 视图切换会重排 snapshot refs：同一 `@eN` 在不同视图解析到不同元素，旧 ref 的 click 返回成功却点错位置。每次切换视图后重新 snapshot 取新 ref，再以成片抽帧核对关键画面（切换、选中、空态）是否都发生。

- `agent-browser click @ref` 对位于嵌套滚动容器可视区之外的按钮可能不产生点击且不报错；先 `scrollintoview @ref` 再点击。Base UI 的 Select 用 `focus` 加 `press Enter` 打开，直接 click 不展开选项。

## 录制、剪辑与发布证据

- 共享 `AlertDialogAction` 是普通按钮，异步成功不会自动关闭确认框。业务组件须控制 `open`，在本地丢弃或服务端删除成功后关闭；失败留在框内展示，且保留输入。回归同时验证记录消失、确认框退出和下一患者入口可操作，避免只检查背景数据就漏掉模态遮挡。参见[检验清空与跨病例回归](../../apps/web/src/app/role-workspaces.test.tsx)。

- `agent-browser` 原生 WebM 会忠实记录自动化输入和等待，未经编排的完整闭环可能远慢于人类观看速度。优先按业务阶段分段录制，成片统一到 3–4 倍速并添加开场、岗位/动作字幕和结束状态。

- Headless 录制默认看不到鼠标指针。点击高亮必须在录制开始前注入已审查的同源脚本，由真实 `pointerdown` 或 `click` 事件在实际坐标显示短暂圆环；不能根据成片猜测并伪造历史点击位置。

- 字幕应持续显示当前岗位和动作，不用字幕复述页面上已经清楚可见的全部文字。压缩优先降低等待时长和分辨率，其次调整码率；临床字段、状态和错误信息必须仍可读。

- 发布媒体使用 append-only assets 分支和新文件名，不覆盖或改写已经发布的对象。PR body 记录 commit、入口、Scenario、时长、尺寸、大小和 SHA-256，并链接新版文件。

- 每次 `record start` 都配对 `record stop` 和进程清理。停止命令超时后检查 encoder 子进程，只对确认属于该录制会话的进程发送终止信号，避免后台 FFmpeg 无限驻留。

- `agent-browser` 会话守护进程存活时，单独终止 Chrome 可能触发自动重启。正常 `record stop`/`close` 超时后先终止该命名会话的守护进程，再清理其 Chrome 和 encoder 子进程；随后用 `ps`/`ss` 验证，不重新连接已关闭会话。

- Windows FFmpeg 的 `drawtext` 引用盘符路径时，冒号会截断 filter 参数；命令行内联转义易被 shell 吃掉。把 filter 写进文件并用 `-filter_complex_script` 执行，路径统一写成 `'C\:/path/...'`（引号包裹 + 转义冒号）。正在写入的 WebM 无法被 FFmpeg 读取（EBML header 未完成），抽帧核对只能在 `record stop` 之后进行。

- 使用 FFmpeg 前先检查依赖；缺失时报告而不是自行安装。后期只改变播放速度、字幕和编码，不拼接来自不同 Scenario、workspace、epoch 或 commit 的业务证据。

- 一次 FFmpeg 命令抽取多个时间点时必须为每个输出显式指定 input/map，或为每个时间点单独执行；依赖默认 stream mapping 可能让多个输出都取自第一个输入，形成看似正常的重复截图。

- 浏览器录制的媒体时间轴不一定等于自动化脚本的墙钟耗时。裁剪前用 ffprobe 和解码画面定位起止，不直接使用脚本执行时间作为视频时间戳，以免裁掉首次操作。

- 并行 UI 分支各自无文本冲突、各自截图或 CI 通过，仍可能在共同入口切换时呈现不同控件。组合验收须真实合并到隔离副本，沿生产 Provider 在模式切换前后比较控件类型、尺寸与状态；不能用 Git 自动合并成功替代视觉一致性。 单独挂载 `BillingWorkspace` 会缺少模式 Provider 及门诊切换控件，双筛选宽度验收应使用真实 `RoleWorkspace` 组合，沿[模式切换旅程](../../apps/web/e2e/workspace-mode-presentation.spec.ts)验证。 共享改动仍分别编译各交付分支，避免仅在合并副本中借到另一分支提供的组件参数。

- 操作状态回归同时覆盖未选项目、已选但缺字段、真正提交中三种情况；边框只在未选状态正确不足以证明所有不可执行状态。几何断言也须结合实际文字布局看图：完整 Range 可能仍被挤成多行而难以阅读。
