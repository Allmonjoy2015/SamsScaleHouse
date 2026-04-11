"""Core data models for the SamsScaleHouse POS system."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Optional


class TransactionType(str, Enum):
    """Whether the yard is buying scrap from a customer or selling it."""

    BUY = "BUY"
    SELL = "SELL"


class TransactionStatus(str, Enum):
    PENDING = "PENDING"
    COMPLETED = "COMPLETED"
    VOIDED = "VOIDED"


@dataclass
class Customer:
    """Represents a scrap yard customer (individual or business)."""

    name: str
    phone: str = ""
    id_number: str = ""  # government-issued ID for compliance
    customer_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def __str__(self) -> str:
        return f"Customer({self.name!r}, id={self.customer_id[:8]})"


@dataclass
class Material:
    """A type of scrap material with a unit price (per pound)."""

    name: str
    price_per_lb: float  # USD
    material_id: str = field(default_factory=lambda: str(uuid.uuid4()))

    def __post_init__(self) -> None:
        if self.price_per_lb < 0:
            raise ValueError("price_per_lb must be non-negative")

    def __str__(self) -> str:
        return f"Material({self.name!r}, ${self.price_per_lb:.4f}/lb)"


@dataclass
class WeightReading:
    """A single weight measurement captured from the scale."""

    gross_weight_lbs: float
    tare_weight_lbs: float = 0.0
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def __post_init__(self) -> None:
        if self.gross_weight_lbs < 0:
            raise ValueError("gross_weight_lbs must be non-negative")
        if self.tare_weight_lbs < 0:
            raise ValueError("tare_weight_lbs must be non-negative")
        if self.tare_weight_lbs > self.gross_weight_lbs:
            raise ValueError("tare_weight_lbs cannot exceed gross_weight_lbs")

    @property
    def net_weight_lbs(self) -> float:
        """Net weight after subtracting tare (container/vehicle weight)."""
        return self.gross_weight_lbs - self.tare_weight_lbs


@dataclass
class TransactionLine:
    """One line in a transaction: a material, its weight, and computed amount."""

    material: Material
    weight: WeightReading
    line_id: str = field(default_factory=lambda: str(uuid.uuid4()))

    @property
    def amount(self) -> float:
        """Dollar amount for this line."""
        return round(self.weight.net_weight_lbs * self.material.price_per_lb, 2)


@dataclass
class Transaction:
    """A complete buy or sell transaction at the scale house."""

    transaction_type: TransactionType
    customer: Customer
    lines: list[TransactionLine] = field(default_factory=list)
    status: TransactionStatus = TransactionStatus.PENDING
    transaction_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    completed_at: Optional[datetime] = None
    notes: str = ""

    @property
    def total_amount(self) -> float:
        """Total dollar amount for all lines."""
        return round(sum(line.amount for line in self.lines), 2)

    @property
    def total_net_weight_lbs(self) -> float:
        """Total net weight across all lines."""
        return sum(line.weight.net_weight_lbs for line in self.lines)

    def add_line(self, line: TransactionLine) -> None:
        """Add a transaction line; only allowed while transaction is PENDING."""
        if self.status != TransactionStatus.PENDING:
            raise ValueError(
                f"Cannot add lines to a {self.status.value} transaction"
            )
        self.lines.append(line)

    def complete(self) -> None:
        """Mark the transaction as completed."""
        if self.status != TransactionStatus.PENDING:
            raise ValueError(
                f"Cannot complete a {self.status.value} transaction"
            )
        if not self.lines:
            raise ValueError("Cannot complete a transaction with no lines")
        self.status = TransactionStatus.COMPLETED
        self.completed_at = datetime.now(timezone.utc)

    def void(self) -> None:
        """Void the transaction."""
        if self.status == TransactionStatus.VOIDED:
            raise ValueError("Transaction is already voided")
        if self.status == TransactionStatus.COMPLETED:
            raise ValueError("Cannot void a completed transaction")
        self.status = TransactionStatus.VOIDED

    def __str__(self) -> str:
        return (
            f"Transaction({self.transaction_type.value}, "
            f"customer={self.customer.name!r}, "
            f"total=${self.total_amount:.2f}, "
            f"status={self.status.value})"
        )
