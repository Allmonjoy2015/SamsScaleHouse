"""Entry point for the SamsScaleHouse POS terminal (interactive demo)."""

from scalehouse.audit import AuditLog
from scalehouse.models import TransactionType
from scalehouse.pos import POSSession
from scalehouse.scale import MockScale


def main() -> None:
    print("=== SamsScaleHouse POS Demo ===")

    # Use a MockScale with a simulated 500 lb reading, 50 lb tare.
    scale = MockScale(gross_weight_lbs=500.0, tare_weight_lbs=50.0)
    audit = AuditLog()
    session = POSSession(scale=scale, audit_log=audit, operator="demo_operator")

    with scale:
        # Add materials
        copper = session.add_material("Copper", price_per_lb=3.50)
        aluminum = session.add_material("Aluminum", price_per_lb=0.60)
        steel = session.add_material("Steel", price_per_lb=0.12)

        # Add a customer
        customer = session.add_customer(
            "Sam's Recycling", phone="555-9876", id_number="BUS-001"
        )

        # BUY transaction: yard purchases scrap from customer
        txn = session.start_transaction(TransactionType.BUY, customer.customer_id)
        session.weigh_and_add_line(txn.transaction_id, copper.material_id)
        session.weigh_and_add_line(txn.transaction_id, aluminum.material_id)
        session.complete_transaction(txn.transaction_id)

        print(f"\nCompleted transaction: {txn}")
        for line in txn.lines:
            print(
                f"  {line.material.name}: "
                f"{line.weight.net_weight_lbs:.1f} lb × "
                f"${line.material.price_per_lb:.4f}/lb = "
                f"${line.amount:.2f}"
            )
        print(f"  TOTAL: ${txn.total_amount:.2f}")

        print("\n--- Audit trail ---")
        for event in audit:
            print(" ", event)


if __name__ == "__main__":
    main()
