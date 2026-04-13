"""Tests for scalehouse.audit."""

import json
from pathlib import Path

import pytest

from scalehouse.audit import AuditAction, AuditEvent, AuditLog


class TestAuditEvent:
    def test_to_dict_round_trip(self):
        event = AuditEvent(
            action=AuditAction.TRANSACTION_CREATED,
            entity_id="txn-123",
            actor="operator1",
            details={"type": "BUY"},
        )
        d = event.to_dict()
        restored = AuditEvent.from_dict(d)
        assert restored.action == AuditAction.TRANSACTION_CREATED
        assert restored.entity_id == "txn-123"
        assert restored.actor == "operator1"
        assert restored.details == {"type": "BUY"}
        assert restored.event_id == event.event_id

    def test_str_contains_key_info(self):
        event = AuditEvent(
            action=AuditAction.PRICE_UPDATED,
            entity_id="mat-abc",
            actor="admin",
        )
        s = str(event)
        assert "admin" in s
        assert "PRICE_UPDATED" in s


class TestAuditLog:
    def test_record_and_retrieve(self):
        log = AuditLog()
        event = log.record(
            AuditAction.CUSTOMER_CREATED,
            entity_id="c-1",
            actor="op",
            details={"name": "Bob"},
        )
        assert len(log) == 1
        assert log.all_events()[0] is event

    def test_events_for_entity(self):
        log = AuditLog()
        log.record(AuditAction.TRANSACTION_CREATED, entity_id="txn-1", actor="op")
        log.record(AuditAction.LINE_ADDED, entity_id="txn-1", actor="op")
        log.record(AuditAction.TRANSACTION_COMPLETED, entity_id="txn-2", actor="op")
        assert len(log.events_for("txn-1")) == 2
        assert len(log.events_for("txn-2")) == 1

    def test_events_by_actor(self):
        log = AuditLog()
        log.record(AuditAction.MATERIAL_CREATED, entity_id="m-1", actor="alice")
        log.record(AuditAction.PRICE_UPDATED, entity_id="m-1", actor="bob")
        log.record(AuditAction.MATERIAL_UPDATED, entity_id="m-1", actor="alice")
        assert len(log.events_by_actor("alice")) == 2
        assert len(log.events_by_actor("bob")) == 1

    def test_iteration(self):
        log = AuditLog()
        log.record(AuditAction.TRANSACTION_VOIDED, entity_id="x", actor="op")
        events = list(log)
        assert len(events) == 1

    def test_file_persistence(self, tmp_path: Path):
        filepath = tmp_path / "audit.jsonl"
        log = AuditLog(filepath=filepath)
        log.record(AuditAction.CUSTOMER_CREATED, entity_id="c-1", actor="op")
        log.record(AuditAction.PRICE_UPDATED, entity_id="m-1", actor="op")

        # File should exist and contain 2 JSON lines
        lines = filepath.read_text().strip().splitlines()
        assert len(lines) == 2
        for line in lines:
            obj = json.loads(line)
            assert "action" in obj
            assert "timestamp" in obj

    def test_file_load_on_construction(self, tmp_path: Path):
        filepath = tmp_path / "audit.jsonl"

        # Write one event, then re-open the log
        log1 = AuditLog(filepath=filepath)
        log1.record(AuditAction.TRANSACTION_CREATED, entity_id="t-1", actor="op")

        log2 = AuditLog(filepath=filepath)
        assert len(log2) == 1
        assert log2.all_events()[0].entity_id == "t-1"

    def test_malformed_line_skipped(self, tmp_path: Path):
        filepath = tmp_path / "audit.jsonl"
        filepath.write_text('{"action": "TRANSACTION_CREATED", "entity_id": "t-1", "actor": "op", "details": {}, "event_id": "e-1", "timestamp": "2024-01-01T00:00:00"}\nnot json at all\n')
        log = AuditLog(filepath=filepath)
        assert len(log) == 1


class TestAuditLogReviewWrite:
    def test_events_by_action(self):
        log = AuditLog()
        log.record(AuditAction.TRANSACTION_CREATED, entity_id="t-1", actor="op")
        log.record(AuditAction.LINE_ADDED, entity_id="t-1", actor="op")
        log.record(AuditAction.TRANSACTION_COMPLETED, entity_id="t-1", actor="op")
        log.record(AuditAction.LINE_ADDED, entity_id="t-2", actor="op")

        created = log.events_by_action(AuditAction.TRANSACTION_CREATED)
        lines = log.events_by_action(AuditAction.LINE_ADDED)
        assert len(created) == 1
        assert len(lines) == 2

    def test_events_by_action_no_match(self):
        log = AuditLog()
        log.record(AuditAction.TRANSACTION_CREATED, entity_id="t-1", actor="op")
        assert log.events_by_action(AuditAction.TRANSACTION_VOIDED) == []

    def test_events_in_range(self):
        log = AuditLog()
        early = log.record(AuditAction.CUSTOMER_CREATED, entity_id="c-1", actor="op")
        middle = log.record(AuditAction.MATERIAL_CREATED, entity_id="m-1", actor="op")
        late = log.record(AuditAction.PRICE_UPDATED, entity_id="m-1", actor="op")

        results = log.events_in_range(early.timestamp, middle.timestamp)
        assert early in results
        assert middle in results
        assert late not in results

    def test_events_in_range_all(self):
        log = AuditLog()
        e1 = log.record(AuditAction.TRANSACTION_CREATED, entity_id="t-1", actor="op")
        e2 = log.record(AuditAction.TRANSACTION_COMPLETED, entity_id="t-1", actor="op")

        results = log.events_in_range(e1.timestamp, e2.timestamp)
        assert len(results) == 2

    def test_write_report_creates_file(self, tmp_path: Path):
        log = AuditLog()
        log.record(
            AuditAction.CUSTOMER_CREATED,
            entity_id="c-1",
            actor="alice",
            details={"name": "Bob"},
        )
        log.record(AuditAction.PRICE_UPDATED, entity_id="m-1", actor="bob")

        report_path = tmp_path / "report.txt"
        log.write_report(report_path)

        assert report_path.exists()
        content = report_path.read_text(encoding="utf-8")
        assert "2 event(s)" in content
        assert "CUSTOMER_CREATED" in content
        assert "PRICE_UPDATED" in content
        assert "alice" in content
        assert "name: Bob" in content

    def test_write_report_overwrites_existing(self, tmp_path: Path):
        log = AuditLog()
        log.record(AuditAction.LINE_ADDED, entity_id="t-1", actor="op")

        report_path = tmp_path / "report.txt"
        report_path.write_text("old content")

        log.write_report(report_path)
        content = report_path.read_text(encoding="utf-8")
        assert "old content" not in content
        assert "LINE_ADDED" in content

    def test_write_report_empty_log(self, tmp_path: Path):
        log = AuditLog()
        report_path = tmp_path / "empty_report.txt"
        log.write_report(report_path)

        content = report_path.read_text(encoding="utf-8")
        assert "0 event(s)" in content
