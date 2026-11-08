"""Tests for the Flight Phase Visualization and Manual Tagging App."""

import pytest
from fastapi.testclient import TestClient

from flight_phase_app.data_manager import DataManager
from flight_phase_app.evaluator import PhaseEvaluator
from flight_phase_app.server import app
from flight_phase_app.tag_store import TagStore


@pytest.fixture
def test_client():
    return TestClient(app)


def test_data_manager_loads_sessions():
    dm = DataManager()
    dm.load_data()
    ac_list = dm.get_aircraft_list()
    assert len(ac_list) > 0

    first_ac = ac_list[0]["aircraft"]
    details = dm.get_aircraft_details(first_ac)
    assert details is not None
    assert details["aircraft"] == first_ac
    assert len(details["sessions"]) > 0

    # Test batch fetch
    first_sid = details["sessions"][0]["id"]
    batch = dm.get_sessions_batch([first_sid])
    assert len(batch["sessions"]) == 1
    assert batch["sessions"][0]["id"] == first_sid
    assert "points" in batch["sessions"][0]
    assert "phase_samples" in batch["sessions"][0]
    assert len(batch["sessions"][0]["points"]) == len(batch["sessions"][0]["phase_samples"])


def test_tag_store_crud(tmp_path):
    tags_file = tmp_path / "test_tags.json"
    ts = TagStore(storage_path=tags_file)

    # Initial state
    assert len(ts.get_tags()) == 0

    # Add tag
    tag = ts.add_tag(
        session_id="test_sess_01",
        aircraft="test_ac_01",
        t_start_s=100.0,
        t_end_s=150.0,
        manual_phase="approach",
        confidence="high",
        notes="Testing tag",
    )
    assert tag["tag_id"] is not None
    assert tag["manual_phase"] == "approach"

    # Query tags
    tags = ts.get_tags(session_id="test_sess_01")
    assert len(tags) == 1
    assert tags[0]["session_id"] == "test_sess_01"

    # Delete tag
    deleted = ts.delete_tag(tag["tag_id"])
    assert deleted is True
    assert len(ts.get_tags()) == 0


def test_evaluator_agreement():
    dm = DataManager()
    dm.load_data()
    ac_list = dm.get_aircraft_list()
    first_ac = ac_list[0]["aircraft"]
    details = dm.get_aircraft_details(first_ac)
    first_sess = details["sessions"][0]

    ts = TagStore()
    evaluator = PhaseEvaluator(data_manager=dm, tag_store=ts)
    res = evaluator.evaluate(session_id=first_sess["id"])
    assert "agreement_rate_pct" in res
    assert "confusion_matrix" in res
    assert "refinement_suggestions" in res


def test_api_endpoints(test_client):
    # Test status endpoint
    resp = test_client.get("/api/status")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ready"
    assert data["total_aircraft"] > 0

    # Test aircraft list
    resp = test_client.get("/api/aircraft")
    assert resp.status_code == 200
    ac_list = resp.json()
    assert len(ac_list) > 0

    first_ac = ac_list[0]["aircraft"]

    # Test aircraft details
    resp = test_client.get(f"/api/aircraft/{first_ac}")
    assert resp.status_code == 200
    details = resp.json()
    assert details["aircraft"] == first_ac
    assert len(details["sessions"]) > 0

    # Test batch sessions
    first_sid = details["sessions"][0]["id"]
    resp = test_client.post("/api/sessions/batch", json={"session_ids": [first_sid]})
    assert resp.status_code == 200
    batch = resp.json()
    assert len(batch["sessions"]) == 1

    # Test tag creation and deletion via API
    tag_payload = {
        "session_id": first_sid,
        "aircraft": first_ac,
        "t_start_s": 0.0,
        "t_end_s": 30.0,
        "manual_phase": "climb",
        "confidence": "high",
        "notes": "API test tag",
    }
    resp = test_client.post("/api/tags", json=tag_payload)
    assert resp.status_code == 200
    tag_data = resp.json()
    tag_id = tag_data["tag"]["tag_id"]

    # Verify tag is returned in GET
    resp = test_client.get(f"/api/tags?session_id={first_sid}")
    assert resp.status_code == 200
    tags = resp.json()
    assert any(t["tag_id"] == tag_id for t in tags)

    # Clean up test tag
    resp = test_client.delete(f"/api/tags/{tag_id}")
    assert resp.status_code == 200


def test_full_session_duration_a0be05_s1():
    dm = DataManager()
    dm.load_data()
    details = dm.get_aircraft_details("a0be05")
    assert details is not None
    s1 = next(s for s in details["sessions"] if s["id"] == "a0be05_S1")

    # Duration must be full flight duration in seconds (>2000s), NOT truncated bin count (415)
    assert s1["duration_s"] > 2000.0
    assert s1["t_max"] > 2000.0

    batch = dm.get_sessions_batch(["a0be05_S1"])
    sess = batch["sessions"][0]
    assert sess["duration_s"] > 2000.0
    assert batch["bounds"]["max_time_s"] > 2000.0

    # Ensure last point reaches JFK altitude 0ft
    last_pt = sess["points"][-1]
    assert last_pt[2] == 0.0
    assert sess["phase_samples"][-1]["phase"] == "ground"


def test_session_neighborhood_api(test_client):
    # Test neighborhood endpoint for session 01013c_S1
    resp = test_client.get("/api/sessions/01013c_S1/neighborhood?max_distance_nm=15.0&limit=5")
    assert resp.status_code == 200
    data = resp.json()

    assert "target" in data
    assert data["target"]["session_id"] == "01013c_S1"
    assert data["target"]["start_ts"] > 0
    assert "start_time_utc" in data["target"]

    assert "aviation_standards" in data
    assert data["aviation_standards"]["terminal_separation_lateral_nm"] == 3.0
    assert data["aviation_standards"]["terminal_separation_vertical_ft"] == 1000.0

    assert "neighbors" in data
    assert len(data["neighbors"]) > 0
    neighbor = data["neighbors"][0]
    assert "session_id" in neighbor
    assert "aircraft" in neighbor
    assert "min_dist_nm" in neighbor
    assert "vert_diff_ft" in neighbor
    assert "separation_status" in neighbor
    assert "points" in neighbor
    assert len(neighbor["points"]) > 0
    # Fourth point element is relative time to target session start
    assert len(neighbor["points"][0]) == 4


def test_neighborhood_404(test_client):
    resp = test_client.get("/api/sessions/nonexistent_session_id/neighborhood")
    assert resp.status_code == 404


def test_build_neighborhood_index_module(tmp_path):
    import sys
    sys.path.insert(0, "03-Visualization")
    from build_neighborhood_index import compute_neighborhood_index

    # Create synthetic test sessions
    test_sessions = {
        "sessions": [
            {
                "id": "T1_S1",
                "aircraft": "T1",
                "start_ts": 1000000.0,
                "complete_kind": "arrival",
                "src": "",
                "dest": "JFK",
                "points": [
                    [-73.8, 40.6, 2000.0, 0],
                    [-73.78, 40.64, 500.0, 10],
                ],
            },
            {
                "id": "T2_S1",
                "aircraft": "T2",
                "start_ts": 1000000.0,
                "complete_kind": "arrival",
                "src": "",
                "dest": "JFK",
                "points": [
                    [-73.81, 40.61, 2200.0, 0],
                    [-73.79, 40.65, 600.0, 10],
                ],
            },
        ]
    }
    sessions_file = tmp_path / "test_continuous.json"
    output_file = tmp_path / "test_neighborhood.json"
    import json
    with open(sessions_file, "w") as f:
        json.dump(test_sessions, f)

    res = compute_neighborhood_index(sessions_path=sessions_file, output_path=output_file)
    assert res["meta"]["total_sessions"] == 2
    assert "T1_S1" in res["neighborhoods"]
    assert len(res["neighborhoods"]["T1_S1"]) == 1
    neighbor = res["neighborhoods"]["T1_S1"][0]
    assert neighbor["session_id"] == "T2_S1"
    assert neighbor["min_dist_nm"] < 3.0
    assert neighbor["separation_status"] == "alert"

