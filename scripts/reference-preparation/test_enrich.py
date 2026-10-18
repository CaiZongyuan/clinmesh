"""Price precision, identity and incomplete-unit boundaries."""

import unittest

from enrich import explicit_package, identifier, money, procedure_use, source_price_status


class PriceBoundaries(unittest.TestCase):
    def test_decimal_price_and_zero_are_preserved(self):
        self.assertEqual(money("0.1567"), "0.1567")
        self.assertEqual(money(0), "0")
        self.assertEqual(money("11990.00"), money(11990))

    def test_missing_confidential_and_formulas_are_not_prices(self):
        for value in [None, "", "*", "=1+1", True, "-1", "nan"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                money(value)

    def test_identifiers_retain_zeros_and_reject_unsafe_float(self):
        self.assertEqual(identifier("001234"), "001234")
        self.assertEqual(identifier(100196647), "100196647")
        with self.assertRaises(ValueError):
            identifier(float(2**53 + 2))

    def test_package_count_requires_an_explicit_unambiguous_structure(self):
        self.assertEqual(explicit_package("28*片/盒")["count"], 28)
        self.assertEqual(explicit_package("2瓶/盒")["packageUnit"], "盒")
        for value in [None, "30片×2板/盒", "每盒", "0片/盒"]:
            self.assertIsNone(explicit_package(value))

    def test_missing_unit_stays_unverified_even_with_numeric_price(self):
        result = source_price_status({"price": {"amount": "0", "unit": None}, "specification": "5mg"})
        self.assertEqual(result["label"], "待核实")
        self.assertIn("价格计量单位或金额分母", result["missingFields"])

    def test_superseded_price_is_blocked_only_for_current_price_use(self):
        result = source_price_status({"currentApplicability": "superseded_historical"})
        self.assertEqual(result["label"], "不可作当前价")

    def test_official_identity_confirmation_does_not_clear_a_technique_conflict(self):
        state, _ = procedure_use({"state": "confirmed_official_online", "nameConflict": True})
        self.assertEqual(state, "暂不可用（隔离）")
        state, reason = procedure_use({"state": "confirmed_official_online", "nameReviewRequired": True})
        self.assertEqual(state, "待核实")
        self.assertIn("文字变体", reason)


if __name__ == "__main__":
    unittest.main()
