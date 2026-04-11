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
