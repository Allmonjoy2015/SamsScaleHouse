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


class SellerAuthorizationType(str, Enum):
    """Authorized seller categories for detached catalytic converters (TN Code § 62-9)."""

    DISMANTLER_RECYCLER = "dismantler_recycler"
    SCRAP_METAL_DEALER = "scrap_metal_dealer"
    MOTOR_VEHICLE_DEALER = "motor_vehicle_dealer"
    MECHANIC_REPAIR = "mechanic_repair"
    LICENSED_BUSINESS = "licensed_business"
    INDIVIDUAL_REPLACEMENT = "individual_replacement"
    CLEAN_AIR_ACT_EXEMPT = "clean_air_act_exempt"


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


@dataclass
class CatalyticConverterPurchase:
    """Compliance record for detached catalytic converter purchases (TN Code § 62-9).

    Tennessee law effective July 1, 2021 requires scrap metal dealers to verify
    seller authorization and maintain documentation for all detached catalytic
    converter transactions.
    """

    transaction_id: str
    seller_authorization_type: SellerAuthorizationType
    seller_license_number: str = ""
    vehicle_registration_doc: str = ""
    clean_air_act_exempt: bool = False
    clean_air_act_cert_info: str = ""
    seller_documentation_notes: str = ""
    notification_sent: bool = False
    record_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def __post_init__(self) -> None:
        if not self.clean_air_act_exempt and self.seller_authorization_type == SellerAuthorizationType.CLEAN_AIR_ACT_EXEMPT:
            raise ValueError(
                "seller_authorization_type cannot be CLEAN_AIR_ACT_EXEMPT "
                "when clean_air_act_exempt is False"
            )

    def __str__(self) -> str:
        return (
            f"CatalyticConverterPurchase(txn={self.transaction_id[:8]}, "
            f"auth={self.seller_authorization_type.value})"
        )


@dataclass
class VehiclePurchaseCompliance:
    """Compliance record for vehicle purchases per TN Code § 55-3-203.

    Tracks seller certification, thumbprint collection, NMVTIS reporting,
    and the mandatory 3-day hold for 12+ year vehicles without title.
    """

    vehicle_purchase_id: str
    seller_thumbprint_collected: bool = False
    seller_certification_signed: bool = False
    nmvtis_reported: bool = False
    nmvtis_report_date: Optional[datetime] = None
    transporting_vehicle_plate: str = ""
    consideration_amount: float = 0.0
    three_day_hold_required: bool = False
    three_day_hold_start: Optional[datetime] = None
    three_day_hold_expiry: Optional[datetime] = None
    record_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def __post_init__(self) -> None:
        if self.consideration_amount < 0:
            raise ValueError("consideration_amount must be non-negative")

    def __str__(self) -> str:
        return (
            f"VehiclePurchaseCompliance(vp={self.vehicle_purchase_id[:8]}, "
            f"thumbprint={self.seller_thumbprint_collected}, "
            f"cert={self.seller_certification_signed})"
        )
