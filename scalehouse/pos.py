"""Point-of-sale (POS) logic for the SamsScaleHouse.

``POSSession`` is the main entry point for conducting buy/sell transactions.
It wires together a scale, the audit log, and a simple in-memory catalogue of
customers and materials.
"""

from __future__ import annotations

from typing import Dict, List, Optional

from scalehouse.audit import AuditAction, AuditLog
from scalehouse.models import (
    Customer,
    Material,
    Transaction,
    TransactionLine,
    TransactionStatus,
    TransactionType,
    WeightReading,
)
from scalehouse.scale import BaseScale


class POSError(Exception):
    """Raised for business-rule violations in the POS layer."""


class POSSession:
    """Manages customers, materials, and transactions for one shift.

    Parameters
    ----------
    scale:
        The scale adapter to use for weight readings.
    audit_log:
        Audit log instance.  If *None*, a new in-memory log is created.
    operator:
        Name or username of the person operating the terminal.
    """

    def __init__(
        self,
        scale: BaseScale,
        audit_log: Optional[AuditLog] = None,
        operator: str = "system",
    ) -> None:
        self.scale = scale
        self.audit = audit_log if audit_log is not None else AuditLog()
        self.operator = operator

        self._customers: Dict[str, Customer] = {}
        self._materials: Dict[str, Material] = {}
        self._transactions: Dict[str, Transaction] = {}

    # ------------------------------------------------------------------
    # Customer management
    # ------------------------------------------------------------------

    def add_customer(self, name: str, phone: str = "", id_number: str = "") -> Customer:
        """Register a new customer and record the event in the audit log."""
        customer = Customer(name=name, phone=phone, id_number=id_number)
        self._customers[customer.customer_id] = customer
        self.audit.record(
            AuditAction.CUSTOMER_CREATED,
            entity_id=customer.customer_id,
            actor=self.operator,
            details={"name": name, "phone": phone},
        )
        return customer

    def update_customer(self, customer_id: str, **kwargs: str) -> Customer:
        """Update mutable fields on an existing customer."""
        customer = self._get_customer(customer_id)
        old = {"name": customer.name, "phone": customer.phone, "id_number": customer.id_number}
        allowed = {"name", "phone", "id_number"}
        invalid = set(kwargs) - allowed
        if invalid:
            raise POSError(f"Unknown customer fields: {invalid}")
        for k, v in kwargs.items():
            setattr(customer, k, v)
        self.audit.record(
            AuditAction.CUSTOMER_UPDATED,
            entity_id=customer_id,
            actor=self.operator,
            details={"before": old, "after": kwargs},
        )
        return customer

    def get_customer(self, customer_id: str) -> Customer:
        return self._get_customer(customer_id)

    def list_customers(self) -> List[Customer]:
        return list(self._customers.values())

    # ------------------------------------------------------------------
    # Material / price management
    # ------------------------------------------------------------------

    def add_material(self, name: str, price_per_lb: float) -> Material:
        """Add a scrap material type to the catalogue."""
        material = Material(name=name, price_per_lb=price_per_lb)
        self._materials[material.material_id] = material
        self.audit.record(
            AuditAction.MATERIAL_CREATED,
            entity_id=material.material_id,
            actor=self.operator,
            details={"name": name, "price_per_lb": price_per_lb},
        )
        return material

    def update_price(self, material_id: str, new_price: float) -> Material:
        """Update the price per pound for a material."""
        material = self._get_material(material_id)
        old_price = material.price_per_lb
        if new_price < 0:
            raise POSError("Price cannot be negative")
        material.price_per_lb = new_price
        self.audit.record(
            AuditAction.PRICE_UPDATED,
            entity_id=material_id,
            actor=self.operator,
            details={"old_price": old_price, "new_price": new_price},
        )
        return material

    def get_material(self, material_id: str) -> Material:
        return self._get_material(material_id)

    def list_materials(self) -> List[Material]:
        return list(self._materials.values())

    # ------------------------------------------------------------------
    # Transaction workflow
    # ------------------------------------------------------------------

    def start_transaction(
        self,
        transaction_type: TransactionType,
        customer_id: str,
        notes: str = "",
    ) -> Transaction:
        """Open a new PENDING transaction for the given customer."""
        customer = self._get_customer(customer_id)
        txn = Transaction(
            transaction_type=transaction_type,
            customer=customer,
            notes=notes,
        )
        self._transactions[txn.transaction_id] = txn
        self.audit.record(
            AuditAction.TRANSACTION_CREATED,
            entity_id=txn.transaction_id,
            actor=self.operator,
            details={
                "type": transaction_type.value,
                "customer_id": customer_id,
                "customer_name": customer.name,
            },
        )
        return txn

    def weigh_and_add_line(
        self,
        transaction_id: str,
        material_id: str,
        tare_weight_lbs: float = 0.0,
    ) -> TransactionLine:
        """Read the scale, compute net weight, and add a line to the transaction.

        Parameters
        ----------
        transaction_id:
            The transaction to add the line to.
        material_id:
            The scrap material being weighed.
        tare_weight_lbs:
            Override the tare configured on the scale (e.g. a known container
            weight captured earlier in the workflow).
        """
        txn = self._get_transaction(transaction_id)
        material = self._get_material(material_id)

        raw: WeightReading = self.scale.read_weight()
        # Apply caller-supplied tare override when provided.
        if tare_weight_lbs:
            weight = WeightReading(
                gross_weight_lbs=raw.gross_weight_lbs,
                tare_weight_lbs=tare_weight_lbs,
            )
        else:
            weight = raw

        line = TransactionLine(material=material, weight=weight)
        txn.add_line(line)

        self.audit.record(
            AuditAction.LINE_ADDED,
            entity_id=transaction_id,
            actor=self.operator,
            details={
                "material": material.name,
                "gross_lbs": weight.gross_weight_lbs,
                "tare_lbs": weight.tare_weight_lbs,
                "net_lbs": weight.net_weight_lbs,
                "amount": line.amount,
            },
        )
        return line

    def complete_transaction(self, transaction_id: str) -> Transaction:
        """Finalise and close a PENDING transaction."""
        txn = self._get_transaction(transaction_id)
        txn.complete()
        self.audit.record(
            AuditAction.TRANSACTION_COMPLETED,
            entity_id=transaction_id,
            actor=self.operator,
            details={
                "total_amount": txn.total_amount,
                "total_net_weight_lbs": txn.total_net_weight_lbs,
                "line_count": len(txn.lines),
            },
        )
        return txn

    def void_transaction(self, transaction_id: str) -> Transaction:
        """Void a PENDING transaction."""
        txn = self._get_transaction(transaction_id)
        txn.void()
        self.audit.record(
            AuditAction.TRANSACTION_VOIDED,
            entity_id=transaction_id,
            actor=self.operator,
            details={"reason": "operator void"},
        )
        return txn

    def get_transaction(self, transaction_id: str) -> Transaction:
        return self._get_transaction(transaction_id)

    def list_transactions(
        self,
        status: Optional[TransactionStatus] = None,
    ) -> List[Transaction]:
        txns = list(self._transactions.values())
        if status:
            txns = [t for t in txns if t.status == status]
        return txns

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _get_customer(self, customer_id: str) -> Customer:
        try:
            return self._customers[customer_id]
        except KeyError:
            raise POSError(f"Customer not found: {customer_id}") from None

    def _get_material(self, material_id: str) -> Material:
        try:
            return self._materials[material_id]
        except KeyError:
            raise POSError(f"Material not found: {material_id}") from None

    def _get_transaction(self, transaction_id: str) -> Transaction:
        try:
            return self._transactions[transaction_id]
        except KeyError:
            raise POSError(f"Transaction not found: {transaction_id}") from None
