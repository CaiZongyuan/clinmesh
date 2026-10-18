import unittest
from decimal import Decimal

from review import bed_prices, grade_prices, tier_example


class SourceReviewTests(unittest.TestCase):
    def test_grade_expression_keeps_conditions_and_rejects_missing_or_duplicate_grade(self):
        options = grade_prices("三级医院70，二级医院55，一级医院50")
        self.assertEqual({r["condition"]["hospitalLevel"]: r["amount"] for r in options},
                         {"三级": "70", "二级": "55", "一级": "50"})
        for text in ["三级医院70，二级医院55", "三级医院70，三级医院55，一级医院50",
                     "三级医院70，二级医院55，一级医院50；儿童另收"]:
            with self.assertRaises(ValueError):
                grade_prices(text)

    def test_bed_rates_preserve_facility_and_occupancy_conditions(self):
        source = ("配备单独卫生设施：一人间60元/床日，二人间50元/床日，三人间40元/床日，"
                  "四人间30元/床日，五人及以上病房20元/床日。未配备单独卫生设施：一人间45元/床日，"
                  "二人间35元/床日，三人间25元/床日，四人间20元/床日，五人及以上病房12元/床日")
        rates = bed_prices(source)
        self.assertEqual(len(rates), 10)
        self.assertEqual([r["amount"] for r in rates if r["condition"]["occupancyMin"] == 1], ["60", "45"])
        self.assertTrue(all(r["condition"]["occupancyMax"] is None for r in rates
                            if r["condition"]["occupancyMin"] == 5))
        with self.assertRaises(ValueError):
            bed_prices(source.replace("二人间35元/床日，", ""))

    def test_activity_tiers_are_cumulative_at_both_boundaries(self):
        tiers = [{"lowerInclusive": 1, "upperInclusive": 10, "rateCnyPerSourceUnit": "59.00"},
                 {"lowerInclusive": 11, "upperInclusive": 50, "rateCnyPerSourceUnit": "47.20"},
                 {"lowerInclusive": 51, "upperInclusive": 100, "rateCnyPerSourceUnit": "38.35"}]
        expected = {1: "59.00", 10: "590.00", 11: "637.20", 50: "2478.00", 51: "2516.35", 100: "4395.50"}
        for activity, amount in expected.items():
            self.assertEqual(tier_example(activity, tiers), Decimal(amount))
        for invalid in [0, 101, 10.5, "11"]:
            with self.assertRaises(ValueError):
                tier_example(invalid, tiers)


if __name__ == "__main__":
    unittest.main()
