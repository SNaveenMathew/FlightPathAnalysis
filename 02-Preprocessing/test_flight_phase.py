import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

from flight_phase import (
    annotate_jfk_flight_phases,
    load_airport_record,
    phase_session_ids,
    select_airport_session_scopes,
)

JFK = {"latitude": 40.64, "longitude": -73.779, "elevation_ft": 4.0}


def make_track(
    session_id="TEST_S1",
    n=100,
    latitude=None,
    longitude=-73.779,
    altitude=None,
    ground=None,
    segment=None,
    scope="departure",
    seed=7,
):
    rng = np.random.default_rng(seed)
    index = np.arange(n)
    times = 1_000_000 + index * 5_000
    if latitude is None:
        latitude = np.full(n, 41.1)
    if altitude is None:
        altitude = np.full(n, 10_000.0)
    if ground is None:
        ground = np.zeros(n, dtype=bool)
    altitude = np.asarray(altitude, dtype=float) + rng.normal(0, 35.0, n)
    ground = np.asarray(ground, dtype=bool)
    if segment is None:
        segment = np.full(n, "T1", dtype=object)
    frame = pd.DataFrame(
        {
            "aircraft": "TEST01",
            "id": "TEST01",
            "aircraft_session_id": session_id,
            "aircraft_session_type": "S3" if scope == "departure" else "S2",
            "ts": times,
            "lat": np.asarray(latitude, dtype=float),
            "lon": np.full(n, longitude),
            "altitude": altitude,
            "altitude_raw_ft": altitude,
            "ground_speed": np.full(n, 180.0),
            "ground_flag": ground,
            "ground_flag_confidence": np.where(ground, 1.0, 0.0),
            "track_segment_id": segment,
            "altitude_invalid_flag": False,
            "altitude_range_flag": False,
            "altitude_ceiling_flag": False,
            "altitude_jump_suspect_flag": False,
            "takeoff": False,
            "touchdown": False,
            "takeoff_candidate": False,
            "touchdown_candidate": False,
            "takeoff_airport": "",
            "airport": "",
            "session_src_airport": "JFK" if scope == "departure" else "",
            "session_dest_airport": "JFK" if scope == "arrival" else "",
            "n_to_session": 1 if scope == "departure" else 0,
            "n_ld_session": 1 if scope == "arrival" else 0,
        }
    )
    if scope == "departure":
        frame.loc[0, ["takeoff", "takeoff_candidate"]] = True
        frame.loc[0, "takeoff_airport"] = "JFK"
    if scope == "arrival":
        frame.loc[n - 1, ["touchdown", "touchdown_candidate"]] = True
        frame.loc[n - 1, "airport"] = "JFK"
    return frame


class FlightPhaseSelectionTests(unittest.TestCase):
    def test_global_airport_database_record_parses_elevation_and_coordinates(self):
        record = load_airport_record("JFK")
        self.assertEqual(record, JFK)

    def test_selects_only_event_matched_jfk_sessions(self):
        frame = make_track("A_S1", n=3)
        other = make_track("B_S1", n=3)
        other.loc[0, "takeoff_airport"] = "LGA"
        other["session_src_airport"] = ""
        other["n_to_session"] = 0
        combined = pd.concat([frame, other], ignore_index=True)

        scopes = select_airport_session_scopes(combined)

        self.assertEqual(scopes, {"A_S1": "jfk_departure"})

    def test_phase_scope_helper_filters_jfk_only(self):
        frame = pd.DataFrame(
            {
                "aircraft_session_id": ["A", "A", "B"],
                "flight_phase_scope": ["jfk_departure", "jfk_departure", pd.NA],
            }
        )
        self.assertEqual(list(phase_session_ids(frame, "JFK")), ["A"])


class CausalPhaseInferenceTests(unittest.TestCase):
    def annotate(self, frame):
        return annotate_jfk_flight_phases(frame, airport_record=JFK)

    def test_jittered_level_cruise_does_not_chatter(self):
        frame = make_track(n=150, seed=15)
        annotated = self.annotate(frame)
        tail = annotated.iloc[-25:]
        self.assertTrue((tail["flight_phase"] == "cruise").all())
        self.assertLess(tail["flight_phase_vertical_rate_fpm"].abs().median(), 150)
        self.assertLessEqual(tail["flight_phase_confidence"].max(), 0.95)

    def test_sustained_climb_is_not_flattened_by_altitude_jitter(self):
        n = 100
        altitude = 2_000 + np.arange(n) * 60.0
        frame = make_track(n=n, altitude=altitude, latitude=np.full(n, 41.1), seed=8)

        annotated = self.annotate(frame)
        tail = annotated.iloc[-20:]
        self.assertTrue((tail["flight_phase"] == "climb").all())
        self.assertGreater(tail["flight_phase_vertical_rate_fpm"].median(), 600)

    def test_arrival_approach_requires_closing_track_and_descent(self):
        n = 100
        latitude = np.linspace(41.2, 40.64, n)
        altitude = np.linspace(10_000, 400, n)
        frame = make_track(
            n=n,
            latitude=latitude,
            altitude=altitude,
            scope="arrival",
            seed=11,
        )
        annotated = self.annotate(frame)
        approach = annotated[annotated["flight_phase"] == "approach"]
        self.assertGreater(len(approach), 0)
        self.assertTrue((approach["flight_phase_closure_rate_kts"] >= 25).all())
        self.assertTrue((approach["flight_phase_vertical_rate_fpm"] < -300).all())
        self.assertTrue(approach["flight_phase_detail"].str.contains("approach_candidate").all())

    def test_departure_climb_does_not_become_approach(self):
        n = 100
        latitude = np.linspace(40.64, 41.2, n)
        altitude = np.linspace(300, 10_000, n)
        ground = np.zeros(n, dtype=bool)
        ground[0] = True
        frame = make_track(
            n=n,
            latitude=latitude,
            altitude=altitude,
            ground=ground,
            scope="departure",
            seed=12,
        )
        annotated = self.annotate(frame)
        self.assertNotIn("approach", set(annotated["flight_phase"]))
        self.assertIn("climb", set(annotated["flight_phase"]))
        self.assertIn("liftoff_candidate", ";".join(annotated["flight_phase_event"]))

    def test_ground_transition_creates_landing_candidate_and_change_flag(self):
        n = 60
        ground = np.zeros(n, dtype=bool)
        ground[-8:] = True
        altitude = np.linspace(5_000, 100, n)
        frame = make_track(
            n=n,
            latitude=np.full(n, JFK["latitude"]),
            altitude=altitude,
            ground=ground,
            scope="arrival",
            seed=18,
        )
        annotated = self.annotate(frame)
        landing_rows = annotated.index[annotated["flight_phase"] == "landing"]
        self.assertGreater(len(landing_rows), 0)
        landing_row = int(landing_rows[0])
        self.assertTrue(annotated.loc[landing_row, "flight_phase_changed"])
        self.assertIn("touchdown_candidate", annotated.loc[landing_row, "flight_phase_event"])
        self.assertFalse(bool(annotated["flight_phase_changed"].iloc[0]))

    def test_phase_changed_is_exact_previous_label_comparison_per_segment(self):
        n = 80
        altitude = np.r_[np.linspace(1_000, 5_000, 40), np.full(40, 5_000.0)]
        segment = np.array(["T1"] * 40 + ["T2"] * 40, dtype=object)
        frame = make_track(n=n, altitude=altitude, segment=segment, seed=3)
        annotated = self.annotate(frame)
        for _, group in annotated.groupby("track_segment_id", sort=False):
            labels = group["flight_phase"].tolist()
            flags = group["flight_phase_changed"].tolist()
            self.assertFalse(flags[0])
            self.assertEqual(flags[1:], [labels[i] != labels[i - 1] for i in range(1, len(labels))])

    def test_track_gap_reinitializes_phase_history(self):
        n = 70
        times = 1_000_000 + np.arange(n) * 5_000
        times[35:] += 300_000
        frame = make_track(n=n, seed=2)
        frame["ts"] = times
        frame.loc[35:, "track_segment_id"] = "T2"
        frame.loc[35:, "altitude_raw_ft"] = np.nan
        frame.loc[35:, "altitude"] = np.nan
        annotated = self.annotate(frame)
        second_segment = annotated.loc[annotated["track_segment_id"] == "T2"]
        self.assertEqual(second_segment["flight_phase"].iloc[0], "unknown")
        self.assertFalse(bool(second_segment["flight_phase_changed"].iloc[0]))

    def test_posthoc_event_flags_do_not_change_causal_phase_estimate(self):
        frame = make_track(n=100, seed=21)
        frame["session_src_airport"] = ""
        frame["n_to_session"] = 0
        first = self.annotate(frame)
        mutated = frame.copy()
        mutated["takeoff"] = ~mutated["takeoff"].astype(bool)
        mutated["touchdown"] = ~mutated["touchdown"].astype(bool)
        second = self.annotate(mutated)
        pd.testing.assert_series_equal(first["flight_phase"], second["flight_phase"])
        pd.testing.assert_series_equal(first["flight_phase_event"], second["flight_phase_event"])
        self.assertTrue(first["flight_phase_is_causal"].all())


if __name__ == "__main__":
    unittest.main()
