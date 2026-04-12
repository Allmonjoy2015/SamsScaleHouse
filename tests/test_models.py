"""Tests for scalehouse.models."""

import pytest

from scalehouse.models import (
    CatalyticConverterPurchase,
    Customer,
    Material,
    SellerAuthorizationType,
    Transaction,
    TransactionLine,
    TransactionStatus,
    TransactionType,
    VehiclePurchaseCompliance,
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

    def test_str_representation(self):
        txn = self._make_transaction()
        txn.add_line(self._make_line(net_lbs=10.0, price=3.0))
        s = str(txn)
        assert "BUY" in s
        assert "Alice" in s
        assert "30.00" in s


# ---------------------------------------------------------------------------
# Customer
# ---------------------------------------------------------------------------

class TestCustomer:
    def test_default_fields(self):
        c = Customer(name="John Doe")
        assert c.name == "John Doe"
        assert c.phone == ""
        assert c.id_number == ""
        assert c.customer_id  # auto-generated UUID

    def test_fields_stored(self):
        c = Customer(name="Jane", phone="555-9999", id_number="DL123")
        assert c.phone == "555-9999"
        assert c.id_number == "DL123"

    def test_str(self):
        c = Customer(name="Bob")
        assert "Bob" in str(c)

    def test_unique_ids(self):
        c1 = Customer(name="A")
        c2 = Customer(name="B")
        assert c1.customer_id != c2.customer_id


# ---------------------------------------------------------------------------
# CatalyticConverterPurchase
# ---------------------------------------------------------------------------

class TestCatalyticConverterPurchase:
    def test_basic_creation(self):
        record = CatalyticConverterPurchase(
            transaction_id="txn-1",
            seller_authorization_type=SellerAuthorizationType.DISMANTLER_RECYCLER,
            seller_license_number="LIC-001",
        )
        assert record.transaction_id == "txn-1"
        assert record.seller_authorization_type == SellerAuthorizationType.DISMANTLER_RECYCLER
        assert record.seller_license_number == "LIC-001"
        assert record.record_id  # auto-generated UUID

    def test_clean_air_act_exempt_flag(self):
        record = CatalyticConverterPurchase(
            transaction_id="txn-2",
            seller_authorization_type=SellerAuthorizationType.CLEAN_AIR_ACT_EXEMPT,
            clean_air_act_exempt=True,
            clean_air_act_cert_info="cert-abc",
        )
        assert record.clean_air_act_exempt is True
        assert record.clean_air_act_cert_info == "cert-abc"

    def test_clean_air_act_type_without_flag_raises(self):
        with pytest.raises(ValueError, match="CLEAN_AIR_ACT_EXEMPT"):
            CatalyticConverterPurchase(
                transaction_id="txn-3",
                seller_authorization_type=SellerAuthorizationType.CLEAN_AIR_ACT_EXEMPT,
                clean_air_act_exempt=False,
            )

    def test_notification_sent_default_false(self):
        record = CatalyticConverterPurchase(
            transaction_id="txn-4",
            seller_authorization_type=SellerAuthorizationType.MECHANIC_REPAIR,
        )
        assert record.notification_sent is False

    def test_str(self):
        record = CatalyticConverterPurchase(
            transaction_id="txn-5",
            seller_authorization_type=SellerAuthorizationType.SCRAP_METAL_DEALER,
        )
        s = str(record)
        assert "txn-5" in s
        assert "scrap_metal_dealer" in s

    def test_unique_record_ids(self):
        r1 = CatalyticConverterPurchase(
            transaction_id="t1",
            seller_authorization_type=SellerAuthorizationType.DISMANTLER_RECYCLER,
        )
        r2 = CatalyticConverterPurchase(
            transaction_id="t2",
            seller_authorization_type=SellerAuthorizationType.DISMANTLER_RECYCLER,
        )
        assert r1.record_id != r2.record_id


# ---------------------------------------------------------------------------
# VehiclePurchaseCompliance
# ---------------------------------------------------------------------------

class TestVehiclePurchaseCompliance:
    def test_basic_creation(self):
        record = VehiclePurchaseCompliance(vehicle_purchase_id="vp-1")
        assert record.vehicle_purchase_id == "vp-1"
        assert record.seller_thumbprint_collected is False
        assert record.seller_certification_signed is False
        assert record.nmvtis_reported is False
        assert record.consideration_amount == pytest.approx(0.0)
        assert record.three_day_hold_required is False
        assert record.record_id  # auto-generated UUID

    def test_negative_consideration_raises(self):
        with pytest.raises(ValueError, match="consideration_amount must be non-negative"):
            VehiclePurchaseCompliance(
                vehicle_purchase_id="vp-2",
                consideration_amount=-1.0,
            )

    def test_zero_consideration_allowed(self):
        record = VehiclePurchaseCompliance(
            vehicle_purchase_id="vp-3",
            consideration_amount=0.0,
        )
        assert record.consideration_amount == pytest.approx(0.0)

    def test_compliance_flags(self):
        record = VehiclePurchaseCompliance(
            vehicle_purchase_id="vp-4",
            seller_thumbprint_collected=True,
            seller_certification_signed=True,
            nmvtis_reported=True,
            consideration_amount=500.0,
        )
        assert record.seller_thumbprint_collected is True
        assert record.seller_certification_signed is True
        assert record.nmvtis_reported is True
        assert record.consideration_amount == pytest.approx(500.0)

    def test_three_day_hold_fields(self):
        from datetime import datetime, timezone, timedelta
        start = datetime.now(timezone.utc)
        expiry = start + timedelta(days=3)
        record = VehiclePurchaseCompliance(
            vehicle_purchase_id="vp-5",
            three_day_hold_required=True,
            three_day_hold_start=start,
            three_day_hold_expiry=expiry,
        )
        assert record.three_day_hold_required is True
        assert record.three_day_hold_start == start
        assert record.three_day_hold_expiry == expiry

    def test_str(self):
        record = VehiclePurchaseCompliance(
            vehicle_purchase_id="vp-6",
            seller_thumbprint_collected=True,
            seller_certification_signed=False,
        )
        s = str(record)
        assert "vp-6" in s
        assert "True" in s
        assert "False" in s

    def test_unique_record_ids(self):
        r1 = VehiclePurchaseCompliance(vehicle_purchase_id="vp-7")
        r2 = VehiclePurchaseCompliance(vehicle_purchase_id="vp-8")
        assert r1.record_id != r2.record_id
