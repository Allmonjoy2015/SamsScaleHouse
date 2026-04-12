"""Tests for scalehouse.scrap_sort_ai."""

from __future__ import annotations

import pytest

from scalehouse.scrap_sort_ai import Observation, ScrapSortAI


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def ai(tmp_path):
    """Return a fresh ScrapSortAI instance backed by a temp DB."""
    return ScrapSortAI(db_path=str(tmp_path / "test_scrap.db"))


# ---------------------------------------------------------------------------
# Observation dataclass
# ---------------------------------------------------------------------------

class TestObservation:
    def test_defaults_are_none(self):
        obs = Observation()
        assert obs.magnetic is None
        assert obs.spark is None
        assert obs.rust is None
        assert obs.color is None
        assert obs.density_g_cm3 is None
        assert obs.conductivity is None
        assert obs.coating_dirty is None

    def test_fields_set_correctly(self):
        obs = Observation(
            magnetic=True,
            spark="branchy",
            rust=False,
            color="gray",
            density_g_cm3=7.8,
            conductivity="low",
            coating_dirty=True,
        )
        assert obs.magnetic is True
        assert obs.spark == "branchy"
        assert obs.rust is False
        assert obs.color == "gray"
        assert obs.density_g_cm3 == pytest.approx(7.8)
        assert obs.conductivity == "low"
        assert obs.coating_dirty is True


# ---------------------------------------------------------------------------
# ScrapSortAI._density_band
# ---------------------------------------------------------------------------

class TestDensityBand:
    def test_none_returns_unknown(self):
        assert ScrapSortAI._density_band(None) == "unknown"

    def test_light_below_3_5(self):
        assert ScrapSortAI._density_band(1.0) == "light"
        assert ScrapSortAI._density_band(3.4) == "light"

    def test_mid_between_3_5_and_6_5(self):
        assert ScrapSortAI._density_band(3.5) == "mid"
        assert ScrapSortAI._density_band(5.0) == "mid"
        assert ScrapSortAI._density_band(6.4) == "mid"

    def test_heavy_at_or_above_6_5(self):
        assert ScrapSortAI._density_band(6.5) == "heavy"
        assert ScrapSortAI._density_band(11.3) == "heavy"


# ---------------------------------------------------------------------------
# ScrapSortAI predict / classify
# ---------------------------------------------------------------------------

class TestPredict:
    def test_returns_both_labels(self, ai):
        obs = Observation(magnetic=True, rust=True, color="gray")
        probs = ai.predict(obs)
        assert set(probs.keys()) == {"ferrous", "non_ferrous"}

    def test_probabilities_sum_to_one(self, ai):
        obs = Observation(magnetic=False, color="red")
        probs = ai.predict(obs)
        assert sum(probs.values()) == pytest.approx(1.0, abs=1e-6)

    def test_ferrous_signals_yield_ferrous(self, ai):
        obs = Observation(
            magnetic=True,
            spark="branchy",
            rust=True,
            color="gray",
            density_g_cm3=7.4,
            conductivity="low",
        )
        probs = ai.predict(obs)
        assert probs["ferrous"] > probs["non_ferrous"]

    def test_non_ferrous_signals_yield_non_ferrous(self, ai):
        obs = Observation(
            magnetic=False,
            spark="none",
            rust=False,
            color="red",
            density_g_cm3=2.7,
            conductivity="high",
        )
        probs = ai.predict(obs)
        assert probs["non_ferrous"] > probs["ferrous"]

    def test_all_unknown_still_returns_probs(self, ai):
        probs = ai.predict(Observation())
        assert sum(probs.values()) == pytest.approx(1.0, abs=1e-6)


class TestClassify:
    def test_result_keys(self, ai):
        result = ai.classify(Observation(magnetic=True))
        assert {"prediction", "confidence", "probabilities", "next_tests"} == set(result)

    def test_prediction_is_valid_label(self, ai):
        result = ai.classify(Observation(magnetic=False, color="yellow"))
        assert result["prediction"] in ("ferrous", "non_ferrous")

    def test_confidence_in_range(self, ai):
        result = ai.classify(Observation(magnetic=True, rust=True))
        assert 0.0 <= result["confidence"] <= 1.0

    def test_missing_magnetic_suggests_magnet_test(self, ai):
        result = ai.classify(Observation())
        assert any("magnet" in t.lower() for t in result["next_tests"])

    def test_missing_spark_suggests_spark_test(self, ai):
        result = ai.classify(Observation(magnetic=True))
        assert any("spark" in t.lower() for t in result["next_tests"])

    def test_missing_density_suggests_density_test(self, ai):
        result = ai.classify(Observation(magnetic=True, spark="branchy"))
        assert any("density" in t.lower() for t in result["next_tests"])

    def test_dirty_coating_suggests_cleaning(self, ai):
        result = ai.classify(Observation(coating_dirty=True))
        assert any("clean" in t.lower() for t in result["next_tests"])

    def test_no_extra_tests_for_full_observation(self, ai):
        # A fully specified, high-confidence ferrous piece should have no tests
        # suggested for missing fields (though XRF may still appear if conf < 0.70).
        obs = Observation(
            magnetic=True,
            spark="branchy",
            rust=True,
            color="gray",
            density_g_cm3=7.8,
            conductivity="low",
            coating_dirty=False,
        )
        result = ai.classify(obs)
        # Magnet / spark / density hints must not appear
        hints = " ".join(result["next_tests"]).lower()
        assert "magnet" not in hints
        assert "spark" not in hints
        assert "density" not in hints
        assert "clean" not in hints

    def test_probabilities_sum_to_one(self, ai):
        result = ai.classify(Observation(magnetic=False))
        total = sum(result["probabilities"].values())
        assert total == pytest.approx(1.0, abs=1e-4)


# ---------------------------------------------------------------------------
# ScrapSortAI learn
# ---------------------------------------------------------------------------

class TestLearn:
    def test_learn_updates_prior(self, ai):
        obs = Observation(magnetic=True, color="gray")
        priors_before = ai._get_prior_counts()
        ai.learn(obs, true_label="ferrous")
        priors_after = ai._get_prior_counts()
        assert priors_after["ferrous"] == priors_before["ferrous"] + 1

    def test_learn_shifts_prediction(self, ai):
        # Repeatedly teach the model that red non-magnetic pieces are non_ferrous
        obs = Observation(magnetic=False, color="red", spark="none", rust=False)
        for _ in range(20):
            ai.learn(obs, true_label="non_ferrous")
        result = ai.classify(obs)
        assert result["prediction"] == "non_ferrous"

    def test_learn_invalid_label_raises(self, ai):
        with pytest.raises(ValueError, match="true_label must be"):
            ai.learn(Observation(), true_label="unknown_metal")

    def test_learn_writes_feedback_log(self, ai):
        import sqlite3

        obs = Observation(magnetic=True)
        ai.learn(obs, true_label="ferrous", pred_label="non_ferrous", pred_conf=0.55)

        con = sqlite3.connect(ai.db_path)
        cur = con.cursor()
        cur.execute("SELECT label_pred, label_true, confidence FROM feedback_log")
        row = cur.fetchone()
        con.close()

        assert row is not None
        assert row[0] == "non_ferrous"
        assert row[1] == "ferrous"
        assert abs(row[2] - 0.55) < 1e-6

    def test_learn_then_classify_improves_confidence(self, ai):
        obs = Observation(magnetic=True, spark="branchy", rust=True, color="gray")
        conf_before = ai.classify(obs)["confidence"]
        for _ in range(10):
            ai.learn(obs, true_label="ferrous")
        conf_after = ai.classify(obs)["confidence"]
        assert conf_after >= conf_before


# ---------------------------------------------------------------------------
# ScrapSortAI recommend_sorting_line
# ---------------------------------------------------------------------------

class TestRecommendSortingLine:
    def test_returns_list(self, ai):
        steps = ai.recommend_sorting_line()
        assert isinstance(steps, list)
        assert len(steps) > 0

    def test_magnetic_step_always_present(self, ai):
        steps = ai.recommend_sorting_line(high_contamination=False)
        assert any("magnetic" in s.lower() for s in steps)

    def test_pre_clean_step_present_when_high_contamination(self, ai):
        steps = ai.recommend_sorting_line(high_contamination=True)
        assert any("pre-clean" in s.lower() for s in steps)

    def test_pre_clean_step_absent_when_low_contamination(self, ai):
        steps = ai.recommend_sorting_line(high_contamination=False)
        assert not any("pre-clean" in s.lower() for s in steps)

    def test_xrf_mentioned_when_separating_cast_wrought(self, ai):
        steps = ai.recommend_sorting_line(
            high_contamination=True, separate_cast_wrought_al=True
        )
        assert any("xrf" in s.lower() for s in steps)

    def test_xrf_absent_when_not_separating_cast_wrought(self, ai):
        steps = ai.recommend_sorting_line(
            high_contamination=True, separate_cast_wrought_al=False
        )
        assert not any("xrf" in s.lower() for s in steps)

    def test_manual_qc_lane_present(self, ai):
        steps = ai.recommend_sorting_line()
        assert any("manual" in s.lower() for s in steps)
