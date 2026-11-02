import json
import sys
import tempfile
import unittest
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

from complete_sessions import (
    MIN_PTS_PER_SESSION,
    _airport_locations,
    classify_complete,
    complete_session_ids,
    continuous_sessions_to_payload,
    discretize_sessions,
    export_session_payload,
    load_adsb,
    phase_session_ids,
)


class CompleteSessionFilterTests(unittest.TestCase):
    def test_phase_scope_helper_filters_by_airport(self):
        frame = pd.DataFrame(
            {
                "aircraft_session_id": ["A", "B", "C", "D"],
                "flight_phase_scope": [
                    "jfk_arrival",
                    "jfk_departure",
                    "lga_arrival",
                    pd.NA,
                ],
            }
        )
        self.assertEqual(set(phase_session_ids(frame)), {"A", "B"})
        self.assertEqual(list(phase_session_ids(frame, "LGA")), ["C"])

    def test_phase_sidecar_join_preserves_duplicate_source_rows(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            source_path = Path(temp_dir) / "source.feather"
            tags_path = Path(temp_dir) / "phase_tags.feather"
            source = pd.DataFrame(
                {
                    "aircraft": ["A"] * 3,
                    "aircraft_session_id": ["A_S1"] * 3,
                    "ts": [100_000, 100_000, 105_000],
                    "lon": [-73.5] * 3,
                    "lat": [40.5] * 3,
                    "altitude": [3_000] * 3,
                }
            )
            tags = pd.DataFrame(
                {
                    "aircraft_session_id": ["A_S1", "A_S1"],
                    "ts": [100_000, 105_000],
                    "flight_phase_scope": ["jfk_departure"] * 2,
                    "flight_phase": ["initial_climb", "climb"],
                    "flight_phase_changed": [False, True],
                }
            )
            source.to_feather(source_path)
            tags.to_feather(tags_path)

            joined, _ = load_adsb(source_path, phase_tags_path=tags_path)

        self.assertEqual(len(joined), len(source))
        self.assertEqual(joined["flight_phase"].tolist(), ["initial_climb", "initial_climb", "climb"])
        self.assertEqual(joined["flight_phase_changed"].tolist(), [False, False, True])

    def test_phase_sidecar_duplicate_keys_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            source_path = Path(temp_dir) / "source.feather"
            tags_path = Path(temp_dir) / "phase_tags.feather"
            pd.DataFrame(
                {
                    "aircraft": ["A"],
                    "aircraft_session_id": ["A_S1"],
                    "ts": [100_000],
                    "lon": [-73.5],
                    "lat": [40.5],
                    "altitude": [3_000],
                }
            ).to_feather(source_path)
            tags = pd.DataFrame(
                {
                    "aircraft_session_id": ["A_S1", "A_S1"],
                    "ts": [100_000, 100_000],
                    "flight_phase_scope": ["jfk_departure"] * 2,
                    "flight_phase": ["climb"] * 2,
                    "flight_phase_changed": [False, False],
                }
            )
            tags.to_feather(tags_path)

            with self.assertRaisesRegex(ValueError, "duplicate join keys"):
                load_adsb(source_path, phase_tags_path=tags_path)

    def test_airport_locations_use_exported_iata_codes(self):
        fields = ["KJFK", "JFK"] + ["unused"] * 12 + ["40.6413", "-73.7781"]
        with tempfile.TemporaryDirectory() as temp_dir:
            database = Path(temp_dir) / "airports.txt"
            database.write_text(":".join(fields) + "\n", encoding="utf-8")

            locations = _airport_locations({"jfk", "missing"}, database)

        self.assertEqual(locations, {"JFK": {"lat": 40.6413, "lon": -73.7781}})

    def setUp(self):
        self.summary = pd.DataFrame(
            {
                "aircraft": ["A", "B", "C", "D"],
                "session_type": ["S1", "S3", "S2", "S4"],
                "n_pts": [5, 5, 5, 5],
                "ts_first": [100_000] * 4,
                "ts_last": [500_000] * 4,
                "n_to": [1, 1, 0, 0],
                "n_ld": [1, 0, 1, 0],
                "flag_to": [True, True, False, False],
                "flag_ld": [True, False, True, False],
                "raw_to": [True, True, False, False],
                "raw_ld": [True, False, True, False],
                "max_alt": [10_000] * 4,
                "min_alt": [0] * 4,
                "ground_only": [False] * 4,
                "first_session_alt": [0] * 4,
                "last_session_alt": [0] * 4,
                "src": [None, "KAAA", None, None],
                "dest": ["KBBB", None, "KBBB", None],
                "first_on_edge": [False, False, True, True],
                "last_on_edge": [False, True, False, True],
                "first_lat": [40.0] * 4,
                "first_lon": [-73.0] * 4,
                "last_lat": [40.0] * 4,
                "last_lon": [-73.0] * 4,
                "first_alt": [0] * 4,
                "last_alt": [0] * 4,
                "n_in_bbox": [5] * 4,
                "n_bbox_runs": [1] * 4,
                "has_to": [True, True, False, False],
                "has_ld": [True, False, True, False],
            },
            index=pd.Index(["A_S1", "B_S1", "C_S1", "D_S1"], name="aircraft_session_id"),
        )

    def test_two_point_floor_keeps_short_complete_routes(self):
        result = classify_complete(self.summary, 0, 1_000_000)
        self.assertEqual(MIN_PTS_PER_SESSION, 2)
        self.assertEqual(result["complete_kind"].tolist(), ["local", "departure", "arrival", "transit"])
        self.assertTrue(result["is_complete"].all())

    def test_labeled_arrival_and_departure_do_not_require_edge_samples(self):
        summary = self.summary.copy()
        summary.loc["B_S1", "last_on_edge"] = False
        summary.loc["C_S1", "first_on_edge"] = False
        summary.loc["D_S1", "first_on_edge"] = False
        summary.loc["D_S1", "last_on_edge"] = False

        result = classify_complete(summary, 0, 1_000_000)

        self.assertTrue(result.loc["B_S1", "is_complete"])
        self.assertEqual(result.loc["B_S1", "complete_kind"], "departure")
        self.assertEqual(result.loc["B_S1", "end_kind"], "E_TRACK_END")
        self.assertTrue(result.loc["C_S1", "is_complete"])
        self.assertEqual(result.loc["C_S1", "complete_kind"], "arrival")
        self.assertEqual(result.loc["C_S1", "start_kind"], "S_TRACK_START")
        self.assertTrue(result.loc["D_S1", "is_complete"])
        self.assertEqual(result.loc["D_S1", "complete_kind"], "transit")

    def test_session_type_must_match_unbuffered_event_counts(self):
        summary = self.summary.copy()
        summary.loc["B_S1", "session_type"] = "S2"

        result = classify_complete(summary, 0, 1_000_000)

        self.assertFalse(result.loc["B_S1", "is_complete"])
        self.assertEqual(
            result.loc["B_S1", "drop_reason"], "session_type_event_mismatch"
        )

    def test_collection_clips_omit_unobserved_session_endpoints(self):
        result = classify_complete(self.summary, 100_000, 500_000)

        self.assertEqual(result.loc["C_S1", "drop_reason"], "clipped_collection_start")
        self.assertEqual(result.loc["B_S1", "drop_reason"], "clipped_collection_end")
        self.assertEqual(result.loc["D_S1", "drop_reason"], "clipped_collection_start")

    def test_ground_only_transit_label_is_not_complete(self):
        summary = self.summary.copy()
        summary.loc["D_S1", "ground_only"] = True

        result = classify_complete(summary, 0, 1_000_000)

        self.assertFalse(result.loc["D_S1", "is_complete"])
        self.assertEqual(result.loc["D_S1", "drop_reason"], "parked_or_ground")

    def test_ground_flag_is_used_to_reject_parked_s4(self):
        df = pd.DataFrame(
            {
                "aircraft": ["A", "A"],
                "aircraft_session_id": ["A_S1", "A_S1"],
                "aircraft_session_type": ["S4", "S4"],
                "ts": [100_000, 120_000],
                "lon": [-73.0, -73.1],
                "lat": [40.0, 40.1],
                "altitude": [5_000, 5_000],
                "ground_flag": [True, True],
                "n_to_session": [0, 0],
                "n_ld_session": [0, 0],
            }
        )

        keep, summary, _ = complete_session_ids(df)

        self.assertEqual(list(keep), [])
        self.assertTrue(summary.loc["A_S1", "ground_only"])
        self.assertEqual(summary.loc["A_S1", "drop_reason"], "parked_or_ground")

    def test_minimum_uses_valid_in_sector_points(self):
        df = pd.DataFrame(
            {
                "aircraft": ["A", "A"],
                "aircraft_session_id": ["A_S1", "A_S1"],
                "aircraft_session_type": ["S1", "S1"],
                "ts": [100_000, 120_000],
                "lon": [-73.0, -73.1],
                "lat": [40.0, 40.1],
                "altitude": [5_000, 5_500],
                "altitude_invalid_flag": [False, True],
                "n_to_session": [1, 1],
                "n_ld_session": [1, 1],
            }
        )

        keep, summary, _ = complete_session_ids(df)

        self.assertEqual(list(keep), [])
        self.assertEqual(summary.loc["A_S1", "n_valid_points"], 1)
        self.assertEqual(summary.loc["A_S1", "drop_reason"], "too_few_points")

    def test_merge_buffer_touchdown_does_not_close_a_departure(self):
        df = pd.DataFrame(
            {
                "aircraft": ["A", "A"],
                "aircraft_session_id": ["A_S1", "A_S1"],
                "aircraft_session_type": ["S3", "S3"],
                "ts": [100_000, 120_000],
                "lon": [-73.0, -73.0],
                "lat": [40.0, 40.0],
                "altitude": [0, 5_000],
                "n_to_session": [1, 1],
                "n_ld_session": [0, 0],
                "takeoff": [False, True],
                "touchdown": [True, False],
                "takeoff_in_sector": [False, True],
                "touchdown_in_sector": [True, False],
                "session_src_airport": ["KAAA", "KAAA"],
                "session_dest_airport": ["KAAA", "KAAA"],
                "ground_flag": [True, False],
                "track_segment_id": ["A_T1", "A_T1"],
            }
        )

        keep, summary, _ = complete_session_ids(df)

        self.assertEqual(list(keep), [])
        self.assertFalse(summary.loc["A_S1", "has_ld"])
        self.assertEqual(summary.loc["A_S1", "start_kind"], "S_TO")
        self.assertEqual(summary.loc["A_S1", "end_kind"], "E_TRACK_END")
        self.assertEqual(
            summary.loc["A_S1", "drop_reason"], "clipped_collection_end"
        )

    def test_higher_quality_floor_is_opt_in(self):
        result = classify_complete(self.summary, 0, 1_000_000, min_points=20)
        self.assertFalse(result["is_complete"].any())
        self.assertTrue((result["drop_reason"] == "too_few_points").all())

    def test_quality_floor_cannot_remove_minimum_geometry_requirement(self):
        with self.assertRaises(ValueError):
            classify_complete(self.summary, 0, 1_000_000, min_points=1)

    def test_bad_altitude_samples_are_omitted_but_session_is_kept(self):
        df = pd.DataFrame(
            {
                "aircraft": ["A"] * 6,
                "aircraft_session_id": ["A_S1"] * 6,
                "aircraft_session_type": ["S1"] * 6,
                "ts": [100_000, 105_000, 110_000, 115_000, 120_000, 125_000],
                "lon": [-73.5] * 6,
                "lat": [40.5] * 6,
                "altitude": [5_000, 5_500, 20_000, 87_700, 6_000, 6_500],
                "altitude_phase_ft": [5_000, 5_500, 5_750, 87_700, 6_000, 6_500],
                "n_to_session": [1] * 6,
                "n_ld_session": [1] * 6,
                "track_segment_id": ["A_T1"] * 6,
                "quality_flag_count": [0, 0, 1, 2, 0, 0],
                "altitude_invalid_flag": [False] * 6,
                "altitude_range_flag": [False, False, False, True, False, False],
                "altitude_ceiling_flag": [False, False, False, True, False, False],
                "altitude_spike_suspect_flag": [False, False, True, False, False, False],
            }
        )

        keep, summary, box = complete_session_ids(df)
        self.assertEqual(list(keep), ["A_S1"])

        occupancy = discretize_sessions(df, keep, box=box)
        self.assertEqual(sorted(occupancy["it"].tolist()), [0, 1, 2, 4, 5])
        self.assertEqual(occupancy.loc[occupancy["it"] == 2, "alt"].iloc[0], 5_750)
        self.assertLess(occupancy["alt"].max(), 48_000)

        continuous = continuous_sessions_to_payload(
            df, keep, summary, box, dt=5, source="synthetic"
        )
        points = continuous["sessions"][0]["points"]
        self.assertEqual([point[3] for point in points], [0, 1, 2, 4, 5])
        self.assertEqual(next(point[2] for point in points if point[3] == 2), 5_750)
        self.assertLess(max(point[2] for point in points), 48_000)

        with tempfile.TemporaryDirectory() as temp_dir:
            output, meta = export_session_payload(
                df,
                "synthetic",
                keep,
                summary,
                box,
                out_path=Path(temp_dir) / "sessions.json",
            )
            payload = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(meta["quality"]["sessions_with_flags"], 1)
        self.assertIn("above-ceiling", meta["quality"]["filtering"])
        self.assertEqual(payload["sessions"][0]["quality"]["altitude_ceiling_points"], 1)
        self.assertEqual(payload["meta"]["n_in_sector_points"], 5)
        self.assertEqual(payload["sessions"][0]["n_points"], 5)
        self.assertEqual(len(payload["sessions"][0]["occ"]), 5)

    def test_qc_flags_are_reported_without_dropping_complete_session(self):
        rows = []
        times = [150_000, 250_000, 350_000, 450_000, 550_000]
        longitudes = [-77.8, -77.6, -77.0, -77.6, -77.8]
        for index, (ts, lon) in enumerate(zip(times, longitudes)):
            rows.append(
                {
                    "aircraft": "A",
                    "aircraft_session_id": "A_S1",
                    "aircraft_session_type": "S4",
                    "ts": ts,
                    "lon": lon,
                    "lat": 40.0,
                    "altitude": 5_000,
                    "track_segment_id": "A_T1",
                    "quality_flag_count": int(index == 2),
                    "position_jump_suspect_flag": index == 2,
                }
            )
        rows.extend(
            [
                {"aircraft": "A", "aircraft_session_id": "A_S1",
                 "aircraft_session_type": "S4", "ts": 100_000,
                 "lon": -80.0, "lat": 40.0, "altitude": 5_000},
                {"aircraft": "A", "aircraft_session_id": "A_S1",
                 "aircraft_session_type": "S4", "ts": 900_000,
                 "lon": -80.0, "lat": 40.0, "altitude": 5_000},
                {"aircraft": "B", "aircraft_session_id": "B_S1", "ts": 0,
                 "lon": -80.0, "lat": 40.0, "altitude": 5_000},
                {"aircraft": "B", "aircraft_session_id": "B_S1", "ts": 1_000_000,
                 "lon": -80.0, "lat": 40.0, "altitude": 5_000},
            ]
        )
        df = pd.DataFrame(rows)
        keep, summary, box = complete_session_ids(df)
        self.assertEqual(list(keep), ["A_S1"])
        self.assertEqual(summary.loc["A_S1", "quality_flagged_points"], 1)

        with tempfile.TemporaryDirectory() as temp_dir:
            output, meta = export_session_payload(
                df,
                "synthetic",
                keep,
                summary,
                box,
                out_path=Path(temp_dir) / "sessions.json",
            )
            payload = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(meta["quality"]["sessions_with_flags"], 1)
        self.assertEqual(payload["sessions"][0]["quality"]["quality_flagged_points"], 1)
        self.assertEqual(len(payload["sessions"][0]["occ"]), 5)
        self.assertEqual(min(point[3] for point in payload["sessions"][0]["occ"]), 0)

        continuous = continuous_sessions_to_payload(
            df, keep, summary, box, dt=5, source="synthetic"
        )
        self.assertEqual(len(continuous["sessions"][0]["points"]), 5)
        self.assertEqual(continuous["meta"]["n_in_sector_points"], 5)
        self.assertEqual(
            min(point[3] for point in continuous["sessions"][0]["points"]), 0
        )


class FlightPhaseExportTests(unittest.TestCase):
    def setUp(self):
        self.frame = pd.DataFrame(
            {
                "aircraft": ["A"] * 3,
                "aircraft_session_id": ["A_S1"] * 3,
                "aircraft_session_type": ["S1"] * 3,
                "ts": [100_000, 105_000, 110_000],
                "lon": [-73.5] * 3,
                "lat": [40.5] * 3,
                "altitude": [3_000] * 3,
                "altitude_phase_ft": [3_000] * 3,
                "n_to_session": [1] * 3,
                "n_ld_session": [1] * 3,
                "track_segment_id": ["A_T1"] * 3,
                "flight_phase_scope": ["jfk_departure"] * 3,
                "flight_phase": ["climb", "climb", "cruise"],
                "flight_phase_detail": ["", "", ""],
                "flight_phase_confidence": [0.8, 0.9, 0.9],
                "flight_phase_changed": [False, False, True],
                "flight_phase_event": ["", "", "phase_changed"],
                "flight_phase_model_version": ["causal_adsb_phase_v1"] * 3,
                "flight_phase_is_causal": [True] * 3,
            }
        )
        self.keep, self.summary, self.box = complete_session_ids(self.frame)
        self.assertEqual(list(self.keep), ["A_S1"])

    def test_change_flag_and_intervals_survive_both_export_modes(self):
        bins = {"dx": 1.0, "dy": 1.0, "dz": 5_000.0, "dt": 5.0}
        with tempfile.TemporaryDirectory() as temp_dir:
            for mode, filename in (
                ("discrete", "discrete.json"),
                ("continuous", "continuous.json"),
            ):
                output, meta = export_session_payload(
                    self.frame,
                    "synthetic.feather",
                    self.keep,
                    self.summary,
                    self.box,
                    mode=mode,
                    bins=bins,
                    out_path=Path(temp_dir) / filename,
                    phase_airport="JFK",
                )
                payload = json.loads(output.read_text(encoding="utf-8"))
                session = payload["sessions"][0]

                self.assertEqual(
                    [sample["changed"] for sample in session["phase_samples"]],
                    [False, False, True],
                )
                self.assertEqual(
                    [sample["phase"] for sample in session["phase_samples"]],
                    ["climb", "climb", "cruise"],
                )
                self.assertEqual(
                    [sample["time_s"] for sample in session["phase_samples"]],
                    [0.0, 5.0, 10.0],
                )
                self.assertEqual(len(session["phase_intervals"]), 2)
                self.assertEqual(session["phase_intervals"][0]["n_points"], 2)
                self.assertEqual(session["phase_intervals"][1]["phase"], "cruise")
                self.assertEqual(meta["phase_inference"]["n_exported_phase_samples"], 3)
                self.assertEqual(meta["phase_inference"]["n_exported_phase_changes"], 1)
                if mode == "discrete":
                    self.assertEqual(session["n_points"], 3)
                    self.assertEqual(len(session["occ"]), 3)
                else:
                    self.assertEqual(len(session["points"]), 3)


if __name__ == "__main__":
    unittest.main()
