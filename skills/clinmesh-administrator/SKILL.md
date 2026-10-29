---
name: clinmesh-administrator
description: ClinMesh administrator CLI workflows for laboratory publication and fixed PCI patient preparation. Use for Laboratory Service configuration, source or panel filtering, publication status, retries, job inspection, and preparing the fixed synthetic PCI patient with an active Persona; use scenario-data workflows for dynamic synthetic patient generation.
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

固定 PCI 作者来源通过独立受控入口准备。它建立可审计的 `clinmesh-authored` Profile、私有 Case Truth 和版本化合成 Persona，并在同一事务选用首个修订；首次返回 `brief-ready`、`activeBriefRevision=1`、病例 `revision=2`，可直接交给登记员，无需手填九字段或另选修订。Persona 的 `model` 为 `clinmesh-authored-template`，准备不调用模型、不登记门诊或入院、不产生诊疗或费用。目录、库存仍由 `inpatient prepare-pci-data` 单独准备。

```bash
clinmesh admin pci-case prepare --expected-epoch <epoch> --idempotency-key <key>
clinmesh command receipt get --operation-id admin.pci-case.prepare --idempotency-key <key>
```

取得准备回执后核对病例状态和当前修订，再交给登记员。重复准备保留已有人工修订、当前选用及消费绑定；历史待准备病例已有未选修订时选用最新已有修订，仅无 Persona 时建立模板。已开始病例继续原就诊，不能再次消费。需调整自述时使用原档案编辑与选择入口。

`PCI_SOURCE_EPOCH_CONFLICT` 时刷新受信上下文后核对意图；传输失败保留原键先查询回执，未找到时才用原键和原输入恢复。准备入口只接受固定来源意图，禁止上传 Bundle 或编造临床事实替代准备。

准备返回 `409 PCI_SOURCE_PERSONA_RUNNING` 时，等待原档案生成任务全部结束，再用原输入和幂等键恢复准备，取得当前病例修订后交接。历史未选用病例仅有排队任务时，准备会原子终止这些旧任务并将其标为 `failed / PERSONA_JOB_SUPERSEDED`，避免准备后重新调用模型或改变修订；已有有效选用病例的显式生成任务继续原流程，仍有排队或运行中任务时等待完成再准备。已消费病例保持原绑定。

保留患者库重置会按原病例及选用修订把已开始的直接住院重放到默认病区待接诊。清空患者库后重新准备将返回新的 Profile 修订和 Case 身份，并自动完成该新病例的固定 Persona 选用；读取本次返回值再交给登记员。旧轮次病例与审计保持不变，详细边界见[仿真合同](../../docs/architecture/simulation.md#103-场景定义)。
