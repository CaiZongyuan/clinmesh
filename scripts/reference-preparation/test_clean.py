import tempfile
import unittest
from pathlib import Path

import pymupdf

from clean import CODE_START, COMPONENT, DIAGNOSIS_CODE, PROCEDURE_CODE, Preparation, expand_table, pdf_grid, price


class ReferencePreparationTests(unittest.TestCase):
    def test_rowspans_do_not_forward_fill_unrelated_blanks(self):
        table = '<table><tr><td rowspan="2">01</td><td>A</td></tr><tr><td></td></tr></table>'
        rows = expand_table(table)
        self.assertEqual([r["cells"] for r in rows], [["01", "A"], ["01", ""]])
        self.assertEqual(rows[1]["origins"], [[0, 0], [1, 0]])

    def test_colspan_preserves_origin_and_column_positions(self):
        rows = expand_table('<table><tr><td colspan="2">类</td><td>乙</td></tr></table>')
        self.assertEqual(rows[0]["cells"], ["类", "类", "乙"])
        self.assertEqual(rows[0]["origins"], [[0, 0], [0, 0], [0, 1]])

    def test_price_states_never_turn_unknown_or_confidential_into_zero(self):
        self.assertEqual(price("*", "payment")["state"], "confidential")
        self.assertIsNone(price("*", "payment")["amount"])
        self.assertEqual(price("", "price")["state"], "unknown")
        self.assertIsNone(price("", "price")["amount"])
        self.assertEqual(price("0", "price")["amount"], "0")
        self.assertEqual(price("5.68元(10mg/片)", "payment")["state"], "expression")

    def test_codes_keep_leading_zero_letters_and_combinations(self):
        for code in ["00.3200x001", "52.4x00x012", "01.2A00"]:
            self.assertIsNotNone(PROCEDURE_CODE.fullmatch(code))
        for code in ["A01.000x005+J17.0*", "A02.203+G01*", "O99.700x011"]:
            self.assertIsNotNone(DIAGNOSIS_CODE.fullmatch(code))
        self.assertIsNone(DIAGNOSIS_CODE.fullmatch("099.700x011"))
        self.assertIsNone(DIAGNOSIS_CODE.fullmatch(r"Y51300 \\times 003"))

    def test_pdf_glyph_assignment_handles_word_crossing_cell_border(self):
        doc = pymupdf.open()
        page = doc.new_page(width=400, height=200)
        for x in [10, 100, 200]:
            page.draw_rect(pymupdf.Rect(x, 20, x + 1, 120))
        for y in [20, 50, 120]:
            page.draw_rect(pymupdf.Rect(11, y, 201, y + 1))
        # A single PDF text span crosses the cell border without a space.
        page.insert_text((70, 85), "ABCDEabcde", fontsize=10)
        rows, _, _ = pdf_grid(page)
        self.assertTrue(rows[1][0])
        self.assertTrue(rows[1][1])
        self.assertEqual(rows[1][0] + rows[1][1], "ABCDEabcde")

    def test_drg_compound_with_three_character_manifestation_keeps_whole_identity(self):
        match = CODE_START.match("A01.002+G01*  合成测试名称")
        self.assertIsNotNone(match)
        self.assertEqual(match[1], "A01.002+G01*")
        self.assertEqual(COMPONENT.findall(match[1]), ["A01.002", "G01"])

    def test_refuses_to_overwrite_prior_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "new directory"):
                Preparation(Path(directory), Path(directory))


if __name__ == "__main__":
    unittest.main()
