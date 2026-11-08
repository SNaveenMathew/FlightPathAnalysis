"""Data manager for loading and indexing continuous flight sessions and airports."""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any

WORKSPACE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SESSIONS_PATH = WORKSPACE_ROOT / "03-Visualization" / "continuous_sessions.json"
DEFAULT_NEIGHBORHOOD_PATH = WORKSPACE_ROOT / "03-Visualization" / "neighborhood_index.json"
DEFAULT_AIRPORTS_PATH = WORKSPACE_ROOT / "data" / "GlobalAirportDatabase.txt"

# Standard known airports in NY/NJ area and Northeast corridor
KNOWN_AIRPORTS: dict[str, dict[str, Any]] = {
    "JFK": {"name": "John F Kennedy Intl", "latitude": 40.6398, "longitude": -73.7789, "elevation_ft": 13.0},
    "LGA": {"name": "LaGuardia", "latitude": 40.7769, "longitude": -73.8740, "elevation_ft": 21.0},
    "EWR": {"name": "Newark Liberty Intl", "latitude": 40.6895, "longitude": -74.1745, "elevation_ft": 18.0},
    "TEB": {"name": "Teterboro", "latitude": 40.8501, "longitude": -74.0608, "elevation_ft": 8.0},
    "HPN": {"name": "Westchester County", "latitude": 41.0670, "longitude": -73.7076, "elevation_ft": 439.0},
    "FRG": {"name": "Republic", "latitude": 40.7288, "longitude": -73.4134, "elevation_ft": 80.0},
    "ISP": {"name": "Long Island MacArthur", "latitude": 40.7952, "longitude": -73.1002, "elevation_ft": 99.0},
    "SWF": {"name": "Stewart Intl", "latitude": 41.5041, "longitude": -74.1048, "elevation_ft": 491.0},
    "BOS": {"name": "Boston Logan Intl", "latitude": 42.3656, "longitude": -71.0096, "elevation_ft": 20.0},
    "PHL": {"name": "Philadelphia Intl", "latitude": 39.8729, "longitude": -75.2437, "elevation_ft": 36.0},
    "BDL": {"name": "Bradley Intl", "latitude": 41.9389, "longitude": -72.6832, "elevation_ft": 173.0},
    "ORD": {"name": "Chicago O'Hare", "latitude": 41.9742, "longitude": -87.9073, "elevation_ft": 668.0},
    "ATL": {"name": "Atlanta Hartsfield", "latitude": 33.6407, "longitude": -84.4277, "elevation_ft": 1026.0},
}


class DataManager:
    """Loads, indexes, and serves session data efficiently."""

    @staticmethod
    def _calculate_session_duration_s(sess: dict[str, Any]) -> float:
        """Calculate the real-world duration in seconds for a session."""
        samples = sess.get("phase_samples", [])
        if samples and "time_s" in samples[-1]:
            try:
                return float(samples[-1]["time_s"])
            except (ValueError, TypeError):
                pass
        points = sess.get("points", [])
        if points and len(points[-1]) > 3:
            try:
                # points have [lon, lat, alt, t_bin], where each bin is 5.0 seconds
                return float(points[-1][3]) * 5.0
            except (ValueError, TypeError):
                pass
        return float(sess.get("t_max", 0)) * 5.0

    def __init__(
        self,
        sessions_path: Path | str = DEFAULT_SESSIONS_PATH,
        airports_path: Path | str = DEFAULT_AIRPORTS_PATH,
        neighborhood_path: Path | str = DEFAULT_NEIGHBORHOOD_PATH,
    ):
        self.sessions_path = Path(sessions_path)
        self.airports_path = Path(airports_path)
        self.neighborhood_path = Path(neighborhood_path)
        self._meta: dict[str, Any] = {}
        self._sessions_by_id: dict[str, dict[str, Any]] = {}
        self._aircraft_to_session_ids: dict[str, list[str]] = {}
        self._aircraft_summaries: list[dict[str, Any]] = []
        self._airports: dict[str, dict[str, Any]] = dict(KNOWN_AIRPORTS)
        self._neighborhoods: dict[str, list[dict[str, Any]]] = {}
        self._neighborhood_meta: dict[str, Any] = {}
        self._is_loaded = False

    def load_data(self) -> None:
        """Load session dataset and build indexes in memory."""
        if self._is_loaded:
            return

        self._load_airports()
        self._load_neighborhoods()

        if not self.sessions_path.is_file():
            raise FileNotFoundError(f"Continuous sessions file not found at: {self.sessions_path}")

        with open(self.sessions_path, "r", encoding="utf-8") as f:
            raw_data = json.load(f)

        self._meta = raw_data.get("meta", {})
        sessions = raw_data.get("sessions", [])

        # Index sessions
        for s in sessions:
            sid = s.get("id")
            ac = s.get("aircraft", "unknown")
            if not sid:
                continue
            self._sessions_by_id[sid] = s
            if ac not in self._aircraft_to_session_ids:
                self._aircraft_to_session_ids[ac] = []
            self._aircraft_to_session_ids[ac].append(sid)

        # Build aircraft summary list
        summaries = []
        for ac, sids in self._aircraft_to_session_ids.items():
            kinds = set()
            routes = set()
            total_points = 0
            max_duration = 0.0
            phase_counter = Counter()

            for sid in sids:
                sess = self._sessions_by_id[sid]
                kind = sess.get("complete_kind") or sess.get("session_type") or "unknown"
                kinds.add(kind)
                src = sess.get("src") or "?"
                dest = sess.get("dest") or "?"
                routes.add(f"{src}->{dest}")
                total_points += sess.get("n_points", 0)
                dur = self._calculate_session_duration_s(sess)
                if dur > max_duration:
                    max_duration = dur

                for ps in sess.get("phase_samples", []):
                    ph = ps.get("phase")
                    if ph:
                        phase_counter[ph] += 1

            dom_phase = phase_counter.most_common(1)[0][0] if phase_counter else "unknown"

            summaries.append({
                "aircraft": ac,
                "session_count": len(sids),
                "session_ids": sids,
                "kinds": sorted(kinds),
                "routes": sorted(routes)[:4],
                "total_points": total_points,
                "max_duration_s": max_duration,
                "dominant_phase": dom_phase,
            })

        # Sort aircraft summaries: primary by session count descending, secondary by aircraft id
        summaries.sort(key=lambda item: (-item["session_count"], item["aircraft"]))
        self._aircraft_summaries = summaries
        self._is_loaded = True

    def _load_airports(self) -> None:
        """Load coordinates from GlobalAirportDatabase if available."""
        if not self.airports_path.is_file():
            return

        try:
            with open(self.airports_path, "r", encoding="utf-8") as f:
                for line in f:
                    fields = line.rstrip("\r\n").split(":")
                    if len(fields) < 16:
                        continue
                    code = fields[1].strip().upper()
                    name = fields[2].strip()
                    if not code or code in self._airports:
                        continue
                    try:
                        elev = float(fields[-3])
                        lat = float(fields[-2])
                        lon = float(fields[-1])
                        if -90 <= lat <= 90 and -180 <= lon <= 180:
                            self._airports[code] = {
                                "name": name,
                                "latitude": lat,
                                "longitude": lon,
                                "elevation_ft": elev,
                            }
                    except (ValueError, TypeError):
                        continue
        except Exception:
            pass

    def _load_neighborhoods(self) -> None:
        """Load precomputed spatial-temporal neighborhood index if available."""
        if self.neighborhood_path.is_file():
            try:
                with open(self.neighborhood_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                self._neighborhoods = data.get("neighborhoods", {})
                self._neighborhood_meta = data.get("meta", {})
                return
            except Exception:
                pass

        # If missing or failed, try to generate it
        try:
            from importlib.machinery import SourceFileLoader
            builder_path = WORKSPACE_ROOT / "03-Visualization" / "build_neighborhood_index.py"
            if builder_path.is_file():
                mod = SourceFileLoader("build_neighborhood_index", str(builder_path)).load_module()
                data = mod.compute_neighborhood_index(
                    sessions_path=self.sessions_path,
                    output_path=self.neighborhood_path,
                )
                self._neighborhoods = data.get("neighborhoods", {})
                self._neighborhood_meta = data.get("meta", {})
        except Exception:
            pass

    def get_aircraft_list(self) -> list[dict[str, Any]]:
        """Return list of all aircraft summaries."""
        if not self._is_loaded:
            self.load_data()
        return self._aircraft_summaries

    def get_aircraft_details(self, aircraft_id: str) -> dict[str, Any] | None:
        """Return aircraft information and metadata for all of its sessions."""
        if not self._is_loaded:
            self.load_data()

        sids = self._aircraft_to_session_ids.get(aircraft_id)
        if not sids:
            return None

        sessions_info = []
        for sid in sids:
            s = self._sessions_by_id[sid]
            phase_counter = Counter(ps.get("phase", "unknown") for ps in s.get("phase_samples", []))
            total_phases = sum(phase_counter.values()) or 1
            phase_pct = {k: round(v / total_phases * 100, 1) for k, v in phase_counter.most_common(5)}
            dom_phase = phase_counter.most_common(1)[0][0] if phase_counter else "unknown"

            dur = self._calculate_session_duration_s(s)
            sessions_info.append({
                "id": sid,
                "session_type": s.get("session_type", ""),
                "complete_kind": s.get("complete_kind", ""),
                "start_kind": s.get("start_kind", ""),
                "end_kind": s.get("end_kind", ""),
                "src": s.get("src", ""),
                "dest": s.get("dest", ""),
                "start_ts": s.get("start_ts", 0.0),
                "end_ts": s.get("end_ts", 0.0),
                "start_time_utc": s.get("start_time_utc", ""),
                "end_time_utc": s.get("end_time_utc", ""),
                "neighbor_count": len(self._neighborhoods.get(sid, [])),
                "n_points": s.get("n_points", 0),
                "t_max": dur,
                "duration_s": dur,
                "dominant_phase": dom_phase,
                "phase_percentages": phase_pct,
                "phase_intervals_count": len(s.get("phase_intervals", [])),
            })

        return {
            "aircraft": aircraft_id,
            "session_count": len(sessions_info),
            "sessions": sessions_info,
        }

    def get_sessions_batch(self, session_ids: list[str]) -> dict[str, Any]:
        """Return full trajectory, predicted phases, and context for requested sessions."""
        if not self._is_loaded:
            self.load_data()

        result_sessions = []
        all_lons = []
        all_lats = []
        all_alts = []
        max_time = 0.0
        used_airports = set()

        for sid in session_ids:
            s = self._sessions_by_id.get(sid)
            if not s:
                continue

            points = s.get("points", [])  # list of [lon, lat, alt_ft, t_bin]
            phase_samples = s.get("phase_samples", [])
            phase_intervals = s.get("phase_intervals", [])

            for p in points:
                if len(p) >= 3:
                    all_lons.append(p[0])
                    all_lats.append(p[1])
                    all_alts.append(p[2])

            dur = self._calculate_session_duration_s(s)
            if dur > max_time:
                max_time = dur

            src = s.get("src")
            dest = s.get("dest")
            if src:
                used_airports.add(src.upper())
            if dest:
                used_airports.add(dest.upper())

            result_sessions.append({
                "id": sid,
                "aircraft": s.get("aircraft", ""),
                "session_type": s.get("session_type", ""),
                "complete_kind": s.get("complete_kind", ""),
                "start_kind": s.get("start_kind", ""),
                "end_kind": s.get("end_kind", ""),
                "src": src or "",
                "dest": dest or "",
                "start_ts": s.get("start_ts", 0.0),
                "end_ts": s.get("end_ts", 0.0),
                "start_time_utc": s.get("start_time_utc", ""),
                "end_time_utc": s.get("end_time_utc", ""),
                "neighbor_count": len(self._neighborhoods.get(sid, [])),
                "t_max": dur,
                "duration_s": dur,
                "n_points": len(points),
                "points": points,
                "phase_samples": phase_samples,
                "phase_intervals": phase_intervals,
            })

        # Calculate bounding box
        if all_lons and all_lats:
            lon_pad = max(0.1, (max(all_lons) - min(all_lons)) * 0.08)
            lat_pad = max(0.1, (max(all_lats) - min(all_lats)) * 0.08)
            bounds = {
                "min_lon": min(all_lons) - lon_pad,
                "max_lon": max(all_lons) + lon_pad,
                "min_lat": min(all_lats) - lat_pad,
                "max_lat": max(all_lats) + lat_pad,
                "min_alt": min(all_alts) if all_alts else 0,
                "max_alt": max(all_alts) if all_alts else 35000,
                "max_time_s": max_time,
            }
        else:
            bounds = {
                "min_lon": -74.5,
                "max_lon": -72.5,
                "min_lat": 40.0,
                "max_lat": 41.5,
                "min_alt": 0,
                "max_alt": 35000,
                "max_time_s": max_time,
            }

        # Include airport context
        # Always include JFK, LGA, EWR
        used_airports.update(["JFK", "LGA", "EWR"])
        airports_data = []
        for code in used_airports:
            if code in self._airports:
                rec = self._airports[code]
                airports_data.append({
                    "code": code,
                    "name": rec.get("name", code),
                    "latitude": rec["latitude"],
                    "longitude": rec["longitude"],
                    "elevation_ft": rec.get("elevation_ft", 0),
                })

        return {
            "sessions": result_sessions,
            "bounds": bounds,
            "airports": airports_data,
        }

    def get_session_neighborhood(
        self,
        session_id: str,
        max_distance_nm: float = 15.0,
        max_neighbors: int = 15,
    ) -> dict[str, Any] | None:
        """Return synchronized neighbor trajectories and aviation separation analysis for a session."""
        if not self._is_loaded:
            self.load_data()

        target = self._sessions_by_id.get(session_id)
        if not target:
            return None

        target_start_ts = target.get("start_ts", 0.0)
        target_end_ts = target.get("end_ts", 0.0)
        target_dur = self._calculate_session_duration_s(target)

        all_neighbors = self._neighborhoods.get(session_id, [])
        filtered_neighbors = []

        for n in all_neighbors:
            if n["min_dist_nm"] > max_distance_nm:
                continue
            nsid = n["session_id"]
            nsess = self._sessions_by_id.get(nsid)
            if not nsess:
                continue

            rel_start_s = float(n.get("relative_start_s", 0.0))
            rel_end_s = float(n.get("relative_end_s", 0.0))

            # Synchronize neighbor points into target session timeline:
            # Target timeline: t=0 is target session start.
            # Point format: [lon, lat, alt, t_rel_target]
            n_pts = nsess.get("points", [])
            synced_points = []
            for p in n_pts:
                if len(p) >= 4:
                    t_rel_target = rel_start_s + float(p[3]) * 5.0
                    synced_points.append([
                        round(float(p[0]), 6),
                        round(float(p[1]), 6),
                        round(float(p[2]), 1),
                        round(t_rel_target, 2),
                    ])

            # Synchronize phase samples into target session timeline
            synced_phases = []
            for ps in nsess.get("phase_samples", []):
                t_ps = rel_start_s + float(ps.get("time_s", 0.0))
                synced_phases.append({
                    "time_s": round(t_ps, 2),
                    "phase": ps.get("phase", "unknown"),
                    "confidence": ps.get("confidence", 1.0),
                })

            filtered_neighbors.append({
                "session_id": nsid,
                "aircraft": n.get("aircraft", nsess.get("aircraft", "")),
                "complete_kind": n.get("complete_kind", nsess.get("complete_kind", "")),
                "src": n.get("src", nsess.get("src", "")),
                "dest": n.get("dest", nsess.get("dest", "")),
                "min_dist_nm": float(n.get("min_dist_nm", 0.0)),
                "vert_diff_ft": float(n.get("vert_diff_ft", 0.0)),
                "cpa_time_s": float(n.get("cpa_time_s", 0.0)),
                "overlap_s": float(n.get("overlap_s", 0.0)),
                "relative_start_s": rel_start_s,
                "relative_end_s": rel_end_s,
                "separation_status": n.get("separation_status", "neighborhood"),
                "separation_label": n.get("separation_label", "Neighborhood"),
                "n_points": len(synced_points),
                "points": synced_points,
                "phase_samples": synced_phases,
            })
            if len(filtered_neighbors) >= max_neighbors:
                break

        return {
            "target": {
                "session_id": session_id,
                "aircraft": target.get("aircraft", ""),
                "complete_kind": target.get("complete_kind", ""),
                "src": target.get("src", ""),
                "dest": target.get("dest", ""),
                "start_ts": target_start_ts,
                "end_ts": target_end_ts,
                "start_time_utc": target.get("start_time_utc", ""),
                "end_time_utc": target.get("end_time_utc", ""),
                "duration_s": target_dur,
            },
            "aviation_standards": self._neighborhood_meta.get("aviation_standards", {
                "terminal_separation_lateral_nm": 3.0,
                "terminal_separation_vertical_ft": 1000.0,
                "enroute_separation_lateral_nm": 5.0,
                "enroute_separation_vertical_ft": 2000.0,
                "surveillance_neighborhood_lateral_nm": max_distance_nm,
                "surveillance_neighborhood_vertical_ft": 4000.0,
                "safe_longitudinal_separation_s": 180.0,
            }),
            "neighbors_count": len(filtered_neighbors),
            "total_available_neighbors": len(all_neighbors),
            "neighbors": filtered_neighbors,
        }

