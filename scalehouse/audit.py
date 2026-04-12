"""Audit logging for the SamsScaleHouse POS system.

Every significant action (transaction created, completed, voided, line added,
customer or material edited) is recorded as an immutable ``AuditEvent``.
Events are stored in-memory by ``AuditLog`` and can be persisted to a
newline-delimited JSON file.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Iterator, List, Optional


class AuditAction(str, Enum):
    TRANSACTION_CREATED = "TRANSACTION_CREATED"
    TRANSACTION_COMPLETED = "TRANSACTION_COMPLETED"
    TRANSACTION_VOIDED = "TRANSACTION_VOIDED"
    LINE_ADDED = "LINE_ADDED"
    CUSTOMER_CREATED = "CUSTOMER_CREATED"
    CUSTOMER_UPDATED = "CUSTOMER_UPDATED"
    MATERIAL_CREATED = "MATERIAL_CREATED"
    MATERIAL_UPDATED = "MATERIAL_UPDATED"
    PRICE_UPDATED = "PRICE_UPDATED"
    CATCONV_PURCHASE_RECORDED = "CATCONV_PURCHASE_RECORDED"
    VEHICLE_COMPLIANCE_RECORDED = "VEHICLE_COMPLIANCE_RECORDED"
    VEHICLE_THREE_DAY_HOLD_APPLIED = "VEHICLE_THREE_DAY_HOLD_APPLIED"


@dataclass
class AuditEvent:
    """An immutable record of a single auditable action."""

    action: AuditAction
    entity_id: str
    actor: str
    details: dict = field(default_factory=dict)
    event_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict:
        d = asdict(self)
        d["action"] = self.action.value
        d["timestamp"] = self.timestamp.isoformat()
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "AuditEvent":
        d = dict(d)
        d["action"] = AuditAction(d["action"])
        d["timestamp"] = datetime.fromisoformat(d["timestamp"])
        return cls(**d)

    def __str__(self) -> str:
        return (
            f"[{self.timestamp.isoformat(timespec='seconds')}] "
            f"{self.actor} – {self.action.value} – {self.entity_id[:8]}"
        )


class AuditLog:
    """In-memory audit log with optional file persistence.

    Parameters
    ----------
    filepath:
        If provided, events are appended to this file as newline-delimited
        JSON (one JSON object per line).  Existing content is loaded on
        construction.
    """

    def __init__(self, filepath: Optional[Path] = None) -> None:
        self._events: List[AuditEvent] = []
        self._filepath = filepath
        if filepath and filepath.exists():
            self._load(filepath)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def record(
        self,
        action: AuditAction,
        entity_id: str,
        actor: str,
        details: Optional[dict] = None,
    ) -> AuditEvent:
        """Create and store a new audit event."""
        event = AuditEvent(
            action=action,
            entity_id=entity_id,
            actor=actor,
            details=details or {},
        )
        self._events.append(event)
        if self._filepath:
            self._append(event)
        return event

    def events_for(self, entity_id: str) -> list[AuditEvent]:
        """Return all events for a specific entity (transaction, customer, …)."""
        return [e for e in self._events if e.entity_id == entity_id]

    def events_by_actor(self, actor: str) -> list[AuditEvent]:
        """Return all events recorded by a specific actor."""
        return [e for e in self._events if e.actor == actor]

    def all_events(self) -> list[AuditEvent]:
        """Return a copy of all recorded events in chronological order."""
        return list(self._events)

    def events_by_action(self, action: AuditAction) -> list[AuditEvent]:
        """Return all events with the given action type."""
        return [e for e in self._events if e.action == action]

    def events_in_range(
        self,
        start: datetime,
        end: datetime,
    ) -> list[AuditEvent]:
        """Return events whose timestamp falls within [start, end] (inclusive).

        Both *start* and *end* must be timezone-aware ``datetime`` objects.
        """
        return [e for e in self._events if start <= e.timestamp <= end]

    def write_report(self, filepath: Path) -> None:
        """Write a human-readable audit report to *filepath*.

        The report lists every recorded event, one per line, in chronological
        order.  The file is overwritten if it already exists.

        Parameters
        ----------
        filepath:
            Destination path for the report (e.g. ``audit_report.txt``).
        """
        with filepath.open("w", encoding="utf-8") as fh:
            fh.write(f"Audit Report — {len(self._events)} event(s)\n")
            fh.write("=" * 60 + "\n")
            for event in self._events:
                fh.write(str(event) + "\n")
                if event.details:
                    for k, v in event.details.items():
                        fh.write(f"    {k}: {v}\n")

    def __iter__(self) -> Iterator[AuditEvent]:
        return iter(self._events)

    def __len__(self) -> int:
        return len(self._events)

    # ------------------------------------------------------------------
    # Persistence helpers
    # ------------------------------------------------------------------

    def _append(self, event: AuditEvent) -> None:
        with self._filepath.open("a", encoding="utf-8") as fh:  # type: ignore[union-attr]
            fh.write(json.dumps(event.to_dict()) + "\n")

    def _load(self, filepath: Path) -> None:
        with filepath.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    try:
                        self._events.append(AuditEvent.from_dict(json.loads(line)))
                    except (json.JSONDecodeError, KeyError, ValueError):
                        pass  # skip malformed lines
