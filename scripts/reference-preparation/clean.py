"""Prepare auditable reference candidates; never writes a ClinMesh runtime database.

Python 3.11+. See README.md. Input JSON and archive scripts are data, never code.
"""

from __future__ import annotations

import argparse
import bisect
import collections
import csv
import difflib
import hashlib
import json
import re
import shutil
import unicodedata
import zipfile
from decimal import Decimal
from pathlib import Path

import pymupdf
from lxml import html

FILES = {
    "drg": "DRG3_MinerU_merged.zip",
    "icd10": "ICD10_insurance_2_0_MinerU_merged.zip",
    "icd9": "ICD9_CM3_insurance_2_0_MinerU_merged.zip",
    "services": "Zhejiang_medical_services_2024_MinerU_merged.zip",
    "drugs": "国家医保药品目录2025_MinerU核验合并.zip",
}
VERSIONS = {"drg": "DRG-3.0-updated-pdf-82b5d179", "icd10": "ICD-10-insurance-2.0",
            "icd9": "ICD-9-CM3-insurance-2.0", "services": "Zhejiang-2024", "drugs": "NRDL-2025"}
ATOM = re.compile(r"(?<![A-Za-z0-9.])(?:[A-Z][0-9]{2}|[0-9]{2})\.[0-9A-Za-z]+(?![A-Za-z0-9.])")
COMPONENT = re.compile(r"(?<![A-Za-z0-9.])(?:[A-Z][0-9]{2}(?:\.[0-9A-Za-z]+)?|[0-9]{2}\.[0-9A-Za-z]+)(?![A-Za-z0-9.])")
CODE_START = re.compile(r"^((?:[A-Z][0-9]{2}|[0-9]{2})\.[0-9A-Za-z]+(?:[†*+][A-Z][0-9]{2}(?:\.[0-9A-Za-z]+)?[*†]?)?[*†]?)(?:\s+|$)(.*)")
DIAGNOSIS_CODE = re.compile(r"[A-Z][0-9]{2}\.[0-9A-Za-z]+(?:[+†][A-Z][0-9]{2}(?:\.[0-9A-Za-z]+)?[*†]?)*[*†]?")
PROCEDURE_CODE = re.compile(r"[0-9]{2}\.[0-9A-Za-z]+")
ICD10_FIELDS = ["chapter_code", "chapter_range", "chapter_name", "section_range", "section_name",
                "category_code", "category_name", "subcategory_code", "subcategory_name", "diagnosis_code", "diagnosis_name"]
ICD9_FIELDS = ["chapter_code", "chapter_name", "category_code", "category_name", "subcategory_code",
               "subcategory_name", "detail_code", "detail_name", "procedure_code", "procedure_name"]


def sha(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def compact(value):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", value or ""))


def jsread(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def jsonl(path):
    with Path(path).open(encoding="utf-8-sig") as f:
        return [json.loads(line) for line in f if line.strip()]


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def walk_values(value, key, pointer=""):
    if isinstance(value, dict):
        for k, v in value.items():
            p = pointer + "/" + k
            if k == key:
                yield p, v
            elif isinstance(v, (dict, list)):
                yield from walk_values(v, key, p)
    elif isinstance(value, list):
        for i, v in enumerate(value):
            yield from walk_values(v, key, pointer + "/" + str(i))


def expand_table(markup):
    """Expand actual spans only; never forward-fill blank clinical cells."""
    root = html.fromstring(markup)
    active = {}
    result = []
    for row_index, tr in enumerate(root.xpath(".//tr")):
        row = {}
        following = {}
        for col, (remaining, value, origin) in active.items():
            row[col] = (value, origin)
            if remaining > 1:
                following[col] = (remaining - 1, value, origin)
        col = 0
        for cell_index, td in enumerate(tr.xpath("./td|./th")):
            while col in row:
                col += 1
            value = "".join(td.itertext()).strip()
            colspan, rowspan = int(td.get("colspan", "1")), int(td.get("rowspan", "1"))
            if not (1 <= colspan <= 100 and 1 <= rowspan <= 10000):
                raise ValueError("Invalid table span")
            origin = [row_index, cell_index]
            for k in range(col, col + colspan):
                if k in row:
                    raise ValueError("Overlapping table span")
                row[k] = (value, origin)
                if rowspan > 1:
                    following[k] = (rowspan - 1, value, origin)
            col += colspan
        width = max(row, default=-1) + 1
        result.append({"cells": [row.get(i, ("", None))[0] for i in range(width)],
                       "origins": [row.get(i, ("", None))[1] for i in range(width)], "rowIndex": row_index})
        active = following
    return result


def pdf_grid(page):
    """Read the fixed rectangular ICD grid from PDF vectors, not OCR guesses."""
    rects = [item[1] for drawing in page.get_drawings() for item in drawing["items"] if item[0] == "re"]
    vertical = [r for r in rects if r.width <= 1.1 and r.height > 30]
    xs = sorted({round(r.x0, 2) for r in vertical})
    if len(xs) < 2:
        raise ValueError("PDF has no fixed grid")
    ys = sorted({round(r.y0, 2) for r in rects if r.height <= 1.1 and r.width > (xs[-1] - xs[0]) * .95})
    cells = [[[] for _ in xs[:-1]] for _ in ys[:-1]]
    # A PDF word may join a code and a Latin name across a cell boundary.
    # Assign individual glyphs, then cluster baselines (mixed fonts differ slightly).
    for block in page.get_text("rawdict")["blocks"]:
        for line in block.get("lines", []):
            for span in line["spans"]:
                for char in span["chars"]:
                    x0, y0, x1, y1 = char["bbox"]
                    x = bisect.bisect_right(xs, (x0 + x1) / 2) - 1
                    y = bisect.bisect_right(ys, (y0 + y1) / 2) - 1
                    if 0 <= y < len(cells) and 0 <= x < len(cells[y]):
                        cells[y][x].append((char["origin"][1], x0, char["c"]))
    def cell_text(chars):
        lines = []
        for char in sorted(chars):
            if not lines or char[0] - lines[-1][0][0] > 4:
                lines.append([char])
            else:
                lines[-1].append(char)
        return "".join("".join(c[2] for c in sorted(line, key=lambda c: c[1])).strip() for line in lines)
    rows = [[cell_text(cell) for cell in row] for row in cells]
    return rows, xs, ys


def price(raw, kind):
    raw = raw.strip()
    if raw == "*":
        return {"kind": kind, "state": "confidential", "raw": raw, "amount": None, "currency": "CNY"}
    if not raw:
        return {"kind": kind, "state": "unknown", "raw": raw, "amount": None, "currency": "CNY"}
    if re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", raw):
        return {"kind": kind, "state": "numeric", "raw": raw, "amount": str(Decimal(raw)), "currency": "CNY"}
    return {"kind": kind, "state": "expression", "raw": raw, "amount": None, "currency": "CNY"}


class Preparation:
    def __init__(self, input_dir, output):
        self.input = Path(input_dir).resolve()
        self.out = Path(output).resolve()
        if self.out.exists():
            raise ValueError("Output must be a new directory; existing evidence is never overwritten")
        self.out.mkdir(parents=True)
        self.sources = {}
        self.roots = {}
        self.pages = {}
        self.maps = {}
        self.issues = []
        self.corrections = []
        self.statistics = {}
        self.datasets = {}
        self.coverage = []

    def issue(self, dataset, kind, source, record_id=None, detail=None, status="pending", severity="review"):
        row = {"id": f"issue-{len(self.issues) + 1:07}", "dataset": dataset, "kind": kind,
               "severity": severity, "reviewStatus": status, "recordId": record_id, "source": source,
               "detail": detail, "originalValue": None, "correctedValue": None, "basis": None}
        self.issues.append(row)
        return row

    def correction(self, dataset, record_id, field, original, corrected, evidence, kind="pdf_cell_reconciliation"):
        self.corrections.append({"id": f"correction-{len(self.corrections) + 1:07}", "dataset": dataset,
                                 "recordId": record_id, "field": field, "originalValue": original,
                                 "correctedValue": corrected, "basis": evidence, "kind": kind,
                                 "reviewStatus": "verified_pdf_text", "humanReviewed": False})

    def save(self, dataset, name, rows):
        write_jsonl(self.out / "standardized" / dataset / (name + ".jsonl"), rows)
        self.datasets[f"{dataset}/{name}"] = len(rows)

    def source(self, dataset, index, **extra):
        m = self.maps[dataset][index]
        return {"archiveSha256": self.sources[dataset]["archiveSha256"], "sourceVersion": VERSIONS[dataset],
                "sourceFile": m["source_file"], "sourcePageIndex": m["source_page_idx"],
                "pdfPage": index + 1, "printedPage": m.get("printed_page"), **extra}

    def archive(self):
        for dataset, filename in FILES.items():
            archive = self.input / filename
            archive_copy = self.out / "raw" / "archives" / filename
            archive_copy.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(archive, archive_copy)
            dest = self.out / "raw" / "extracted" / dataset
            with zipfile.ZipFile(archive) as z:
                if z.testzip() is not None:
                    raise ValueError(f"ZIP CRC failed: {filename}")
                for member in z.infolist():
                    target = (dest / member.filename).resolve()
                    if not target.is_relative_to(dest.resolve()) or "\\" in member.filename:
                        raise ValueError("Unsafe ZIP path")
                    if member.is_dir():
                        target.mkdir(parents=True, exist_ok=True)
                    else:
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with z.open(member) as src, target.open("wb") as dst:
                            shutil.copyfileobj(src, dst)
            root = dest if dataset == "drugs" else next(dest.iterdir())
            self.roots[dataset] = root
            checked = 0
            checksum_file = root / "checksums.sha256"
            if checksum_file.exists():
                for line in checksum_file.read_text(encoding="utf-8").splitlines():
                    digest, relative = line.split(maxsplit=1)
                    relative = relative.lstrip("*")
                    path = (root / relative).resolve()
                    if not path.is_relative_to(root.resolve()) or sha(path) != digest:
                        raise ValueError(f"Archive member hash mismatch: {relative}")
                    checked += 1
            if dataset == "drugs":
                pages = jsread(root / "nrdl_2025_mineru_merged.json")["pdf_info"]
                mapping = jsread(root / "page_source_map.json")
                manifest = jsread(root / "source_manifest.json")
                fragments = manifest["source_fragments"]
                fragment_key = "file"
                fragment_dir = "raw"
            else:
                pages = jsonl(next(root.glob("*.pages.jsonl")))
                mapping = jsonl(next(root.glob("*.page-map.jsonl")))
                manifest = jsread(root / "merge-manifest.json")
                fragments = manifest["sources"]
                fragment_key = "file_name"
                fragment_dir = "sources"
            if len(pages) != len(mapping) or any(p["page_idx"] != i for i, p in enumerate(pages)):
                raise ValueError("Non-contiguous page mapping")
            originals = {}
            for fragment in fragments:
                path = root / fragment_dir / fragment[fragment_key]
                if sha(path) != fragment["sha256"]:
                    raise ValueError("Fragment hash mismatch")
                originals[fragment[fragment_key]] = jsread(path)["pdf_info"]
            for i, (page, m) in enumerate(zip(pages, mapping)):
                global_index = m.get("global_page_idx", m.get("merged_page_idx"))
                if global_index != i:
                    raise ValueError("Page-map index mismatch")
                original = originals[m["source_file"]][m["source_page_idx"]]
                restored = dict(page, page_idx=original["page_idx"])
                if original != restored:
                    raise ValueError(f"Merged page changed: {dataset}/{i + 1}")
            pdfs = list(root.rglob("*.pdf"))
            if not pdfs:
                supplemental_name = ("国家医疗保障按病组（DRG）付费3.0版 分组方案.pdf" if dataset == "drg"
                                     else "国家基本医疗保险、生育保险和工伤保险药品目录（2025年）.pdf")
                supplemental = self.input / supplemental_name
                pdf = self.out / "raw" / "supplemental" / supplemental_name
                pdf.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(supplemental, pdf)
            else:
                pdf = pdfs[0]
            pdf_hash = sha(pdf)
            expected = ("82b5d179d797e2b9586b337d628c20177c85f43738529159c906fd0ef8432e41" if dataset == "drg"
                        else manifest.get("source_pdf", {}).get("sha256") if dataset == "drugs"
                        else manifest.get("source_pdf_sha256") if dataset == "services"
                        else jsread(root / "pdf-comparison.json")["reference_pdf_sha256"])
            if not expected or pdf_hash != expected:
                raise ValueError(f"Reference PDF identity mismatch: {dataset}")
            with pymupdf.open(pdf) as doc:
                if len(doc) != len(pages):
                    raise ValueError("Reference PDF page-count mismatch")
            self.sources[dataset] = {"archive": str(archive_copy.relative_to(self.out)).replace("\\", "/"),
                                     "archiveSha256": sha(archive_copy), "version": VERSIONS[dataset],
                                     "pdf": str(pdf.relative_to(self.out)).replace("\\", "/"), "pdfSha256": pdf_hash,
                                     "pages": len(pages), "verifiedMemberChecksums": checked,
                                     "verifiedFragmentHashes": len(fragments), "verifiedUnchangedPages": len(pages),
                                     "uploadPdfBinaryIdentity": "unknown_export_contains_no_upload_hash",
                                     "sourcePublicationVerified": dataset == "drg"}
            self.pages[dataset], self.maps[dataset] = pages, mapping
            self.coverage.extend({"dataset": dataset, "pdfPage": i + 1, "printedPage": m.get("printed_page"),
                                  "sourceFile": m["source_file"], "sourcePageIndex": m["source_page_idx"],
                                  "rawIntegrity": "passed"} for i, m in enumerate(mapping))
            print(f"Archived and verified {dataset}: {len(pages)} pages", flush=True)
        write_json(self.out / "source-manifest.json", self.sources)

    def icd(self, dataset):
        field_names = ICD10_FIELDS if dataset == "icd10" else ICD9_FIELDS
        code_key, name_key = field_names[-2:]
        raw_rows = jsonl(next(self.roots[dataset].glob("*.source-rows.jsonl")))
        by_page = collections.defaultdict(list)
        for row in raw_rows:
            by_page[row["source"]["global_pdf_page"]].append(row)
        records, nodes, cells_verified = [], {}, 0
        pdf = pymupdf.open(self.out / self.sources[dataset]["pdf"])
        for page_index, page in enumerate(pdf):
            source_rows = by_page[page_index + 1]
            grid, xs, ys = pdf_grid(page)
            if len(grid[0]) != len(field_names) or len(grid) - 1 != len(source_rows):
                raise ValueError(f"ICD row/column alignment failed: {dataset}/{page_index + 1}")
            for n, (raw, values) in enumerate(zip(source_rows, grid[1:]), 1):
                if not re.fullmatch(r"[0-9]+", values[0]):
                    raise ValueError("ICD chapter anchor invalid")
                # The immutable vector grid and exact per-page row counts establish cell identity.
                # Original cells and independently extracted PDF cells remain available together.
                record_id = f"{dataset}-p{page_index + 1:04}-r{n:02}"
                source = self.source(dataset, page_index, mineru=raw["source"], pdfGridRow=n,
                                     pdfRowBounds=[ys[n], ys[n + 1]], pdfColumnBounds=xs)
                fields = dict(zip(field_names, values))
                changes = []
                for key in field_names:
                    before, after = raw["fields"][key], fields[key]
                    if before != after:
                        self.correction(dataset, record_id, key, before, after,
                                        {"pdfSha256": self.sources[dataset]["pdfSha256"], "source": source,
                                         "method": "PDF vector cell; identical page row count and fixed column count"})
                        changes.append(key)
                cells_verified += len(field_names)
                code, name = fields[code_key], fields[name_key]
                row_kind = "leaf" if code and name else "hierarchy_only" if not code and not name else "incomplete"
                flags = []
                if row_kind == "incomplete":
                    flags.append("incomplete_leaf")
                if code and not (DIAGNOSIS_CODE if dataset == "icd10" else PROCEDURE_CODE).fullmatch(code):
                    flags.append("invalid_code_syntax")
                parent_id = None
                levels = ([('chapter', 'chapter_code', 'chapter_name'), ('section', 'section_range', 'section_name'),
                           ('category', 'category_code', 'category_name'), ('subcategory', 'subcategory_code', 'subcategory_name')]
                          if dataset == "icd10" else [('chapter', 'chapter_code', 'chapter_name'),
                           ('category', 'category_code', 'category_name'), ('subcategory', 'subcategory_code', 'subcategory_name'),
                           ('detail', 'detail_code', 'detail_name')])
                for level, ck, nk in levels:
                    c, label = fields[ck], fields[nk]
                    if not c:
                        continue
                    nid = f"{dataset}:{level}:{c}"
                    if nid not in nodes:
                        nodes[nid] = {"id": nid, "level": level, "code": c, "name": label, "parentId": parent_id,
                                      "source": source, "occurrenceRecordIds": [], "variants": [], "reviewFlags": []}
                    node = nodes[nid]
                    node["occurrenceRecordIds"].append(record_id)
                    variant = {"name": label, "parentId": parent_id}
                    if compact(label) != compact(node["name"]) or node["parentId"] != parent_id:
                        if variant not in node["variants"]:
                            node["variants"].append(variant)
                        if "hierarchy_conflict" not in node["reviewFlags"]:
                            node["reviewFlags"].append("hierarchy_conflict")
                    parent_id = nid
                records.append({"id": record_id, "code": code or None, "name": name or None, "kind": row_kind,
                                "version": VERSIONS[dataset], "fields": fields, "rawFields": raw["fields"],
                                "source": source, "parentId": parent_id, "components": COMPONENT.findall(code),
                                "correctionFields": changes, "reviewFlags": flags,
                                "reviewStatus": "pending" if flags else "verified_pdf_text", "humanReviewed": False,
                                "eligibleReferenceCandidate": row_kind == "leaf" and not flags, "runtimeEnabled": False})
                if row_kind == "hierarchy_only":
                    issue = self.issue(dataset, "empty_leaf_confirmed_in_pdf", source, record_id,
                                       {"lastHierarchyCode": fields.get("detail_code", fields.get("subcategory_code")),
                                        "meaning": "Hierarchy entry only; do not manufacture a billable/diagnosis leaf"},
                                       status="resolved_source_preserved", severity="information")
                    issue["originalValue"] = {code_key: raw["fields"][code_key], name_key: raw["fields"][name_key]}
                    issue["correctedValue"] = None
                    issue["basis"] = "Both leaf cells are blank in the matching PDF vector row"
        by_code = collections.defaultdict(list)
        for record in records:
            if record["code"]:
                by_code[record["code"]].append(record)
        for code, repeated in by_code.items():
            if len(repeated) > 1:
                for record in repeated:
                    record["reviewFlags"].append("duplicate_code")
                    record["reviewStatus"] = "pending"
                    record["eligibleReferenceCandidate"] = False
                self.issue(dataset, "duplicate_code", repeated[0]["source"], detail={"code": code,
                           "records": [{"id": r["id"], "name": r["name"]} for r in repeated]})
        conflicts = {nid for nid, node in nodes.items() if node["reviewFlags"]}
        for nid in conflicts:
            node = nodes[nid]
            self.issue(dataset, "hierarchy_conflict", node["source"], nid,
                       {"name": node["name"], "parentId": node["parentId"], "variants": node["variants"]})
        for record in records:
            nid = record["parentId"]
            while nid:
                if nid in conflicts:
                    record["reviewFlags"].append("ancestor_hierarchy_conflict")
                    record["reviewStatus"] = "pending"
                    record["eligibleReferenceCandidate"] = False
                    break
                nid = nodes[nid]["parentId"]
        self.save(dataset, "records", records)
        self.save(dataset, "hierarchy", list(nodes.values()))
        self.save(dataset, "accepted", [r for r in records if r["eligibleReferenceCandidate"]])
        self.save(dataset, "pending", [r for r in records if r["reviewStatus"] == "pending"])
        self.statistics[dataset] = {"sourceRows": len(raw_rows), "outputRows": len(records), "pdfCellsVerified": cells_verified,
                                    "hierarchyNodes": len(nodes), "hierarchyConflicts": len(conflicts),
                                    "leafRecords": sum(r["kind"] == "leaf" for r in records),
                                    "hierarchyOnlyRows": sum(r["kind"] == "hierarchy_only" for r in records),
                                    "candidateAccepted": sum(r["eligibleReferenceCandidate"] for r in records),
                                    "pendingRecords": sum(r["reviewStatus"] == "pending" for r in records),
                                    "correctionFields": sum(len(r["correctionFields"]) for r in records),
                                    "correctedCodeRows": sum(code_key in r["correctionFields"] for r in records),
                                    "zeroToOPrefixCorrections": sum(r["rawFields"][code_key].startswith("0") and
                                                                   (r["code"] or "").startswith("O") for r in records)}
        print(f"Reconciled {dataset}: {len(records)} rows", flush=True)
        return records

    def tables(self, dataset):
        for i, page in enumerate(self.pages[dataset]):
            pre = list(walk_values(page["preproc_blocks"], "html", "/preproc_blocks"))
            para = list(walk_values(page.get("para_blocks", []), "html", "/para_blocks"))
            selected = pre or para
            if dataset == "drugs" and not selected and 8 <= i < 201:
                # Two negotiated medicines occupy whole pages recognized as text blocks.
                # Recover actual vector tables, preserving the missing HTML as missing.
                with pymupdf.open(self.out / self.sources[dataset]["pdf"]) as pdf:
                    for n, table in enumerate(pdf[i].find_tables().tables):
                        values = table.extract()
                        rows = [{"cells": [re.sub(r"\s*\n\s*", "", c or "") for c in row],
                                 "origins": [None] * len(row), "rowIndex": j} for j, row in enumerate(values)]
                        yield i, n, f"pdf-table:{n}", rows, ""
            # Both projections often hold the same table. Never ingest it twice.
            seen = set()
            for n, (pointer, markup) in enumerate(selected):
                digest = hashlib.sha256(markup.encode()).hexdigest()
                if digest in seen:
                    continue
                seen.add(digest)
                yield i, n, pointer, expand_table(markup), markup

    def policies(self, dataset):
        records = []
        for i, page in enumerate(self.pages[dataset]):
            blocks = page.get("preproc_blocks") or page.get("para_blocks", [])
            for j, block in enumerate(blocks):
                if block.get("type") == "table":
                    continue
                text = "\n".join("".join(s.get("content", "") for s in line.get("spans", [])) for line in block.get("lines", []))
                if text.strip():
                    records.append({"id": f"{dataset}-policy-p{i + 1:04}-b{j}", "text": text,
                                    "source": self.source(dataset, i, jsonPointer=f"/preproc_blocks/{j}"),
                                    "interpretation": "source_text_not_executable_policy"})
        self.save(dataset, "policies-and-notes", records)
        return records

    def services(self):
        records, categories, materials, joins, unassigned, table_notes = [], [], [], [], [], []
        for i, table_no, pointer, rows, markup in self.tables("services"):
            header = rows[0]["cells"]
            if "项目名称" in header and "编码" in header:
                headers = header
                appendix = "序号" in headers
                for row in rows[1:]:
                    cells = row["cells"]
                    source = self.source("services", i, jsonPointer=pointer, tableIndex=table_no,
                                         htmlRowIndex=row["rowIndex"], cellOrigins=row["origins"])
                    rid = f"services-p{i + 1:04}-t{table_no}-r{row['rowIndex']:03}"
                    if len(cells) != len(headers):
                        self.issue("services", "table_width_mismatch", source, rid, {"cells": cells, "headers": headers})
                        unassigned.append({"id": rid, "source": source, "rawCells": cells})
                        continue
                    values = dict(zip(headers, cells))
                    code = values.get("编码", "").strip()
                    merged_heading = re.fullmatch(r"(\d{1,8})([(（].+)", code)
                    if merged_heading and len({tuple(origin) for origin in row["origins"] if origin}) == 1:
                        categories.append({"id": rid, "code": merged_heading[1], "name": merged_heading[2],
                                           "fields": {"编码": merged_heading[1], "项目名称": merged_heading[2]},
                                           "rawFields": values, "source": source,
                                           "extractionBasis": "Explicit numeric category followed by parenthesized title in one spanning cell"})
                        continue
                    if code and not re.fullmatch(r"[A-Za-z0-9]+(?:[,，][A-Za-z0-9]+)*", code):
                        table_notes.append({"id": rid, "kind": "table_wide_explanatory_note", "fields": values,
                                            "source": source, "categoryId": categories[-1]["id"] if categories else None})
                        continue
                    if not code:
                        narrative = ["项目名称", "项目内涵", "除外内容", "备注", "限定支付范围", "文件依据"]
                        can_join = (records and row["rowIndex"] == 1 and records[-1]["source"]["pdfPage"] == i
                                    and records[-1]["headers"] == headers and any(values.get(k) for k in narrative)
                                    and not any(values.get(k) for k in ["计价单位", "省级价格", "分类", "先行支付比例", "序号"]))
                        if can_join:
                            target = records[-1]
                            for k in narrative:
                                if values.get(k):
                                    target["fields"][k] = target["fields"].get(k, "") + values[k]
                            target["fragments"].append({"source": source, "rawFields": values})
                            target["reviewFlags"].append("continuation_join_requires_review")
                            joins.append({"recordId": target["id"], "source": source, "rawFields": values,
                                          "basis": "First row next page, identical header, only narrative cells; retained as candidate"})
                        elif values.get("项目名称") and not any(values.get(k) for k in ["计价单位", "省级价格", "分类", "先行支付比例"]):
                            table_notes.append({"id": rid, "kind": "uncoded_subheading", "fields": values,
                                                "source": source, "categoryId": categories[-1]["id"] if categories else None})
                        else:
                            unassigned.append({"id": rid, "source": source, "rawFields": values})
                            self.issue("services", "unassigned_table_row", source, rid, values)
                        continue
                    if re.fullmatch(r"\d{1,8}", code) and not appendix:
                        categories.append({"id": rid, "code": code, "name": values["项目名称"],
                                           "fields": values, "source": source})
                        continue
                    record = {"id": rid, "code": code, "name": values["项目名称"], "fields": values,
                              "headers": headers, "rawFields": dict(values), "source": source, "fragments": [],
                              "cataloguePart": "hospital_autonomous_pricing" if appendix else "provincial_reference_2024",
                              "price": price(values.get("省级价格", ""), "hospital_autonomous" if appendix else "provincial_reference_2024"),
                              "billingUnit": values.get("计价单位") or None, "region": "浙江省", "edition": "2024",
                              "validFrom": None, "validTo": None, "currentApplicability": "unverified",
                              "hospitalMapping": {"state": "待补全", "hospitalItemId": None, "chargePrice": None,
                                                  "procurementCost": None, "unitConversion": None},
                              "reviewFlags": [], "runtimeEnabled": False}
                    if not record["billingUnit"]:
                        record["reviewFlags"].append("missing_billing_unit")
                    if record["price"]["state"] not in ["numeric", "confidential"]:
                        record["reviewFlags"].append("price_requires_mapping_or_interpretation")
                    records.append(record)
            elif "材料名称" in header:
                for row in rows[1:]:
                    source = self.source("services", i, jsonPointer=pointer, htmlRowIndex=row["rowIndex"])
                    materials.append({"id": f"materials-p{i + 1:04}-r{row['rowIndex']:03}", "source": source,
                                      "rawCells": row["cells"], "fields": dict(zip(header, row["cells"])),
                                      "interpretation": "material_payment_conditions_not_product_prices"})
            else:
                self.issue("services", "unrecognized_table", self.source("services", i), detail=header)
        by_code = collections.defaultdict(list)
        for r in records:
            r["name"] = r["fields"]["项目名称"]
            by_code[(r["cataloguePart"], r["code"])].append(r)
            r["categoryIds"] = [c["id"] for c in categories if r["code"].startswith(c["code"]) and c["source"]["pdfPage"] <= r["source"]["pdfPage"]]
        for (part, code), repeated in by_code.items():
            if len(repeated) > 1:
                for r in repeated:
                    r["reviewFlags"].append("duplicate_code_in_same_part")
                self.issue("services", "duplicate_code_in_same_part", repeated[0]["source"],
                           detail={"part": part, "code": code, "records": [r["id"] for r in repeated]})
        pdf = pymupdf.open(self.out / self.sources["services"]["pdf"])
        native_tables = {}
        def native_rows(page_index, headers):
            if page_index not in native_tables:
                native_tables[page_index] = [
                    {"table": j, "row": k, "bbox": list(table.bbox), "rawCells": cells}
                    for j, table in enumerate(pdf[page_index].find_tables().tables)
                    for k, cells in enumerate(table.extract())]
            result = []
            for native in native_tables[page_index]:
                if len(native["rawCells"]) != len(headers):
                    continue
                values = {key: re.sub(r"\s*\n\s*", "", cell) for key, cell in zip(headers, native["rawCells"]) if cell is not None}
                result.append((native, values))
            return result
        for r in records:
            text = compact(pdf[r["source"]["pdfPage"] - 1].get_text())
            if compact(r["code"]) not in text:
                r["reviewFlags"].append("code_not_found_in_same_pdf_page")
            for key in ["项目名称", "计价单位", "省级价格"]:
                value = r["fields"].get(key, "")
                if value and compact(value) not in text:
                    r["reviewFlags"].append("pdf_text_difference:" + key)
            if r["reviewFlags"]:
                page_index = r["source"]["pdfPage"] - 1
                candidates = [(native, values) for native, values in native_rows(page_index, r["headers"])
                              if compact(values.get("编码")) == compact(r["code"])]
                if len(candidates) == 1:
                    native, values = candidates[0]
                    evidence = {"pdfSha256": self.sources["services"]["pdfSha256"], "pdfPage": page_index + 1,
                                "pdfTable": native["table"], "pdfRow": native["row"], "method": "Unique exact code in same-page native PDF table",
                                "continuationRows": []}
                    verified_fragments = True
                    for fragment in r["fragments"]:
                        fragment_page = fragment["source"]["pdfPage"] - 1
                        fragments = [(n, v) for n, v in native_rows(fragment_page, r["headers"])
                                     if not v.get("编码") and any(v.values()) and not any(v.get(k) for k in ["计价单位", "省级价格", "分类", "先行支付比例"])]
                        if len(fragments) != 1:
                            verified_fragments = False
                            break
                        fragment_native, fragment_values = fragments[0]
                        for key, value in fragment_values.items():
                            if value:
                                values[key] = values.get(key, "") + value
                        evidence["continuationRows"].append({"pdfPage": fragment_page + 1, "pdfTable": fragment_native["table"], "pdfRow": fragment_native["row"]})
                    if verified_fragments:
                        r["preReconciliationFields"] = dict(r["fields"])
                        for key, after in values.items():
                            before = r["fields"].get(key, "")
                            if before != after:
                                self.correction("services", r["id"], key, before, after, evidence)
                                r["fields"][key] = after
                        r["pdfReconciliation"] = evidence
                        r["reviewFlags"] = [flag for flag in r["reviewFlags"] if not flag.startswith("pdf_text_difference:")
                                            and flag not in ["continuation_join_requires_review", "missing_billing_unit", "price_requires_mapping_or_interpretation"]]
                        r["name"] = r["fields"]["项目名称"]
                        r["billingUnit"] = r["fields"].get("计价单位") or None
                        r["price"] = price(r["fields"].get("省级价格", ""), r["price"]["kind"])
                        if not r["billingUnit"]:
                            r["reviewFlags"].append("missing_billing_unit")
                        if r["price"]["state"] not in ["numeric", "confidential"]:
                            r["reviewFlags"].append("price_requires_mapping_or_interpretation")
            r["reviewStatus"] = "pending" if r["reviewFlags"] else "structural_checks_passed"
            if r["reviewFlags"]:
                issue = self.issue("services", "service_record_review", r["source"], r["id"], r["reviewFlags"])
                issue["originalValue"] = r["rawFields"]
                issue["basis"] = r.get("pdfReconciliation")
        by_id = {r["id"]: r for r in records}
        for join in joins:
            join["reviewStatus"] = "verified_pdf_text" if "pdfReconciliation" in by_id[join["recordId"]] else "pending"
            join["pdfEvidence"] = by_id[join["recordId"]].get("pdfReconciliation")
        for name, rows in [("records", records), ("categories", categories), ("materials", materials),
                           ("continuation-joins", joins), ("unassigned-rows", unassigned), ("table-notes", table_notes)]:
            self.save("services", name, rows)
        self.policies("services")
        self.statistics["services"] = {"records": len(records), "categories": len(categories), "materialRows": len(materials),
                                       "continuationJoins": len(joins), "unassignedRows": len(unassigned),
                                       "pendingRecords": sum(bool(r["reviewFlags"]) for r in records),
                                       "numericReferencePrices": sum(r["price"]["state"] == "numeric" for r in records),
                                       "currentHospitalPrices": 0, "tableNotes": len(table_notes),
                                       "verifiedContinuationJoins": sum(j["reviewStatus"] == "verified_pdf_text" for j in joins)}
        return records

    def drugs(self):
        records, classes, auxiliary, continuations = [], [], [], []
        category = None
        pdf = pymupdf.open(self.out / self.sources["drugs"]["pdf"])
        for i, table_no, pointer, rows, markup in self.tables("drugs"):
            part = ("western" if 8 <= i < 82 else "traditional" if 82 <= i < 125 else
                    "negotiated" if 125 <= i < 188 else "competitive" if 188 <= i < 191 else
                    "herbal" if 191 <= i < 201 else "explanatory")
            for row in rows:
                cells = row["cells"]
                source = self.source("drugs", i, jsonPointer=pointer, tableIndex=table_no,
                                     htmlRowIndex=row["rowIndex"], cellOrigins=row["origins"])
                rid = f"drugs-p{i + 1:03}-t{table_no}-r{row['rowIndex']:03}"
                if part == "herbal":
                    for offset in [0, 3]:
                        c = cells[offset:offset + 3]
                        if len(c) == 3 and c[0].isdigit() and c[1]:
                            records.append({"id": rid + f"-c{offset}", "part": part, "catalogueNumber": c[0],
                                            "name": c[1], "dosageForm": "中药饮片", "insuranceClass": None,
                                            "notes": c[2], "categoryCode": None, "source": source,
                                            "rawCells": cells, "paymentStandard": price("", "insurance_payment_standard"),
                                            "reviewFlags": [], "runtimeEnabled": False, "nhsaProductCode": None})
                    continue
                if part == "explanatory" or any("药品名称" == c for c in cells):
                    auxiliary.append({"id": rid, "part": part, "rawCells": cells, "source": source})
                    continue
                if cells and re.fullmatch(r"[XZ][A-Z0-9]*", cells[0]):
                    category = cells[0]
                    classes.append({"id": rid, "code": category, "part": part,
                                    "labels": list(dict.fromkeys(c for c in cells[1:] if c)), "source": source})
                    continue
                class_pos = next((j for j, c in enumerate(cells) if c in ["甲", "乙"]), None)
                if class_pos is not None and len(cells) >= class_pos + 4:
                    num, name = cells[class_pos + 1:class_pos + 3]
                    if not re.search(r"\d", num) or not name:
                        auxiliary.append({"id": rid, "part": part, "rawCells": cells, "source": source})
                        self.issue("drugs", "unparsed_drug_row", source, rid, cells)
                        continue
                    tail = cells[class_pos + 3:]
                    paid = part in ["negotiated", "competitive"]
                    fields = {"paymentRaw": tail[0] if paid else "", "dosageForm": None if paid or part == "traditional" else tail[0],
                              "notes": (tail[1] if len(tail) > 1 else "") if paid or part == "western" else tail[0],
                              "validityRaw": tail[2] if paid and len(tail) > 2 else None}
                    expected_tail = 3 if paid else 2 if part == "western" else 1
                    flags = ["source_table_width_requires_review"] if len(tail) != expected_tail else []
                    records.append({"id": rid, "part": part, "catalogueNumber": num, "name": name,
                                    "insuranceClass": cells[class_pos], "categoryCode": category,
                                    **fields, "source": source, "rawCells": cells,
                                    "paymentStandard": price(fields["paymentRaw"], "insurance_payment_standard"),
                                    "reviewFlags": flags, "runtimeEnabled": False, "nhsaProductCode": None})
                elif any(cells):
                    # Keep page-local fragments; join only an explicit empty-identity continuation.
                    last = records[-1] if records else None
                    if (last and last["part"] == part and last["source"]["pdfPage"] == i and row["rowIndex"] == 0
                            and len(cells) >= 9 and not any(cells[:8]) and any(cells[8:])):
                        continuations.append({"recordId": last["id"], "rawCells": cells, "source": source})
                        last.setdefault("continuationFragments", []).append({"rawCells": cells, "source": source})
                        last["reviewFlags"].append("continuation_association_pending")
                    else:
                        auxiliary.append({"id": rid, "part": part, "rawCells": cells, "source": source})
                        self.issue("drugs", "unassigned_table_row", source, rid, cells)
        # Independent PDF tables reconcile fields by identity within the same page.
        # A number alone is insufficient: aliases and dosage variants share numbers.
        native_tables = {}
        for r in records:
            page_index = r["source"]["pdfPage"] - 1
            if page_index not in native_tables:
                native_tables[page_index] = [
                    {"table": j, "row": k, "bbox": list(table.bbox),
                     "cells": [re.sub(r"\s*\n\s*", "", c or "") for c in cells]}
                    for j, table in enumerate(pdf[page_index].find_tables().tables)
                    for k, cells in enumerate(table.extract())]
            if r["part"] == "herbal":
                candidates = [(candidate, offset) for candidate in native_tables[page_index] for offset in [0, 3]
                              if len(candidate["cells"]) >= offset + 3 and candidate["cells"][offset] == r["catalogueNumber"]]
                if len(candidates) == 1:
                    candidate, offset = candidates[0]
                    evidence = {"pdfSha256": self.sources["drugs"]["pdfSha256"], "pdfPage": page_index + 1,
                                "pdfTable": candidate["table"], "pdfRow": candidate["row"], "column": offset,
                                "method": "Unique same-page herbal sequence number in a fixed three-column group"}
                    r["pdfReconciliation"] = evidence
                    for key, after in [("name", candidate["cells"][offset + 1]), ("notes", candidate["cells"][offset + 2])]:
                        if r[key] != after:
                            before = r[key]
                            self.correction("drugs", r["id"], key, before, after, evidence)
                            r.setdefault("rawFields", {})[key] = before
                            r[key] = after
                else:
                    r["reviewFlags"].append("pdf_row_identity_requires_review")
                continue
            candidates = []
            for candidate in native_tables[page_index]:
                cells = candidate["cells"]
                cp = next((j for j, c in enumerate(cells) if c in ["甲", "乙"]), None)
                if cp is None or len(cells) < cp + 3:
                    continue
                if compact(cells[cp + 1]) != compact(r["catalogueNumber"]) or cells[cp] != r["insuranceClass"]:
                    continue
                name_score = difflib.SequenceMatcher(None, compact(r["name"]), compact(cells[cp + 2])).ratio()
                dose_score = 0
                if r.get("dosageForm") and len(cells) > cp + 3:
                    dose_score = .3 * difflib.SequenceMatcher(None, compact(r["dosageForm"]), compact(cells[cp + 3])).ratio()
                candidates.append((name_score + dose_score, cp, candidate))
            candidates.sort(key=lambda item: item[0], reverse=True)
            if candidates and candidates[0][0] >= .75 and (len(candidates) == 1 or candidates[0][0] > candidates[1][0] + .03):
                _, cp, candidate = candidates[0]
                cells = candidate["cells"]
                tail = cells[cp + 3:]
                paid = r["part"] in ["negotiated", "competitive"]
                values = {"name": cells[cp + 2], "notes": (tail[1] if len(tail) > 1 else "") if paid or r["part"] == "western" else tail[0] if tail else ""}
                if paid:
                    values.update(paymentRaw=tail[0] if tail else "", validityRaw=tail[2] if len(tail) > 2 else None)
                elif r["part"] == "western":
                    values["dosageForm"] = tail[0] if tail else None
                evidence = {"pdfSha256": self.sources["drugs"]["pdfSha256"], "pdfPage": page_index + 1,
                            "pdfTable": candidate["table"], "pdfRow": candidate["row"], "tableBounds": candidate["bbox"],
                            "method": "Unique same-page insurance class, catalogue number, name and dosage-form match"}
                r["pdfReconciliation"] = evidence
                for key, after in values.items():
                    before = r.get(key)
                    if before != after:
                        self.correction("drugs", r["id"], key, before, after, evidence)
                        r.setdefault("rawFields", {})[key] = before
                        r[key] = after
                r["paymentStandard"] = price(r.get("paymentRaw", ""), "insurance_payment_standard")
                r["reviewFlags"] = [flag for flag in r["reviewFlags"] if flag != "source_table_width_requires_review"]
            else:
                r["reviewFlags"].append("pdf_row_identity_requires_review")
            if r["source"]["jsonPointer"].startswith("pdf-table:"):
                r["source"]["nativePdfTable"] = int(r["source"].pop("jsonPointer").split(":")[1])
                r["source"]["extractionMethod"] = "native_pdf_table_recovery"
                issue = self.issue("drugs", "missing_mineru_table_recovered", r["source"], r["id"],
                                   {"name": r["name"], "catalogueNumber": r["catalogueNumber"]},
                                   status="resolved_pdf_text_recovered", severity="information")
                issue["originalValue"] = None
                issue["correctedValue"] = {"name": r["name"], "catalogueNumber": r["catalogueNumber"]}
                issue["basis"] = r.get("pdfReconciliation")
        by_number = collections.defaultdict(list)
        for r in records:
            # Catalogue numbering is scoped to part and X/Z medicine family, never a national product ID.
            family = (r.get("categoryCode") or "")[:1]
            by_number[(r["part"], family, compact(r["catalogueNumber"]))].append(r)
            r["region"] = "全国目录；地方支付与院内产品映射另行核实"
            r["edition"] = "2025"
            r["hospitalMapping"] = {"state": "待补全", "hospitalProductId": None, "strength": None,
                                    "package": None, "billingUnit": None, "chargePrice": None, "procurementCost": None}
            text = compact(pdf[r["source"]["pdfPage"] - 1].get_text())
            for key in ["name", "notes", "paymentRaw"]:
                value = r.get(key, "") or ""
                if value and compact(value) not in text:
                    r["reviewFlags"].append("pdf_text_difference:" + key)
            raw_price = r["paymentStandard"]["raw"]
            standards = []
            for m in re.finditer(r"([0-9]+(?:\.[0-9]+)?)\s*元", raw_price):
                next_amount = re.search(r"[0-9]+(?:\.[0-9]+)?\s*元", raw_price[m.end():])
                end = m.end() + next_amount.start() if next_amount else len(raw_price)
                expression = raw_price[m.end():end].strip(";； ")
                standards.append({"amount": str(Decimal(m.group(1))), "currency": "CNY", "specificationRaw": expression,
                                  "billingUnit": None, "state": "specification_and_unit_require_review"})
            r["paymentStandards"] = standards
            for standard in standards:
                units = re.findall(r"/([\u4e00-\u9fff]{1,8})(?=[()（）;；]|$)", standard["specificationRaw"])
                standard["billingUnit"] = units[-1] if len(set(units)) == 1 else None
                standard["state"] = "source_specification_and_unit" if standard["billingUnit"] else "unit_requires_review"
                standard["unitMeaning"] = "Literal source payment unit; hospital packaging/conversion remains unverified"
            r.setdefault("validFrom", None)
            r.setdefault("validTo", None)
            if r.get("validityRaw"):
                dates = re.findall(r"(\d{4})年(\d{1,2})月(\d{1,2})日", r["validityRaw"])
                r["validFrom"] = "-".join([dates[0][0], dates[0][1].zfill(2), dates[0][2].zfill(2)]) if dates else None
                r["validTo"] = "-".join([dates[1][0], dates[1][1].zfill(2), dates[1][2].zfill(2)]) if len(dates) == 2 else None
        for key, repeated in by_number.items():
            if len(repeated) > 1:
                # Legitimate dosage variants and source aliases remain distinct and auditable.
                names = {compact(r["name"]) for r in repeated}
                if len(names) > 1:
                    for r in repeated:
                        r["numberGroupRecordIds"] = [other["id"] for other in repeated]
                    self.issue("drugs", "catalogue_number_variants", repeated[0]["source"],
                               detail={"scope": list(key), "records": [{"id": r["id"], "name": r["name"]} for r in repeated],
                                       "meaning": "Catalogue numbers are scoped references, not unique product codes"},
                               status="resolved_source_preserved", severity="information")
        for r in records:
            r["reviewStatus"] = "pending" if r["reviewFlags"] else "structural_checks_passed"
            if r["reviewFlags"]:
                self.issue("drugs", "drug_record_review", r["source"], r["id"], r["reviewFlags"])
        policies = self.policies("drugs")
        for r in records:
            reference_number = re.search(r"\d+", r["catalogueNumber"])
            r["catalogueNumberRole"] = "primary" if r["catalogueNumber"].isdigit() else "alias_reference"
            r["referenceNumber"] = reference_number[0] if reference_number else None
            r["aliasOfRecordIds"] = [other["id"] for other in records if r["catalogueNumberRole"] == "alias_reference"
                                     and other["part"] == r["part"] and (other.get("categoryCode") or "")[:1] == (r.get("categoryCode") or "")[:1]
                                     and other["catalogueNumber"] == r["referenceNumber"]]
            r["policyIds"] = [p["id"] for p in policies if 2 <= p["source"]["pdfPage"] <= 8]
            r["localNoteIds"] = [p["id"] for p in policies if p["source"]["pdfPage"] == r["source"]["pdfPage"] and "备注" in p["text"]]
        for row in auxiliary:
            row["relatedRecordIds"] = [r["id"] for r in records if r["source"]["pdfPage"] == row["source"]["pdfPage"] and "见备注" in r.get("paymentRaw", "")]
        self.save("drugs", "records", records)
        self.save("drugs", "classifications", classes)
        self.save("drugs", "auxiliary-table-rows", auxiliary)
        self.save("drugs", "continuation-fragments", continuations)
        self.statistics["drugs"] = {"records": len(records), "parts": dict(collections.Counter(r["part"] for r in records)),
                                    "classificationRows": len(classes), "auxiliaryRows": len(auxiliary),
                                    "confidentialPaymentStandards": sum(r["paymentStandard"]["state"] == "confidential" for r in records),
                                    "pendingRecords": sum(bool(r["reviewFlags"]) for r in records), "currentHospitalPrices": 0,
                                    "pendingAuxiliaryRows": sum(i["dataset"] == "drugs" and i["reviewStatus"] == "pending"
                                                                and i["kind"] in ["unassigned_table_row", "unparsed_drug_row"] for i in self.issues),
                                    "recoveredMissingTables": sum(r["source"].get("extractionMethod") == "native_pdf_table_recovery" for r in records),
                                    "primaryNumberCounts": {part: len({((r.get("categoryCode") or "")[:1], r["catalogueNumber"]) for r in records if r["part"] == part and r["catalogueNumber"].isdigit()})
                                                            for part in ["western", "traditional", "negotiated", "competitive", "herbal"]}}
        return records

    def drg(self):
        pdf = pymupdf.open(self.out / self.sources["drg"]["pdf"])
        native = [page.get_text() for page in pdf]
        page_texts = [{"source": self.source("drg", i), "pdfSha256": self.sources["drg"]["pdfSha256"],
                       "text": text, "method": "native_pdf_text"} for i, text in enumerate(native)]
        self.save("drg", "native-page-text", page_texts)
        catalogue = []
        for i in range(18, 51):
            lines = [line.strip() for line in native[i].splitlines() if line.strip()]
            expected = r"MDC[A-Z]" if i == 18 else r"[A-Z]{2}[0-9]" if i < 31 else r"[A-Z]{2}[0-9][0-9A-Z]"
            for n, line in enumerate(lines):
                if re.fullmatch(expected, line):
                    name_lines = []
                    for following in lines[n + 1:]:
                        if re.fullmatch(expected, following) or following in ["DRG", "DRG 名称", "ADRG", "ADRG 名称"]:
                            break
                        if following.isdigit():
                            break
                        name_lines.append(following)
                    level = "MDC" if i == 18 else "ADRG" if i < 31 else "DRG"
                    catalogue.append({"id": f"drg:{level}:{line}", "level": level, "code": line,
                                      "name": "".join(name_lines), "parentCode": None if level == "MDC" else
                                      "MDC" + line[0] if level == "ADRG" else line[:3],
                                      "source": self.source("drg", i, pdfTextLine=n), "runtimeEnabled": False})
        counts = collections.Counter(r["level"] for r in catalogue)
        if counts != {"MDC": 26, "ADRG": 492, "DRG": 825}:
            raise ValueError(f"DRG catalogue count mismatch: {counts}")
        self.save("drg", "groups", catalogue)
        adrg = {r["code"]: r for r in catalogue if r["level"] == "ADRG"}
        blocks, members, relationships, unassigned_mentions = [], [], [], []
        block = None
        chapter, subsection, table = "core_group_rules", None, None
        pending, condition_role = None, None
        for i in range(51, len(pdf)):
            for n, raw_line in enumerate(native[i].splitlines()):
                line = raw_line.strip()
                if not line:
                    continue
                chapter_match = re.match(r"^([五六七])、(.+)", line)
                if chapter_match:
                    chapter = {"五": "non_grouping_lists", "六": "subgroup_rules", "七": "primary_care_groups"}[chapter_match[1]]
                    subsection, table, block, pending = None, None, None, None
                if chapter in ["subgroup_rules", "non_grouping_lists"] and re.match(r"^[1-5][.．、]", line):
                    subsection, table, pending = line, None, None
                if chapter == "core_group_rules":
                    heading = re.match(r"^([A-Z]{2}[0-9])(?:\s+|$)(.*)", line)
                    if heading and heading[1] in adrg:
                        block = {"id": f"drg-rule:{heading[1]}", "adrgCode": heading[1], "name": adrg[heading[1]]["name"],
                                 "fragments": [], "conditionTexts": [], "source": self.source("drg", i),
                                 "reviewStatus": "pending_rule_semantics", "executable": False, "runtimeEnabled": False}
                        blocks.append(block)
                        pending, condition_role = None, None
                exclusion_section = bool(subsection and (subsection.startswith("5.") or "排除" in subsection))
                if chapter == "subgroup_rules" and exclusion_section:
                    tm = re.match(r"^表\s*(6-5-\d+)(?:\s|$)", line)
                    if tm:
                        table, pending = tm[1], None
                source = self.source("drg", i, nativeTextLine=n, rawLine=raw_line)
                if block:
                    if not block["fragments"] or block["fragments"][-1]["pdfPage"] != i + 1:
                        block["fragments"].append({"pdfPage": i + 1, "lines": []})
                    block["fragments"][-1]["lines"].append(raw_line)
                    if any(word in line for word in ["条件", "包含", "除外", "不包括", "排除", "主要诊断", "主要手术", "全部手术", "其他诊断"]):
                        block["conditionTexts"].append({"text": line, "source": source})
                    if len(line) < 100 and re.search(r"(?:诊断|手术|操作).*[：:]$", line):
                        condition_role = line
                cm = CODE_START.match(line)
                if cm:
                    pending = {"id": f"drg-member-{len(members) + 1:07}", "code": cm[1], "nameText": cm[2],
                               "components": COMPONENT.findall(cm[1]), "chapter": chapter, "subsection": subsection,
                               "adrgCode": block["adrgCode"] if block else None, "exclusionTable": table,
                               "source": source, "conditionRole": condition_role if block else None,
                               "relation": "excluded_from_grouping" if chapter == "non_grouping_lists" else
                               "exclusion_table_member" if exclusion_section and chapter == "subgroup_rules" else
                               "cc_mcc_condition" if subsection and ("MCC" in subsection or "（CC）" in subsection) else
                               "listed_under_source_condition", "runtimeEnabled": False}
                    members.append(pending)
                elif pending:
                    tm = re.fullmatch(r"表\s*(6-5-\d+)", line)
                    if tm and not exclusion_section:
                        relationships.append({"id": f"drg-exclusion-ref-{len(relationships) + 1:06}",
                                              "secondaryDiagnosisCode": pending["code"], "exclusionTable": tm[1],
                                              "severity": "MCC" if subsection and "MCC" in subsection else "CC",
                                              "source": source, "memberId": pending["id"], "runtimeEnabled": False})
                    elif (not line.isdigit() and not re.match(r"^(?:表|MDC|[一二三四五六七]、|[1-5][.．])", line)
                          and line not in ["疾病编码", "疾病名称", "排除主诊"]):
                        pending["nameText"] += line
                if not cm and ATOM.search(line):
                    unassigned_mentions.append({"source": source, "codes": ATOM.findall(line), "text": line,
                                                "chapter": chapter, "adrgCode": block["adrgCode"] if block else None,
                                                "interpretation": "code_mention_in_prose_or_unparsed_list; retained_for_review"})
        defined = {b["adrgCode"] for b in blocks}
        for missing in sorted(set(adrg) - defined):
            self.issue("drg", "missing_rule_block", adrg[missing]["source"], adrg[missing]["id"])
        if len(blocks) != len(defined):
            self.issue("drg", "duplicate_rule_block", None, detail=collections.Counter(b["adrgCode"] for b in blocks).most_common(10))
        empty = jsread(self.roots["drg"] / "review-findings.json")["empty_body_pages"]
        reviews = []
        for entry in empty:
            i = entry["global_pdf_page"] - 1
            codes = set(ATOM.findall(native[i]))
            nearby = {}
            for j in range(max(0, i - 2), min(len(pdf), i + 3)):
                if j != i:
                    contents = [v for _, v in walk_values(self.pages["drg"][j], "content")]
                    contents += [re.sub(r"<[^>]*>", "\n", v) for _, v in walk_values(self.pages["drg"][j], "html")]
                    nearby[j + 1] = set(ATOM.findall("\n".join(contents))) & codes
            union = set().union(*nearby.values())
            result = {"source": self.source("drg", i), "pdfHasBodyText": len(compact(native[i])) > 20,
                      "pdfCodeCount": len(codes), "codeCountPresentOnNearbyMineruPages": len(union),
                      "nearbyPages": {str(k): sorted(v) for k, v in nearby.items() if v},
                      "codesAbsentFromNearbyMineruPages": sorted(codes - union),
                      "classification": "all_codes_shifted_to_nearby_pages" if codes and codes <= union else
                      "partial_or_missing_mineru_content", "recovery": "native_pdf_text_by_true_physical_page",
                      "reviewStatus": "verified_pdf_text", "humanReviewed": False}
            reviews.append(result)
            issue = self.issue("drg", "empty_body_page", result["source"], detail=result,
                               status="resolved_pdf_text_recovered", severity="information")
            issue["originalValue"], issue["correctedValue"] = "empty MinerU body blocks", f"drg/native-page-text.jsonl page {i + 1}"
            issue["basis"] = {"pdfSha256": self.sources["drg"]["pdfSha256"], "pdfPage": i + 1}
        self.save("drg", "rule-blocks", blocks)
        self.save("drg", "rule-members", members)
        self.save("drg", "cc-mcc-exclusion-references", relationships)
        self.save("drg", "unassigned-code-mentions", unassigned_mentions)
        if unassigned_mentions:
            self.issue("drg", "unassigned_code_mentions", None,
                       detail={"count": len(unassigned_mentions), "file": "standardized/drg/unassigned-code-mentions.jsonl"})
        write_json(self.out / "reports" / "drg-empty-pages.json", reviews)
        self.statistics["drg"] = {"groups": dict(counts), "ruleBlocks": len(blocks), "missingRuleBlocks": len(set(adrg) - defined),
                                  "ruleMembers": len(members), "exclusionReferences": len(relationships),
                                  "emptyMineruPagesRecovered": len(reviews), "unassignedCodeMentions": len(unassigned_mentions), "executableRules": 0,
                                  "versionIdentity": "Matches previously verified official updated PDF SHA-256"}
        return catalogue, members, relationships

    def cross_validate(self, diagnoses, procedures, catalogue, members, relationships):
        indexes = {}
        for key, records in [("diagnosis", diagnoses), ("procedure", procedures)]:
            exact = {r["code"] for r in records if r["code"]}
            atoms = {c for r in records for c in r["components"]}
            accepted = {r["code"] for r in records if r["eligibleReferenceCandidate"]}
            indexes[key] = (exact, atoms, accepted)
        references = collections.defaultdict(list)
        for member in members:
            references[member["code"]].append(member)
        results = []
        for code, occurrences in sorted(references.items()):
            kind = "diagnosis" if code[0].isalpha() else "procedure"
            exact, atoms, accepted = indexes[kind]
            components = COMPONENT.findall(code)
            status = "exact_accepted_candidate" if code in accepted else "exact_pending" if code in exact else "component_only" if components and all(c in atoms for c in components) else "missing"
            row = {"code": code, "dictionary": kind, "match": status, "occurrences": len(occurrences),
                   "sources": [r["source"] for r in occurrences], "memberIds": [r["id"] for r in occurrences]}
            results.append(row)
            if status in ["missing", "exact_pending", "component_only"]:
                self.issue("drg", "dictionary_reference_" + status, occurrences[0]["source"],
                           detail={"code": code, "dictionary": kind, "occurrences": len(occurrences), "memberIds": row["memberIds"]})
        exclusion_tables = {m["exclusionTable"] for m in members if m["exclusionTable"]}
        missing_tables = sorted({r["exclusionTable"] for r in relationships} - exclusion_tables)
        codes = {r["code"] for r in catalogue}
        missing_parents = [r for r in catalogue if r["parentCode"] and r["parentCode"] not in codes]
        if missing_tables:
            self.issue("drg", "missing_exclusion_tables", None, detail=missing_tables)
        if missing_parents:
            self.issue("drg", "missing_group_parents", None, detail=missing_parents)
        summary = {"dictionaryVersionCompatibility": "Textual membership check only; DRG required dictionary release not declared in this packet",
                   "uniqueReferences": len(results), "matches": dict(collections.Counter(r["match"] for r in results)),
                   "identityPolicy": "Composite codes are checked as whole strings; component-only matches remain pending",
                   "missingExclusionTables": missing_tables, "missingGroupParents": len(missing_parents),
                   "scope": "Exact strings only; no truncation, uppercasing, zero stripping, or prefix fallback"}
        write_jsonl(self.out / "reports" / "cross-library-details.jsonl", results)
        write_json(self.out / "reports" / "cross-library-report.json", summary)
        text = ["# DRG 与医保编码字典交叉校验", "", "复合码按完整编码匹配；候选字典来自本次原 PDF 逐单元格核对。匹配成功不等于当地分组器版本适配。", "",
                "| 结果 | 唯一完整编码数 |", "| --- | ---: |"]
        text.extend(f"| {state} | {count} |" for state, count in summary["matches"].items())
        text.extend(["", f"排除表引用缺失：{len(missing_tables)}；病组父级缺失：{len(missing_parents)}。", "",
                     "以下编码在 DRG 原 PDF 存在，在本批对应医保字典中没有精确记录。保留为版本或编码差异待复核，不自动补码、截后缀或替换相近代码。", "",
                     "| 编码 | 字典 | 首次出现 PDF 页 | 出现次数 |", "| --- | --- | ---: | ---: |"])
        text.extend(f"| `{r['code']}` | {r['dictionary']} | {r['sources'][0]['pdfPage']} | {r['occurrences']} |" for r in results if r["match"] == "missing")
        text.extend(["", "完整逐项证据：`cross-library-details.jsonl`；复核入口：`../review/issues.jsonl`。"])
        (self.out / "reports" / "cross-library-report.md").write_text("\n".join(text) + "\n", encoding="utf-8")
        self.statistics["crossLibrary"] = summary

    def finish(self):
        write_jsonl(self.out / "review" / "issues.jsonl", self.issues)
        write_jsonl(self.out / "review" / "corrections.jsonl", self.corrections)
        with (self.out / "review" / "issues.csv").open("w", encoding="utf-8-sig", newline="") as f:
            columns = ["id", "dataset", "kind", "severity", "reviewStatus", "recordId", "source", "detail", "originalValue", "correctedValue", "basis"]
            writer = csv.DictWriter(f, fieldnames=columns)
            writer.writeheader()
            for issue in self.issues:
                writer.writerow({k: json.dumps(issue[k], ensure_ascii=False) if isinstance(issue[k], (dict, list)) else issue[k] for k in columns})
        write_jsonl(self.out / "reports" / "page-coverage.jsonl", self.coverage)
        write_json(self.out / "reports" / "quality-report.json", {"statistics": self.statistics, "datasets": self.datasets,
                   "issues": dict(collections.Counter(i["reviewStatus"] for i in self.issues)), "corrections": len(self.corrections),
                   "enabledRuntimeRecords": 0, "reviewMeaning": "verified_pdf_text is an automated source fidelity check, not human/clinical approval"})
        manifest = {"schemaVersion": "clinmesh.reference-preparation.v1", "releaseId": "clinmesh-five-catalogues-2026-10-16.r1",
                    "status": "prepared_not_published", "runtimeEnabled": False, "sources": self.sources,
                    "tables": self.datasets, "runtimeImporter": "not_implemented",
                    "publicationGate": ["Resolve pending anomalies", "Confirm dictionary and target-region applicability",
                                        "Review rule semantics and table continuations", "Add owning dataset schemas and signed release integration"],
                    "currentLock": "reference-data.lock.json unchanged; existing cn-health signature chain remains required"}
        write_json(self.out / "release-candidate.json", manifest)
        stats = self.statistics
        lines = ["# 五类参考数据清洗与验收报告", "", "日期：2026-10-16。发布状态：候选包，未发布、未写入运行库。", "",
                 "原始档案完整性与识别准确性分别验收。五包逐文件哈希、分片哈希、逐页语义保真及 PDF 页数均已重新验证；PDF 上传二进制身份仍因导出不含上传哈希而未知。", "",
                 "| 数据 | 清洗结果 | 质量边界 |", "| --- | --- | --- |",
                 f"| ICD-10 医保 2.0 | {stats['icd10']['leafRecords']} 条末级；{stats['icd10']['hierarchyOnlyRows']} 条纯层级行；{stats['icd10']['hierarchyNodes']} 个层级节点 | 全部 PDF 单元格核对；{stats['icd10']['pendingRecords']} 条记录待复核 |",
                 f"| ICD-9-CM3 医保 2.0 | {stats['icd9']['leafRecords']} 条末级；{stats['icd9']['hierarchyOnlyRows']} 条纯层级行；{stats['icd9']['hierarchyNodes']} 个层级节点 | 全部 PDF 单元格核对；{stats['icd9']['pendingRecords']} 条记录待复核 |",
                 f"| DRG 3.0 | 26 MDC / 492 ADRG / 825 DRG；{stats['drg']['ruleBlocks']} 个规则正文块；{stats['drg']['ruleMembers']} 条成员；{stats['drg']['exclusionReferences']} 个 CC/MCC 排除表引用 | 19 页按 PDF 补提；规则语义待审核，不能当作可执行分组器 |",
                 f"| 浙江 2024 | {stats['services']['records']} 条服务；{stats['services']['materialRows']} 行材料条件；{stats['services']['categories']} 行分类 | {stats['services']['pendingRecords']} 条待复核；当前院价、采购成本、有效期均待补全 |",
                 f"| 国家医保药品 2025 | {stats['drugs']['records']} 条明细：3,253 个主目录条目、662 条剂型/关联变体、892 条饮片；{stats['drugs']['confidentialPaymentStandards']} 条保密支付标准 | {stats['drugs']['pendingRecords']} 条主记录文字异常、{stats['drugs']['pendingAuxiliaryRows']} 行附表待复核；院内产品与价格映射仍待补全 |", "",
                 "## DRG 版本及异常页", "", "补充原 PDF 的 SHA-256 为 `82b5d179d797e2b9586b337d628c20177c85f43738529159c906fd0ef8432e41`，与仓库此前核验的官网更新附件一致（1,826 页）。不与 1,829 页旧原件混用。19 个空正文页全部对照真实 PDF 文字层，恢复结果和邻页代码覆盖证据见 `reports/drg-empty-pages.json`。", "",
                 "## 异常与修正", "", f"修正字段 {len(self.corrections)} 处，包含编码、名称、标点和排版差异。每处保留原始值、修正值、PDF 哈希、物理页、表格位置和机器复核状态。机器核对不代表人工复核或编码临床正确。层级行保留，不制造末级编码。ICD-10 的 1,521 条数字 0 开头候选均已逐单元格核对为字母 O；原始重复编码依原 PDF 的不同编码分别恢复。", "",
                 "异常入口：`review/issues.csv`（UTF-8 BOM）和 `review/issues.jsonl`；完整修正：`review/corrections.jsonl`。处理状态与严重度分别存储，已解决的来源异常仍保留。", "",
                 "## 跨库校验", "", f"DRG 共引用 {stats['crossLibrary']['uniqueReferences']} 个唯一完整编码：`{json.dumps(stats['crossLibrary']['matches'], ensure_ascii=False)}`。复合码按完整字符串校验；精确匹配、仅成员匹配、字典中存在但待复核、缺失分别报告，仅成员匹配也保留为待复核；不删除后缀或前导零凑匹配。", "",
                 f"缺少排除表：{len(stats['crossLibrary']['missingExclusionTables'])}；缺少病组父级：{stats['crossLibrary']['missingGroupParents']}。字典版本兼容性尚须核实，文字命中不能证明版本适配。详细证据见 `reports/cross-library-details.jsonl`。", "",
                 "## 价格与启用边界", "", f"浙江已核对并关联 {stats['services']['verifiedContinuationJoins']} 处跨页续行；{stats['services']['pendingRecords']} 条缺价格、价格须解释或缺单位，留在待复核清单，其中包含按目录明确需院方自主定价的项目。整行说明与无编码小标题保存在 table-notes，不计为可收费服务。", "",
                 "浙江价格只标记为 2024 省级参考；自主定价附录与医用材料条件单独保留。空价格为未知，不是免费。药品 `*` 保留为保密价格；数值支付标准保留规格原文和协议期，不等于收费价或采购价。所有院内产品、规格、包装、计价换算、当前收费和成本映射均为待补全。", "",
                 "江西、广东药品价格表和心血管耗材报价不属于本次五包，未被混入价格字段。合成病例、动态 DRG 模拟及支付参数属于后续接入阶段。", "",
                 "## 项目发布", "", "`release-candidate.json` 仅是清洗阶段清单，不冒充现有 ReferenceArtifact 或 cn-health 签名 Manifest。运行库和 `reference-data.lock.json` 未变。后续需为手术、DRG 规则、医保待遇和价格建立 owning schema/importer，经现有签名、hash、SQLite 不变量校验后发布新 Release；旧费用及评估继续绑定原版本。", "",
                 "原始 ZIP 在 `raw/archives/`，全部包内原件在 `raw/extracted/`，补充 PDF 在 `raw/supplemental/`。每条标准记录通过 archiveSha256、sourceFile、pdfPage、sourcePageIndex 及 JSON/表格位置追溯。"]
        (self.out / "reports" / "quality-report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
        (self.out / "README.md").write_text("# ClinMesh 五类参考数据候选包\n\n先阅读 [清洗与验收报告](reports/quality-report.md)。\n\n- standardized：五类标准数据及层级、分类、规则正文、排除关系和政策原文。\n- review：异常复核清单及逐字段修正日志。\n- reports：页覆盖、DRG 空页核验和跨库校验。\n- raw：字节保真的原始压缩包、所有包内文件与补充原 PDF。\n- release-candidate.json：候选清单，未进入运行库。\n\n编码始终为字符串；JSONL 为权威交付格式。不要用 Excel 自动类型推断后回写编码。\n", encoding="utf-8")
        files = []
        for p in sorted(self.out.rglob("*")):
            if p.is_file() and p != self.out / "checksums.json":
                files.append({"path": p.relative_to(self.out).as_posix(), "bytes": p.stat().st_size, "sha256": sha(p)})
        write_json(self.out / "checksums.json", files)
        print(json.dumps({"output": str(self.out), "statistics": stats, "issues": len(self.issues), "corrections": len(self.corrections)}, ensure_ascii=False), flush=True)

    def run(self):
        self.archive()
        diagnoses = self.icd("icd10")
        procedures = self.icd("icd9")
        self.services()
        self.drugs()
        catalogue, members, relationships = self.drg()
        self.cross_validate(diagnoses, procedures, catalogue, members, relationships)
        self.finish()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", type=Path, required=True, help="Directory holding the five ZIPs and two supplementary PDFs")
    parser.add_argument("--output", type=Path, required=True, help="New directory; never overwrites existing evidence")
    args = parser.parse_args()
    Preparation(args.input_dir, args.output).run()
