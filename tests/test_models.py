"""Tests for scalehouse.models."""

import pytest

from scalehouse.models import (
    Customer,
    Material,
    Transaction,
    TransactionLine,
    TransactionStatus,
    TransactionType,
    WeightReading,
)


# ---------------------------------------------------------------------------
# WeightReading
# ---------------------------------------------------------------------------

class TestWeightReading:
    def test_net_weight(self):
        w = WeightReading(gross_weight_lbs=100.0, tare_weight_lbs=20.0)
        assert w.net_weight_lbs == pytest.approx(80.0)

    def test_zero_tare(self):
        w = WeightReading(gross_weight_lbs=55.5)
        assert w.net_weight_lbs == pytest.approx(55.5)

    def test_negative_gross_raises(self):
        with pytest.raises(ValueError, match="gross_weight_lbs must be non-negative"):
            WeightReading(gross_weight_lbs=-1.0)

    def test_negative_tare_raises(self):
        with pytest.raises(ValueError, match="tare_weight_lbs must be non-negative"):
            WeightReading(gross_weight_lbs=10.0, tare_weight_lbs=-1.0)

    def test_tare_exceeds_gross_raises(self):
        with pytest.raises(ValueError, match="tare_weight_lbs cannot exceed gross_weight_lbs"):
            WeightReading(gross_weight_lbs=10.0, tare_weight_lbs=15.0)


# ---------------------------------------------------------------------------
# Material
# ---------------------------------------------------------------------------

class TestCustomer:
    def test_str_contains_name_and_id(self):
        c = Customer(name="Alice")
        s = str(c)
        assert "Alice" in s
        assert c.customer_id[:8] in s

    def test_str_with_phone_and_id_number(self):
        c = Customer(name="Bob", phone="555-1234", id_number="ID-999")
        # __str__ only shows name and first 8 chars of customer_id
        assert "Bob" in str(c)


class TestMaterial:
    def test_str(self):
        m = Material(name="Copper", price_per_lb=3.5)
        assert "Copper" in str(m)
        assert "3.5000" in str(m)

    def test_negative_price_raises(self):
        with pytest.raises(ValueError, match="price_per_lb must be non-negative"):
            Material(name="Copper", price_per_lb=-1.0)

    def test_zero_price_allowed(self):
        m = Material(name="Free", price_per_lb=0.0)
        assert m.price_per_lb == 0.0


# ---------------------------------------------------------------------------
# TransactionLine
# ---------------------------------------------------------------------------

class TestTransactionLine:
    def test_amount_calculation(self):
        material = Material(name="Aluminum", price_per_lb=0.50)
        weight = WeightReading(gross_weight_lbs=200.0, tare_weight_lbs=20.0)
        line = TransactionLine(material=material, weight=weight)
        # net = 180 lbs  * $0.50 = $90.00
        assert line.amount == pytest.approx(90.00)

    def test_amount_rounding(self):
        material = Material(name="Steel", price_per_lb=0.10)
        weight = WeightReading(gross_weight_lbs=3.0)
        line = TransactionLine(material=material, weight=weight)
        # 3.0 * 0.10 = 0.30
        assert line.amount == pytest.approx(0.30)


# ---------------------------------------------------------------------------
# Transaction
# ---------------------------------------------------------------------------

class TestTransaction:
    def _make_transaction(self) -> Transaction:
        customer = Customer(name="Alice")
        return Transaction(
            transaction_type=TransactionType.BUY,
            customer=customer,
        )

    def _make_line(self, net_lbs: float = 100.0, price: float = 1.0) -> TransactionLine:
        material = Material(name="Copper", price_per_lb=price)
        weight = WeightReading(gross_weight_lbs=net_lbs)
        return TransactionLine(material=material, weight=weight)

    def test_initial_status_is_pending(self):
        txn = self._make_transaction()
        assert txn.status == TransactionStatus.PENDING

    def test_add_line_updates_total(self):
        txn = self._make_transaction()
        txn.add_line(self._make_line(net_lbs=100.0, price=2.0))
        assert txn.total_amount == pytest.approx(200.0)

    def test_multiple_lines(self):
        txn = self._make_transaction()
        txn.add_line(self._make_line(net_lbs=100.0, price=1.0))
        txn.add_line(self._make_line(net_lbs=50.0, price=2.0))
        assert txn.total_amount == pytest.approx(200.0)
        assert txn.total_net_weight_lbs == pytest.approx(150.0)

    def test_complete_sets_status(self):
        txn = self._make_transaction()
        txn.add_line(self._make_line())
        txn.complete()
        assert txn.status == TransactionStatus.COMPLETED
        assert txn.completed_at is not None

    def test_complete_empty_transaction_raises(self):
        txn = self._make_transaction()
        with pytest.raises(ValueError, match="no lines"):
            txn.complete()

    def test_void_sets_status(self):
        txn = self._make_transaction()
        txn.void()
        assert txn.status == TransactionStatus.VOIDED

    def test_cannot_add_line_after_complete(self):
        txn = self._make_transaction()
        txn.add_line(self._make_line())
        txn.complete()
        with pytest.raises(ValueError, match="COMPLETED"):
            txn.add_line(self._make_line())

    def test_cannot_void_completed(self):
        txn = self._make_transaction()
        txn.add_line(self._make_line())
        txn.complete()
        with pytest.raises(ValueError, match="Cannot void a completed"):
            txn.void()

    def test_cannot_void_already_voided(self):
        txn = self._make_transaction()
        txn.void()
        with pytest.raises(ValueError, match="already voided"):
            txn.void()

    def test_cannot_complete_voided_transaction(self):
        txn = self._make_transaction()
        txn.void()
        with pytest.raises(ValueError, match="Cannot complete"):
            txn.complete()

    def test_cannot_add_line_to_voided_transaction(self):
        txn = self._make_transaction()
        txn.void()
        with pytest.raises(ValueError, match="Cannot add lines to a VOIDED transaction"):
            txn.add_line(self._make_line())

    def test_total_amount_zero_lines(self):
        txn = self._make_transaction()
        assert txn.total_amount == pytest.approx(0.0)

    def test_total_net_weight_zero_lines(self):
        txn = self._make_transaction()
        assert txn.total_net_weight_lbs == pytest.approx(0.0)

    def test_str_representation(self):
        txn = self._make_transaction()
        txn.add_line(self._make_line(net_lbs=10.0, price=3.0))
        s = str(txn)
        assert "BUY" in s
        assert "Alice" in s
        assert "30.00" in s
