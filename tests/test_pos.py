"""Tests for scalehouse.pos (POSSession)."""

import pytest

from scalehouse.audit import AuditAction, AuditLog
from scalehouse.models import TransactionStatus, TransactionType
from scalehouse.pos import POSError, POSSession
from scalehouse.scale import MockScale


@pytest.fixture()
def session() -> POSSession:
    """Return a POSSession wired to a MockScale."""
    scale = MockScale(gross_weight_lbs=200.0, tare_weight_lbs=10.0)
    scale.connect()
    audit = AuditLog()
    return POSSession(scale=scale, audit_log=audit, operator="test_op")


@pytest.fixture()
def populated_session(session: POSSession):
    """Session with one customer and two materials pre-loaded."""
    session._customer = session.add_customer("Sam Smith", phone="555-1234", id_number="ID9999")
    session._copper = session.add_material("Copper", price_per_lb=3.50)
    session._aluminum = session.add_material("Aluminum", price_per_lb=0.60)
    return session


# ---------------------------------------------------------------------------
# Customer management
# ---------------------------------------------------------------------------

class TestCustomerManagement:
    def test_add_customer(self, session: POSSession):
        customer = session.add_customer("Jane Doe", phone="555-0000")
        assert customer.name == "Jane Doe"
        assert customer in session.list_customers()

    def test_add_customer_creates_audit_event(self, session: POSSession):
        customer = session.add_customer("John")
        events = session.audit.events_for(customer.customer_id)
        assert any(e.action == AuditAction.CUSTOMER_CREATED for e in events)

    def test_update_customer(self, session: POSSession):
        customer = session.add_customer("Old Name")
        updated = session.update_customer(customer.customer_id, name="New Name")
        assert updated.name == "New Name"

    def test_update_customer_unknown_field_raises(self, session: POSSession):
        customer = session.add_customer("Test")
        with pytest.raises(POSError, match="Unknown customer fields"):
            session.update_customer(customer.customer_id, email="x@y.com")

    def test_get_nonexistent_customer_raises(self, session: POSSession):
        with pytest.raises(POSError, match="Customer not found"):
            session.get_customer("does-not-exist")


# ---------------------------------------------------------------------------
# Material / price management
# ---------------------------------------------------------------------------

class TestMaterialManagement:
    def test_add_material(self, session: POSSession):
        mat = session.add_material("Steel", price_per_lb=0.10)
        assert mat in session.list_materials()

    def test_update_price(self, session: POSSession):
        mat = session.add_material("Copper", price_per_lb=3.00)
        updated = session.update_price(mat.material_id, 3.75)
        assert updated.price_per_lb == pytest.approx(3.75)

    def test_update_price_creates_audit_event(self, session: POSSession):
        mat = session.add_material("Brass", price_per_lb=2.00)
        session.update_price(mat.material_id, 2.25)
        events = session.audit.events_for(mat.material_id)
        assert any(e.action == AuditAction.PRICE_UPDATED for e in events)

    def test_update_price_negative_raises(self, session: POSSession):
        mat = session.add_material("Lead", price_per_lb=0.50)
        with pytest.raises(POSError, match="negative"):
            session.update_price(mat.material_id, -1.0)

    def test_get_nonexistent_material_raises(self, session: POSSession):
        with pytest.raises(POSError, match="Material not found"):
            session.get_material("no-such-id")


# ---------------------------------------------------------------------------
# Transaction workflow
# ---------------------------------------------------------------------------

class TestTransactionWorkflow:
    def test_buy_transaction_full_cycle(self, populated_session: POSSession):
        s = populated_session
        txn = s.start_transaction(TransactionType.BUY, s._customer.customer_id)
        assert txn.status == TransactionStatus.PENDING

        line = s.weigh_and_add_line(txn.transaction_id, s._copper.material_id)
        # gross=200, tare=10, net=190, price=3.50 → $665.00
        assert line.weight.net_weight_lbs == pytest.approx(190.0)
        assert line.amount == pytest.approx(665.0)

        completed = s.complete_transaction(txn.transaction_id)
        assert completed.status == TransactionStatus.COMPLETED
        assert completed.total_amount == pytest.approx(665.0)

    def test_sell_transaction(self, populated_session: POSSession):
        s = populated_session
        txn = s.start_transaction(TransactionType.SELL, s._customer.customer_id)
        s.weigh_and_add_line(txn.transaction_id, s._aluminum.material_id)
        s.complete_transaction(txn.transaction_id)
        assert txn.transaction_type == TransactionType.SELL

    def test_void_transaction(self, populated_session: POSSession):
        s = populated_session
        txn = s.start_transaction(TransactionType.BUY, s._customer.customer_id)
        voided = s.void_transaction(txn.transaction_id)
        assert voided.status == TransactionStatus.VOIDED

    def test_weigh_with_tare_override(self, populated_session: POSSession):
        s = populated_session
        txn = s.start_transaction(TransactionType.BUY, s._customer.customer_id)
        # Override tare to 50 lbs (e.g. truck tare captured separately)
        line = s.weigh_and_add_line(
            txn.transaction_id, s._copper.material_id, tare_weight_lbs=50.0
        )
        assert line.weight.tare_weight_lbs == pytest.approx(50.0)
        assert line.weight.net_weight_lbs == pytest.approx(150.0)

    def test_transaction_audit_trail(self, populated_session: POSSession):
        s = populated_session
        txn = s.start_transaction(TransactionType.BUY, s._customer.customer_id)
        s.weigh_and_add_line(txn.transaction_id, s._copper.material_id)
        s.complete_transaction(txn.transaction_id)

        events = s.audit.events_for(txn.transaction_id)
        actions = {e.action for e in events}
        assert AuditAction.TRANSACTION_CREATED in actions
        assert AuditAction.LINE_ADDED in actions
        assert AuditAction.TRANSACTION_COMPLETED in actions

    def test_list_transactions_by_status(self, populated_session: POSSession):
        s = populated_session
        txn1 = s.start_transaction(TransactionType.BUY, s._customer.customer_id)
        txn2 = s.start_transaction(TransactionType.BUY, s._customer.customer_id)
        s.weigh_and_add_line(txn1.transaction_id, s._copper.material_id)
        s.complete_transaction(txn1.transaction_id)

        completed = s.list_transactions(status=TransactionStatus.COMPLETED)
        pending = s.list_transactions(status=TransactionStatus.PENDING)
        assert txn1 in completed
        assert txn2 in pending
        assert txn2 not in completed

    def test_start_transaction_unknown_customer_raises(self, session: POSSession):
        with pytest.raises(POSError, match="Customer not found"):
            session.start_transaction(TransactionType.BUY, "no-such-customer")

    def test_weigh_unknown_material_raises(self, populated_session: POSSession):
        s = populated_session
        txn = s.start_transaction(TransactionType.BUY, s._customer.customer_id)
        with pytest.raises(POSError, match="Material not found"):
            s.weigh_and_add_line(txn.transaction_id, "no-such-material")

    def test_weigh_unknown_transaction_raises(self, populated_session: POSSession):
        s = populated_session
        with pytest.raises(POSError, match="Transaction not found"):
            s.weigh_and_add_line("no-such-txn", s._copper.material_id)

    def test_complete_unknown_transaction_raises(self, session: POSSession):
        with pytest.raises(POSError, match="Transaction not found"):
            session.complete_transaction("no-such-txn")

    def test_void_unknown_transaction_raises(self, session: POSSession):
        with pytest.raises(POSError, match="Transaction not found"):
            session.void_transaction("no-such-txn")

    def test_get_transaction(self, populated_session: POSSession):
        s = populated_session
        txn = s.start_transaction(TransactionType.BUY, s._customer.customer_id)
        retrieved = s.get_transaction(txn.transaction_id)
        assert retrieved is txn

    def test_get_nonexistent_transaction_raises(self, session: POSSession):
        with pytest.raises(POSError, match="Transaction not found"):
            session.get_transaction("does-not-exist")

    def test_list_all_transactions_no_filter(self, populated_session: POSSession):
        s = populated_session
        txn1 = s.start_transaction(TransactionType.BUY, s._customer.customer_id)
        txn2 = s.start_transaction(TransactionType.SELL, s._customer.customer_id)
        all_txns = s.list_transactions()
        assert txn1 in all_txns
        assert txn2 in all_txns

    def test_void_transaction_creates_audit_event(self, populated_session: POSSession):
        s = populated_session
        txn = s.start_transaction(TransactionType.BUY, s._customer.customer_id)
        s.void_transaction(txn.transaction_id)
        events = s.audit.events_for(txn.transaction_id)
        assert any(e.action == AuditAction.TRANSACTION_VOIDED for e in events)

    def test_start_transaction_with_notes(self, populated_session: POSSession):
        s = populated_session
        txn = s.start_transaction(
            TransactionType.BUY, s._customer.customer_id, notes="large load"
        )
        assert txn.notes == "large load"

    def test_update_customer_creates_audit_event(self, session: POSSession):
        customer = session.add_customer("Old Name")
        session.update_customer(customer.customer_id, name="New Name")
        events = session.audit.events_for(customer.customer_id)
        assert any(e.action == AuditAction.CUSTOMER_UPDATED for e in events)

    def test_add_material_creates_audit_event(self, session: POSSession):
        mat = session.add_material("Brass", price_per_lb=1.50)
        events = session.audit.events_for(mat.material_id)
        assert any(e.action == AuditAction.MATERIAL_CREATED for e in events)

    def test_session_without_audit_log_creates_default(self):
        from scalehouse.scale import MockScale
        scale = MockScale(gross_weight_lbs=10.0)
        scale.connect()
        s = POSSession(scale=scale)
        assert s.audit is not None
        assert len(s.audit) == 0

    def test_multiple_lines_in_transaction(self, populated_session: POSSession):
        s = populated_session
        # session fixture: MockScale gross=200 lbs, tare=10 lbs → net=190 lbs
        # populated_session: copper=$3.50/lb, aluminum=$0.60/lb
        copper_amount = 190.0 * 3.50   # $665.00
        aluminum_amount = 190.0 * 0.60  # $114.00
        txn = s.start_transaction(TransactionType.BUY, s._customer.customer_id)
        s.weigh_and_add_line(txn.transaction_id, s._copper.material_id)
        s.weigh_and_add_line(txn.transaction_id, s._aluminum.material_id)
        s.complete_transaction(txn.transaction_id)
        assert len(txn.lines) == 2
        assert txn.total_amount == pytest.approx(copper_amount + aluminum_amount)
