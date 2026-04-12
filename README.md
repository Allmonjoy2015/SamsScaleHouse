# SamsScaleHouse

A scrap-yard point-of-sale (POS) system with RS-232 scale integration.  The
project has two components that can be used independently:

| Component | Language | Purpose |
|-----------|----------|---------|
| `scalehouse/` Python package | Python ≥ 3.10 | Core business logic — models, POS session, scale adapters, audit log |
| Electron desktop app | Node.js / Electron | Full-featured GUI with SQLite database and live scale feed |

---

## Table of Contents

1. [Python Package](#python-package)
2. [Electron Desktop App](#electron-desktop-app)
3. [Architecture Overview](#architecture-overview)
4. [Database Schema](#database-schema)
5. [Scale Integration](#scale-integration)
6. [Contributing](#contributing)

---

## Python Package

### Installation

```bash
# Core library (no hardware required)
pip install -e .

# With RS-232 serial support
pip install -e ".[serial]"

# With development / test tools
pip install -e ".[dev]"
```

### Running the demo

```bash
python main.py
```

This runs an interactive demo that creates a `MockScale`, opens a buy
transaction, weighs copper and aluminium, and prints the audit trail.

### Running the tests

```bash
pytest
```

All tests live in `tests/` and require no hardware or database.

### Package layout

```
scalehouse/
  models.py   — Core dataclasses: Customer, Material, WeightReading,
                TransactionLine, Transaction (with TransactionType /
                TransactionStatus enums)
  scale.py    — BaseScale ABC, MockScale, SerialScale, parse_weight_string()
  pos.py      — POSSession: customer & material catalogue, transaction
                workflow, tare override, audit integration
  audit.py    — AuditLog + AuditEvent with optional JSONL file persistence
```

### Quick example

```python
from scalehouse.audit import AuditLog
from scalehouse.models import TransactionType
from scalehouse.pos import POSSession
from scalehouse.scale import MockScale

scale = MockScale(gross_weight_lbs=500.0, tare_weight_lbs=50.0)
audit = AuditLog()
session = POSSession(scale=scale, audit_log=audit, operator="sam")

with scale:
    copper = session.add_material("Copper", price_per_lb=3.50)
    customer = session.add_customer("Jane Doe", phone="555-1234", id_number="DL9999")

    txn = session.start_transaction(TransactionType.BUY, customer.customer_id)
    line = session.weigh_and_add_line(txn.transaction_id, copper.material_id)
    session.complete_transaction(txn.transaction_id)

    print(f"Total: ${txn.total_amount:.2f}")   # Total: $1575.00
```

---

## Electron Desktop App

### Prerequisites

- Node.js 18 or later
- npm

### Install dependencies

```bash
npm install
```

If you use a physical RS-232 scale, rebuild the native serial-port module after
install:

```bash
npx electron-rebuild -f -w serialport
```

### Run

```bash
npm start
```

### Build a distributable (Windows portable)

```bash
npm run dist
```

The output appears in `dist/`.

### Key source files

| File | Purpose |
|------|---------|
| `main.js` | Electron main process — creates the `BrowserWindow`, initialises SQLite, registers all IPC handlers |
| `preload.js` | Context bridge — exposes a typed `window.electronAPI` to the renderer with an explicit IPC allow-list |
| `renderer.js` | UI logic — ticket form, customer search, CRM, reporting |
| `scale-settings.js` | Scale configuration panel — port list, presets, auto-seek, save/reconnect |
| `index.html` | Application shell |

---

## Architecture Overview

```
┌─────────────────────────────────────────────┐
│            Electron Renderer Process         │
│  renderer.js + scale-settings.js            │
│  (DOM, UI logic, scale status display)       │
└──────────────────┬──────────────────────────┘
                   │  window.electronAPI.invoke(channel, …)
                   │  (context bridge — preload.js)
┌──────────────────▼──────────────────────────┐
│            Electron Main Process             │
│  main.js                                    │
│  ├── SQLite (scrapyard.db via userData)      │
│  ├── IPC handlers (50+ channels)             │
│  └── SerialPort — RS-232 scale reader        │
└─────────────────────────────────────────────┘

Python package (scalehouse/) is a standalone library that mirrors the
same domain model and is independently testable without Electron or SQLite.
```

---

## Database Schema

The Electron app stores all data in an SQLite database (`scrapyard.db`) inside
the OS user-data directory.  Tables are created automatically on first launch
and upgraded in place when new columns are added.

| Table | Description |
|-------|-------------|
| `customers` | Customer profiles — name, ID number, phone, DL expiry, images, vendor/dealer flags |
| `transactions` | Buy/sell ticket headers — customer, date, total, type, override flag |
| `ticket_items` | Line items within a ticket — material, net weight, price, scale reading |
| `products` | Material catalogue — name, price per pound |
| `vouchers` | Redeemable vouchers tied to tickets |
| `copper_holds` | Copper hold tracking with expiry and release dates |
| `inventory` | Inventory lots by material with location and expiry |
| `price_history` | Audit trail of price changes per material |
| `customer_balances` | Running account balances per customer |
| `vehicle_purchases` | Whole-vehicle scrap purchases — VIN, make, model, title status |

---

## Scale Integration

### Electron app (RS-232 via SerialPort)

Open the gear icon ⚙ in the app to configure the scale:

- **Port** — select from detected COM / ttyUSB ports, or use *Auto-seek* to scan automatically
- **Baud rate / parity / data bits / stop bits / delimiter** — match your scale's factory settings
- **Poll mode** — enable for scales that require a request command rather than continuous output

Built-in presets are available for common indicators:

| Preset | Model examples |
|--------|---------------|
| Toledo | Mettler Toledo IND/SIC series |
| Fairbanks | Ultegra / SCB |
| Rice Lake | 920i / 820i |
| Cardinal | Cardinal / Detecto |
| Generic | Most 9600 8N1 scales |

### Python package (`SerialScale`)

```python
from scalehouse.scale import SerialScale

with SerialScale(port="COM3", baudrate=9600, tare_weight_lbs=200.0) as scale:
    reading = scale.read_weight()
    print(f"Net: {reading.net_weight_lbs:.1f} lb")
```

`pyserial` must be installed (`pip install pyserial` or `pip install -e ".[serial]"`).

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, code style
guidelines, and the pull-request process.
