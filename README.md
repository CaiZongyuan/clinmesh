# PR #379 PCI 审阅界面证据

产品提交：`93b25cc734d105499aa3a0f02cdfe1046af4ef00`。最终 PR 提交 `aefdb9b4a8a7b7f596cbd12772e633d55d8bbe67` 仅增加已验收规格与决策文档收尾。

截图来自临时数据库、合成患者、合成 Provider 及受控模型响应，不含真实患者或影像像素。入口是 React 18 DSH Surface 的真实住院 PCI 审阅组件，容器宽 826px，浅色主题。

- `parameters.png`：报告身份、参数来源与选型草稿顶部；不表示所有长表单字段同时可见。
- `costs.png`：确定性费用组成与口径。
- `cost-explanation.png`：费用尾部与完整当前 AI 费用正文。
- `refresh-paused.png`：主动持有 GET 刷新时，确认按钮暂停并说明原因；释放请求后确认恢复。

布局测试通过（18.4s，含构建总 44.7s）；暂停状态测试通过（17.9s，含构建总 44.1s），暂停态操作栏 clientWidth = scrollWidth = 558px，高 111.5px。完整 React 18/19 与 standalone 矩阵、浅深主题及其余宽度结果见 PR 验证表。本媒体分支只保存证据，不合入产品分支。
