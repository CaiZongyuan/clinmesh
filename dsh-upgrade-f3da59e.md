# DSH 兼容升级演示

- Issue: https://github.com/CaiZongyuan/clinmesh/issues/79
- Commit: f3da59ef08c2661c7b58c375c44e79d53e2b2a03
- DSH: 0.1.5-alpha.1；React Surface: 2917fd0ff5572f0840f536cccdb5a8382bb04535。
- 入口：隔离 DSH Web Profile 中的 ClinMesh launcher，真实 ClinMesh Server 与临时 SQLite。
- 数据：内置合成 Scenario，门诊医生演示账号，workspace-demo / epoch-1。
- 运行方式：pnpm --filter @clinmesh/server dev；构建后的 ClinMesh 与 React Surface 插件。
- 验证：页面打开、临床标签页切换、Surface 主题切换；15 个医生工具注册，读取当前页面上下文成功。
- 工具调用：隔离 Profile 内临时驱动调用真实 DSH ToolRuntime，经过原生执行证明与 ClinMesh 授权；未连接真实模型。驱动不进入产品分支。
- 视频：原生 WebM，3.5 倍速，1600×900，22.4 秒，225641 bytes；显示当前步骤及真实 pointerdown 位置。
- SHA-256: 4780d301e70fe1b3042c875bb11bce77a9c097ae32ae160246faa190c92c532c
