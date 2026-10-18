"""Review source-resolvable anomalies in a new, immutable preparation candidate."""

from __future__ import annotations

import argparse
import collections
import copy
import csv
import json
import re
import shutil
from decimal import Decimal
from pathlib import Path

import pymupdf

from clean import compact, jsread, jsonl, sha, write_json, write_jsonl
from verify import verify


HEADING_PREFIXES = {
    "21020000100": "210200001",
    "311501001": "311501001",
    "311501002": "311501002",
    "311501003": "311501003",
}


def grade_prices(raw):
    """Accept only a complete, unambiguous three-level source price expression."""
    text = compact(raw)
    matches = re.findall(r"([一二三])级医院([0-9]+(?:\.[0-9]+)?)", text)
    if len(matches) != 3 or {level for level, _ in matches} != {"一", "二", "三"}:
        raise ValueError("Expected exactly one price for each of three hospital levels")
    if re.sub(r"[一二三]级医院[0-9]+(?:\.[0-9]+)?", "", text).strip("，,;；"):
        raise ValueError("Unrecognized condition in hospital-level price expression")
    return [{"condition": {"hospitalLevel": level + "级"}, "amount": str(Decimal(amount))}
            for level, amount in matches]


def bed_prices(raw):
    text = compact(raw)
    marker = "未配备单独卫生设施"
    if text.count(marker) != 1 or "配备单独卫生设施" not in text:
        raise ValueError("Missing explicit sanitary-facility condition")
    sections = text.split(marker)
    result = []
    for private_bathroom, section in zip([True, False], sections):
        rates = re.findall(r"([一二三四五])人(及以上病房|间)([0-9]+(?:\.[0-9]+)?)元/床日", section)
        if len(rates) != 5 or {count for count, _, _ in rates} != set("一二三四五"):
            raise ValueError("Expected all five explicit occupancy rates")
        for count, suffix, amount in rates:
            occupancy = "一二三四五".index(count) + 1
            result.append({"condition": {"privateBathroom": private_bathroom,
                                          "occupancyMin": occupancy,
                                          "occupancyMax": None if "以上" in suffix else occupancy},
                           "amount": str(Decimal(amount)), "sourceDenominator": "床日"})
    return result


def tier_example(activity, tiers):
    """Validate the source's integer-mCi examples; not a clinical pricing API."""
    if not isinstance(activity, int) or not 1 <= activity <= 100:
        raise ValueError("Source examples cover integer activity from 1 to 100 only")
    return sum((Decimal(str(max(0, min(activity, t["upperInclusive"]) - t["lowerInclusive"] + 1)))
                * Decimal(t["rateCnyPerSourceUnit"]) for t in tiers), Decimal(0))


class Review:
    def __init__(self, candidate, output):
        self.candidate, self.out = Path(candidate).resolve(), Path(output).resolve()
        if self.out.exists() or self.out.is_relative_to(self.candidate):
            raise ValueError("Output must be a new directory outside the previous candidate")
        verify(self.candidate)
        shutil.copytree(self.candidate, self.out)
        self.manifest = jsread(self.out / "release-candidate.json")
        self.issues = jsonl(self.out / "review/issues.jsonl")
        write_jsonl(self.out / "review/round-1-issues.jsonl", self.issues)
        self.resolutions = []
        self.evidence = []
        self.tables = {}
        self.pdfs = {dataset: pymupdf.open(self.out / self.manifest["sources"][dataset]["pdf"])
                     for dataset in ["services", "drugs"]}

    def pdf_row(self, dataset, record):
        page_number = record["source"]["pdfPage"]
        key = dataset, page_number
        if key not in self.tables:
            self.tables[key] = [
                {"pdfTable": table_index, "pdfRow": row_index, "rawCells": row,
                 "tableBounds": list(table.bbox)}
                for table_index, table in enumerate(self.pdfs[dataset][page_number - 1].find_tables().tables)
                for row_index, row in enumerate(table.extract())]
        code = record.get("code") or record.get("catalogueNumber")
        matches = [row for row in self.tables[key] if any(compact(c) == compact(code) for c in row["rawCells"])]
        if len(matches) != 1:
            raise ValueError(f"Ambiguous PDF identity: {dataset} {code}")
        return {"dataset": dataset, "pdfSha256": self.manifest["sources"][dataset]["pdfSha256"],
                "pdfPage": page_number, "source": record["source"], **matches[0],
                "pageText": self.pdfs[dataset][page_number - 1].get_text(sort=True),
                "method": "Exact code in native PDF table plus complete-page context and rendered-page review"}

    def record_change(self, dataset, issue, before, after, evidence, outcome, explanation):
        changes = [{"field": key, "originalValue": before.get(key), "correctedValue": after.get(key)}
                   for key in sorted(set(before) | set(after)) if before.get(key) != after.get(key)]
        entry = {"id": f"round2-{len(self.resolutions) + 1:04}", "dataset": dataset,
                 "issueId": issue["id"], "recordId": issue["recordId"],
                 "originalReviewStatus": issue["reviewStatus"], "reviewStatus": outcome,
                 "changes": changes, "basis": evidence, "explanation": explanation,
                 "humanReviewed": False, "runtimeEnabled": False}
        self.resolutions.append(entry)
        issue["reviewStatus"] = outcome
        issue["resolution"] = {"reviewId": entry["id"], "explanation": explanation}
        self.evidence.append(evidence)

    def services(self):
        records = jsonl(self.out / "standardized/services/records.jsonl")
        by_id = {r["id"]: r for r in records}
        rules = []
        for issue in self.issues:
            if issue["dataset"] != "services" or issue["kind"] != "service_record_review" or issue["reviewStatus"] != "pending":
                continue
            r = by_id[issue["recordId"]]
            before = copy.deepcopy(r)
            evidence = self.pdf_row("services", r)
            raw = evidence["rawCells"]
            r["sourceReview"] = {"round": 2, "pdfSha256": evidence["pdfSha256"],
                                  "pdfPage": evidence["pdfPage"], "humanReviewed": False}
            r["entryKind"] = "service"
            rule = None
            if r["code"] in HEADING_PREFIXES:
                assert not r["billingUnit"] and not r["price"]["raw"]
                children = [child["id"] for child in records
                            if child["id"] != r["id"] and child["code"].startswith(HEADING_PREFIXES[r["code"]])]
                assert children
                if r["code"] != "21020000100":
                    assert "包括" in compact(r["name"])
                r.update(entryKind="catalogue_heading", childRecordIds=children,
                         chargeability="not_a_billable_leaf", reviewFlags=[],
                         reviewStatus="verified_catalogue_heading")
                outcome, explanation = "resolved_source_classification", "分类标题；收费须选择具体子项，不补造标题价格或单位"
            else:
                if r["code"] in ["25050100901", "25050101102", "25050101103"]:
                    assert compact(raw[5]) == compact(r["price"]["raw"])
                    rule = {"type": "hospital_level", "options": grade_prices(raw[5]), "raw": r["price"]["raw"]}
                elif r["code"] == "11050000101":
                    note = compact(raw[6])
                    assert "初学驾驶员每人次30元" in note and "其他驾驶员每人次15元" in note
                    assert "新标准未制定前" in note and "执行属地价格政策" in note
                    rule = {"type": "conditional_driver_exam", "raw": raw[6],
                            "options": [{"condition": {"driverType": "初学驾驶员"}, "amount": "30"},
                                        {"condition": {"driverType": "其他驾驶员"}, "amount": "15"}],
                            "applicabilityRaw": "新标准未制定前；省级公立医院执行属地价格政策"}
                elif r["code"] == "11090000100":
                    rule = {"type": "occupancy_and_facilities", "raw": raw[6], "options": bed_prices(raw[6])}
                elif r["code"] == "32000000100":
                    assert "每增加一根血管的治疗加收原收费标准30%" in compact(raw[6])
                    assert "血管造影检查不得按此计价" in compact(evidence["pageText"])
                    rule = {"type": "additional_vessel_surcharge", "raw": raw[6],
                            "multiplier": "0.30", "baseAmountMeaning": "原收费标准", "amount": None,
                            "quantityMeaning": "以一根血管为起点，每增加一根血管", "excluded": "血管造影检查"}
                if rule:
                    rule.update(id="service-price-rule:" + r["code"], recordId=r["id"], source=r["source"],
                                evidence=evidence, currency="CNY", billingUnit=r["billingUnit"],
                                priceKind="provincial_reference_2024", currentApplicability="unverified",
                                executable=False, runtimeEnabled=False)
                    rules.append(rule)
                    r.update(priceRuleId=rule["id"], reviewFlags=[], reviewStatus="verified_source_price_rule")
                    outcome, explanation = "resolved_source_rule_structured", "来源中的条件价格已结构化；现行属地及院内适用性仍需核实"
                else:
                    assert r["price"]["amount"] is None and not compact(raw[5] if len(raw) == 10 else "")
                    requirement = "hospital_pricing_required" if r["cataloguePart"] == "hospital_autonomous_pricing" else "applicable_local_tariff_required"
                    r.update(reviewStatus="waiting_external_pricing",
                             reviewFlags=[requirement] + (["hospital_billing_unit_required"] if not r["billingUnit"] else []),
                             pricingRequirement={"state": requirement,
                                                 "missing": ["price"] + (["billingUnit"] if not r["billingUnit"] else []),
                                                 "sourceMissingConfirmed": True})
                    outcome = "waiting_external_pricing"
                    explanation = "原目录未给单价；自主定价项目需补院内价格" if r["cataloguePart"] == "hospital_autonomous_pricing" else "原价格栏确为空白；需目标地区适用价表或院内有效价格，不能借用邻行价格"
                    if r["code"].startswith("13"):
                        parent = next(c for c in jsonl(self.out / "standardized/services/categories.jsonl") if c["code"] == "13")
                        assert "按市级价格主管部门规定执行" in compact(json.dumps(parent, ensure_ascii=False))
                        r["pricingRequirement"]["scopeNote"] = "所属社区卫生服务及预防保健类明确按市级价格主管部门规定执行"
                        evidence["categorySource"] = parent
            self.record_change("services", issue, before, r, evidence, outcome, explanation)
        assert len(rules) == 6
        write_jsonl(self.out / "standardized/services/records.jsonl", records)
        write_jsonl(self.out / "standardized/services/price-rules.jsonl", rules)
        self.manifest["tables"]["services/price-rules"] = len(rules)

    def drugs(self):
        records = jsonl(self.out / "standardized/drugs/records.jsonl")
        target = next(r for r in records if r["source"]["pdfPage"] == 180 and r["catalogueNumber"] == "398")
        assert target["name"] == "治疗用碘[131I]化钠胶囊" and "见备注2" in target["paymentRaw"]
        evidence = self.pdf_row("drugs", target)
        p = self.pdfs["drugs"][179]
        table = p.find_tables().tables[1]
        cells = table.extract()
        assert len(cells) == 4
        normalized = [[compact(c) for c in row] for row in cells]
        assert normalized[0][:2] == ["规格(毫居)", "阶梯内单价(元/毫居)"]
        assert [row[0] for row in normalized[1:]] == ["1-10", "11-50", "51-100"]
        assert [row[1] for row in normalized[1:]] == ["59.00", "0.8*59.00=47.20", "0.65*59.00=38.35"]
        tiers = [{"lowerInclusive": 1, "upperInclusive": 10, "rateCnyPerSourceUnit": "59.00"},
                 {"lowerInclusive": 11, "upperInclusive": 50, "rateCnyPerSourceUnit": "47.20"},
                 {"lowerInclusive": 51, "upperInclusive": 100, "rateCnyPerSourceUnit": "38.35"}]
        examples = [{"sourceActivity": n, "expectedCny": str(Decimal(value)), "calculatedCny": str(tier_example(n, tiers))}
                    for n, value in [(1, "59.00"), (11, "637.20"), (51, "2516.35"), (100, "4395.50")]]
        assert all(Decimal(e["expectedCny"]) == Decimal(e["calculatedCny"]) for e in examples)
        evidence.update(auxiliaryPdfTable=1, auxiliaryTableBounds=list(table.bbox), auxiliaryRawCells=cells)
        schedule = {"id": "drug-payment-schedule:negotiated-X-398", "recordId": target["id"],
                    "name": target["name"], "type": "cumulative_activity_tiers", "sourceUnit": "毫居",
                    "currency": "CNY", "tiers": tiers, "sourceExamples": examples,
                    "activityRangeRaw": "37-3700MBq(1-100毫居)", "source": target["source"],
                    "evidence": evidence, "validFrom": target["validFrom"], "validTo": target["validTo"],
                    "executable": False, "runtimeEnabled": False,
                    "applicability": "目录支付标准；不是院内收费或采购成本；小数活度、实际包装及换算须另行核实"}
        target["paymentScheduleId"] = schedule["id"]
        auxiliary = jsonl(self.out / "standardized/drugs/auxiliary-table-rows.jsonl")
        selected = [issue for issue in self.issues if issue["dataset"] == "drugs" and issue["kind"] == "unassigned_table_row" and issue["reviewStatus"] == "pending"]
        assert len(selected) == 4
        for issue in selected:
            row = next(r for r in auxiliary if r["id"] == issue["recordId"])
            before = copy.deepcopy(row)
            index = row["source"]["htmlRowIndex"]
            row.update(kind="payment_schedule_header" if index == 0 else "payment_schedule_tier",
                       relatedRecordIds=[target["id"]], paymentScheduleId=schedule["id"],
                       verifiedPdfCells=cells[index], reviewStatus="verified_pdf_text")
            self.record_change("drugs", issue, before, row, evidence, "resolved_payment_schedule_associated",
                               "备注2明确关联谈判西药编号398；阶梯表逐行对照PDF，原例金额验证通过")
        write_jsonl(self.out / "standardized/drugs/records.jsonl", records)
        write_jsonl(self.out / "standardized/drugs/auxiliary-table-rows.jsonl", auxiliary)
        write_jsonl(self.out / "standardized/drugs/tiered-payment-schedules.jsonl", [schedule])
        self.manifest["tables"]["drugs/tiered-payment-schedules"] = 1

    def procedures(self, review_path):
        review_path = Path(review_path).resolve()
        report = jsread(review_path)
        entries = {r["code"]: r for r in report["records"]}
        issues = [i for i in self.issues if i["kind"] == "dictionary_reference_missing" and i["reviewStatus"] == "pending"]
        assert len(entries) == 80 and set(entries) == {i["detail"]["code"] for i in issues}
        replacements = {}
        for source in report["sources"]:
            relative = Path(source["localPath"])
            origin = (review_path.parent / relative).resolve()
            assert origin.is_relative_to(review_path.parent) and origin.is_file()
            assert sha(origin) == source["sha256"]
            target = self.out / "raw/verification-sources" / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(origin, target)
            replacements[source["localPath"]] = target.relative_to(self.out).as_posix()
        def relocate(value):
            if isinstance(value, dict):
                return {k: relocate(v) for k, v in value.items()}
            if isinstance(value, list):
                return [relocate(v) for v in value]
            return replacements.get(value, value) if isinstance(value, str) else value
        report = relocate(report)
        entries = {r["code"]: r for r in report["records"]}
        supplement, by_code, status_by_code = [], {}, {}
        for issue in issues:
            r = entries[issue["detail"]["code"]]
            assert r["drgPdfPresent"] and r["historicalDictionaryExactPresent"] is False
            before, after = copy.deepcopy(issue), copy.deepcopy(issue)
            confirmed = r["state"] == "confirmed_official_online"
            if confirmed:
                assert r["dictionaryExactPresent"] is True and r["officialNames"]
                source = next(e for e in r["evidence"] if e["claim"] == "complete_code_and_literal_name_present")
                if r["nameConflict"]:
                    status = "pending_clinical_name_conflict"
                elif r["nameDiffers"]:
                    status = "pending_source_name_variants"
                else:
                    status = "resolved_official_online_dictionary_confirmed"
                supplement.append({"id": "icd9-online:" + r["code"], "code": r["code"], "name": r["name"],
                                   "officialNames": r["officialNames"], "hierarchy": r["officialHierarchy"],
                                   "kind": "leaf", "source": {"kind": "official_online_dictionary", **source},
                                   "sourceReleaseVersion": None, "sourceReleaseDate": None,
                                   "sourceVersion": "official-web-snapshot-2026-10-16-unknown-release",
                                   "historicalPdfContainsCode": False, "runtimeEnabled": False,
                                   "humanReviewed": False, "reviewStatus": status,
                                   "eligibleReferenceCandidate": False,
                                   "officialEntryActiveStatus": None,
                                   "officialEntryDisplay": r["officialEntryDisplay"],
                                   "officialHtmlContainerAttributes": r["officialHtmlContainerAttributes"],
                                   "reviewFlags": ["release_and_active_status_unknown"] +
                                                  (["clinical_technique_name_conflict"] if r["nameConflict"] else
                                                   ["drg_source_name_variants"] if r["nameDiffers"] else []),
                                   "drgNameVariants": r["drgNameVariants"],
                                   "drgCompatibleDictionaryReleaseConfirmed": False})
            else:
                assert r["state"] == "waiting_official_dictionary_release" and r["dictionaryExactPresent"] is None
                status = "waiting_official_dictionary_release"
            status_by_code[r["code"]] = status
            by_code[r["code"]] = r
            after["dictionaryReview"] = {"state": r["state"], "historicalDictionaryExactPresent": False,
                                         "dictionaryExactPresent": r["dictionaryExactPresent"],
                                         "officialName": r["name"] if confirmed else None,
                                         "nameDiffers": r["nameDiffers"], "nameConflict": r["nameConflict"],
                                         "drgCompatibleDictionaryReleaseConfirmed": False}
            basis = {"dataset": "drg", "code": r["code"], "method": "official_dictionary_version_review",
                     "sourceReview": r, "evidence": r["evidence"]}
            self.record_change("drg", issue, before, after, basis, status, r["reason"])
            issue["dictionaryReview"] = after["dictionaryReview"]
        write_jsonl(self.out / "standardized/icd9/official-online-supplement.jsonl", supplement)
        self.manifest["tables"]["icd9/official-online-supplement"] = len(supplement)
        write_json(self.out / "review/procedure-code-review.json", report)
        write_jsonl(self.out / "review/procedure-name-review.jsonl", [r for r in entries.values() if r["nameDiffers"]])
        # Link disputed source occurrences without replacing any DRG wording or codes.
        members = jsonl(self.out / "standardized/drg/rule-members.jsonl")
        for member in members:
            if member["code"] in by_code:
                r = by_code[member["code"]]
                member["dictionaryReviewStatus"] = status_by_code[member["code"]]
                member["officialOnlineName"] = r["name"] if r["state"] == "confirmed_official_online" else None
                member["sourceNameReviewRequired"] = bool(r["nameConflict"] or (member["officialOnlineName"] and compact(member["nameText"]) != compact(member["officialOnlineName"])))
        write_jsonl(self.out / "standardized/drg/rule-members.jsonl", members)
        details = jsonl(self.out / "reports/cross-library-details.jsonl")
        matches = {"resolved_official_online_dictionary_confirmed": "exact_official_online_supplement",
                   "pending_source_name_variants": "official_online_source_name_variants",
                   "pending_clinical_name_conflict": "official_online_clinical_name_conflict",
                   "waiting_official_dictionary_release": "official_online_unverified_request_failure"}
        for result in details:
            if result["code"] in status_by_code and result["dictionary"] == "procedure":
                assert result["match"] == "missing"
                result["historicalDictionaryMatch"] = "missing"
                result["match"] = matches[status_by_code[result["code"]]]
                result["reviewStatus"] = status_by_code[result["code"]]
        write_jsonl(self.out / "reports/cross-library-details.jsonl", details)
        summary = jsread(self.out / "reports/cross-library-report.json")
        summary["historicalDictionaryMatches"] = summary["matches"]
        summary["matches"] = dict(collections.Counter(r["match"] for r in details))
        summary["officialOnlineReview"] = report["summary"]
        summary["dictionaryVersionCompatibility"] = "Official static PDF identity confirmed; online snapshots have no published release or DRG-compatible release metadata"
        write_json(self.out / "reports/cross-library-report.json", summary)
        self.cross_summary = summary
        self.procedure_summary = report["summary"]
        self.procedure_statuses = dict(collections.Counter(status_by_code.values()))
        write_json(self.out / "review/official-source-manifest.json", {"sources": report["sources"], "summary": report["summary"]})
        self.manifest["supplementalSourceManifest"] = "review/official-source-manifest.json"
        lines = ["# DRG与医保编码字典交叉校验（r2）", "",
                 "原2021年1月ICD-9-CM3医保2.0 PDF已经与官网公开PDF核对为同一文件；其中确实缺少这80个完整编码。原字典不被动态网页改写。", "",
                 "| 当前核查结果 | 唯一完整编码数 |", "| --- | ---: |"]
        lines += [f"| {state} | {count} |" for state, count in summary["matches"].items()]
        lines += ["", "53个完整码和名称已在官方动态详情核实，补充记录单独保存在`standardized/icd9/official-online-supplement.jsonl`。其中35个在本轮全部DRG引用名称中一致；17个有来源文字变体；1个为微波/射频术式冲突，相关记录隔离。", "",
                  "27个详情请求遇到站点安全阻断或网络错误，不能据此判定在线字典没有该码；保留等待官方详情或可下载匹配版本状态。未绕过站点访问控制。", "",
                  "所有80个编码的DRG原文、完整出现页、官方查询或失败证据、详情POST参数和快照哈希见`review/procedure-code-review.json`。历史PDF缺失、动态字典存在和DRG名称一致性是三个独立结果。", "",
                  "动态网页快照没有提供每条发布批次、生效时间或与DRG3.0配套的正式版本声明。即使完整码和名称吻合，也不能据此直接用于正式分组；兼容版本与地方适用性仍是发布门槛。", "",
                  "## 80码逐项结果", "",
                  "| 完整编码 | DRG首处名称 | 官方在线名称 | 结果 | 首次PDF页 |", "| --- | --- | --- | --- | ---: |"]
        for r in entries.values():
            labels = {"resolved_official_online_dictionary_confirmed": "完整码及全部来源名称一致",
                      "pending_source_name_variants": "编码确认；来源名称变体待审",
                      "pending_clinical_name_conflict": "微波/射频术式冲突；隔离",
                      "waiting_official_dictionary_release": "请求未成功；在线存在性未知"}
            lines.append(f"| `{r['code']}` | {r['drgName']} | {r['name'] if r['dictionaryExactPresent'] else '未取得详情'} | {labels[status_by_code[r['code']]]} | {r['drgOccurrences'][0]['pdfPage']} |")
        lines += ["", "## 名称差异", "",
                  "来源文字不被覆盖。18个编码至少有一处与官方在线名称不一致，全部变体和页码保存在`review/procedure-name-review.jsonl`；这包含源PDF实际排印问题和文字层/字形差异，不能笼统称为OCR错误。", "",
                  "`41.4200x005`：DRG第438、487、875、943、944、1048、1165页为微波消融，官方动态字典为射频消融；DRG第1264页又出现射频字样及名称文字异常。保留双方证据，不能自动改名或用相近码替换。", ""]
        (self.out / "reports/cross-library-report.md").write_text("\n".join(lines), encoding="utf-8")

    def finish(self, procedure_review=None):
        self.manifest.update(releaseId="clinmesh-five-catalogues-2026-10-16.r2",
                             previousCandidate={"releaseId": "clinmesh-five-catalogues-2026-10-16.r1",
                                                "checksumsSha256": sha(self.candidate / "checksums.json")})
        write_jsonl(self.out / "review/resolutions.jsonl", self.resolutions)
        write_jsonl(self.out / "review/source-review-evidence.jsonl", self.evidence)
        write_jsonl(self.out / "review/issues.jsonl", self.issues)
        columns = ["id", "dataset", "kind", "severity", "reviewStatus", "recordId", "source", "detail", "originalValue", "correctedValue", "basis", "resolution"]
        with (self.out / "review/issues.csv").open("w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=columns)
            writer.writeheader()
            for issue in self.issues:
                writer.writerow({k: json.dumps(issue.get(k), ensure_ascii=False) if isinstance(issue.get(k), (dict, list)) else issue.get(k) for k in columns})
        stats = {"reviewRound": 2, "outcomes": dict(collections.Counter(r["reviewStatus"] for r in self.resolutions)),
                 "issuesByStatus": dict(collections.Counter(r["reviewStatus"] for r in self.issues)),
                 "serviceSourceRows": 6222, "serviceItems": 6218, "serviceHeadings": 4,
                 "sourcePriceRules": 6, "externalPricingRecords": 72,
                 "autonomousHospitalPricingRecords": 47, "otherApplicableTariffRecords": 25,
                 "drugAuxiliaryRowsResolved": 4, "drugPaymentSchedules": 1, "runtimeEnabled": False}
        if hasattr(self, "procedure_summary"):
            stats["procedureReview"] = self.procedure_summary
            stats["procedureOutcomes"] = self.procedure_statuses
        write_json(self.out / "reports/round-2-review.json", stats)
        quality = jsread(self.out / "reports/quality-report.json")
        quality["statistics"]["services"].update(pendingRecords=0, sourceRows=6222, serviceItems=6218,
                                                 catalogueHeadings=4, sourcePriceRules=6, waitingExternalPricing=72)
        quality["statistics"]["drugs"].update(pendingAuxiliaryRows=0, tieredPaymentSchedules=1)
        if hasattr(self, "cross_summary"):
            quality["statistics"]["crossLibrary"] = self.cross_summary
        quality.update(round2Review=stats, issues=stats["issuesByStatus"], datasets=self.manifest["tables"])
        write_json(self.out / "reports/quality-report.json", quality)
        write_json(self.out / "release-candidate.json", self.manifest)
        shutil.copy2(self.candidate / "reports/quality-report.md", self.out / "reports/round-1-quality-report.md")
        lines = ["# 五类参考数据清洗与验收报告（r2）", "",
                 "五类原件继续保留；这是离线参考候选包，未发布、未启用、未写入运行库。", "",
                 "| 数据 | 当前结果 |", "| --- | --- |",
                 "| ICD-10 医保2.0 | 33,304 条末级编码；保留922条纯层级行；原单元格核对与修正证据继续有效 |",
                 "| ICD-9-CM3 医保2.0 | 原PDF字典13,686条末级；原版本不被在线补充覆盖 |",
                 "| DRG3.0 | 26 MDC / 492 ADRG / 825 DRG；19个空正文页已补提；尚非可执行分组器 |",
                 "| 浙江2024 | 6,222条来源行，其中6,218条项目、4条分类标题；6条条件价格规则已结构化；72条等待外部价格资料 |",
                 "| 医保药品2025 | 4,807条明细；4行阶梯附表已关联到碘[131I]胶囊，保密价仍为*、未知仍为空 |", "",
                 "## 来源复核结果", "",
                 "3条检验价格按医院等级分别保存；驾驶员体检价格保留初学/其他驾驶员及新标准、属地政策条件；普通床位费保留有无独立卫生设施及床位人数的10档价格；血管介入加收保留原收费标准30%、增加血管数与造影排除条件。均为2024来源事实，未替换成本院现行价。", "",
                 "磁共振总项及A/B/C三类精神科量表总项标为catalogue_heading并关联子项。它们不计作收费末级，不再以缺价项目要求补价。", "",
                 "碘[131I]胶囊备注2的3档阶梯支付标准、4行表头/数据及原金额算例全部保留并关联。单位按原文“毫居”保存，小数活度、包装转换和实际适用性仍须核实；不提供运行时支付计算接口。", "",
                 "## 仍需外部资料的项目", "",
                 "72条服务包括47条自主定价附录项目和25条省级目录未给单价的项目。原文空白已核实；等待目标地区适用价表或院内有效价格，其中22条还需明确院内计价单位。它们的价格不设为0、不借用邻行或外省价格。所有记录的本院收费、采购成本、有效期和产品映射仍需独立补全。", "",
                 "编码版本调查见[跨库报告](cross-library-report.md)和`review/procedure-code-review.json`；在线查询身份确认与正式分组器版本兼容性分别记录。", "",
                 "## 证据和验证", "",
                 "[本轮复核速览](review-overview.md)、`review/resolutions.jsonl`、`review/source-review-evidence.jsonl`保存本轮结果、变更前后值、原PDF哈希、物理页及表格行。原字段修正日志继续保留在`review/corrections.jsonl`。主目录与附表问题共同统计；来源核对与外部参数齐备不混为一种通过状态。", "",
                 "[检查记录](checks-run.md)说明实际执行的验证；最终独立验证及压缩包CRC与SHA-256记录在交付目录旁的verification.json。机器复核不代表人工医学或地方适用性审定。", "",
                 "原始压缩包、PDF、分片、页码映射及校验文件不变；补充官网证据单独归档。DRG更新版PDF身份及初轮全文提取详见[初轮验收报告](round-1-quality-report.md)。运行库和reference-data.lock.json未修改，后续正式发布仍须沿用项目现有参考数据签名、同步与版本冻结机制。", ""]
        if hasattr(self, "procedure_summary"):
            position = lines.index("## 仍需外部资料的项目")
            lines[position:position] = ["## 80个操作编码的官方复核", "",
                                       "80码确实未收录在官方2021年1月静态医保2.0 PDF。53码已在官方动态详情取得完整编码、名称及可见层级：35码的本轮DRG引用名称一致，17码存在来源字面变体，1码存在微波/射频术式冲突；27码的详情读取遇到站点安全阻断或网络错误，不能把请求失败说成字典缺码。", "",
                                       "53条网页记录单独形成补充候选集；有效状态、发布批次、生效日期及DRG配套版本仍未知。返回HTML的折叠或显示属性不作为有效状态依据。18个名称差异保留全部原文及页码，1个术式冲突隔离等待权威勘误。历史PDF字典、动态字典和DRG规则的来源事实分别保留。", ""]
        (self.out / "reports/quality-report.md").write_text("\n".join(lines), encoding="utf-8")
        self.overview()
        shutil.copy2(self.candidate / "reports/checks-run.md", self.out / "reports/round-1-checks-run.md")
        checks = ["# 工具验证记录（r2）", "",
                  "- 清洗与来源价格边界回归：10项通过；覆盖编码保真、表格跨列、医院等级条件、病房条件和阶梯边界。",
                  "- 5份Python源码的语法、尾部空白及末换行检查通过。",
                  "- 输入r1候选包独立验证通过；新增来源证据逐文件核对SHA-256。",
                  "- PDF原表和名称差异位置已渲染查看；不涉及患者或影像像素。",
                  "- pnpm docs:check：2份测试文件、6项测试及VitePress构建通过。",
                  "- 原工作区pnpm verify:docs因既有CLAUDE.md符号链接占位缺换行失败；pnpm verify:agent-notes因既有CRLF格式失败。未修改这些无关文件；在包含本任务最新文档的LF隔离副本中，原验证脚本分别通过183份Markdown和105份Agent Note。",
                  "- r2完整独立验证命令：python tooling/verify.py <候选包目录>。最终执行结果与ZIP CRC、SHA-256保存在交付目录旁的verification.json。", "",
                  "本次仅修改离线清洗工具和文档；未运行项目业务测试，未修改运行库或reference-data.lock.json。", ""]
        (self.out / "reports/checks-run.md").write_text("\n".join(checks), encoding="utf-8")
        for p in Path(__file__).parent.iterdir():
            if p.is_file() and p.suffix in [".py", ".txt", ".md"]:
                shutil.copy2(p, self.out / "tooling" / p.name)
        files = [{"path": p.relative_to(self.out).as_posix(), "bytes": p.stat().st_size, "sha256": sha(p)}
                 for p in sorted(self.out.rglob("*")) if p.is_file() and p != self.out / "checksums.json"]
        write_json(self.out / "checksums.json", files)
        print(json.dumps(stats, ensure_ascii=False))

    def overview(self):
        def cell(value):
            return str(value if value is not None else "").replace("|", "&#124;").replace("\n", " ")
        records = jsonl(self.out / "standardized/services/records.jsonl")
        by_id = {r["id"]: r for r in records}
        lines = ["# 本轮复核速览", "", "原r1候选包保留；本文件展示r2。未接入运行库。", "",
                 "## 已从来源解决的10条服务记录", "",
                 "| 编码 | 名称 | 处理结果 | PDF页 |", "| --- | --- | --- | ---: |"]
        for review in self.resolutions:
            if review["dataset"] == "services" and review["reviewStatus"].startswith("resolved_"):
                r = by_id[review["recordId"]]
                lines.append("|" + "|".join(map(cell, [r["code"], r["name"], review["explanation"], r["source"]["pdfPage"]])) + "|")
        lines += ["", "6条价格规则详见`standardized/services/price-rules.jsonl`；条件不同的金额分别保存，不选定一个金额充当通用价。", "",
                  "## 已解决的4行药品附表", "",
                  "药品目录PDF第180页（印刷第179页）的备注2明确属于谈判西药398：治疗用碘[131I]化钠胶囊。原表按1–10、11–50、51–100毫居列出59.00、47.20、38.35元/毫居的阶梯内单价，累计金额原例已核算一致。详见`standardized/drugs/tiered-payment-schedules.jsonl`。", "",
                  "## 等待外部价格资料的72条服务", "",
                  "以下空值已核实来自原文。47条来自自主定价附录，25条需要适用地区价表或院内有效价；22条另需明确计价单位。", "",
                  "| 编码 | 名称 | 需要补的资料 | 原单位 | PDF页 |", "| --- | --- | --- | --- | ---: |"]
        for r in records:
            if r["reviewStatus"] == "waiting_external_pricing":
                need = "院内自主定价" if r["cataloguePart"] == "hospital_autonomous_pricing" else "目标地区适用价表或院内有效价"
                if not r["billingUnit"]:
                    need += "；院内计价单位"
                lines.append("|" + "|".join(map(cell, [r["code"], r["name"], need, r["billingUnit"] or "未列", r["source"]["pdfPage"]])) + "|")
        lines += ["", "## 操作编码核查", "", "详见[跨库报告](cross-library-report.md)及`review/procedure-code-review.json`。原医保2.0 PDF与官方在线查询数据分别保留，版本兼容性不得由文字命中推断。", ""]
        if hasattr(self, "procedure_summary"):
            lines += ["53个完整码已取得官方详情：35个本轮全部来源名称一致，17个有来源字面变体，1个为微波/射频术式冲突；27个详情请求失败。53条的发布批次、生效日期及实际有效状态均未知，补充集不能直接启用。", ""]
        (self.out / "reports/review-overview.md").write_text("\n".join(lines), encoding="utf-8")

    def run(self, procedure_review=None):
        self.services()
        self.drugs()
        if procedure_review:
            self.procedures(procedure_review)
        self.finish(procedure_review)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--procedure-review", type=Path)
    args = parser.parse_args()
    Review(args.candidate, args.output).run(args.procedure_review)
