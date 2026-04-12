---
# Fill in the fields below to create a basic custom agent for your repository.
# The Copilot CLI can be used for local testing: https://gh.io/customagents/cli
# To make this agent available, merge this file into the default repository branch.
# For format details, see: https://gh.io/customagents/config

name:
description:
Compliance and Knowledge of Automobile AI

# My Agent

Describe what your agent does here.
# scrap_compliance_agent.py
# Python 3.11+

import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

DB_PATH = "scrap_ai.db"
RULES_PATH = "tca_rules.json"


@dataclass
class ComplianceFinding:
    rule_id: str
    citation: str
    severity: str
    confidence: float
    message: str
    suggested_edit: str


class ScrapComplianceAI:
    def __init__(self, db_path: str = DB_PATH, rules_path: str = RULES_PATH):
        self.db_path = db_path
        self.rules_path = rules_path
        self.rules = self._load_rules()
        self._init_db()

    # --------------------------
    # Setup
    # --------------------------
    def _load_rules(self) -> List[Dict[str, Any]]:
        if not Path(self.rules_path).exists():
            # bootstrap starter rules file
            starter = [
                {
                    "id": "TCA-SCRAP-001",
                    "citation": "T.C.A. <insert exact citation>",
                    "title": "Seller identity capture",
                    "severity": "high",
                    "keywords": ["seller", "identity", "id", "driver license", "purchase"],
                    "required_controls": ["capture_seller_id", "store_id_expiration", "audit_log_entry"],
                    "suggestion_template": "Add required seller identity fields and audit logging before transaction finalization."
                },
                {
                    "id": "TCA-SCRAP-002",
                    "citation": "T.C.A. <insert exact citation>",
                    "title": "Transaction record retention",
                    "severity": "high",
                    "keywords": ["record", "retention", "delete", "purge", "transaction"],
                    "required_controls": ["retention_policy_enforced", "immutable_transaction_history"],
                    "suggestion_template": "Enforce retention window and prevent early deletion of regulated transaction records."
                },
                {
                    "id": "TCA-SCRAP-003",
                    "citation": "T.C.A. <insert exact citation>",
                    "title": "Law enforcement reporting flow",
                    "severity": "medium",
                    "keywords": ["report", "law enforcement", "suspicious", "stolen", "flag"],
                    "required_controls": ["reporting_queue", "timestamped_submission"],
                    "suggestion_template": "Add reporting workflow with timestamp and status tracking for required submissions."
                }
            ]
            Path(self.rules_path).write_text(json.dumps(starter, indent=2), encoding="utf-8")
            return starter
        return json.loads(Path(self.rules_path).read_text(encoding="utf-8"))

    def _init_db(self):
        con = sqlite3.connect(self.db_path)
        cur = con.cursor()

        cur.execute("""
            CREATE TABLE IF NOT EXISTS feedback (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                rule_id TEXT NOT NULL,
                accepted INTEGER NOT NULL,
                note TEXT,
                created_at TEXT NOT NULL
            )
        """)

        cur.execute("""
            CREATE TABLE IF NOT EXISTS vehicles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                make TEXT NOT NULL,
                model TEXT NOT NULL,
                year INTEGER NOT NULL,
                trim TEXT,
                curb_weight_lbs REAL,
                wheel_material TEXT, -- alloy | steel | unknown
                source TEXT,
                last_seen TEXT NOT NULL,
                UNIQUE(make, model, year, IFNULL(trim, ''))
            )
        """)

        con.commit()
        con.close()

    # --------------------------
    # Compliance Engine
    # --------------------------
    def review_change(self, change_text: str, module_name: str = "unknown") -> List[ComplianceFinding]:
        text = change_text.lower()
        findings: List[ComplianceFinding] = []

        for rule in self.rules:
            matched_keywords = [k for k in rule["keywords"] if k.lower() in text]
            if not matched_keywords:
                continue

            missing_controls = self._missing_controls(rule["required_controls"], text)
            if missing_controls:
                base_conf = 0.65 + min(0.3, 0.05 * len(matched_keywords))
                learned_bias = self._rule_acceptance_bias(rule["id"])  # continuous learning
                confidence = max(0.05, min(0.99, base_conf + learned_bias))

                findings.append(
                    ComplianceFinding(
                        rule_id=rule["id"],
                        citation=rule["citation"],
                        severity=rule["severity"],
                        confidence=round(confidence, 3),
                        message=(
                            f"{rule['title']} may be incomplete in module '{module_name}'. "
                            f"Missing controls: {', '.join(missing_controls)}."
                        ),
                        suggested_edit=rule["suggestion_template"]
                    )
                )

        return sorted(findings, key=lambda x: (x.severity, x.confidence), reverse=True)

    def _missing_controls(self, required_controls: List[str], text: str) -> List[str]:
        return [c for c in required_controls if c.lower() not in text]

    def _rule_acceptance_bias(self, rule_id: str) -> float:
        """
        Learns from accepted/rejected suggestions.
        Returns bias in [-0.25, +0.25].
        """
        con = sqlite3.connect(self.db_path)
        cur = con.cursor()
        cur.execute("SELECT accepted FROM feedback WHERE rule_id = ?", (rule_id,))
        rows = cur.fetchall()
        con.close()

        if not rows:
            return 0.0

        accepted = sum(r[0] for r in rows)
        total = len(rows)
        rate = accepted / total  # [0..1]
        return (rate - 0.5) * 0.5  # scale to [-0.25..0.25]

    def record_feedback(self, rule_id: str, accepted: bool, note: str = ""):
        con = sqlite3.connect(self.db_path)
        cur = con.cursor()
        cur.execute(
            "INSERT INTO feedback(rule_id, accepted, note, created_at) VALUES (?, ?, ?, ?)",
            (rule_id, 1 if accepted else 0, note, datetime.utcnow().isoformat())
        )
        con.commit()
        con.close()

    # --------------------------
    # Vehicle Knowledge Engine
    # --------------------------
    def upsert_vehicle(
        self,
        make: str,
        model: str,
        year: int,
        trim: Optional[str],
        curb_weight_lbs: Optional[float],
        wheel_material: Optional[str],
        source: str = "manual"
    ):
        wm = self._normalize_wheel_material(wheel_material, trim or "")
        con = sqlite3.connect(self.db_path)
        cur = con.cursor()

        cur.execute("""
            INSERT INTO vehicles(make, model, year, trim, curb_weight_lbs, wheel_material, source, last_seen)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(make, model, year, IFNULL(trim, '')) DO UPDATE SET
                curb_weight_lbs = COALESCE(excluded.curb_weight_lbs, vehicles.curb_weight_lbs),
                wheel_material = COALESCE(excluded.wheel_material, vehicles.wheel_material),
                source = excluded.source,
                last_seen = excluded.last_seen
        """, (
            make.strip().lower(),
            model.strip().lower(),
            int(year),
            (trim or "").strip().lower() or None,
            curb_weight_lbs,
            wm,
            source,
            datetime.utcnow().isoformat()
        ))
        con.commit()
        con.close()

    def _normalize_wheel_material(self, wheel_material: Optional[str], trim_hint: str) -> str:
        if wheel_material:
            w = wheel_material.strip().lower()
            if "alloy" in w:
                return "alloy"
            if "steel" in w:
                return "steel"
        t = trim_hint.lower()
        if any(x in t for x in ["sport", "premium", "limited", "touring", "gt", "s-line", "platinum"]):
            return "alloy"
        if any(x in t for x in ["base", "work", "fleet"]):
            return "steel"
        return "unknown"

    def get_vehicle(self, make: str, model: str, year: int, trim: Optional[str] = None) -> Optional[Dict[str, Any]]:
        con = sqlite3.connect(self.db_path)
        cur = con.cursor()
        cur.execute("""
            SELECT make, model, year, trim, curb_weight_lbs, wheel_material, source, last_seen
            FROM vehicles
            WHERE make=? AND model=? AND year=? AND IFNULL(trim, '')=IFNULL(?, '')
            LIMIT 1
        """, (make.strip().lower(), model.strip().lower(), int(year), (trim or "").strip().lower() or None))
        row = cur.fetchone()
        con.close()

        if not row:
            return None
        return {
            "make": row[0], "model": row[1], "year": row[2], "trim": row[3],
            "curb_weight_lbs": row[4], "wheel_material": row[5],
            "source": row[6], "last_seen": row[7]
        }

    def search_vehicle(self, make: str = "", model: str = "", year: Optional[int] = None) -> List[Dict[str, Any]]:
        con = sqlite3.connect(self.db_path)
        cur = con.cursor()
        q = "SELECT make, model, year, trim, curb_weight_lbs, wheel_material FROM vehicles WHERE 1=1"
        params: List[Any] = []
        if make:
            q += " AND make = ?"
            params.append(make.strip().lower())
        if model:
            q += " AND model = ?"
            params.append(model.strip().lower())
        if year is not None:
            q += " AND year = ?"
            params.append(int(year))

        cur.execute(q, params)
        rows = cur.fetchall()
        con.close()
        return [
            {
                "make": r[0], "model": r[1], "year": r[2], "trim": r[3],
                "curb_weight_lbs": r[4], "wheel_material": r[5]
            } for r in rows
        ]


if __name__ == "__main__":
    ai = ScrapComplianceAI()

    # Example: review a code change/diff text
    proposed_change = """
    def finalize_purchase(txn):
        # capture seller name only
        save_transaction(txn)
        if txn.flag_stolen:
            enqueue_report(txn.id)
    """

    findings = ai.review_change(proposed_change, module_name="purchase_flow.py")
    print("=== Compliance Findings ===")
    for f in findings:
        print(f"- [{f.severity.upper()}] {f.rule_id} ({f.citation}) confidence={f.confidence}")
        print(f"  {f.message}")
        print(f"  Suggestion: {f.suggested_edit}")

    # Feedback loop (continuous learning)
    if findings:
        ai.record_feedback(findings[0].rule_id, accepted=True, note="good catch")

    # Example: vehicle knowledge
    ai.upsert_vehicle("Ford", "F-150", 2021, "XLT", 4769, "alloy", source="oem_spec_sheet")
    ai.upsert_vehicle("Chevrolet", "Silverado 1500", 2020, "Work Truck", 4520, None, source="auction_feed")
    print("\n=== Vehicle Query ===")
    print(ai.get_vehicle("Ford", "F-150", 2021, "XLT"))
    print(ai.search_vehicle(make="chevrolet"))
