"""Tests for scalehouse.scale."""

import time
from unittest.mock import MagicMock, patch

import pytest

from scalehouse.models import WeightReading
from scalehouse.scale import MockScale, ScaleError, SerialScale, parse_weight_string


class TestMockScale:
    def test_read_weight_returns_correct_values(self):
        with MockScale(gross_weight_lbs=150.0, tare_weight_lbs=20.0) as scale:
            reading = scale.read_weight()
        assert reading.gross_weight_lbs == pytest.approx(150.0)
        assert reading.tare_weight_lbs == pytest.approx(20.0)
        assert reading.net_weight_lbs == pytest.approx(130.0)

    def test_context_manager_connects_and_disconnects(self):
        scale = MockScale(gross_weight_lbs=10.0)
        assert not scale._connected
        with scale:
            assert scale._connected
        assert not scale._connected

    def test_read_without_connect_raises(self):
        scale = MockScale(gross_weight_lbs=10.0)
        with pytest.raises(ScaleError, match="not connected"):
            scale.read_weight()

    def test_zero_weight(self):
        with MockScale() as scale:
            reading = scale.read_weight()
        assert reading.net_weight_lbs == pytest.approx(0.0)

    def test_explicit_connect_disconnect(self):
        scale = MockScale(gross_weight_lbs=5.0)
        scale.connect()
        reading = scale.read_weight()
        scale.disconnect()
        assert reading.gross_weight_lbs == pytest.approx(5.0)
        with pytest.raises(ScaleError):
            scale.read_weight()


    def test_stable_delay_respected(self, monkeypatch):
        slept = []
        monkeypatch.setattr(time, "sleep", lambda s: slept.append(s))
        with MockScale(gross_weight_lbs=10.0, stable_delay=0.5) as scale:
            scale.read_weight()
        assert slept == [0.5]


class TestParseWeightString:
    @pytest.mark.parametrize(
        "raw, expected",
        [
            ("  12.34 lb\r\n", 12.34),
            ("ST,GS,+0012.3 lb\r\n", 12.3),
            ("0.0 lb", 0.0),
            ("999 lb", 999.0),
            ("LB: 5.50 lb", 5.50),
            ("Weight: 123.456 lb", 123.456),
        ],
    )
    def test_valid_strings(self, raw: str, expected: float):
        assert parse_weight_string(raw) == pytest.approx(expected)

    def test_invalid_string_raises(self):
        with pytest.raises(ScaleError, match="Cannot parse weight"):
            parse_weight_string("no weight here")

    def test_empty_string_raises(self):
        with pytest.raises(ScaleError):
            parse_weight_string("")


class TestSerialScaleInit:
    """Unit-test SerialScale initialisation without hardware."""

    def test_attributes_stored(self):
        scale = SerialScale(port="/dev/ttyUSB0", baudrate=4800, tare_weight_lbs=5.0)
        assert scale.port == "/dev/ttyUSB0"
        assert scale.baudrate == 4800
        assert scale.tare_weight_lbs == pytest.approx(5.0)

    def test_not_connected_initially(self):
        scale = SerialScale(port="COM1")
        assert scale._serial is None

    def test_read_without_connect_raises(self):
        scale = SerialScale(port="COM1")
        with pytest.raises(ScaleError, match="not connected"):
            scale.read_weight()


class TestSerialScaleConnect:
    """Test SerialScale.connect() without real hardware."""

    def test_connect_stores_serial_object(self):
        mock_serial_instance = MagicMock()
        mock_serial_class = MagicMock(return_value=mock_serial_instance)
        mock_serial_module = MagicMock()
        mock_serial_module.Serial = mock_serial_class
        with patch.dict("sys.modules", {"serial": mock_serial_module}):
            scale = SerialScale(port="/dev/ttyUSB0", baudrate=9600, timeout=2.0)
            scale.connect()
        assert scale._serial is mock_serial_instance
        mock_serial_class.assert_called_once_with(
            "/dev/ttyUSB0", baudrate=9600, timeout=2.0
        )

    def test_connect_raises_on_import_error(self):
        with patch.dict("sys.modules", {"serial": None}):
            scale = SerialScale(port="/dev/ttyUSB0")
            with pytest.raises(ScaleError, match="pyserial is required"):
                scale.connect()

    def test_connect_raises_on_serial_error(self):
        mock_serial_module = MagicMock()
        mock_serial_module.Serial.side_effect = OSError("No such file or directory")
        with patch.dict("sys.modules", {"serial": mock_serial_module}):
            scale = SerialScale(port="/dev/ttyUSB0")
            with pytest.raises(ScaleError, match="Failed to connect"):
                scale.connect()


class TestSerialScaleDisconnect:
    """Test SerialScale.disconnect() without real hardware."""

    def test_disconnect_closes_and_clears_serial(self):
        mock_serial = MagicMock()
        scale = SerialScale(port="COM1")
        scale._serial = mock_serial
        scale.disconnect()
        mock_serial.close.assert_called_once()
        assert scale._serial is None

    def test_disconnect_when_not_connected_is_noop(self):
        scale = SerialScale(port="COM1")
        assert scale._serial is None
        scale.disconnect()  # should not raise
        assert scale._serial is None


class TestSerialScaleReadWeight:
    """Test SerialScale.read_weight() without real hardware."""

    def _make_connected_scale(self, readline_return: bytes, tare: float = 0.0) -> SerialScale:
        mock_serial = MagicMock()
        mock_serial.readline.return_value = readline_return
        scale = SerialScale(port="COM1", tare_weight_lbs=tare)
        scale._serial = mock_serial
        return scale

    def test_successful_read(self):
        scale = self._make_connected_scale(b"ST,GS,+0012.3 lb\r\n", tare=2.0)
        reading = scale.read_weight()
        assert reading.gross_weight_lbs == pytest.approx(12.3)
        assert reading.tare_weight_lbs == pytest.approx(2.0)
        assert reading.net_weight_lbs == pytest.approx(10.3)

    def test_unrecognised_output_raises(self):
        scale = self._make_connected_scale(b"ERR: no weight\r\n")
        with pytest.raises(ScaleError, match="Unrecognised scale output"):
            scale.read_weight()

    def test_negative_weight_raises(self):
        scale = self._make_connected_scale(b"-5.0 lb\r\n")
        with pytest.raises(ScaleError, match="negative weight"):
            scale.read_weight()

    def test_readline_error_raises(self):
        mock_serial = MagicMock()
        mock_serial.readline.side_effect = OSError("port closed")
        scale = SerialScale(port="COM1")
        scale._serial = mock_serial
        with pytest.raises(ScaleError, match="Error reading from scale"):
            scale.read_weight()
