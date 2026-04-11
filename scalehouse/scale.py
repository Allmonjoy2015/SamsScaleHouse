"""Scale integration module.

Provides a unified interface for reading weights from a physical scale
over a serial/USB connection.  A ``MockScale`` is included for testing
and development without hardware.
"""

from __future__ import annotations

import re
import time
from abc import ABC, abstractmethod
from typing import Optional

from scalehouse.models import WeightReading

# Regex that matches common indicator output formats, e.g.:
#   "  12.34 lb\r\n"  or  "ST,GS,+0012.3 lb\r\n"
_WEIGHT_PATTERN = re.compile(r"([+-]?\d+(?:\.\d+)?)\s*lb", re.IGNORECASE)


class ScaleError(Exception):
    """Raised when the scale cannot be read."""


class BaseScale(ABC):
    """Abstract base class for all scale adapters."""

    @abstractmethod
    def connect(self) -> None:
        """Open the connection to the scale."""

    @abstractmethod
    def disconnect(self) -> None:
        """Close the connection to the scale."""

    @abstractmethod
    def read_weight(self) -> WeightReading:
        """Return the current weight reading from the scale."""

    def __enter__(self) -> "BaseScale":
        self.connect()
        return self

    def __exit__(self, *_: object) -> None:
        self.disconnect()


class MockScale(BaseScale):
    """In-memory scale for tests and demos.

    Parameters
    ----------
    gross_weight_lbs:
        The simulated gross weight to return on every ``read_weight()`` call.
    tare_weight_lbs:
        The simulated tare (container) weight.
    stable_delay:
        Optional seconds to sleep to simulate stabilisation time.
    """

    def __init__(
        self,
        gross_weight_lbs: float = 0.0,
        tare_weight_lbs: float = 0.0,
        stable_delay: float = 0.0,
    ) -> None:
        self.gross_weight_lbs = gross_weight_lbs
        self.tare_weight_lbs = tare_weight_lbs
        self.stable_delay = stable_delay
        self._connected = False

    def connect(self) -> None:
        self._connected = True

    def disconnect(self) -> None:
        self._connected = False

    def read_weight(self) -> WeightReading:
        if not self._connected:
            raise ScaleError("Scale is not connected")
        if self.stable_delay:
            time.sleep(self.stable_delay)
        return WeightReading(
            gross_weight_lbs=self.gross_weight_lbs,
            tare_weight_lbs=self.tare_weight_lbs,
        )


class SerialScale(BaseScale):
    """Adapter for scales that communicate over RS-232/USB-serial.

    The scale must emit weight strings that match the pattern::

        <optional_status>, <value> lb

    Parameters
    ----------
    port:
        Serial port path, e.g. ``/dev/ttyUSB0`` or ``COM3``.
    baudrate:
        Communication speed (default 9600).
    timeout:
        Read timeout in seconds.
    tare_weight_lbs:
        Known tare/container weight to subtract from gross readings.
    """

    def __init__(
        self,
        port: str,
        baudrate: int = 9600,
        timeout: float = 2.0,
        tare_weight_lbs: float = 0.0,
    ) -> None:
        self.port = port
        self.baudrate = baudrate
        self.timeout = timeout
        self.tare_weight_lbs = tare_weight_lbs
        self._serial: Optional[object] = None

    def connect(self) -> None:
        try:
            import serial  # type: ignore[import]

            self._serial = serial.Serial(
                self.port, baudrate=self.baudrate, timeout=self.timeout
            )
        except ImportError as exc:
            raise ScaleError(
                "pyserial is required for SerialScale. "
                "Install it with: pip install pyserial"
            ) from exc
        except Exception as exc:
            raise ScaleError(f"Failed to connect to scale on {self.port}: {exc}") from exc

    def disconnect(self) -> None:
        if self._serial is not None:
            try:
                self._serial.close()  # type: ignore[attr-defined]
            finally:
                self._serial = None

    def read_weight(self) -> WeightReading:
        if self._serial is None:
            raise ScaleError("Scale is not connected")
        try:
            raw: bytes = self._serial.readline()  # type: ignore[attr-defined]
        except Exception as exc:
            raise ScaleError(f"Error reading from scale: {exc}") from exc

        line = raw.decode("ascii", errors="replace").strip()
        match = _WEIGHT_PATTERN.search(line)
        if not match:
            raise ScaleError(
                f"Unrecognised scale output: {line!r}. "
                "Check scale baud rate and protocol settings."
            )
        gross = float(match.group(1))
        if gross < 0:
            raise ScaleError(f"Scale returned a negative weight: {gross}")
        return WeightReading(
            gross_weight_lbs=gross,
            tare_weight_lbs=self.tare_weight_lbs,
        )


def parse_weight_string(raw: str) -> float:
    """Parse a raw weight string and return the value in pounds.

    Raises ``ScaleError`` if the string cannot be parsed.
    """
    match = _WEIGHT_PATTERN.search(raw)
    if not match:
        raise ScaleError(f"Cannot parse weight from: {raw!r}")
    return float(match.group(1))
