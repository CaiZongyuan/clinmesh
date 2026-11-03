# PCI 支架类别与尺寸核对：实验专题

本页是人工整理、尚未接入产品的证据导航。适用于医生已经提出 PCI 计划、需要核对材料类别或尺寸依据的取证实验；不判断患者是否应接受 PCI，不提供具体品牌、型号或固定件数。

```json
{
  "id": "pci-stent",
  "version": 1,
  "unsupportedCapabilities": ["specific-product-selection", "material-quantity"],
  "references": [
    { "sourceId": "local-evaluation-coronary-folder-g10", "version": "2021", "sha256": "9843131ad84f9a261ceb8857025e656a067496472edabfb6bd2b6297f2c5ff0e", "page": 35, "required": true },
    { "sourceId": "local-evaluation-coronary-folder-g10", "version": "2021", "sha256": "9843131ad84f9a261ceb8857025e656a067496472edabfb6bd2b6297f2c5ff0e", "page": 36, "required": true },
    { "sourceId": "local-evaluation-coronary-folder-g15", "version": "2021", "sha256": "c2018438f6bfe9abf39cdfa813f6a6312de858bb6047ce18d9a01bff222ae9ad", "page": 6, "required": true }
  ]
}
```

## 类别与影像指导

[2021 ACC/AHA/SCAI 血运重建指南](https://doi.org/10.1161/CIR.0000000000001038)物理第 35 页 §10.2 对接受 PCI 的患者讨论 DES 相对 BMS 的选择，属于支架类别建议；它不能证明本院某个产品或某个患者的具体用量。

同文物理第 36 页 §10.3 说明 IVUS 可用于介入指导，尤其左主干或复杂支架置入；OCT 的替代建议有左主干开口等适用限制。不能把这段改写成所有 PCI 均必须进行 IVUS。

## 尺寸与测量依据

血运重建指南物理第 36 页将病变长度、斑块、钙化及外弹力层直径等与术前支架尺寸评估联系起来，同时讨论术后贴壁、膨胀和边缘夹层等核对内容。[2021 CVIT 血管内超声共识](https://doi.org/10.1007/s12928-021-00824-0)物理第 6 页要求区分近远端参考段及管腔、EEM、斑块测量；长度取得还具有电动回撤或纵向成像等方法条件，不具备相应条件的手动回撤不能据此测长。

“需要核对测量”的归纳不等于系统已经具备选径算法。未知测量保留未知，不从目录规格反推患者管径，不把合成演示中的 3.0mm、5–16mm 或四类各一件当成指南要求。具体产品、规格和数量仍需要本次患者证据、医生计划及对应产品资料。

## 使用与更新

机器引用指向现有指南库的来源、版本、原件哈希和物理页；正文仅用于导航，实验上下文同时回读完整原文页。任一必需来源不可用时，本页的派生文字一并停用。它不绕过来源用途、完整性或正文质量策略。来源条件与实验结论见[对照研究](../2026-11-02-llm-wiki-for-inpatient-guidelines.md)。

相关专题：[对比剂与肾功能风险](contrast-kidney.md)。相关链接用于继续阅读，不构成本页的医学依据。
