"""Naive-Bayes scrap-metal sorting AI with SQLite-backed online learning."""

# Python 3.10+

from __future__ import annotations

import math
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, List, Optional


@dataclass
class Observation:
    """Physical observations recorded at the sorting station."""

    magnetic: Optional[bool] = None        # True / False / None
    spark: Optional[str] = None            # "branchy", "few_red", "none", …
    rust: Optional[bool] = None            # True / False / None
    color: Optional[str] = None            # "silver", "red", "yellow", "gray", …
    density_g_cm3: Optional[float] = None  # measured or estimated
    conductivity: Optional[str] = None     # "low", "medium", "high"
    coating_dirty: Optional[bool] = None   # dirty / painted / oily piece


class ScrapSortAI:
    """Incremental Naive-Bayes classifier for ferrous / non-ferrous sorting."""

    LABELS = ("ferrous", "non_ferrous")

    def __init__(self, db_path: str = "scrap_sort_ai.db") -> None:
        self.db_path = db_path
        self._init_db()
        self._bootstrap()

    # ------------------------------------------------------------------
    # DB helpers
    # ------------------------------------------------------------------

    def _conn(self) -> sqlite3.Connection:
        return sqlite3.connect(self.db_path)

    def _init_db(self) -> None:
        con = self._conn()
        cur = con.cursor()
        cur.execute("""
            CREATE TABLE IF NOT EXISTS priors (
                label TEXT PRIMARY KEY,
                count REAL NOT NULL
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS feature_counts (
                label   TEXT NOT NULL,
                feature TEXT NOT NULL,
                value   TEXT NOT NULL,
                count   REAL NOT NULL,
                PRIMARY KEY (label, feature, value)
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS feedback_log (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                label_pred TEXT    NOT NULL,
                label_true TEXT    NOT NULL,
                confidence REAL    NOT NULL,
                obs_json   TEXT    NOT NULL,
                created_at TEXT    NOT NULL
            )
        """)
        con.commit()
        con.close()

    def _bootstrap(self) -> None:
        """Seed the model with lightweight heuristic counts on first run."""
        con = self._conn()
        cur = con.cursor()

        for label in self.LABELS:
            cur.execute(
                "INSERT OR IGNORE INTO priors(label, count) VALUES(?, ?)",
                (label, 10.0),
            )

        seed = [
            # magnetic
            ("ferrous",     "magnetic", "yes",  30.0),
            ("ferrous",     "magnetic", "no",    3.0),
            ("non_ferrous", "magnetic", "yes",   2.0),
            ("non_ferrous", "magnetic", "no",   30.0),
            # rust
            ("ferrous",     "rust", "yes",  24.0),
            ("ferrous",     "rust", "no",    8.0),
            ("non_ferrous", "rust", "yes",   3.0),
            ("non_ferrous", "rust", "no",   26.0),
            # spark
            ("ferrous",     "spark", "branchy", 18.0),
            ("ferrous",     "spark", "few_red", 10.0),
            ("ferrous",     "spark", "none",     2.0),
            ("non_ferrous", "spark", "branchy",  2.0),
            ("non_ferrous", "spark", "few_red",  3.0),
            ("non_ferrous", "spark", "none",    20.0),
            # color
            ("ferrous",     "color", "gray",   16.0),
            ("ferrous",     "color", "silver", 10.0),
            ("non_ferrous", "color", "red",    12.0),   # copper-like
            ("non_ferrous", "color", "yellow", 12.0),   # brass-like
            ("non_ferrous", "color", "silver", 10.0),   # aluminum / stainless
        ]
        for row in seed:
            cur.execute(
                """
                INSERT OR IGNORE INTO feature_counts(label, feature, value, count)
                VALUES (?, ?, ?, ?)
                """,
                row,
            )

        con.commit()
        con.close()

    # ------------------------------------------------------------------
    # Feature engineering
    # ------------------------------------------------------------------

    @staticmethod
    def _density_band(d: Optional[float]) -> str:
        if d is None:
            return "unknown"
        if d < 3.5:
            return "light"
        if d < 6.5:
            return "mid"
        return "heavy"

    def _normalize(self, obs: Observation) -> Dict[str, str]:
        return {
            "magnetic": (
                "yes" if obs.magnetic is True
                else "no" if obs.magnetic is False
                else "unknown"
            ),
            "spark": (obs.spark or "unknown").strip().lower(),
            "rust": (
                "yes" if obs.rust is True
                else "no" if obs.rust is False
                else "unknown"
            ),
            "color": (obs.color or "unknown").strip().lower(),
            "density_band": self._density_band(obs.density_g_cm3),
            "conductivity": (obs.conductivity or "unknown").strip().lower(),
        }

    # ------------------------------------------------------------------
    # Probability helpers
    # ------------------------------------------------------------------

    def _get_prior_counts(self) -> Dict[str, float]:
        con = self._conn()
        cur = con.cursor()
        cur.execute("SELECT label, count FROM priors")
        rows = cur.fetchall()
        con.close()
        return {label: cnt for label, cnt in rows}

    def _get_feature_count(self, label: str, feature: str, value: str) -> float:
        con = self._conn()
        cur = con.cursor()
        cur.execute(
            "SELECT count FROM feature_counts WHERE label=? AND feature=? AND value=?",
            (label, feature, value),
        )
        row = cur.fetchone()
        con.close()
        return row[0] if row else 0.0

    def _get_feature_total(self, label: str, feature: str) -> float:
        con = self._conn()
        cur = con.cursor()
        cur.execute(
            "SELECT COALESCE(SUM(count), 0) FROM feature_counts WHERE label=? AND feature=?",
            (label, feature),
        )
        val = cur.fetchone()[0]
        con.close()
        return val

    # ------------------------------------------------------------------
    # Inference
    # ------------------------------------------------------------------

    # Approximate vocabulary sizes used for Laplace smoothing
    _VOCAB: Dict[str, int] = {
        "magnetic": 3,
        "spark": 8,
        "rust": 3,
        "color": 10,
        "density_band": 4,
        "conductivity": 5,
    }

    def predict(self, obs: Observation) -> Dict[str, float]:
        """Return a probability dict keyed by label name."""
        x = self._normalize(obs)
        priors = self._get_prior_counts()
        total_prior = sum(priors.values()) + 1e-9

        logp: Dict[str, float] = {}
        for label in self.LABELS:
            lp = math.log(
                (priors.get(label, 1.0) + 1.0) / (total_prior + len(self.LABELS))
            )
            for f, v in x.items():
                c = self._get_feature_count(label, f, v)
                t = self._get_feature_total(label, f)
                p = (c + 1.0) / (t + self._VOCAB.get(f, 8))
                lp += math.log(p)
            logp[label] = lp

        # softmax for calibrated probabilities
        m = max(logp.values())
        probs = {k: math.exp(v - m) for k, v in logp.items()}
        z = sum(probs.values()) + 1e-9
        return {k: v / z for k, v in probs.items()}

    def classify(self, obs: Observation) -> Dict[str, object]:
        """Classify an observation and suggest follow-up tests."""
        probs = self.predict(obs)
        label = max(probs, key=probs.get)  # type: ignore[arg-type]
        conf = probs[label]

        next_tests: List[str] = []
        if obs.magnetic is None:
            next_tests.append("Run a magnet test first.")
        if obs.spark is None:
            next_tests.append(
                "Do a quick grinder spark test (if safe for your workflow)."
            )
        if obs.density_g_cm3 is None:
            next_tests.append(
                "Measure weight and estimate volume for density banding."
            )
        if obs.coating_dirty:
            next_tests.append(
                "Clean a small flat area before instrument testing (XRF/LIBS)."
            )
        if conf < 0.70:
            next_tests.append(
                "Send to uncertainty lane for manual/XRF verification."
            )

        return {
            "prediction": label,
            "confidence": round(conf, 4),
            "probabilities": {k: round(v, 4) for k, v in probs.items()},
            "next_tests": next_tests,
        }

    # ------------------------------------------------------------------
    # Online learning
    # ------------------------------------------------------------------

    def learn(
        self,
        obs: Observation,
        true_label: str,
        pred_label: Optional[str] = None,
        pred_conf: float = 0.0,
    ) -> None:
        """Update model counts from a confirmed label (operator feedback)."""
        if true_label not in self.LABELS:
            raise ValueError("true_label must be 'ferrous' or 'non_ferrous'")

        x = self._normalize(obs)
        con = self._conn()
        cur = con.cursor()

        cur.execute(
            "UPDATE priors SET count=count+1 WHERE label=?",
            (true_label,),
        )
        for f, v in x.items():
            cur.execute(
                """
                INSERT INTO feature_counts(label, feature, value, count)
                VALUES (?, ?, ?, 1)
                ON CONFLICT(label, feature, value) DO UPDATE SET count=count+1
                """,
                (true_label, f, v),
            )

        cur.execute(
            """
            INSERT INTO feedback_log(label_pred, label_true, confidence, obs_json, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                pred_label or "unknown",
                true_label,
                float(pred_conf),
                str(x),
                datetime.now(timezone.utc).isoformat(),
            ),
        )

        con.commit()
        con.close()

    # ------------------------------------------------------------------
    # Yard layout helper
    # ------------------------------------------------------------------

    def recommend_sorting_line(
        self,
        high_contamination: bool = True,
        separate_cast_wrought_al: bool = True,
    ) -> List[str]:
        """Return an ordered list of recommended sorting-line stages."""
        _PRE_CLEAN = "2) Remove bulky non-metals and fines (pre-clean)."
        _SENSOR_XRF = (
            "6) Sensor stage (vision + XRF) for alloy-level sorting and quality grading."
        )
        _SENSOR_VISION = (
            "6) Sensor stage (vision) for quality grading and contaminant rejection."
        )

        steps = [
            "1) Primary magnetic separation to pull ferrous first.",
            _PRE_CLEAN,
            "3) Sink-float stage for non-metal removal and density-based pre-split.",
            "4) Heavy-media split for heavy vs light non-ferrous fractions.",
            "5) Eddy-current separation to recover/purify light non-ferrous stream.",
            _SENSOR_XRF,
            "7) Uncertain pieces route to manual QC lane; corrections feed model retraining.",
        ]

        if not high_contamination:
            steps = [s for s in steps if s != _PRE_CLEAN]

        if not separate_cast_wrought_al:
            steps = [_SENSOR_VISION if s == _SENSOR_XRF else s for s in steps]

        return steps


if __name__ == "__main__":  # pragma: no cover
    ai = ScrapSortAI()

    obs = Observation(
        magnetic=True,
        spark="branchy",
        rust=True,
        color="gray",
        density_g_cm3=7.4,
        conductivity="low",
        coating_dirty=False,
    )

    result = ai.classify(obs)
    print("Classification:", result)

    print("\nRecommended yard sorting line:")
    for s in ai.recommend_sorting_line(high_contamination=True, separate_cast_wrought_al=True):
        print("-", s)

    ai.learn(
        obs,
        true_label="ferrous",
        pred_label=str(result["prediction"]),
        pred_conf=float(result["confidence"]),  # type: ignore[arg-type]
    )
