---
name: clinmesh-administrator
description: ClinMesh administrator CLI workflow for inspecting automatically enabled laboratory-cn services and explicitly configuring bounded laboratory publication batches. Use for Laboratory Service configuration, source or panel filtering, publication status, retries, and job inspection; use scenario-data workflows for synthetic patient generation instead.
---

# ClinMesh Administrator

Read [`../clinmesh-shared/SKILL.md`](../clinmesh-shared/SKILL.md) first. Work only with synthetic ClinMesh data and the configured local Reference Release.

ClinMesh automatically enables every active laboratory-cn panel and test at startup. Ordinary clinical use requires no selection or publication step. The default Reference Release excludes the standalone LOINC Dataset; LOINC publication is available only with an explicitly configured Reference Release and source filter. The Reference catalog and the hospital's published Laboratory Services have different identities. Search candidates through the administrator operation, optionally filtering with `--source-dataset laboratory-cn` or `--source-dataset loinc-zh-cn` and `--panel-only`. Candidate output owns the Dataset Release, member count, specimen, adult applicability, and reference-source summary. For explicit configuration changes, publish only selected `conceptId` values with their current candidate versions. A publication batch contains at most 50 roots and may atomically add dependency-only panel members. Do not submit a global Reference Concept ID to a doctor Laboratory Request.

```bash
clinmesh admin laboratory-services candidates search
clinmesh admin laboratory-services candidates search --source-dataset laboratory-cn --panel-only
clinmesh admin laboratory-services publish --input @publication.json --idempotency-key <key>
clinmesh admin laboratory-services job get --job-id <job-id>
```

Publication completion requires a `succeeded` job and `published` candidate state. `queued` and `running` jobs remain in progress. On `failed`, read the structured error and current candidate version before forming a new intent; a retry uses a new idempotency key and the returned version. `laboratory-cn` panels and tests use their frozen Dataset definition without a Catalog Enrichment provider. LOINC candidates still require valid Catalog Enrichment before they become doctor-visible.

Reference Candidate files are operator-supplied local inputs. This workflow does not upload, publish, or expose those artifacts.

固定 PCI 作者来源通过独立受控入口准备。它建立可审计的 `clinmesh-authored` Profile 与私有 Case Truth；不会登记门诊、入院、执行手术或产生费用。与 `inpatient prepare-pci-data` 的目录、库存准备分别执行。返回病例尚需经现有手工 Persona 修订与选择后交给登记员；诊疗、实际检验、手术和 DRG 仍由正常业务形成。

```bash
clinmesh admin pci-case prepare --expected-epoch <epoch> --idempotency-key <key>
clinmesh command receipt get --operation-id admin.pci-case.prepare --idempotency-key <key>
```

`PCI_SOURCE_EPOCH_CONFLICT` 时刷新受信上下文后核对意图；传输失败保留原键查询回执，禁止通过上传 Bundle 或编造临床事实替代准备。

保留患者库重置会把已开始的直接住院病例重放到默认病区待接诊。清空患者库后重新准备将返回新的 Profile 修订和 Case 身份；读取本次返回值并重新建立、选择 Persona，再交给登记员。旧轮次病例与审计保持不变。
