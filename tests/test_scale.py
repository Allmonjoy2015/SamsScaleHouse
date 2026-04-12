"""Tests for scalehouse.scale."""

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

    def test_stable_delay_does_not_block_long(self):
        """stable_delay path is exercised; use a very short delay."""
        import time

        scale = MockScale(gross_weight_lbs=10.0, stable_delay=0.01)
        scale.connect()
        t0 = time.monotonic()
        reading = scale.read_weight()
        elapsed = time.monotonic() - t0
        scale.disconnect()
        assert elapsed >= 0.01
        assert reading.gross_weight_lbs == pytest.approx(10.0)


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

    def test_disconnect_when_not_connected_is_safe(self):
        """Calling disconnect without connecting must not raise."""
        scale = SerialScale(port="COM1")
        scale.disconnect()  # should be a no-op
        assert scale._serial is None

    def test_connect_raises_when_pyserial_missing(self, monkeypatch):
        """If pyserial is not installed, connect() raises ScaleError."""
        import builtins
        real_import = builtins.__import__

        def mock_import(name, *args, **kwargs):
            if name == "serial":
                raise ImportError("No module named 'serial'")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", mock_import)
        scale = SerialScale(port="COM1")
        with pytest.raises(ScaleError, match="pyserial is required"):
            scale.connect()

    def test_connect_raises_on_port_error(self, monkeypatch):
        """If serial.Serial raises (bad port), connect() wraps it in ScaleError."""
        import types
        import builtins
        real_import = builtins.__import__

        def mock_import(name, *args, **kwargs):
            if name == "serial":
                fake_serial = types.ModuleType("serial")

                class Serial:
                    def __init__(self, *a, **kw):
                        raise OSError("No such file or directory")

                fake_serial.Serial = Serial
                return fake_serial
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", mock_import)
        scale = SerialScale(port="/dev/nonexistent")
        with pytest.raises(ScaleError, match="Failed to connect"):
            scale.connect()

    def test_disconnect_closes_serial(self):
        """disconnect() closes the underlying serial object and sets _serial to None."""

        class FakeSerial:
            closed = False

            def close(self):
                self.closed = True

        scale = SerialScale(port="COM1")
        fake = FakeSerial()
        scale._serial = fake
        scale.disconnect()
        assert fake.closed
        assert scale._serial is None

    def test_read_weight_parses_valid_line(self):
        """read_weight() decodes readline() output and returns a WeightReading."""

        class FakeSerial:
            def readline(self):
                return b"  42.5 lb\r\n"

        scale = SerialScale(port="COM1", tare_weight_lbs=2.5)
        scale._serial = FakeSerial()
        reading = scale.read_weight()
        assert reading.gross_weight_lbs == pytest.approx(42.5)
        assert reading.tare_weight_lbs == pytest.approx(2.5)
        assert reading.net_weight_lbs == pytest.approx(40.0)

    def test_read_weight_raises_on_unrecognised_output(self):
        """read_weight() raises ScaleError when the line cannot be parsed."""

        class FakeSerial:
            def readline(self):
                return b"UNSTABLE\r\n"

        scale = SerialScale(port="COM1")
        scale._serial = FakeSerial()
        with pytest.raises(ScaleError, match="Unrecognised scale output"):
            scale.read_weight()

    def test_read_weight_raises_on_negative_value(self):
        """read_weight() raises ScaleError when the scale reports a negative weight."""

        class FakeSerial:
            def readline(self):
                return b"-5.0 lb\r\n"

        scale = SerialScale(port="COM1")
        scale._serial = FakeSerial()
        with pytest.raises(ScaleError, match="negative weight"):
            scale.read_weight()

    def test_read_weight_raises_on_serial_error(self):
        """read_weight() wraps hardware I/O errors in ScaleError."""

        class FakeSerial:
            def readline(self):
                raise OSError("device disconnected")

        scale = SerialScale(port="COM1")
        scale._serial = FakeSerial()
        with pytest.raises(ScaleError, match="Error reading from scale"):
            scale.read_weight()
