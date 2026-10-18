"""Independently verify a saved preparation directory. No runtime database access."""

import argparse
import collections
import hashlib
import html
import json
import re
from decimal import Decimal
from pathlib import Path


def load(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def rows(path):
    with path.open(encoding="utf-8-sig") as f:
        yield from (json.loads(line) for line in f if line.strip())


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def verify_review(root, manifest):
    summary = load(root / "reports/round-2-review.json")
    issues = list(rows(root / "review/issues.jsonl"))
    assert summary["issuesByStatus"] == dict(collections.Counter(r["reviewStatus"] for r in issues))
    services = {r["id"]: r for r in rows(root / "standardized/services/records.jsonl")}
    headings = [r for r in services.values() if r.get("entryKind") == "catalogue_heading"]
    assert len(headings) == 4
    for r in headings:
        assert r["chargeability"] == "not_a_billable_leaf" and r["price"]["amount"] is None
        assert r["childRecordIds"] and all(cid in services for cid in r["childRecordIds"])
        assert r["id"] not in r["childRecordIds"] and not r["reviewFlags"]
    waiting = [r for r in services.values() if r["reviewStatus"] == "waiting_external_pricing"]
    assert len(waiting) == summary["externalPricingRecords"] == 72
    assert all(r["price"]["amount"] is None and r["hospitalMapping"]["chargePrice"] is None for r in waiting)
    rules = list(rows(root / "standardized/services/price-rules.jsonl"))
    assert len(rules) == summary["sourcePriceRules"] == 6
    for r in rules:
        assert r["runtimeEnabled"] is False and r["executable"] is False
        assert r["priceKind"] == "provincial_reference_2024" and r["currentApplicability"] == "unverified"
        assert services[r["recordId"]]["priceRuleId"] == r["id"]
        assert services[r["recordId"]]["price"]["amount"] is None
        assert r["evidence"]["pdfSha256"] == manifest["sources"]["services"]["pdfSha256"]
    schedules = list(rows(root / "standardized/drugs/tiered-payment-schedules.jsonl"))
    assert len(schedules) == 1
    drugs = {r["id"]: r for r in rows(root / "standardized/drugs/records.jsonl")}
    for s in schedules:
        assert not s["executable"] and not s["runtimeEnabled"]
        assert drugs[s["recordId"]]["paymentScheduleId"] == s["id"]
        for example in s["sourceExamples"]:
            activity = example["sourceActivity"]
            amount = sum((Decimal(max(0, min(activity, t["upperInclusive"]) - t["lowerInclusive"] + 1))
                          * Decimal(t["rateCnyPerSourceUnit"]) for t in s["tiers"]), Decimal(0))
            assert amount == Decimal(example["expectedCny"]) == Decimal(example["calculatedCny"])
    auxiliary = {r["id"]: r for r in rows(root / "standardized/drugs/auxiliary-table-rows.jsonl")}
    issue_by_id = {r["id"]: r for r in issues}
    resolutions = list(rows(root / "review/resolutions.jsonl"))
    assert summary["outcomes"] == dict(collections.Counter(r["reviewStatus"] for r in resolutions))
    for review in resolutions:
        assert not review["humanReviewed"] and not review["runtimeEnabled"]
        issue = issue_by_id[review["issueId"]]
        assert issue["reviewStatus"] == review["reviewStatus"]
        if review["dataset"] in ["services", "drugs"]:
            record = (services if review["dataset"] == "services" else auxiliary)[review["recordId"]]
            for change in review["changes"]:
                assert record.get(change["field"]) == change["correctedValue"]
            assert review["basis"]["pdfSha256"] == manifest["sources"][review["dataset"]]["pdfSha256"]
        elif review["dataset"] == "drg":
            for change in review["changes"]:
                assert issue.get(change["field"]) == change["correctedValue"]
    assert not any(r["dataset"] == "drugs" and r["reviewStatus"] == "pending" for r in issues)
    if (root / "review/procedure-code-review.json").exists():
        review = load(root / "review/procedure-code-review.json")
        for source in review["sources"]:
            path = (root / source["localPath"]).resolve()
            assert path.is_relative_to(root.resolve()) and digest(path) == source["sha256"]
        supplement = list(rows(root / "standardized/icd9/official-online-supplement.jsonl"))
        assert len(supplement) == review["summary"]["officialOnlineConfirmed"] == 53
        by_code = {r["code"]: r for r in review["records"]}
        for r in supplement:
            assert not r["eligibleReferenceCandidate"] and r["officialEntryActiveStatus"] is None
            assert r["sourceReleaseVersion"] is None and not r["drgCompatibleDictionaryReleaseConfirmed"]
            assert by_code[r["code"]]["dictionaryExactPresent"] is True
            snapshot = (root / r["source"]["snapshotPath"]).read_text(encoding="utf-8")
            text = re.sub(r"\s+", "", html.unescape(re.sub(r"<[^>]*>", "", snapshot)))
            assert r["code"] in text and re.sub(r"\s+", "", r["name"]) in text
        for r in review["records"]:
            assert not r["historicalDictionaryExactPresent"] and r["drgPdfPresent"]
            if r["state"] == "waiting_official_dictionary_release":
                assert r["dictionaryExactPresent"] is None
        details = list(rows(root / "reports/cross-library-details.jsonl"))
        assert dict(collections.Counter(r["match"] for r in details)) == load(root / "reports/cross-library-report.json")["matches"]
        assert sum(r["match"] == "official_online_clinical_name_conflict" for r in details) == 1
        assert sum(r["match"] == "official_online_source_name_variants" for r in details) == 17
        assert sum(r["match"] == "official_online_unverified_request_failure" for r in details) == 27
    return len(resolutions)


def verify_enrichment(root, manifest):
    summary = load(root / "reports/round-3-data-status.json")
    assert summary["scope"] == "offline_data_only" and not summary["runtimeEnabled"]
    sources = load(root / "review/price-source-manifest.json")
    official = [r for r in sources.values() if r["status"] == "hash_matched"]
    assert len(official) == summary["officialPriceSourcesHashVerified"] == 9
    for source in official:
        assert digest(root / source["path"]) == source["sha256"] == source["expectedSha256"]
    assert sources["JX-LOCAL"]["cellMatrixEqualToOfficial"] == "JX-DRUG-20250930"
    assert not sources["JX-LOCAL"]["binaryEqualToOfficial"]
    assert sources["GD-LOCAL"]["binaryEqualToOfficial"]
    previous = root / "review/round-2-checksums.json"
    assert digest(previous) == summary["previousChecksumsSha256"]
    for entry in load(previous):
        if entry["path"].startswith(("standardized/", "raw/", "review/")):
            assert digest(root / entry["path"]) == entry["sha256"], entry["path"]
    primary = ["icd10/records", "icd9/records", "services/records", "drugs/records", "drg/groups"]
    expected = {(table, r["id"]) for table in primary for r in rows(root / "standardized" / (table + ".jsonl"))}
    prices = []
    for table, count in [("prices/jiangxi-drugs", 1974), ("prices/guangdong-drugs", 78), ("prices/cardiovascular", 231)]:
        records = list(rows(root / "standardized" / (table + ".jsonl")))
        assert len(records) == count == summary["counts"][table]
        for r in records:
            assert isinstance(r["productCode"], str) or r["productCode"] is None
            assert isinstance(r["price"]["amount"], str) and Decimal(r["price"]["amount"]) >= 0
            assert r["hospitalMapping"]["state"] == "待补全"
            assert all(r["hospitalMapping"][field] is None for field in ["hospitalProductId", "chargePrice", "procurementCost", "unitConversion"])
            assert r["currentPriceUse"]["label"] in ["待核实", "不可作当前价"]
            assert not r["runtimeEnabled"]
            if table == "prices/jiangxi-drugs":
                assert r["price"]["unit"] is None and r["price"]["basis"] == "denominator_unverified"
            if table == "prices/cardiovascular":
                assert r["specification"] is None
                if r["source"]["sourceId"] == "HN-PACING-2026":
                    assert r["registrant"] and r["price"]["unit"] in ["台", "根"]
                    assert Decimal(str(r["originalSourceRow"][8])) == Decimal(r["price"]["amount"])
                if r["productCode"] and len(r["productCode"]) == 20:
                    assert r["codeSystem"] == "source_consumable_20_character_code"
        prices.extend(records)
        expected.update((table, r["id"]) for r in records)
    expected.update(("review/procedure-code-review", r["code"]) for r in load(root / "review/procedure-code-review.json")["records"])
    readiness = list(rows(root / "standardized/assessment/record-readiness.jsonl"))
    assert len(readiness) == len(expected) == summary["counts"]["assessment/record-readiness"]
    assert {(r["table"], r["recordId"]) for r in readiness} == expected
    assert sum(r.get("clinicalGroupingUse") == "暂不可用（隔离）" for r in readiness) == 1
    assert sum(r.get("sourcePriceUse") == "待补全" for r in readiness) == 72
    assert sum(r["table"] == "services/records" and "来源计价单位" in r.get("missingFields", []) for r in readiness) == 22
    assert sum(not r["price"]["unit"] for r in prices) == summary["sourcePricesMissingUnit"]
    assert sum(r["currentPriceUse"]["label"] == "不可作当前价" for r in prices) == summary["supersededCurrentPrices"] == 16
    assert summary["confirmedHospitalMappings"] == 0 and len(prices) == summary["priceRecords"] == 2283
    corrections = list(rows(root / "review/price-source-corrections.jsonl"))
    assert dict(collections.Counter(r["reviewStatus"] for r in corrections)) == summary["priceTextReviewOutcomes"] == {
        "pending_source_layout": 6, "resolved_official_pdf_cell": 5}
    cardio = [r for r in prices if r["source"]["sourceId"] in ["HN-PACING-2026", "TJ2023-1", "TJ2023-2", "TJ2023-3", "TJ2023-4", "ZJ-STENT-1", "ZJ-STENT-2"]]
    assert sum(r["declaringEnterprise"] is None for r in cardio) == 5
    assert sum(bool(r["candidateProductCodes"]) and r["productCode"] is None for r in cardio) == 1
    assert sum(bool(r.get("sourceReviewFlags")) for r in readiness) == 6
    return {"priceRecords": len(prices), "readinessRecords": len(readiness), "officialSourceFiles": len(official)}


def verify(root):
    checked = 0
    for entry in load(root / "checksums.json"):
        path = (root / entry["path"]).resolve()
        assert path.is_relative_to(root.resolve()), entry
        assert path.stat().st_size == entry["bytes"], entry["path"]
        assert digest(path) == entry["sha256"], entry["path"]
        checked += 1
    manifest = load(root / "release-candidate.json")
    assert manifest["runtimeEnabled"] is False
    assert manifest["status"] == "prepared_not_published"
    assert manifest["runtimeImporter"] == "not_implemented"
    external_hashes = {}
    for table, count in manifest["tables"].items():
        data = list(rows(root / "standardized" / (table + ".jsonl")))
        assert len(data) == count, table
        ids = [r["id"] for r in data if "id" in r]
        assert len(ids) == len(set(ids)), f"Duplicate row identity: {table}"
        for r in data:
            assert not r.get("runtimeEnabled"), table
            if "source" in r:
                source = r["source"]
                if source.get("kind") == "official_online_dictionary":
                    assert source["url"].startswith("https://code.nhsa.gov.cn/")
                    path = (root / source["snapshotPath"]).resolve()
                    assert path.is_relative_to(root.resolve()) and digest(path) == source["sha256"]
                elif source.get("kind") == "external_price_file":
                    path = (root / source["path"]).resolve()
                    assert path.is_relative_to(root.resolve())
                    if path not in external_hashes:
                        external_hashes[path] = digest(path)
                    assert external_hashes[path] == source["sha256"]
                    assert source.get("worksheet") or source.get("pdfPage")
                else:
                    assert source["sourceFile"]
                    assert 1 <= source["pdfPage"] <= manifest["sources"][table.split("/")[0]]["pages"]
    correction_count = 0
    for dataset, code_key, expected in [("icd10", "diagnosis_code", 34226), ("icd9", "procedure_code", 13687)]:
        data = list(rows(root / "standardized" / dataset / "records.jsonl"))
        by_id = {r["id"]: r for r in data}
        assert len(data) == expected
        node_ids = {r["id"] for r in rows(root / "standardized" / dataset / "hierarchy.jsonl")}
        for r in data:
            assert r["parentId"] in node_ids or r["parentId"] is None
            assert r["code"] is None or isinstance(r["code"], str)
            if r["eligibleReferenceCandidate"]:
                assert r["kind"] == "leaf" and not r["reviewFlags"]
                assert r["reviewStatus"] == "verified_pdf_text"
            if r["kind"] == "hierarchy_only":
                assert not r["code"] and not r["eligibleReferenceCandidate"]
        for c in rows(root / "review" / "corrections.jsonl"):
            if c["dataset"] != dataset:
                continue
            r = by_id[c["recordId"]]
            assert r["rawFields"][c["field"]] == c["originalValue"]
            assert r["fields"][c["field"]] == c["correctedValue"]
            assert c["basis"]["pdfSha256"] == manifest["sources"][dataset]["pdfSha256"]
            assert c["humanReviewed"] is False
            correction_count += 1
    groups = list(rows(root / "standardized/drg/groups.jsonl"))
    assert collections.Counter(r["level"] for r in groups) == {"MDC": 26, "ADRG": 492, "DRG": 825}
    group_ids = {r["code"] for r in groups}
    assert all(r["parentCode"] is None or r["parentCode"] in group_ids for r in groups)
    empty_pages = load(root / "reports/drg-empty-pages.json")
    assert len(empty_pages) == 19 and all(r["pdfHasBodyText"] for r in empty_pages)
    for r in rows(root / "standardized/drugs/records.jsonl"):
        assert r["nhsaProductCode"] is None
        p = r["paymentStandard"]
        if p["state"] in ["unknown", "confidential"]:
            assert p["amount"] is None
        if p["state"] == "confidential":
            assert p["raw"] == "*"
    coverage = list(rows(root / "reports/page-coverage.jsonl"))
    assert len(coverage) == sum(s["pages"] for s in manifest["sources"].values())
    quality = load(root / "reports/quality-report.json")
    all_corrections = list(rows(root / "review" / "corrections.jsonl"))
    drug_by_id = {r["id"]: r for r in rows(root / "standardized/drugs/records.jsonl")}
    service_by_id = {r["id"]: r for r in rows(root / "standardized/services/records.jsonl")}
    for c in all_corrections:
        if c["dataset"] == "drugs":
            r = drug_by_id[c["recordId"]]
            assert r["rawFields"][c["field"]] == c["originalValue"]
            assert r[c["field"]] == c["correctedValue"]
            assert c["basis"]["pdfSha256"] == manifest["sources"]["drugs"]["pdfSha256"]
        if c["dataset"] == "services":
            r = service_by_id[c["recordId"]]
            assert r["preReconciliationFields"][c["field"]] == c["originalValue"]
            assert r["fields"][c["field"]] == c["correctedValue"]
            assert c["basis"]["pdfSha256"] == manifest["sources"]["services"]["pdfSha256"]
    assert quality["corrections"] == len(all_corrections)
    result = {"result": "passed", "hashedFiles": checked, "verifiedPages": len(coverage),
              "verifiedCorrectionFields": len(all_corrections), "runtimeEnabled": False}
    if (root / "reports/round-2-review.json").exists():
        result["verifiedRound2Reviews"] = verify_review(root, manifest)
    if (root / "reports/round-3-data-status.json").exists():
        result["verifiedEnrichment"] = verify_enrichment(root, manifest)
    print(json.dumps(result))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    verify(parser.parse_args().directory.resolve())
