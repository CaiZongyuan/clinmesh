# breast-pathology-report-v1

乳腺切片病理会诊素材的中文报告草稿整理规则。草稿由模型依据素材条目中的结构化临床字段整理，模型不读取像素，因此不能描述切片上实际可见的形态。

## 输入

- `clinical`：从来源临床数据原样转录的字段（取值为英文原文）：`histologicType`、`estrogenReceptor`、`progesteroneReceptor`、`her2`（`ihcScore`、`ihcStatus`、`fish`、`finalStatus`）、`pathologicT`、`pathologicN`、`sampleType`。
- 不使用来源受试者的身份、年龄、手术方式、部位和侧别；`pathologicT` 与 `pathologicN` 只供病例匹配，不写入报告。

## 受体状态

- ER、PR：来源状态为 `Positive` 或 `Negative` 时照写；其他取值或缺失的素材不整理报告。
- HER2：IHC 3+ 或 FISH 阳性判为阳性；IHC 0、1+（或来源只给出 IHC 阴性结论）或 IHC 2+ 且 FISH 阴性判为阴性；只做了 FISH 时以 FISH 结果为准。
- IHC 评分与 IHC 结论不一致、IHC 与 FISH 一阳一阴、或判定结果与来源最终结论不一致时，字段相互矛盾，素材不整理报告，也不发布。IHC 2+ 且没有 FISH 结果时无法判定，同样不整理。

## 输出

一份报告内容修订，字段为 `specimen`、`microscopy`、`diagnosis`、`immunohistochemistry`、`note` 和 `draft`。

1. `specimen` 固定为 `{ "procedure": "case-source-procedure", "slideCount": 1, "stain": "HE" }`。既往手术名称与日期在会诊时取病例所选的来源手术，草稿不写标本文字。
2. `microscopy`（镜下所见）只写组织学类型本身所能支持的特征，按类型使用固定表述：
   - `Infiltrating Ductal Carcinoma`：“送检切片为 HE 染色乳腺组织，见浸润性癌，癌细胞呈巢状、条索状或腺管样排列，浸润纤维间质。”
   - `Infiltrating Lobular Carcinoma`：“送检切片为 HE 染色乳腺组织，见浸润性癌，癌细胞黏附性差，呈单行条索状排列或散在浸润纤维间质。”
   - 其他类型没有固定表述，不整理报告。
3. `diagnosis`（病理诊断）写组织学类型，并以“原始资料未提供组织学分级。”结尾：
   - `Infiltrating Ductal Carcinoma`：“乳腺浸润性导管癌（浸润性癌，非特殊类型）。”
   - `Infiltrating Lobular Carcinoma`：“乳腺浸润性小叶癌。”
4. `immunohistochemistry`（既有免疫组化）以“以下结果引自原始病理资料，本次会诊未提供免疫组化切片。”开头，随后依次写“ER：阳性/阴性；PR：阳性/阴性；HER2：阳性/阴性（依据）。”。HER2 的依据只写来源实际给出的项目，例如“IHC 3+，FISH 阳性”“IHC 阴性”“FISH 阴性”。
5. `note`（备注）固定为“本次会诊切片为原发灶组织，未包含淋巴结；淋巴结情况以原病例记录为准。”
6. `draft` 记录模型标识与本文件版本 `breast-pathology-report-v1`。

## 禁止内容

- 组织学分级及其组成部分：分级、分化程度、核分裂、核异型或多形性。
- 淋巴结转移、阳性或阴性的任何判断，以及淋巴结数目。
- 肿瘤大小、T/N/M 分期、侧别、象限、切缘、脉管或神经侵犯、坏死、钙化、原位癌成分等来源字段没有给出或切片未经核对的内容。
- 来源未给出的其他组织学类型名称。
- 素材来源、数据集名称、来源受试者或切片标识。

整理完成后运行 `pnpm pathology:check`；自动一致性检查未通过的草稿不进入人工复核。
