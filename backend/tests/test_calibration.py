import math
import unittest
from unittest.mock import patch

from backend.app import main


def _make_stationary_rows(count: int = 120) -> list[dict[str, float]]:
    rows: list[dict[str, float]] = []
    for i in range(count):
        rows.append(
            {
                "time_ns": 1_700_000_000_000_000_000 + i,
                "x": -0.006 + (0.0003 * ((i % 7) - 3)),
                "y": -0.008 + (0.0002 * ((i % 5) - 2)),
                "z": 1.014 + (0.0003 * ((i % 9) - 4)),
                "roll": 0.21 + (0.01 * ((i % 5) - 2)),
                "pitch": 0.12 + (0.008 * ((i % 7) - 3)),
                "yaw": -0.15 + (0.01 * ((i % 6) - 3)),
            }
        )
    return rows


class CalibrationTests(unittest.TestCase):
    def test_required_calibration_samples_window_aware(self) -> None:
        required_short = main._required_calibration_samples(2.5)
        required_long = main._required_calibration_samples(8.0)
        self.assertGreaterEqual(required_short, 40)
        self.assertGreaterEqual(required_long, required_short)
        self.assertLessEqual(required_long, main.CALIBRATION_MIN_SAMPLES)

    def test_calibration_min_points_error_uses_window_aware_threshold(self) -> None:
        rows = _make_stationary_rows(count=39)
        profile, error = main._compute_calibration_from_rows(rows, window_seconds=2.5)
        self.assertIsNone(profile)
        self.assertIsNotNone(error)
        assert error is not None
        self.assertIn("for window 2.5s", error)

    def test_filter_rows_to_realtime_excludes_far_future(self) -> None:
        now_ns = 1_700_000_000_000_000_000
        skew_ns = int(main.CALIBRATION_MAX_FUTURE_SKEW_SECONDS * 1_000_000_000)
        rows = [
            {"time_ns": now_ns - 1, "x": 0.0, "y": 0.0, "z": 1.0, "roll": 0.0, "pitch": 0.0, "yaw": 0.0},
            {"time_ns": now_ns + skew_ns, "x": 0.0, "y": 0.0, "z": 1.0, "roll": 0.0, "pitch": 0.0, "yaw": 0.0},
            {"time_ns": now_ns + skew_ns + 1, "x": 0.0, "y": 0.0, "z": 1.0, "roll": 0.0, "pitch": 0.0, "yaw": 0.0},
        ]
        filtered = main._filter_rows_to_realtime(rows, now_ns=now_ns)
        self.assertEqual([r["time_ns"] for r in filtered], [now_ns - 1, now_ns + skew_ns])

    def test_compute_calibration_preserves_rest_gravity(self) -> None:
        rows = _make_stationary_rows()
        profile, error = main._compute_calibration_from_rows(rows, window_seconds=2.5)
        self.assertIsNone(error)
        self.assertIsNotNone(profile)

        assert profile is not None
        offsets = profile["offsets"]
        # Resting Z near 1g should not be zeroed out.
        self.assertLess(abs(offsets["az"]), 80)

        x_mean = sum(r["x"] for r in rows) / len(rows)
        y_mean = sum(r["y"] for r in rows) / len(rows)
        z_mean = sum(r["z"] for r in rows) / len(rows)
        corrected = main._apply_offsets_to_row(
            {
                "x": x_mean,
                "y": y_mean,
                "z": z_mean,
                "roll": 0.0,
                "pitch": 0.0,
                "yaw": 0.0,
            },
            profile,
        )

        self.assertAlmostEqual(corrected["x"], 0.0, delta=0.03)
        self.assertAlmostEqual(corrected["y"], 0.0, delta=0.03)
        # Dominant axis should keep gravity after calibration.
        self.assertAlmostEqual(abs(corrected["z"]), 1.0, delta=0.03)
        magnitude = math.sqrt(
            (corrected["x"] ** 2) + (corrected["y"] ** 2) + (corrected["z"] ** 2)
        )
        self.assertAlmostEqual(magnitude, 1.0, delta=0.03)

    def test_rewrite_candidates_only_include_uncalibrated_rows(self) -> None:
        rows = [
            {"time_ns": 101, "calibration_profile_signature": 0},
            {"time_ns": 102, "calibration_profile_signature": 42},
            {"time_ns": 103, "calibration_profile_signature": 17},
            {"time_ns": 104, "calibration_profile_signature": 42},
            {"time_ns": 105, "calibration_profile_signature": 0},
        ]
        with patch("backend.app.main._query_recent_window_rows", return_value=rows):
            candidates = main._query_rewrite_candidates(
                after_ns=100,
                batch_size=20,
            )

        self.assertEqual([row["time_ns"] for row in candidates], [101, 105])

    def test_calibration_accepts_angle_like_series_when_delta_noise_is_small(self) -> None:
        rows: list[dict[str, float]] = []
        for i in range(140):
            rows.append(
                {
                    "time_ns": 1_700_000_100_000_000_000 + i,
                    "x": -0.004,
                    "y": -0.006,
                    "z": 1.010,
                    # Large absolute spread (angle-like), but tiny per-sample delta.
                    "roll": -110.0 + (0.35 * i),
                    "pitch": 35.0 + (0.18 * i),
                    "yaw": -45.0 + (0.16 * i),
                }
            )

        profile, error = main._compute_calibration_from_rows(rows, window_seconds=2.5)
        self.assertIsNone(error)
        self.assertIsNotNone(profile)
        assert profile is not None
        self.assertTrue(profile["metrics"]["gyro_angle_like"])

    def test_calibration_rejects_large_delta_noise(self) -> None:
        rows: list[dict[str, float]] = []
        for i in range(140):
            rows.append(
                {
                    "time_ns": 1_700_000_200_000_000_000 + i,
                    "x": -0.004 + (0.0002 * ((i % 5) - 2)),
                    "y": -0.006 + (0.0002 * ((i % 5) - 2)),
                    "z": 1.010 + (0.0002 * ((i % 5) - 2)),
                    # High sample-to-sample jumps.
                    "roll": -80.0 + (4.0 if i % 2 else -4.0),
                    "pitch": 25.0 + (3.5 if i % 2 else -3.5),
                    "yaw": -40.0 + (3.8 if i % 2 else -3.8),
                }
            )

        profile, error = main._compute_calibration_from_rows(rows, window_seconds=2.5)
        self.assertIsNone(profile)
        self.assertIsNotNone(error)
        assert error is not None
        self.assertIn("gyro delta abs p95", error)

    def test_normalize_profile_generates_stable_signature(self) -> None:
        raw = {
            "offsets": {
                "ax": -5,
                "ay": 3,
                "az": 18,
                "gx": 2,
                "gy": -1,
                "gz": 4,
            },
            "sample_count": 100,
            "window_seconds": 2.5,
        }
        profile = main._normalize_calibration_profile(raw)
        self.assertIsNotNone(profile)
        assert profile is not None

        expected = main._profile_signature_from_offsets(profile["offsets"])
        self.assertEqual(profile["profile_signature"], expected)
        self.assertGreater(profile["profile_signature"], 0)

    def test_capture_fresh_raw_window_rows_filters_to_capture_interval(self) -> None:
        start_ns = 1_700_000_000_000_000_000
        end_ns = start_ns + 8_000_000_000
        rows = [
            {"time_ns": start_ns - 1, "calibration_profile_signature": 0},
            {"time_ns": start_ns + 1, "calibration_profile_signature": 0},
            {"time_ns": end_ns + 1, "calibration_profile_signature": 0},
            {
                "time_ns": end_ns + int((main.CALIBRATION_MAX_FUTURE_SKEW_SECONDS + 1.0) * 1_000_000_000),
                "calibration_profile_signature": 0,
            },
        ]

        with patch("backend.app.main.time.time_ns", side_effect=[start_ns, start_ns, end_ns]):
            with patch("backend.app.main.time.sleep") as sleep_mock:
                with patch("backend.app.main._query_recent_window_rows", return_value=rows):
                    captured = main._capture_fresh_raw_window_rows(8.0)

        self.assertEqual([row["time_ns"] for row in captured], [start_ns + 1, end_ns + 1])
        sleep_mock.assert_called_once_with(8.0)
        self.assertGreater(main.calibration_rewrite_pause_until_ns, 0)
        main._clear_rewrite_pause()

    def test_start_calibration_fresh_window_uses_capture_helper(self) -> None:
        rows = _make_stationary_rows(count=120)

        with patch("backend.app.main._capture_fresh_raw_window_rows", return_value=rows) as capture_mock:
            with patch("backend.app.main._query_recent_window_rows") as query_mock:
                with patch("backend.app.main._save_persisted_calibration_profile", side_effect=lambda p: p):
                    with patch("backend.app.main._activate_calibration_profile", side_effect=lambda p, **kwargs: p):
                        result = main.start_calibration({"window_seconds": 8.0, "fresh_window": True})

        self.assertTrue(result["ok"])
        capture_mock.assert_called_once_with(8.0)
        query_mock.assert_not_called()

    def test_start_calibration_default_uses_recent_raw_query(self) -> None:
        rows = _make_stationary_rows(count=120)

        with patch("backend.app.main._capture_fresh_raw_window_rows") as capture_mock:
            with patch("backend.app.main._query_recent_window_rows", return_value=rows) as query_mock:
                with patch("backend.app.main._save_persisted_calibration_profile", side_effect=lambda p: p):
                    with patch("backend.app.main._activate_calibration_profile", side_effect=lambda p, **kwargs: p):
                        result = main.start_calibration({"window_seconds": 8.0})

        self.assertTrue(result["ok"])
        capture_mock.assert_not_called()
        query_mock.assert_called_once()

    def test_encoded_line_contains_profile_signature_field(self) -> None:
        line = main._encode_calibrated_line(
            row={"time_ns": 123},
            calibrated={
                "x": 0.1,
                "y": 0.2,
                "z": 0.3,
                "roll": 1.1,
                "pitch": 2.2,
                "yaw": 3.3,
            },
            profile_signature=777,
        )
        self.assertIn("cal_profile_sig=777i", line)
        self.assertTrue(line.endswith(" 123"))


if __name__ == "__main__":
    unittest.main()
