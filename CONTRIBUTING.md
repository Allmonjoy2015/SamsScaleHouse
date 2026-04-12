# Contributing to SamsScaleHouse

Thank you for your interest in contributing!  This document covers how to set
up a development environment, run tests, and submit changes.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Setting Up the Python Package](#setting-up-the-python-package)
3. [Setting Up the Electron App](#setting-up-the-electron-app)
4. [Running Tests](#running-tests)
5. [Code Style](#code-style)
6. [Submitting a Pull Request](#submitting-a-pull-request)
7. [Reporting Bugs](#reporting-bugs)

---

## Prerequisites

| Tool | Minimum version |
|------|----------------|
| Python | 3.10 |
| Node.js | 18 |
| npm | 9 |
| Git | any recent |

---

## Setting Up the Python Package

```bash
# Clone the repository
git clone https://github.com/Allmonjoy2015/SamsScaleHouse.git
cd SamsScaleHouse

# Create and activate a virtual environment (recommended)
python -m venv .venv
source .venv/bin/activate        # Linux / macOS
.venv\Scripts\activate           # Windows

# Install in editable mode with dev dependencies
pip install -e ".[dev]"
```

---

## Setting Up the Electron App

```bash
npm install

# If you have a physical RS-232 scale, rebuild the native module:
npx electron-rebuild -f -w serialport

# Run the app
npm start
```

---

## Running Tests

### Python tests

```bash
pytest
```

All tests are in `tests/` and require no hardware, database, or Electron.

### What is tested

| Test file | Coverage |
|-----------|---------|
| `tests/test_models.py` | `WeightReading`, `Material`, `TransactionLine`, `Transaction` |
| `tests/test_scale.py` | `MockScale`, `SerialScale` init, `parse_weight_string` |
| `tests/test_pos.py` | `POSSession` — customers, materials, full transaction workflow |
| `tests/test_audit.py` | `AuditEvent`, `AuditLog` (in-memory and JSONL persistence) |

---

## Code Style

- **Python**: Follow [PEP 8](https://peps.python.org/pep-0008/).  Use type
  annotations for all public functions and class attributes.  Document public
  API with docstrings.
- **JavaScript / Electron**: Match the style of the existing files (2-space
  indentation, single quotes, semicolons).
- Keep commits focused; one logical change per commit.

---

## Submitting a Pull Request

1. Fork the repository and create a feature branch from `main`:
   ```bash
   git checkout -b feature/my-change
   ```
2. Make your changes and add or update tests as appropriate.
3. Ensure all tests pass (`pytest`).
4. Push your branch and open a pull request against `main`.
5. Fill in the pull-request description with a summary of what changed and why.

A maintainer will review and respond within a few business days.

---

## Reporting Bugs

Please open a [GitHub Issue](https://github.com/Allmonjoy2015/SamsScaleHouse/issues)
with:

- A clear title and description.
- Steps to reproduce the problem.
- Expected vs. actual behaviour.
- Your OS, Python version, and/or Node.js version.

For security issues, see [SECURITY.md](SECURITY.md) instead.
