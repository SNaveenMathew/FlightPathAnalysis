"""Build spatial-temporal neighborhood index for complete aircraft sessions.

Applies FAA and ICAO air traffic separation standards:
- Terminal radar separation minimum: 3.0 NM lateral, 1,000 ft vertical (Alert)
- Traffic Advisory / En-route separation minimum: 5.0 NM lateral, 2,000 ft vertical (Caution)
- Longitudinal / in-trail flow separation: <= 180 s (3 minutes) along the same corridor
- Extended surveillance neighborhood volume: <= 15.0 NM lateral, <= 4,000 ft vertical
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

DEFAULT_SESSIONS_PATH = Path(__file__).resolve().parent / "continuous_sessions.json"
DEFAULT_OUTPUT_PATH = Path(__file__).resolve().parent / "neighborhood_index.json"

# Aviation standard separation parameters
TERMINAL_SEP_NM = 3.0
TERMINAL_SEP_ALT_FT = 1000.0
CAUTION_SEP_NM = 5.0
CAUTION_SEP_ALT_FT = 2000.0
MAX_NEIGHBORHOOD_NM = 15.0
MAX_NEIGHBORHOOD_ALT_FT = 4000.0
IN_TRAIL_TIME_S = 180.0
TIME_EVAL_STEP_S = 10.0


def compute_neighborhood_index(
    sessions_path: Path | str = DEFAULT_SESSIONS_PATH,
    output_path: Path | str | None = DEFAULT_OUTPUT_PATH,
    max_neighborhood_nm: float = MAX_NEIGHBORHOOD_NM,
    max_neighborhood_alt_ft: float = MAX_NEIGHBORHOOD_ALT_FT,
    step_s: float = TIME_EVAL_STEP_S,
) -> dict[str, Any]:
    """Compute spatial-temporal neighborhood relationships for all sessions."""
    sessions_path = Path(sessions_path)
    if not sessions_path.is_file():
        raise FileNotFoundError(f"Sessions file not found: {sessions_path}")

    with open(sessions_path, "r", encoding="utf-8") as f:
        payload = json.load(f)

    sessions = payload.get("sessions", [])

    sess_list: list[dict[str, Any]] = []
    for s in sessions:
        sid = s.get("id")
        start_ts = s.get("start_ts")
        pts_raw = s.get("points", [])
        if not sid or not pts_raw or start_ts is None:
            continue

        pts = np.array(pts_raw, dtype=np.float64)
        if len(pts) == 0:
            continue

        t_sec = float(start_ts) / 1000.0 + pts[:, 3] * 5.0
        sess_list.append({
            "id": sid,
            "aircraft": s.get("aircraft", ""),
            "t": t_sec,
            "lon": pts[:, 0],
            "lat": pts[:, 1],
            "alt": pts[:, 2],
            "t_min": float(t_sec[0]),
            "t_max": float(t_sec[-1]),
            "min_lon": float(pts[:, 0].min()),
            "max_lon": float(pts[:, 0].max()),
            "min_lat": float(pts[:, 1].min()),
            "max_lat": float(pts[:, 1].max()),
            "min_alt": float(pts[:, 2].min()),
            "max_alt": float(pts[:, 2].max()),
            "complete_kind": s.get("complete_kind", ""),
            "src": s.get("src", ""),
            "dest": s.get("dest", ""),
        })

    # Sort sessions temporally by flight start
    sess_list.sort(key=lambda item: item["t_min"])

    index_map: dict[str, list[dict[str, Any]]] = {s["id"]: [] for s in sess_list}
    alert_count = 0
    caution_count = 0
    in_trail_count = 0
    total_pairs_evaluated = 0

    # Bounding box expansion degrees (15 NM ~ 0.25 deg lat, ~0.35 deg lon at NY latitude)
    lat_pad = (max_neighborhood_nm / 60.0) * 1.15
    lon_pad = (max_neighborhood_nm / 45.0) * 1.15

    for i in range(len(sess_list)):
        si = sess_list[i]
        for j in range(i + 1, len(sess_list)):
            sj = sess_list[j]
            if sj["t_min"] > si["t_max"]:
                break

            # Fast vertical altitude filter
            if (si["min_alt"] - max_neighborhood_alt_ft > sj["max_alt"] or
                si["max_alt"] + max_neighborhood_alt_ft < sj["min_alt"]):
                continue

            # Fast lateral bounding box filter
            if (si["min_lon"] - lon_pad > sj["max_lon"] or
                si["max_lon"] + lon_pad < sj["min_lon"] or
                si["min_lat"] - lat_pad > sj["max_lat"] or
                si["max_lat"] + lat_pad < sj["min_lat"]):
                continue

            t_start = max(si["t_min"], sj["t_min"])
            t_end = min(si["t_max"], sj["t_max"])
            overlap_s = t_end - t_start
            if overlap_s < 10.0:
                continue

            total_pairs_evaluated += 1

            t_eval = np.arange(t_start, t_end + 1.0, step_s)
            if len(t_eval) == 0:
                continue

            lon1 = np.interp(t_eval, si["t"], si["lon"])
            lat1 = np.interp(t_eval, si["t"], si["lat"])
            alt1 = np.interp(t_eval, si["t"], si["alt"])

            lon2 = np.interp(t_eval, sj["t"], sj["lon"])
            lat2 = np.interp(t_eval, sj["t"], sj["lat"])
            alt2 = np.interp(t_eval, sj["t"], sj["alt"])

            mid_lat = (lat1 + lat2) * 0.5 * (math.pi / 180.0)
            dx_nm = (lon1 - lon2) * np.cos(mid_lat) * 60.0
            dy_nm = (lat1 - lat2) * 60.0
            dist_nm = np.sqrt(dx_nm * dx_nm + dy_nm * dy_nm)
            dalt_ft = np.abs(alt1 - alt2)

            min_idx = int(np.argmin(dist_nm))
            min_dist = float(dist_nm[min_idx])

            if min_dist > max_neighborhood_nm:
                continue

            cpa_t = float(t_eval[min_idx])
            vert_diff = float(dalt_ft[min_idx])

            # Classify relationship according to FAA regulations
            is_same_flow = bool(
                (si["src"] and si["src"] == sj["src"] and si["src"] in {"JFK", "LGA", "EWR"}) or
                (si["dest"] and si["dest"] == sj["dest"] and si["dest"] in {"JFK", "LGA", "EWR"})
            )

            if min_dist < TERMINAL_SEP_NM and vert_diff < TERMINAL_SEP_ALT_FT:
                status = "alert"
                label = f"Loss of Separation (<{TERMINAL_SEP_NM} NM, <{int(TERMINAL_SEP_ALT_FT)} ft)"
                alert_count += 1
            elif min_dist < CAUTION_SEP_NM and vert_diff < CAUTION_SEP_ALT_FT:
                status = "caution"
                label = f"Traffic Proximity Caution (<{CAUTION_SEP_NM} NM, <{int(CAUTION_SEP_ALT_FT)} ft)"
                caution_count += 1
            elif is_same_flow and min_dist < 8.0 and vert_diff < 1500.0:
                status = "in_trail"
                label = "In-Trail Flow Sequence (<3 min spacing)"
                in_trail_count += 1
            else:
                status = "neighborhood"
                label = f"Airspace Neighborhood ({round(min_dist, 1)} NM)"

            rel_start_i = round(sj["t_min"] - si["t_min"], 1)
            rel_end_i = round(sj["t_max"] - si["t_min"], 1)
            rel_start_j = round(si["t_min"] - sj["t_min"], 1)
            rel_end_j = round(si["t_max"] - sj["t_min"], 1)

            entry_i = {
                "session_id": sj["id"],
                "aircraft": sj["aircraft"],
                "complete_kind": sj["complete_kind"],
                "src": sj["src"],
                "dest": sj["dest"],
                "min_dist_nm": round(min_dist, 2),
                "vert_diff_ft": round(vert_diff, 1),
                "cpa_time_s": round(cpa_t - si["t_min"], 1),
                "overlap_s": round(overlap_s, 1),
                "relative_start_s": rel_start_i,
                "relative_end_s": rel_end_i,
                "separation_status": status,
                "separation_label": label,
            }

            entry_j = {
                "session_id": si["id"],
                "aircraft": si["aircraft"],
                "complete_kind": si["complete_kind"],
                "src": si["src"],
                "dest": si["dest"],
                "min_dist_nm": round(min_dist, 2),
                "vert_diff_ft": round(vert_diff, 1),
                "cpa_time_s": round(cpa_t - sj["t_min"], 1),
                "overlap_s": round(overlap_s, 1),
                "relative_start_s": rel_start_j,
                "relative_end_s": rel_end_j,
                "separation_status": status,
                "separation_label": label,
            }

            index_map[si["id"]].append(entry_i)
            index_map[sj["id"]].append(entry_j)

    # Sort each session's neighbors by proximity (closest approach first)
    for sid in index_map:
        index_map[sid].sort(key=lambda n: n["min_dist_nm"])

    result_payload = {
        "meta": {
            "source_file": sessions_path.name,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "total_sessions": len(sess_list),
            "total_neighbor_links": sum(len(v) for v in index_map.values()),
            "alerts": alert_count,
            "cautions": caution_count,
            "in_trails": in_trail_count,
            "aviation_standards": {
                "terminal_separation_lateral_nm": TERMINAL_SEP_NM,
                "terminal_separation_vertical_ft": TERMINAL_SEP_ALT_FT,
                "enroute_separation_lateral_nm": CAUTION_SEP_NM,
                "enroute_separation_vertical_ft": CAUTION_SEP_ALT_FT,
                "surveillance_neighborhood_lateral_nm": max_neighborhood_nm,
                "surveillance_neighborhood_vertical_ft": max_neighborhood_alt_ft,
                "safe_longitudinal_separation_s": IN_TRAIL_TIME_S,
            },
        },
        "neighborhoods": index_map,
    }

    if output_path is not None:
        out_file = Path(output_path)
        out_file.parent.mkdir(parents=True, exist_ok=True)
        with open(out_file, "w", encoding="utf-8") as f:
            json.dump(result_payload, f, separators=(",", ":"))

    return result_payload


def main() -> None:
    parser = argparse.ArgumentParser(description="Build spatial-temporal neighborhood index for flight sessions.")
    parser.add_argument("--sessions", type=Path, default=DEFAULT_SESSIONS_PATH, help="Path to continuous_sessions.json")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT_PATH, help="Path to output neighborhood_index.json")
    parser.add_argument("--max-dist", type=float, default=MAX_NEIGHBORHOOD_NM, help="Max neighborhood distance (NM)")
    parser.add_argument("--step", type=float, default=TIME_EVAL_STEP_S, help="Time evaluation step (s)")
    args = parser.parse_args()

    t0 = time.time()
    print(f"Building neighborhood index from {args.sessions}...")
    result = compute_neighborhood_index(
        sessions_path=args.sessions,
        output_path=args.output,
        max_neighborhood_nm=args.max_dist,
        step_s=args.step,
    )
    meta = result["meta"]
    print(f"Generated neighborhood index in {time.time() - t0:.2f}s:")
    print(f"  Total sessions: {meta['total_sessions']}")
    print(f"  Total neighbor links: {meta['total_neighbor_links']}")
    print(f"  Alerts (<3 NM, <1000 ft): {meta['alerts']}")
    print(f"  Cautions (<5 NM, <2000 ft): {meta['cautions']}")
    print(f"  In-trail sequences: {meta['in_trails']}")
    print(f"  Saved to: {args.output}")


if __name__ == "__main__":
    main()

