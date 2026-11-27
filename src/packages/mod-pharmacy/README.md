# 门诊药房

`createPharmacyModule(billing?)` 注册处方、用药结论、完诊条件、开账库存和药师队列。组合根和当前数据包均启用 `mod-pharmacy` 时生效。

- `prescription.read` 返回医生可见的目录、当前过敏、最新确诊编码、本患者有效疗程与本次就诊的处方历史。`checkPrescription` 在客户端预检，签发时在写事务中重验。剂量单位取自品规，发药数量以完整制剂单位计。
- `prescription.sign` 接受 1–8 行同来源药品，校验就诊版本并为每行创建 Clinical Order。处方指纹冻结数据包版本、药品编码、显示名、来源、剂量、途径、频次、疗程与总量。合成说明书通过只读目录展示。
- `prescription.no-medication` 记录理由与独立正式事实。`prescription.withdraw` 接受处方版本与撤回理由，追加撤回事实并取消关联 Clinical Order。原签发、已发生资金和审计记录继续可查。
- 已完诊患者撤回最后一张有效处方时，医生需在同一次人工确认中填写 `noMedicationReason`。撤回事务同时签署独立的无需用药结论。门诊持续处于完诊状态，原临床签署、撤回和替代结论均可追溯。
- `pharmacy.queue` 只列出已完诊、放行、待发的院内处方。`pharmacy.dispense` 接受处方版本以及可选的逐行 `lots`，缺省按近效期先出。服务端以医院当地虚拟日期核对效期，用原子条件写入每项负向库存流水，在同一事务中逐笔记录 Dispense。

`knowledge.pharmacy` 指定适应证编码体系、互斥药理类别配对和开账批次。`catalog.medications[].source` 缺省为 `internal`，外配品规声明 `external`。`ingredient` 可标识不同品规共有的有效成分。医院停用收费时直接放行已完诊的本院处方。装配收费端口且当前包启用 `mod-billing` 时，签发事务冻结每行价格、数量、币种与版本，发药事务仅接受免费或足额结清的来源行。撤回事务重读锁账与未决资金。

药房完诊条件随 Epoch 装载的数据包冻结。恢复既有快照时，缺少 `knowledge.pharmacy` 的历史 Epoch 沿用原有完诊条件。新装医院包启用 `mod-pharmacy` 时，须提供 `knowledge.pharmacy`。新建或重置 Workspace 时，系统在同一事务中初始化药房规则及批次。

在 Windows 原生运行 `pnpm exec vitest run src/packages/mod-pharmacy/tests src/web/modules/pharmacy`。服务端流程覆核实际 Node HTTP 和 Worker 的 SQLite Durable Object。
