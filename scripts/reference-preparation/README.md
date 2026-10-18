# 五类参考资料清洗

本目录提供离线清洗与验收工具，输入为用户提供的五个 MinerU 合并包及补充原 PDF；产物是可追溯的参考数据候选包。业务目标见 [DRG 设计方案](../../docs/spec/2026-10-15-drg-prescription-budget.md)，数据来源版本依据见 [DRG 数据来源核验](../../docs/research/2026-10-15-drg-data-sources.md)，取舍见 [清洗候选包决策](../../.agents/notes/implemented/process/2026-10-16-reference-data-preparation.md)。

## 运行

核验后的 r3 可按[部署说明](../../docs/deployment.md#3-同步参考目录推荐)生成本地发布文件，并通过现有参考库同步入口导入。`publish.ts` 只读取标准化 JSONL 与校验清单，复制生成到 `.data/reference-prepared/r3`；`preparedRelease` 固定发布清单，导入再核对每个文件和行数。发布身份是来源参考，原始 `runtimeEnabled` 和用途状态按归档保留；模拟计算使用独立合成映射，不自动启用全部目录。

使用 Python 3.11 以上版本，在独立环境安装 `requirements.txt`。不执行压缩包内的脚本，不获取远程图片，不修改 `references/`。生成文件放入 Git 忽略的 `.data/` 或仓库外目录；输出路径必须不存在，防止覆盖旧证据。

```sh
python -m pip install -r scripts/reference-preparation/requirements.txt
python scripts/reference-preparation/clean.py --input-dir /path/to/source --output /path/to/new-candidate
python scripts/reference-preparation/verify.py /path/to/new-candidate
python -m unittest discover -s scripts/reference-preparation -p test_clean.py
```

已交付候选包的来源复核使用第二阶段工具；它先验证上一候选包，再复制到新目录，不覆盖旧证据：

```sh
python scripts/reference-preparation/review.py --candidate /path/to/r1 --output /path/to/new-r2 --procedure-review /path/to/procedure-code-review.json
python scripts/reference-preparation/verify.py /path/to/new-r2
python -m unittest discover -s scripts/reference-preparation -p 'test_*.py'
```

`review/resolutions.jsonl` 保留每条复核的旧值、新值、原状态、结果状态和 PDF 表格证据；上一轮问题清单保存在 `review/round-1-issues.jsonl`。`resolved_source_rule_structured` 表示已从原文形成条件价格，仍须确认当前适用性；`waiting_external_pricing` 表示原文确实没有所需价格，等待地区价表或院内定价；`waiting_official_dictionary_release` 表示已确认来源差异，但缺少官方兼容字典或版本对应依据。汇总必须同时统计目录行和附表问题，不能仅以主记录的 `reviewFlags` 数量作为全部未决项数。

输入目录必须包含五个指定 ZIP，以及 `国家医疗保障按病组（DRG）付费3.0版 分组方案.pdf`、`国家基本医疗保险、生育保险和工伤保险药品目录（2025年）.pdf`。其余三份 PDF 使用 ZIP 中已归档的版本。DRG 补充 PDF 必须匹配此前核验的官网更新版 SHA-256；其他 PDF 必须匹配包内来源清单。识别平台未导出上传文件哈希，因此同页内容核对与补充 PDF 哈希不能证明平台上传文件的二进制身份。

## 产物与字段

`raw/archives/` 保存字节保真的五包，`raw/extracted/` 保存全部包内文件，`raw/supplemental/` 保存另取的两份原 PDF。`source-manifest.json` 保存 SHA-256、版本、页数和完整性验证计数；`checksums.json` 固定全部其他产物的哈希。页覆盖清单位于 `reports/page-coverage.jsonl`。

`standardized/<dataset>/records.jsonl` 为标准目录行。编码始终是字符串；空末级码保持 `null`，不拿父码伪造末级码。记录身份使用来源页和行位置，编码冲突不会覆盖另一行。共同的 `source` 包含 `archiveSha256`、`sourceVersion`、`sourceFile`、`sourcePageIndex`、一基 `pdfPage` 和原印刷页；表格记录另有 JSON Pointer、HTML 行号或 PDF 网格坐标。JSON Pointer 基于该条记录的页对象；ICD 原提取行中的 `html_json_pointer` 为合并对象定位，使用 `mineru.source_page_idx` 可回到分片。

| 数据 | 标准化内容 | 验收边界 |
| --- | --- | --- |
| `icd10`、`icd9` | 末级行、各层级节点、父子关系、复合码、原始字段、逐字段修正、候选通过集和待复核集 | 按 PDF 矢量网格逐字形定位，逐页核对行数与列数；名称或父级冲突影响对应后代候选，重复码隔离 |
| `drg` | MDC/ADRG/DRG 定义、ADRG 正文及条件原文、成员清单、CC/MCC 排除表引用、原 PDF 分页正文 | 病组数断言 26/492/825；条件与列表只结构化为来源事实，不编译布尔分组逻辑 |
| `services` | 服务、分类、材料支付条件、自主定价附录、政策和备注原文、跨页候选关联 | 省级价格保持 2024 参考身份；空白医保分类不向下填充，材料限额不转成产品单价 |
| `drugs` | 目录分类、药品与剂型原文、甲乙类、备注、支付标准及协议期、饮片、续表关联和凡例 | 目录编号不等于医保产品码；剂型与规格无法可靠拆分时保留原文，交人工复核 |

二次复核的 `services/records.jsonl` 保留全部来源行身份；磁共振总项和三类精神科量表总项标为 `entryKind=catalogue_heading`、`chargeability=not_a_billable_leaf`，通过 `childRecordIds` 指向具体项目，不能把标题当作待补单价的收费末级。`services/price-rules.jsonl` 保存按医院等级、驾驶员类型、病房条件及原收费比例区分的来源价格；原价格栏、备注和适用条件不被覆盖。`drugs/tiered-payment-schedules.jsonl` 将碘[131I]胶囊备注2中的阶梯表关联到谈判西药编号398，保留原单位、原表和金额核算样例；仅作来源事实结构化，不提供运行时计价接口。

`review/corrections.jsonl` 每条保存 `originalValue`、`correctedValue`、`basis`、`reviewStatus` 与 `humanReviewed`。`verified_pdf_text` 只代表机器核对来源文字；不表示人工审定或医学编码正确。`review/issues.jsonl` 与 UTF-8 BOM 的 `issues.csv` 保留待复核项和已解决的来源异常。`structural_checks_passed` 仅表示已实施的结构与文字存在性检查通过，不能替代逐单元格医学审核。

`reports/drg-empty-pages.json` 对每个空正文页保存 PDF 正文、邻近两页的编码覆盖及补提依据。跨库报告对 DRG 引用逐个精确匹配：通过候选字典、待复核字典、仅复合码成员、完全缺失分别报告；不截短后缀、不去前导零、不自动转字母大小写。表引用和病组父级单独校验。字典文字命中不证明其版本满足目标地区分组器要求。

金额使用十进制字符串，不使用浮点数。价格 `state` 区分 `numeric`、`confidential`、`unknown` 和 `expression`；`*` 保留为保密，空值保留为未知，复杂标准保留规格原文。数值支付标准能直接定位中文计价单位时保存原文单位，院内包装与换算仍待核对。省级参考价、医保支付标准、医院自主定价分别标记 `kind`。收费价、采购成本、包装、拆零换算和当前有效期缺失时，`hospitalMapping.state` 为“待补全”。

## 参考价格与按用途标记

`enrich.py`将已取得并核对来源哈希的江西、广东药品和心血管耗材价格整理到独立的`standardized/prices/`；原五类标准表保持不变。每条报价保留原字段、工作表/单元格或PDF表格定位、价格类型、地区、批次与单位，原报价不替代本院收费或采购成本。工具只读取用户提供文件及已下载的来源证据，不执行外部脚本。

```sh
python scripts/reference-preparation/enrich.py --candidate /path/to/r2 --output /path/to/new-r3 --desktop /path/to/provided-files --evidence /path/to/verified-price-evidence
python scripts/reference-preparation/verify.py /path/to/new-r3
```

证据目录包含`source-metadata.json`、`source-download-results.json`及其指向的原始附件，取得过程和哈希须可核查。`assessment/record-readiness.jsonl`按稳定记录ID分别表达来源参考、当前价格、院内用途和分组用途；“待补全”“待核实”“暂不可用”不覆盖原始复核结果。具体流程见[院内映射说明](hospital-mapping-guide.md)。没有院内主数据时，映射确认数为0；原表只有中选价金额而未明确分母时，不因存在包装列就计算每片价。重复产品码保留全部原行，不用第一条报价覆盖其他批次、包装或注册证。

## 发布边界

候选清单格式为 `clinmesh.reference-preparation.v1`，不属于当前运行时 `ReferenceArtifact` 或 cn-health 的签名 Manifest。`runtimeEnabled` 始终为 `false`；只有字典通过集标记为可供后续发布审核的候选。该工具不更新 lock、不调用 `pnpm reference:sync`、不写 HIS 或 Reference SQLite。

后续接入须在 owning Dataset 中明确新类型的 schema、许可、地区、适用期与签名发布流程，继续使用项目现有 hash、receipt、SQLite 不变量和复合 Release 验证。新价格和规则只进入新版本；既有费用与历史评估继续引用发生时冻结的版本。
