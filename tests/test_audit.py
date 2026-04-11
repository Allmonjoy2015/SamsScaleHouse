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
