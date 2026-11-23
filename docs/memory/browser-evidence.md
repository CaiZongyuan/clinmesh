# 浏览器与演示证据

验证真实布局、滚动缩放或准备浏览器预览与 PR 录屏证据时查阅；验证合同见 [`docs/testing.md#用户界面验证`](../testing.md#用户界面验证)，`1x` 人眼导览完整方案见 [人眼慢速操作导览录屏](video-walkthrough.md)。其他主题见[工程记忆入口](memory.md)。

<a id="布局滚动与像素聚合"></a>

## 布局、滚动与像素聚合

- **`.prototypes/` 原型逐项核对**：实施前对照原型 HTML 源码核对 DOM 层次、区块顺序、列对齐、按钮文案与收起条件，完工前在真实入口按同视口（`1600 / 1280` 宿主对应 Surface `1101 / 826`、浅/深色、三档字号及长页滚动分段）逐页签核对——移除废弃面板与内部技术 ID（UUID、`v1`、`Composition/...`），真实字段无值时留空或显示真实占位而非写死示例数，旧测试冲突时同步更新断言。
- **CSS Zoom、容器高度链与滚动测量**：根 CSS zoom 下固定弹窗用包含块百分比高度而非 `100svh`（Surface 会改写 `100svh` 为 `100%`，须同时测 standalone Web）；Surface fixture 外框宽高须除以 `zoom` 保持物理尺寸，核算末张卡片置底能否露出顶边时扣除容器 `(paddingTop + paddingBottom) * zoom`；中间弹性层仅设 `min-height` 不能约束子级百分比滚动，父层 `overflow-hidden` 时滚动区须自身具备受控高度与 `overflow-y-auto`。验证局部滚动统一改目标 `scrollTop` 或滚轮（禁用 `scrollIntoView` 偷滚隐藏祖先），并用 DOM Range 检查 `nowrap` 穿列、`sr-only` 撑宽单元格、Base UI `TabsList`（需 `h-auto!`）与 `Select ItemText`（默认 `div`）换行裁切。
- **ShadowRoot 容器、模态内报错与连续队列**：Surface 响应式依赖 `@container dsh-react-surface-content` 与 `PortalContainerProvider`，fixture 须完整复现宿主容器；多个 `keepMounted` 分区表单用 `useId` 生成控件 ID；模态审阅窗内的写入失败必须在窗内展示（背景全局 Alert 会被遮挡），异步清空草稿确认窗在请求期间同时禁用取消与 `Escape`，而持久意图待恢复（非请求在途）时应允许退出窗口；连续办理自动选下一位须先记住操作前行索引，待写入确认后再定位，避免查询提前刷新移走旧行。

## 预览文件、`agent-browser` 与 PR 录屏证据

- **单文件预览导出**：交付自包含 HTML 时同时保留本地持久文件入口；将构建后的 JS/CSS 注入模板时，`String.replace` 第二个参数必须传函数 `() => code`，防止正文中的 `$$`、`$&` 被当作替换标记损坏脚本。
- **`agent-browser` 操作与清理**：`record start` 新建录制 tab 后先关掉本次验证的旧 tab 并确认录制 tab 持有 `active` lease；PowerShell 中给 ref 加单引号（如 `click '@e74'`，防 `@` 变量展开），视图切换后重新 `snapshot` 取新 ref，嵌套滚动区先 `scrollintoview '@ref'` 再点；Windows `eval --stdin` 若静默返回 `null` 改用 Base64 `eval -b`；录制全程固定视口尺寸，结束必须配对 `record stop` 并在超时后按会话守护进程 → Chrome → FFmpeg 顺序清理残留进程。
- **PR 短片（3–4x WebM）与 FFmpeg 细节**：PR 验收短片分段录制、统一 3–4 倍速，录制前注入基于真实 `pointerdown` 的点击圆环，并在画面底部显示当前岗位与动作字幕（避开顶部遮挡与底部操作栏）；人眼 `1x` 完整 `.mp4` 导览按 [人眼慢速操作导览录屏](video-walkthrough.md) 执行。Windows FFmpeg `drawtext`/`ass` 含盘符冒号时写入脚本文件用 `-filter_complex_script`（路径写 `'C\:/...'`），仅在 `record stop` 写完 EBML 头后再抽帧，单命令多时间点抽帧显式指定 `-map`，裁剪以 `ffprobe` 解码画面校准起点，严禁拼接跨 commit/epoch 的画面。录制脚本监控真实 `DshModelProvider` 时继承该类或注入 `fetch`，避免普通对象包装双倍触发请求控制耗尽单次预算；录制住院 DRG 时先保存主操作再同时核对分组状态、病组码、支付参考与实际费用。
