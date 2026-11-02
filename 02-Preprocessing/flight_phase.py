"""Causal, ADS-B-only flight-phase candidates for JFK-related sessions.

The estimator uses only the current observation and trailing observations within
its track segment. Session-level airport fields and post-processed takeoff /
touchdown flags are used only to select the offline JFK cohort, never as inputs
to the per-row phase estimate.
"""

from __future__ import annotations


from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

PHASE_MODEL_VERSION = "causal_adsb_phase_v1"
DEFAULT_AIRPORT_CODE = "JFK"
DEFAULT_AIRPORT_FILE = Path(__file__).resolve().parents[1] / "data" / "GlobalAirportDatabase.txt"

PHASE_OUTPUT_COLUMNS = [
    "flight_phase_scope",
    "flight_phase",
    "flight_phase_detail",
    "flight_phase_confidence",
    "flight_phase_changed",
    "flight_phase_event",
    "flight_phase_evidence",
    "flight_phase_vertical_rate_fpm",
    "flight_phase_distance_to_airport_nm",
    "flight_phase_closure_rate_kts",
    "flight_phase_model_version",
    "flight_phase_is_causal",
]

# These are deliberately conservative starting values, not operational limits.
TREND_WINDOW_MS = 60_000
TREND_MIN_SPAN_MS = 15_000
TREND_MIN_POINTS = 3
TREND_MAX_ANCHORS = 7
MAX_TREND_RATE_FPM = 12_000
CLIMB_THRESHOLD_FPM = 300.0
DESCENT_THRESHOLD_FPM = -300.0
LEVEL_THRESHOLD_FPM = 150.0
CLIMB_DESCENT_DWELL_MS = 15_000
LEVEL_DWELL_MS = 45_000
TRACK_GAP_MS = 120_000
AIRPORT_CONTEXT_NM = 50.0
AIRPORT_NEAR_NM = 5.0


def load_airport_record(
    airport_code: str = DEFAULT_AIRPORT_CODE,
    database_path: str | Path = DEFAULT_AIRPORT_FILE,
) -> dict[str, float] | None:
    """Load airport lat/lon and elevation in feet from GlobalAirportDatabase."""
    wanted = str(airport_code).strip().upper()
    path = Path(database_path)
    if not path.is_file():
        return None
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            fields = line.rstrip("\r\n").split(":")
            if len(fields) < 16 or fields[1].strip().upper() != wanted:
                continue
            try:
                elevation_ft = float(fields[-3])
                latitude = float(fields[-2])
                longitude = float(fields[-1])
            except (TypeError, ValueError):
                continue
            if not (
                np.isfinite(elevation_ft)
                and -90 <= latitude <= 90
                and -180 <= longitude <= 180
            ):
                continue
            return {
                "latitude": latitude,
                "longitude": longitude,
                "elevation_ft": elevation_ft,
            }
    return None


def _bool_values(values: pd.Series) -> pd.Series:
    if pd.api.types.is_bool_dtype(values.dtype):
        return values.fillna(False)
    normalized = values.astype("string").str.strip().str.lower()
    return normalized.isin({"1", "true", "t", "yes", "y"})


def _airport_values(values: pd.Series, airport_code: str) -> pd.Series:
    return values.astype("string").str.strip().str.upper().eq(airport_code.upper()).fillna(False)


def _group_any(frame: pd.DataFrame, mask: pd.Series) -> pd.Series:
    return mask.groupby(frame["aircraft_session_id"], sort=False, dropna=False).any()


def select_airport_session_scopes(
    df: pd.DataFrame,
    airport_code: str = DEFAULT_AIRPORT_CODE,
) -> dict[str, str]:
    """Select sessions with a JFK airport-matched takeoff and/or touchdown.

    Per-event airport columns are preferred. If they are unavailable or have no
    usable event row for a session, propagated session airport plus a positive
    preprocessor event count is an explicit fallback for minimal processed files.
    """
    if "aircraft_session_id" not in df.columns:
        raise ValueError("Data must contain aircraft_session_id")
    session_ids = df["aircraft_session_id"].astype("string")
    valid_id = session_ids.notna() & session_ids.str.strip().ne("")
    work = df.loc[valid_id].copy()
    work["aircraft_session_id"] = session_ids.loc[valid_id].astype(str)
    if work.empty:
        return {}

    if "takeoff" in work.columns:
        takeoff_flag = _bool_values(work["takeoff"])
    elif "takeoff_candidate" in work.columns:
        takeoff_flag = _bool_values(work["takeoff_candidate"])
    else:
        takeoff_flag = pd.Series(False, index=work.index)
    if "takeoff_candidate" in work.columns:
        takeoff_flag |= _bool_values(work["takeoff_candidate"])

    if "touchdown" in work.columns:
        touchdown_flag = _bool_values(work["touchdown"])
    elif "touchdown_candidate" in work.columns:
        touchdown_flag = _bool_values(work["touchdown_candidate"])
    else:
        touchdown_flag = pd.Series(False, index=work.index)
    if "touchdown_candidate" in work.columns:
        touchdown_flag |= _bool_values(work["touchdown_candidate"])

    if "takeoff_airport" in work.columns:
        departure_event = takeoff_flag & _airport_values(work["takeoff_airport"], airport_code)
    else:
        departure_event = pd.Series(False, index=work.index)
    if "airport" in work.columns:
        arrival_event = touchdown_flag & _airport_values(work["airport"], airport_code)
    else:
        arrival_event = pd.Series(False, index=work.index)

    departure_by_session = _group_any(work, departure_event)
    arrival_by_session = _group_any(work, arrival_event)

    if "session_src_airport" in work.columns and "n_to_session" in work.columns:
        count = pd.to_numeric(work["n_to_session"], errors="coerce").fillna(0)
        fallback = _airport_values(work["session_src_airport"], airport_code) & count.gt(0)
        fallback_by_session = _group_any(work, fallback)
        departure_by_session = departure_by_session | fallback_by_session
    if "session_dest_airport" in work.columns and "n_ld_session" in work.columns:
        count = pd.to_numeric(work["n_ld_session"], errors="coerce").fillna(0)
        fallback = _airport_values(work["session_dest_airport"], airport_code) & count.gt(0)
        fallback_by_session = _group_any(work, fallback)
        arrival_by_session = arrival_by_session | fallback_by_session

    scopes: dict[str, str] = {}
    for session_id in departure_by_session.index.union(arrival_by_session.index):
        is_departure = bool(departure_by_session.get(session_id, False))
        is_arrival = bool(arrival_by_session.get(session_id, False))
        if is_departure and is_arrival:
            scopes[str(session_id)] = f"{airport_code.lower()}_local"
        elif is_departure:
            scopes[str(session_id)] = f"{airport_code.lower()}_departure"
        elif is_arrival:
            scopes[str(session_id)] = f"{airport_code.lower()}_arrival"
    return scopes


def _haversine_nm(
    lat1: np.ndarray,
    lon1: np.ndarray,
    lat2: float,
    lon2: float,
) -> np.ndarray:
    earth_radius_nm = 3440.065
    lat1_rad = np.radians(lat1)
    lat2_rad = np.radians(lat2)
    delta_lat = lat2_rad - lat1_rad
    delta_lon = np.radians(lon2 - lon1)
    a = np.sin(delta_lat / 2.0) ** 2 + np.cos(lat1_rad) * np.cos(lat2_rad) * np.sin(delta_lon / 2.0) ** 2
    return 2.0 * earth_radius_nm * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0)))


def _causal_theil_sen_rates(
    times_ms: np.ndarray,
    altitudes_ft: np.ndarray,
    valid_altitude: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Estimate vertical trend from trailing raw-altitude samples only."""
    n_rows = len(times_ms)
    rates = np.full(n_rows, np.nan, dtype=float)
    confidences = np.zeros(n_rows, dtype=float)
    spans_ms = np.zeros(n_rows, dtype=float)
    sample_counts = np.zeros(n_rows, dtype=np.int16)
    for row in range(n_rows):
        left = int(np.searchsorted(times_ms, times_ms[row] - TREND_WINDOW_MS, side="left"))
        indices = np.flatnonzero(valid_altitude[left : row + 1]) + left
        if len(indices) < TREND_MIN_POINTS:
            continue
        if len(indices) > TREND_MAX_ANCHORS:
            take = np.linspace(0, len(indices) - 1, TREND_MAX_ANCHORS).round().astype(int)
            indices = indices[np.unique(take)]
        span_ms = float(times_ms[row] - times_ms[indices[0]])
        spans_ms[row] = span_ms
        sample_counts[row] = min(len(indices), np.iinfo(np.int16).max)
        if span_ms < TREND_MIN_SPAN_MS:
            continue

        pair_slopes = []
        for left_index in range(len(indices) - 1):
            later = indices[left_index + 1 :]
            elapsed_ms = times_ms[later] - times_ms[indices[left_index]]
            valid_pairs = elapsed_ms > 0
            if not valid_pairs.any():
                continue
            slopes = (
                (altitudes_ft[later[valid_pairs]] - altitudes_ft[indices[left_index]])
                / (elapsed_ms[valid_pairs] / 1000.0)
                * 60.0
            )
            pair_slopes.extend(slopes.tolist())
        if not pair_slopes:
            continue
        rate = float(np.median(pair_slopes))
        if not np.isfinite(rate) or abs(rate) > MAX_TREND_RATE_FPM:
            continue

        rates[row] = rate
        time_minutes = (times_ms[indices] - times_ms[row]) / 60_000.0
        centered_altitude = altitudes_ft[indices] - altitudes_ft[indices[-1]]
        residual = centered_altitude - rate * time_minutes
        median_abs_residual = float(np.median(np.abs(residual - np.median(residual))))
        coverage = min(1.0, span_ms / 45_000.0)
        sample_support = min(1.0, float(sample_counts[row]) / 5.0)
        residual_support = float(np.exp(-median_abs_residual / 900.0))
        confidences[row] = float(
            np.clip(0.35 + 0.25 * coverage + 0.20 * sample_support + 0.15 * residual_support, 0.0, 0.95)
        )
    return rates, confidences, spans_ms


def _causal_reference_index(times_ms: np.ndarray, row: int, lookback_ms: int) -> int | None:
    reference = int(np.searchsorted(times_ms, times_ms[row] - lookback_ms, side="right")) - 1
    if reference < 0 or reference >= row:
        return None
    elapsed = times_ms[row] - times_ms[reference]
    if elapsed < lookback_ms * 0.5 or elapsed > TRACK_GAP_MS:
        return None
    return reference


def _split_track_segments(group: pd.DataFrame) -> list[pd.DataFrame]:
    ordered = group.sort_values("ts", kind="mergesort").copy()
    times = pd.to_numeric(ordered["ts"], errors="coerce").to_numpy(dtype=float)
    supplied_segment = ordered.get("track_segment_id")
    if supplied_segment is None:
        segment_values = np.full(len(ordered), None, dtype=object)
    else:
        segment_values = supplied_segment.astype("string").fillna("<missing>").to_numpy()

    boundaries = [0]
    for row in range(1, len(ordered)):
        gap = times[row] - times[row - 1]
        segment_changed = segment_values[row] != segment_values[row - 1]
        if not np.isfinite(gap) or gap < 0 or gap > TRACK_GAP_MS or segment_changed:
            boundaries.append(row)
    boundaries.append(len(ordered))
    return [ordered.iloc[start:end].copy() for start, end in zip(boundaries[:-1], boundaries[1:]) if end > start]


def _phase_one_segment(
    segment: pd.DataFrame,
    airport: dict[str, float],
    airport_code: str,
) -> pd.DataFrame:
    result = segment.copy()
    times = pd.to_numeric(result["ts"], errors="coerce").to_numpy(dtype=float)
    altitude_column = "altitude_raw_ft" if "altitude_raw_ft" in result.columns else "altitude"
    altitudes = pd.to_numeric(result[altitude_column], errors="coerce").to_numpy(dtype=float)
    latitudes = pd.to_numeric(
        result["lat"] if "lat" in result.columns else pd.Series(np.nan, index=result.index),
        errors="coerce",
    ).to_numpy(dtype=float)
    longitudes = pd.to_numeric(
        result["lon"] if "lon" in result.columns else pd.Series(np.nan, index=result.index),
        errors="coerce",
    ).to_numpy(dtype=float)
    ground_speed = pd.to_numeric(
        result["ground_speed"] if "ground_speed" in result.columns else pd.Series(np.nan, index=result.index),
        errors="coerce",
    ).to_numpy(dtype=float)

    ground_flag = _bool_values(result.get("ground_flag", pd.Series(False, index=result.index))).to_numpy()
    if "ground_flag_confidence" in result.columns:
        ground_confidence = pd.to_numeric(result["ground_flag_confidence"], errors="coerce").fillna(0).to_numpy(dtype=float)
    else:
        ground_confidence = ground_flag.astype(float)
    known_ground = ground_flag & (ground_confidence >= 0.6)

    invalid_altitude = np.zeros(len(result), dtype=bool)
    for flag_column in ("altitude_invalid_flag", "altitude_range_flag", "altitude_ceiling_flag", "altitude_jump_suspect_flag"):
        if flag_column in result.columns:
            invalid_altitude |= _bool_values(result[flag_column]).to_numpy()
    valid_altitude = np.isfinite(altitudes) & (altitudes >= -2_000) & (altitudes <= 60_000) & ~invalid_altitude

    rates, trend_confidence, spans_ms = _causal_theil_sen_rates(times, altitudes, valid_altitude)
    if len(result) and np.isfinite(latitudes).any() and np.isfinite(longitudes).any():
        distance_nm = _haversine_nm(latitudes, longitudes, airport["latitude"], airport["longitude"])
    else:
        distance_nm = np.full(len(result), np.nan, dtype=float)
    height_above_airport = altitudes - airport["elevation_ft"]

    closure_rate_kts = np.full(len(result), np.nan, dtype=float)
    for row in range(len(result)):
        if not np.isfinite(distance_nm[row]):
            continue
        reference = _causal_reference_index(times, row, 45_000)
        if reference is None or not np.isfinite(distance_nm[reference]):
            continue
        elapsed_hours = (times[row] - times[reference]) / 3_600_000.0
        if elapsed_hours > 0:
            closure_rate_kts[row] = (distance_nm[reference] - distance_nm[row]) / elapsed_hours

    regime = None
    candidate_regime = None
    candidate_start_ms = None
    last_confirmed_trend_ms = None
    last_ground_ms = None
    last_airborne_ms = None
    last_takeoff_ms = None
    last_touchdown_ms = None
    regime_before_change = None
    regime_changed = False
    previous_phase = None
    labels: list[str] = []
    details: list[str] = []
    confidences: list[float] = []
    events: list[str] = []
    evidence_rows: list[str] = []

    for row in range(len(result)):
        now = times[row]
        regime_changed = False
        regime_before_change = None
        if known_ground[row]:
            last_ground_ms = now
        altitude_airborne = (
            valid_altitude[row]
            and np.isfinite(height_above_airport[row])
            and height_above_airport[row] > (150.0 if np.isfinite(distance_nm[row]) and distance_nm[row] < 5.0 else 300.0)
        )
        trend_airborne = np.isfinite(rates[row]) and abs(rates[row]) >= CLIMB_THRESHOLD_FPM
        airborne_observed = not known_ground[row] and (altitude_airborne or trend_airborne)
        if airborne_observed:
            last_airborne_ms = now

        recent_ground_to_air = (
            airborne_observed
            and last_ground_ms is not None
            and 0 <= now - last_ground_ms <= 30_000
            and np.isfinite(distance_nm[row])
            and distance_nm[row] <= 15.0
        )
        recent_air_to_ground = (
            known_ground[row]
            and last_airborne_ms is not None
            and 0 <= now - last_airborne_ms <= 120_000
            and np.isfinite(distance_nm[row])
            and distance_nm[row] <= 15.0
        )
        if recent_ground_to_air:
            last_takeoff_ms = now
            last_ground_ms = None
        if recent_air_to_ground:
            last_touchdown_ms = now
            last_airborne_ms = None

        signal = None
        if np.isfinite(rates[row]):
            if rates[row] >= CLIMB_THRESHOLD_FPM:
                signal = "climb"
            elif rates[row] <= DESCENT_THRESHOLD_FPM:
                signal = "descent"
            elif abs(rates[row]) <= LEVEL_THRESHOLD_FPM and spans_ms[row] >= 45_000:
                signal = "level"

        if signal is None:
            candidate_regime = None
            candidate_start_ms = None
            if last_confirmed_trend_ms is not None and now - last_confirmed_trend_ms > 90_000:
                regime = None
        else:
            last_confirmed_trend_ms = now
            if signal != candidate_regime:
                candidate_regime = signal
                candidate_start_ms = now
            dwell_ms = LEVEL_DWELL_MS if signal == "level" else CLIMB_DESCENT_DWELL_MS
            if candidate_start_ms is not None and now - candidate_start_ms >= dwell_ms and regime != signal:
                regime_before_change = regime
                regime = signal
                regime_changed = True
                candidate_regime = None
                candidate_start_ms = None

        phase = "unknown"
        detail = ""
        confidence = 0.0
        evidence: list[str] = []
        row_events: list[str] = []

        if known_ground[row]:
            phase = "ground"
            confidence = float(np.clip(ground_confidence[row], 0.0, 1.0))
            evidence.append("ground_state")
            if recent_air_to_ground:
                phase = "landing"
                detail = "touchdown_candidate"
                confidence = min(0.8, max(0.55, confidence))
                row_events.append("touchdown_candidate")
            elif last_touchdown_ms is not None and 0 <= now - last_touchdown_ms <= 90_000:
                speed = ground_speed[row]
                if np.isfinite(speed) and speed >= 10.0:
                    phase = "landing_roll"
                    evidence.append("recent_air_to_ground_transition")
            speed_reference = _causal_reference_index(times, row, 10_000)
            if (
                phase == "ground"
                and np.isfinite(ground_speed[row])
                and ground_speed[row] >= 40.0
                and speed_reference is not None
                and np.isfinite(ground_speed[speed_reference])
                and ground_speed[row] - ground_speed[speed_reference] >= 5.0
            ):
                detail = "takeoff_roll_candidate"
                confidence = min(confidence, 0.55)
                evidence.extend(["ground_state", "increasing_ground_speed"])
        elif airborne_observed or (last_airborne_ms is not None and now - last_airborne_ms <= 120_000):
            evidence.append("airborne_altitude_or_trend")
            confidence = float(trend_confidence[row]) if np.isfinite(rates[row]) else 0.45
            if recent_ground_to_air:
                phase = "initial_climb"
                detail = "liftoff_candidate"
                confidence = max(confidence, 0.65)
                row_events.append("liftoff_candidate")
            elif regime == "climb":
                if last_takeoff_ms is not None and 0 <= now - last_takeoff_ms <= 180_000:
                    phase = "initial_climb"
                else:
                    phase = "climb"
                    if regime_changed and regime_before_change == "level" and np.isfinite(distance_nm[row]) and distance_nm[row] > 20.0:
                        detail = "step_climb_candidate"
                evidence.append("sustained_positive_robust_altitude_trend")
            elif regime == "descent":
                approach_candidate = (
                    np.isfinite(distance_nm[row])
                    and distance_nm[row] <= AIRPORT_CONTEXT_NM
                    and np.isfinite(height_above_airport[row])
                    and height_above_airport[row] <= 8_000.0
                    and np.isfinite(closure_rate_kts[row])
                    and closure_rate_kts[row] >= 25.0
                )
                if approach_candidate:
                    phase = "approach"
                    detail = "approach_candidate"
                    evidence.extend([
                        "sustained_negative_robust_altitude_trend",
                        f"closing_to_{airport_code.lower()}",
                        f"within_{airport_code.lower()}_terminal_context",
                    ])
                    confidence = min(0.78, max(0.5, confidence * 0.78))
                    if distance_nm[row] <= AIRPORT_NEAR_NM and height_above_airport[row] <= 1_500.0:
                        detail = "final_approach_candidate_runway_alignment_unavailable"
                        confidence = min(confidence, 0.68)
                else:
                    phase = "descent"
                    evidence.append("sustained_negative_robust_altitude_trend")
            elif regime == "level":
                if (
                    np.isfinite(distance_nm[row])
                    and distance_nm[row] > 20.0
                    and not (
                        np.isfinite(closure_rate_kts[row])
                        and closure_rate_kts[row] >= 25.0
                        and distance_nm[row] <= AIRPORT_CONTEXT_NM
                    )
                ):
                    phase = "cruise"
                    evidence.extend(["sustained_near_level_altitude_trend", "enroute_distance_context"])
                else:
                    phase = "level_flight"
                    evidence.append("sustained_near_level_altitude_trend")
            elif np.isfinite(rates[row]):
                phase = "airborne_transition"
                evidence.append("vertical_trend_not_yet_stable")
            else:
                phase = "airborne_transition"
                evidence.append("insufficient_vertical_trend_history")

            if (
                phase in {"climb", "initial_climb"}
                and previous_phase == "approach"
                and np.isfinite(distance_nm[row])
                and distance_nm[row] <= 30.0
            ):
                phase = "go_around_climb_candidate"
                detail = "go_around_candidate"
                row_events.append("go_around_candidate")
                confidence = min(confidence, 0.7)
                evidence.append(f"climb_after_approach_near_{airport_code.lower()}")

            if regime_changed and regime_before_change == "level" and phase == "climb":
                row_events.append("step_climb_candidate")
            if regime_changed and regime == "descent" and regime_before_change == "level":
                row_events.append("top_of_descent_candidate")
            if regime_changed and regime == "level" and regime_before_change in {"climb", "descent"}:
                row_events.append("level_off_candidate")
                if regime_before_change == "climb":
                    row_events.append("top_of_climb_candidate")
        else:
            evidence.append("ground_air_state_uncertain")

        if recent_air_to_ground and "touchdown_candidate" not in row_events:
            row_events.append("touchdown_candidate")
        if recent_ground_to_air and last_touchdown_ms is not None and 0 <= now - last_touchdown_ms <= 120_000:
            row_events.append("touch_and_go_candidate")

        labels.append(phase)
        details.append(detail)
        confidences.append(float(np.clip(confidence, 0.0, 1.0)))
        events.append(";".join(dict.fromkeys(row_events)))
        evidence_rows.append(";".join(dict.fromkeys(evidence)))
        previous_phase = phase

    phase_changed = [False]
    for row in range(1, len(labels)):
        phase_changed.append(labels[row] != labels[row - 1])
    events = [
        ";".join(filter(None, [event, "phase_changed" if phase_changed[row] else ""]))
        for row, event in enumerate(events)
    ]

    result["flight_phase"] = labels
    result["flight_phase_detail"] = details
    result["flight_phase_confidence"] = confidences
    result["flight_phase_changed"] = phase_changed
    result["flight_phase_event"] = events
    result["flight_phase_evidence"] = evidence_rows
    result["flight_phase_vertical_rate_fpm"] = rates
    result["flight_phase_distance_to_airport_nm"] = distance_nm
    result["flight_phase_closure_rate_kts"] = closure_rate_kts
    result["flight_phase_model_version"] = PHASE_MODEL_VERSION
    result["flight_phase_is_causal"] = True
    return result



def annotate_jfk_flight_phases(
    df: pd.DataFrame,
    airport_code: str = DEFAULT_AIRPORT_CODE,
    airport_file: str | Path = DEFAULT_AIRPORT_FILE,
    airport_record: dict[str, float] | None = None,
) -> pd.DataFrame:
    """Annotate only sessions with JFK takeoff/touchdown evidence."""
    required = {"aircraft_session_id", "ts"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"Input is missing required columns: {sorted(missing)}")
    airport = airport_record or load_airport_record(airport_code, airport_file)
    if airport is None:
        raise FileNotFoundError(f"Could not load {airport_code} airport coordinates from {airport_file}")

    scopes = select_airport_session_scopes(df, airport_code)
    if not scopes:
        raise ValueError(f"No sessions with a matched {airport_code} takeoff or touchdown were found")

    session_ids = df["aircraft_session_id"].astype("string")
    selected = df.loc[session_ids.isin(scopes)].copy()
    for column in PHASE_OUTPUT_COLUMNS:
        if column not in selected.columns:
            selected[column] = pd.NA
    selected["flight_phase_scope"] = selected["aircraft_session_id"].astype(str).map(scopes)

    annotated_groups = []
    for _, session in selected.groupby("aircraft_session_id", sort=False, dropna=True):
        ordered = session.sort_values("ts", kind="mergesort")
        pieces = []
        for segment in _split_track_segments(ordered):
            pieces.append(_phase_one_segment(segment, airport, airport_code))
        if pieces:
            annotated_groups.append(pd.concat(pieces, axis=0))
    if not annotated_groups:
        raise ValueError("JFK sessions were selected but no rows could be annotated")

    result = pd.concat(annotated_groups, axis=0).sort_values(
        ["aircraft_session_id", "ts"], kind="mergesort"
    )
    return result.reset_index(drop=True)


def sample_session_ids(
    annotated: pd.DataFrame,
    sample_size: int = 300,
    random_seed: int = 42,
) -> list[str]:
    """Choose a deterministic departure/arrival-balanced set of session IDs."""
    if sample_size <= 0 or annotated.empty:
        return []
    summary = annotated.groupby("aircraft_session_id", sort=True).agg(
        scope=("flight_phase_scope", "first")
    )
    available = list(summary.index.astype(str))
    if len(available) <= sample_size:
        return available
    rng = np.random.default_rng(random_seed)
    chosen: list[str] = []
    for scope in (f"{DEFAULT_AIRPORT_CODE.lower()}_departure", f"{DEFAULT_AIRPORT_CODE.lower()}_arrival"):
        candidates = [
            str(session_id)
            for session_id, value in summary["scope"].items()
            if value == scope and str(session_id) not in chosen
        ]
        target = min(len(candidates), sample_size // 2)
        if target:
            chosen.extend(sorted(rng.choice(candidates, size=target, replace=False).tolist()))
    if len(chosen) < sample_size:
        remaining = [session_id for session_id in available if session_id not in set(chosen)]
        target = min(len(remaining), sample_size - len(chosen))
        if target:
            chosen.extend(sorted(rng.choice(remaining, size=target, replace=False).tolist()))
    return chosen


def phase_session_ids(df: pd.DataFrame, airport_code: str = DEFAULT_AIRPORT_CODE) -> pd.Index:
    """Return session IDs present in the matching airport-tagged phase sidecar."""
    if "flight_phase_scope" not in df.columns or "aircraft_session_id" not in df.columns:
        return pd.Index([], dtype="object")
    prefix = f"{airport_code.strip().lower()}_"
    scope = df["flight_phase_scope"].astype("string").str.lower()
    mask = scope.str.startswith(prefix, na=False)
    return pd.Index(df.loc[mask, "aircraft_session_id"].dropna().astype(str).unique())


def summarize_phases(annotated: pd.DataFrame) -> dict[str, Any]:
    """Return compact counts useful for logs and real-data validation."""
    session_scope = annotated.groupby("aircraft_session_id", sort=False)["flight_phase_scope"].first()
    return {
        "model_version": PHASE_MODEL_VERSION,
        "n_sessions": int(session_scope.size),
        "n_departure_sessions": int(session_scope.str.endswith("_departure").sum()),
        "n_arrival_sessions": int(session_scope.str.endswith("_arrival").sum()),
        "n_local_sessions": int(session_scope.str.endswith("_local").sum()),
        "n_rows": int(len(annotated)),
        "phase_rows": {
            str(phase): int(count)
            for phase, count in annotated["flight_phase"].value_counts(dropna=False).items()
        },
        "event_rows": {
            str(event): int(annotated["flight_phase_event"].astype("string").str.contains(event, na=False).sum())
            for event in (
                "liftoff_candidate",
                "touchdown_candidate",
                "top_of_climb_candidate",
                "top_of_descent_candidate",
                "go_around_candidate",
            )
        },
        "mean_confidence": float(pd.to_numeric(annotated["flight_phase_confidence"], errors="coerce").mean()),
    }
