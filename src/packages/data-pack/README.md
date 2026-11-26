# Hospital Data Pack

每个 `data/packs/<pack-id>/pack.json` 是可独立发布的五层 bundle。`manifest` 定义机构、币种、政策与病历模板。`organization` 定义岗位及其院内能力。`catalog` 定义带编码系统的目录。可选 `knowledge` 定义有来源的条款、医嘱组套与交给地区模块解释的参数。`cases` 保存版本固定的教学病例。

## 编译与服务端装包

从本包唯一入口 `src/packages/data-pack/index.ts` 导入 `parseHospitalDataPack(raw)`。它接受内存中的对象、JSON 或 YAML 文本，编译成功后返回深度冻结的数据包。对于外部受信任来源，可以将调用方取得的 HTTP 响应正文传入同一入口。YAML bundle 使用普通映射和序列。装载错误包含稳定的 `code` 与字段位置。`PERSONA_TRUTH_LEAK` 表示 Patient Persona 含本次未知诊断的名称、别名或精确编码。已知既往诊断按完整的 `codeSystem` 和 `code` 匹配。

服务端从 `src/server/builtin-data-packs.ts` 导入 `BUILTIN_DATA_PACKS`。它通过静态 JSON 导入携带两套已编译的完整 bundle，供本地 Node 和 Workers 使用。该注册表与编译后的完整数据含私有 Case Truth，使用范围为受信任服务端。`findCatalogItem(pack, kind, coding)` 使用装载时建立的索引，以目录类别、URI 与编码查找条目。

Persona 检查在每项隐藏诊断所属的编码体系中，从左到右识别已登记的完整编码。同一位置优先匹配最长编码，并继续检查后续文本。已知子码和含标点的既往编码可以照录，单独出现的隐藏编码仍触发拒绝。

```ts
const at = await store.withTransaction(tx => installHospitalDataPack(tx, {
  workspaceId, expectedEpoch: null, virtualTime: '2026-08-24T00:00:00Z',
}, BUILTIN_DATA_PACKS['global-general']));

const visible = await store.read(reader => readHospitalDataPack(reader, at));
```

初次安装使用 `expectedEpoch: null`。切换包时传入当前 Epoch ID，成功后得到新 `StoreScope`。事务同时关闭旧 Epoch，并写入新清单、组织、知识、冻结目录价格及币种精度、病例、Persona 与私有 Case Truth。后续 Command 可在同一个事务追加授权后的审计、幂等回执等事实。步骤失败时让异常退出事务即可整体回滚。安装只物化教学配置与病例，开诊时才写入患者和本院业务事实。

## 工作台查询

对浏览器和医生助手返回 `readHospitalDataPack(reader, scope)` 的公开投影。病例列表仅含稳定的 UUIDv5 标识、就诊类型、人口学资料、Prior History 和分诊生命体征。Case 标签保存在私有复盘内容中。Patient Agent 的受控服务端入口从对应病例的 `case_personas` 取档案。仿真与完诊复盘遵循 [Store 的受控 Case Truth 查询](../store/README.md)。

价格为机构币种的整数最小单位，精度范围与 Store 一致（0–9）。报告结果以服务编码与阶段定位，同一结果的修订从 1 开始连续编号。后继修订须给出更正原因。新的采样复查使用 `repeat` 阶段。参考区间、剂量上限、教学价格与病例答案均随包版本冻结。

已知既往测量写在 `priorHistory.observations`。每项包含 UTC `observedAt`、同包服务和指标的完整编码、值及单位。编译器核对指标所属服务与单位。`caseTruth.results` 保存本次就诊各阶段签发报告所需的私有结果。

`caseTruth.results[].observations` 的定量值携带源 `unit`。无量纲 `1` 和有明确 `interpretation` 的 `qualitative` 结果可省略源单位。`caseTruth.normalBaselines` 可按服务编码给出本病例明确授权的正常报告正文和完整测量值。`services[].turnaroundMinutes` 指定虚拟周转分钟数，默认 30 分钟。`requiresProcedure` 标记需要术式流程执行的检查。

术式 `defaultPreopOrderPolicy` 对应住院模块手术申请的长期医嘱处理策略。`continue-active` 保持术前长期医嘱有效，`stop-on-completion` 在手术完成时请求停用。所需术前检查使用 `preopServices` 指向院内服务目录。每例拟行手术的检查依据取该病例的相应阶段结果。

## 验证

在 Windows 原生运行 `pnpm exec vitest run src/packages/data-pack/tests src/server/pack-privacy.test.ts`。它通过公开模块验证编译器、真实文件 SQLite 跨 Epoch 热切换与同事务回滚、实际 workerd SQLite 装载，以及开发 Web 服务器对原始资料的访问边界。构建后运行 `pnpm verify:worker` 生成真实 Worker 上传包并核对压缩体积。
