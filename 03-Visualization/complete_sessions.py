"""Filter complete S1–S4 aircraft sessions and discretize (x, y, z, t)."""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pyarrow.feather as feather

# Sector and edge band configured by 02-Preprocessing/01-label_aircraft_id.ipynb.
SECTOR = {
    "lat_min": 35.0,
    "lat_max": 45.0,
    "lon_min": -78.0,
    "lon_max": -68.0,
    "lat_range": 0.4,
    "lon_range": 0.5,
}
DEFAULT_BINS = {"dx": 0.05, "dy": 0.05, "dz": 500.0, "dt": 5.0}
MIN_PTS_PER_SESSION = 2
CLIP_TOLERANCE_MS = 60_000

QC_FLAG_COLUMNS = (
    "track_gap_flag",
    "position_invalid_flag",
    "altitude_invalid_flag",
    "altitude_range_flag",
    "position_jump_suspect_flag",
    "altitude_jump_suspect_flag",
    "altitude_spike_suspect_flag",
    "altitude_ceiling_flag",
)

NEEDED_COLS = [
    "aircraft",
    "id",
    "aircraft_session_id",
    "aircraft_session_type",
    "n_to_session",
    "n_ld_session",
    "session_src_airport",
    "session_dest_airport",
    "ts",
    "lon",
    "lat",
    "altitude",
    "altitude_raw_ft",
    "altitude_phase_ft",
    "ground_flag",
    "track_segment_id",
    "sample_gap_ms",
    "quality_flag_count",
    "track_gap_flag",
    "position_invalid_flag",
    "altitude_invalid_flag",
    "altitude_range_flag",
    "position_jump_suspect_flag",
    "altitude_jump_suspect_flag",
    "altitude_spike_suspect_flag",
    "altitude_ceiling_flag",
    "takeoff_in_sector",
    "touchdown_in_sector",
    "takeoff",
    "touchdown",
]

COMPLETE_KIND = {
    ("S_TO", "E_LD"): "local",
    ("S_TO", "E_EDGE"): "departure",
    ("S_EDGE", "E_LD"): "arrival",
    ("S_EDGE", "E_EDGE"): "transit",
}

SESSION_TYPE_KIND = {
    "S1": "local",
    "S2": "arrival",
    "S3": "departure",
    "S4": "transit",
}
SESSION_TYPE_ENDPOINTS = {
    "S1": ("S_TO", "E_LD"),
    "S2": ("S_TRACK_START", "E_LD"),
    "S3": ("S_TO", "E_TRACK_END"),
    "S4": ("S_TRACK_START", "E_TRACK_END"),
}
SESSION_TYPE_EVENTS = {
    "S1": (True, True),
    "S2": (False, True),
    "S3": (True, False),
    "S4": (False, False),
}
COMPLETENESS_BASIS = {
    "local": "S1: in-sector takeoff and landing events",
    "arrival": "S2: landing event; inbound track start inferred",
    "departure": "S3: takeoff event; sector exit inferred from track end",
    "transit": "S4: no takeoff/landing; airborne pass-through inferred",
}


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def candidate_feather_paths() -> list[Path]:
    root = repo_root()
    return [
        root / "02-Preprocessing" / "full_ac_data.feather",
        root.parent / "atc_app" / "full_ac_data.feather",
        root / "02-Preprocessing" / "ac_data_processed.feather",
        root.parent / "atc_app" / "ac_data_processed.feather",
    ]


def _can_read_feather(path: Path) -> bool:
    if not path.is_file() or path.stat().st_size < 1000:
        return False
    try:
        feather.read_table(path, columns=["aircraft"], memory_map=False)
        return True
    except Exception:
        return False


def resolve_feather_path(explicit: str | Path | None = None) -> Path:
    if explicit is not None:
        path = Path(explicit)
        if not _can_read_feather(path):
            raise FileNotFoundError(f"Unreadable or missing feather file: {path}")
        return path
    for path in candidate_feather_paths():
        if _can_read_feather(path):
            return path
    raise FileNotFoundError(
        "No readable preprocessed Feather file found. The file under "
        "02-Preprocessing may be truncated; pass feather_path= to select a valid file."
    )


def load_adsb(feather_path: str | Path | None = None) -> tuple[pd.DataFrame, Path]:
    path = resolve_feather_path(feather_path)
    table = feather.read_table(path, memory_map=False)
    names = set(table.schema.names)
    required = {"aircraft_session_id", "ts", "lon", "lat", "altitude"}
    missing = required - names
    if missing:
        raise ValueError(f"{path} is missing required columns: {sorted(missing)}")
    cols = [column for column in NEEDED_COLS if column in names]
    df = feather.read_table(path, columns=cols, memory_map=False).to_pandas()
    for column in (
        "ts", "lon", "lat", "altitude", "altitude_raw_ft",
        "altitude_phase_ft", "sample_gap_ms",
        "quality_flag_count", "n_to_session", "n_ld_session"
    ):
        if column in df.columns:
            df[column] = pd.to_numeric(df[column], errors="coerce")
    for flag in (
        "takeoff_in_sector", "touchdown_in_sector", "takeoff", "touchdown",
        *QC_FLAG_COLUMNS,
    ):
        if flag in df.columns:
            df[flag] = df[flag].fillna(False).astype(bool)
        else:
            df[flag] = False
    for column in ("n_to_session", "n_ld_session"):
        if column not in df.columns:
            df[column] = 0
        df[column] = df[column].fillna(0)
    for column in (
        "aircraft",
        "aircraft_session_type",
        "session_src_airport",
        "session_dest_airport",
        "takeoff",
        "touchdown",
    ):
        if column not in df.columns:
            df[column] = False if column in {"takeoff", "touchdown"} else pd.NA
    return df, path


def in_box(lat: pd.Series | np.ndarray, lon: pd.Series | np.ndarray, box: dict) -> np.ndarray:
    lat = np.asarray(lat, dtype=float)
    lon = np.asarray(lon, dtype=float)
    return (
        (lat >= box["lat_min"])
        & (lat <= box["lat_max"])
        & (lon >= box["lon_min"])
        & (lon <= box["lon_max"])
    )


def on_edge_band(lat, lon, box: dict) -> np.ndarray:
    lat = np.asarray(lat, dtype=float)
    lon = np.asarray(lon, dtype=float)
    near_west = lon < box["lon_min"] + box["lon_range"]
    near_east = lon > box["lon_max"] - box["lon_range"]
    near_south = lat < box["lat_min"] + box["lat_range"]
    near_north = lat > box["lat_max"] - box["lat_range"]
    return in_box(lat, lon, box) & (near_west | near_east | near_south | near_north)


def coverage_box(_df: pd.DataFrame) -> dict:
    """Return the configured sector: observed extrema are not sector boundaries."""
    return dict(SECTOR)


def _session_summaries(df: pd.DataFrame, box: dict) -> pd.DataFrame:
    work = df.loc[df["aircraft_session_id"].notna()].copy()
    for column in (
        "aircraft",
        "aircraft_session_type",
        "n_to_session",
        "n_ld_session",
        "takeoff_in_sector",
        "touchdown_in_sector",
        "takeoff",
        "touchdown",
        "ground_flag",
        "track_segment_id",
        "quality_flag_count",
        *QC_FLAG_COLUMNS,
        "session_src_airport",
        "session_dest_airport",
    ):
        if column not in work.columns:
            work[column] = 0 if column in {
                "n_to_session", "n_ld_session", "quality_flag_count"
            } else (
                False if column in {
                    "takeoff_in_sector", "touchdown_in_sector", "takeoff",
                    "touchdown", "ground_flag", *QC_FLAG_COLUMNS
                } else pd.NA
            )
    for column in ("altitude", "altitude_phase_ft"):
        if column not in work.columns:
            work[column] = np.nan
    for column in (
        "takeoff_in_sector", "touchdown_in_sector", "takeoff", "touchdown",
        "ground_flag", *QC_FLAG_COLUMNS,
    ):
        work[column] = work[column].astype("boolean").fillna(False).astype(bool)
    work = work.dropna(subset=["ts"]).sort_values(
        ["aircraft_session_id", "ts"], kind="mergesort"
    )
    work["in_bbox"] = in_box(work["lat"].to_numpy(), work["lon"].to_numpy(), box)
    work["on_edge"] = on_edge_band(work["lat"].to_numpy(), work["lon"].to_numpy(), box)

    raw_altitude = pd.to_numeric(work["altitude"], errors="coerce")
    phase_altitude = pd.to_numeric(work["altitude_phase_ft"], errors="coerce")
    work["_altitude_for_completeness"] = phase_altitude.where(
        phase_altitude.notna(), raw_altitude
    )
    invalid_altitude = pd.Series(False, index=work.index)
    for flag in (
        "altitude_invalid_flag", "altitude_range_flag", "altitude_ceiling_flag"
    ):
        invalid_altitude |= work[flag]
    work.loc[invalid_altitude, "_altitude_for_completeness"] = np.nan
    work["_valid_track_point"] = (
        work["in_bbox"]
        & np.isfinite(pd.to_numeric(work["ts"], errors="coerce"))
        & np.isfinite(pd.to_numeric(work["lon"], errors="coerce"))
        & np.isfinite(pd.to_numeric(work["lat"], errors="coerce"))
        & work["_altitude_for_completeness"].notna()
    )

    prev_in = work.groupby("aircraft_session_id", sort=False)["in_bbox"].shift(1)
    prev_in = prev_in.astype("boolean").fillna(False).astype(bool)
    run_start = work["in_bbox"] & ~prev_in
    n_runs = run_start.groupby(work["aircraft_session_id"], sort=False).sum()
    inb = work.loc[work["in_bbox"]]
    if inb.empty:
        return pd.DataFrame()

    first = inb.groupby("aircraft_session_id", sort=False).head(1).set_index("aircraft_session_id")
    last = inb.groupby("aircraft_session_id", sort=False).tail(1).set_index("aircraft_session_id")
    first_all = work.groupby("aircraft_session_id", sort=False).head(1).set_index("aircraft_session_id")
    last_all = work.groupby("aircraft_session_id", sort=False).tail(1).set_index("aircraft_session_id")
    agg = work.groupby("aircraft_session_id", sort=False).agg(
        aircraft=("aircraft", "first"),
        session_type=("aircraft_session_type", "first"),
        n_pts=("ts", "size"),
        ts_first=("ts", "min"),
        ts_last=("ts", "max"),
        n_to=("n_to_session", "max"),
        n_ld=("n_ld_session", "max"),
        flag_to=("takeoff_in_sector", "any"),
        flag_ld=("touchdown_in_sector", "any"),
        raw_to=("takeoff", "any"),
        raw_ld=("touchdown", "any"),
        max_alt=("altitude", "max"),
        max_valid_alt=("_altitude_for_completeness", "max"),
        n_valid_points=("_valid_track_point", "sum"),
        min_alt=("altitude", "min"),
        ground_only=("ground_flag", "all"),
        first_session_alt=("altitude", "first"),
        last_session_alt=("altitude", "last"),
        src=("session_src_airport", "first"),
        dest=("session_dest_airport", "first"),
        quality_flag_events=("quality_flag_count", "sum"),
        quality_flagged_points=("quality_flag_count", lambda values: int((values > 0).sum())),
        n_track_segments=("track_segment_id", "nunique"),
        track_gap_points=("track_gap_flag", "sum"),
        position_invalid_points=("position_invalid_flag", "sum"),
        position_jump_points=("position_jump_suspect_flag", "sum"),
        altitude_invalid_points=("altitude_invalid_flag", "sum"),
        altitude_range_points=("altitude_range_flag", "sum"),
        altitude_jump_points=("altitude_jump_suspect_flag", "sum"),
        altitude_spike_points=("altitude_spike_suspect_flag", "sum"),
        altitude_ceiling_points=("altitude_ceiling_flag", "sum"),
    )
    point_summary = pd.DataFrame(
        {
            "first_on_edge": first["on_edge"].to_numpy(),
            "last_on_edge": last["on_edge"].to_numpy(),
            "first_lat": first["lat"].to_numpy(),
            "first_lon": first["lon"].to_numpy(),
            "last_lat": last["lat"].to_numpy(),
            "last_lon": last["lon"].to_numpy(),
            "ts_first_bbox": first["ts"].to_numpy(),
            "ts_last_bbox": last["ts"].to_numpy(),
            "first_alt": first_all["altitude"].reindex(first.index).to_numpy(),
            "last_alt": last_all["altitude"].reindex(first.index).to_numpy(),
            "n_in_bbox": inb.groupby("aircraft_session_id", sort=False).size().to_numpy(),
        },
        index=first.index,
    )
    out = agg.join(point_summary, how="inner")
    # Session event counts exclude the merge buffer; per-row flags may not.
    out["has_to"] = out["n_to"].fillna(0) > 0
    out["has_ld"] = out["n_ld"].fillna(0) > 0
    out["n_bbox_runs"] = n_runs.reindex(out.index).fillna(0).astype(int)
    out["first_on_edge"] = out["first_on_edge"].fillna(False).astype(bool)
    out["last_on_edge"] = out["last_on_edge"].fillna(False).astype(bool)
    out["n_in_bbox"] = out["n_in_bbox"].fillna(0).astype(int)
    return out


def classify_complete(
    summary: pd.DataFrame,
    ts_global_min: float,
    ts_global_max: float,
    min_points: int = MIN_PTS_PER_SESSION,
) -> pd.DataFrame:
    if not isinstance(min_points, int) or min_points < 2:
        raise ValueError("min_points must be an integer of at least 2")
    s = summary.copy()
    if s.empty:
        s["start_kind"] = pd.Series(dtype=str)
        s["end_kind"] = pd.Series(dtype=str)
        s["complete_kind"] = pd.Series(dtype=str)
        s["completeness_basis"] = pd.Series(dtype=str)
        s["drop_reason"] = pd.Series(dtype=str)
        s["is_complete"] = pd.Series(dtype=bool)
        return s

    has_to = s["has_to"].fillna(False).astype(bool)
    has_ld = s["has_ld"].fillna(False).astype(bool)
    session_type = s.get(
        "session_type", pd.Series(pd.NA, index=s.index, dtype="object")
    ).fillna("").astype(str)
    known_type = session_type.isin(SESSION_TYPE_KIND)

    legacy_start = np.where(
        has_to,
        "S_TO",
        np.where(s["first_on_edge"], "S_EDGE", "S_TRUNC"),
    )
    legacy_end = np.where(
        has_ld,
        "E_LD",
        np.where(s["last_on_edge"], "E_EDGE", "E_TRUNC"),
    )
    legacy_kind = pd.Series(
        [COMPLETE_KIND.get((a, b), "incomplete") for a, b in zip(legacy_start, legacy_end)],
        index=s.index,
    )

    expected_events = pd.Series(True, index=s.index)
    for kind, (expected_to, expected_ld) in SESSION_TYPE_EVENTS.items():
        mask = session_type.eq(kind)
        expected_events.loc[mask] = has_to.loc[mask].eq(expected_to) & has_ld.loc[mask].eq(expected_ld)
    type_mismatch = known_type & ~expected_events

    mapped_kind = session_type.map(SESSION_TYPE_KIND)
    s["complete_kind"] = mapped_kind.where(known_type, legacy_kind)
    s.loc[type_mismatch, "complete_kind"] = "incomplete"

    mapped_endpoints = session_type.map(SESSION_TYPE_ENDPOINTS)
    mapped_start = mapped_endpoints.map(lambda pair: pair[0] if isinstance(pair, tuple) else pd.NA)
    mapped_end = mapped_endpoints.map(lambda pair: pair[1] if isinstance(pair, tuple) else pd.NA)
    mapped_start = mapped_start.mask(
        mapped_start.eq("S_TRACK_START") & s["first_on_edge"], "S_EDGE"
    )
    mapped_end = mapped_end.mask(
        mapped_end.eq("E_TRACK_END") & s["last_on_edge"], "E_EDGE"
    )
    s["start_kind"] = mapped_start.where(known_type, pd.Series(legacy_start, index=s.index))
    s["end_kind"] = mapped_end.where(known_type, pd.Series(legacy_end, index=s.index))
    s["completeness_basis"] = s["complete_kind"].map(COMPLETENESS_BASIS).fillna(
        "observed takeoff/landing or sector-edge evidence"
    )

    n_valid_points = pd.to_numeric(
        s.get("n_valid_points", s["n_pts"]), errors="coerce"
    ).fillna(0)
    n_in_bbox = pd.to_numeric(s["n_in_bbox"], errors="coerce").fillna(0)
    n_bbox_runs = pd.to_numeric(
        s.get("n_bbox_runs", pd.Series(1, index=s.index)), errors="coerce"
    ).fillna(0)
    max_valid_alt = pd.to_numeric(
        s.get("max_valid_alt", s["max_alt"]), errors="coerce"
    )

    too_short = n_valid_points < min_points
    no_bbox = n_in_bbox < 2
    returned = s["complete_kind"].isin(["departure", "transit"]) & n_bbox_runs.gt(1)
    parked = (
        ~has_to
        & ~has_ld
        & (
            s["ground_only"].fillna(False).astype(bool)
            | max_valid_alt.fillna(0).lt(2000)
        )
    )
    clip_open = ~has_to & (s["ts_first"] <= ts_global_min + CLIP_TOLERANCE_MS)
    clip_close = ~has_ld & (s["ts_last"] >= ts_global_max - CLIP_TOLERANCE_MS)

    reason = np.full(len(s), "", dtype=object)
    reason = np.where(too_short, "too_few_points", reason)
    reason = np.where((reason == "") & no_bbox, "no_in_sector_track", reason)
    reason = np.where((reason == "") & type_mismatch, "session_type_event_mismatch", reason)
    reason = np.where((reason == "") & returned, "session_returned", reason)
    reason = np.where((reason == "") & parked, "parked_or_ground", reason)
    reason = np.where((reason == "") & clip_open, "clipped_collection_start", reason)
    reason = np.where((reason == "") & clip_close, "clipped_collection_end", reason)
    reason = np.where((reason == "") & (s["complete_kind"] == "incomplete"), "truncated", reason)
    s["drop_reason"] = reason
    s["is_complete"] = s["drop_reason"].eq("")
    return s


def complete_session_ids(
    df: pd.DataFrame,
    box: dict | None = None,
    min_points: int = MIN_PTS_PER_SESSION,
) -> tuple[pd.Index, pd.DataFrame, dict]:
    if box is None:
        box = coverage_box(df)
    all_ts = pd.to_numeric(df["ts"], errors="coerce").dropna()
    labeled_ts = df.loc[df["aircraft_session_id"].notna(), "ts"].dropna()
    if labeled_ts.empty or all_ts.empty:
        raise ValueError("No non-null aircraft_session_id / ts rows found")
    summary = classify_complete(
        _session_summaries(df, box),
        float(all_ts.min()),
        float(all_ts.max()),
        min_points=min_points,
    )
    keep = summary.index[summary["is_complete"]]
    return keep, summary, box


def _trajectory_rows(
    df: pd.DataFrame,
    session_ids: pd.Index | list[str],
    box: dict,
) -> pd.DataFrame:
    columns = [
        "aircraft",
        "aircraft_session_id",
        "aircraft_session_type",
        "ts",
        "lon",
        "lat",
        "altitude",
        "altitude_phase_ft",
        "altitude_invalid_flag",
        "altitude_range_flag",
        "altitude_ceiling_flag",
    ]
    available = [column for column in columns if column in df.columns]
    selected = df.loc[
        df["aircraft_session_id"].isin(list(session_ids)), available
    ].copy()
    selected = selected.loc[in_box(selected["lat"], selected["lon"], box)].copy()
    for column in ("aircraft", "aircraft_session_type"):
        if column not in selected.columns:
            selected[column] = pd.NA

    invalid_altitude = pd.Series(False, index=selected.index)
    for flag in (
        "altitude_invalid_flag",
        "altitude_range_flag",
        "altitude_ceiling_flag",
    ):
        if flag in selected.columns:
            invalid_altitude |= selected[flag].fillna(False).astype(bool)
    selected = selected.loc[~invalid_altitude].copy()

    if "altitude_phase_ft" in selected.columns:
        phase_altitude = pd.to_numeric(selected["altitude_phase_ft"], errors="coerce")
        raw_altitude = pd.to_numeric(selected["altitude"], errors="coerce")
        selected["altitude"] = phase_altitude.combine_first(raw_altitude)
    selected = selected.dropna(subset=["ts", "lon", "lat", "altitude"])
    return selected.sort_values(
        ["aircraft_session_id", "ts"], kind="mergesort"
    )


def discretize_sessions(
    df: pd.DataFrame,
    session_ids: pd.Index | list[str],
    bins: dict[str, float] | None = None,
    box: dict | None = None,
) -> pd.DataFrame:
    bins = {**DEFAULT_BINS, **(bins or {})}
    if box is None:
        box = coverage_box(df)
    for name, width in bins.items():
        if not np.isfinite(width) or width <= 0:
            raise ValueError(f"Bin width {name} must be positive and finite")
    sub = _trajectory_rows(df, session_ids, box)
    t0 = sub.groupby("aircraft_session_id")["ts"].transform("min")
    sub["t_rel"] = (sub["ts"] - t0) / 1000.0
    sub["ix"] = np.floor((sub["lon"] - box["lon_min"]) / bins["dx"]).astype(np.int32)
    sub["iy"] = np.floor((sub["lat"] - box["lat_min"]) / bins["dy"]).astype(np.int32)
    sub["iz"] = np.floor(np.maximum(sub["altitude"], 0) / bins["dz"]).astype(np.int32)
    sub["it"] = np.floor(sub["t_rel"] / bins["dt"]).astype(np.int32)
    group_columns = [
        "aircraft_session_id", "aircraft", "aircraft_session_type", "ix", "iy", "iz", "it"
    ]
    occ = sub.groupby(
        group_columns,
        sort=False,
        as_index=False,
        dropna=False,
    ).agg(
        lon=("lon", "mean"),
        lat=("lat", "mean"),
        alt=("altitude", "mean"),
        t_rel=("t_rel", "min"),
    )
    occ["x"] = box["lon_min"] + (occ["ix"] + 0.5) * bins["dx"]
    occ["y"] = box["lat_min"] + (occ["iy"] + 0.5) * bins["dy"]
    occ["z"] = (occ["iz"] + 0.5) * bins["dz"]
    occ["t"] = occ["it"] * bins["dt"]
    return occ


def voxel_index(occ: pd.DataFrame) -> dict[tuple[int, int, int], list[dict[str, Any]]]:
    index: dict[tuple[int, int, int], list[dict[str, Any]]] = defaultdict(list)
    seen: set[tuple[int, int, int, str, int]] = set()
    columns = occ[["ix", "iy", "iz", "aircraft_session_id", "it"]].itertuples(index=False, name=None)
    for ix, iy, iz, session_id, it in columns:
        key = (int(ix), int(iy), int(iz), str(session_id), int(it))
        if key in seen:
            continue
        seen.add(key)
        index[key[:3]].append({"session_id": session_id, "it": int(it)})
    return dict(index)


QUALITY_SUMMARY_FIELDS = (
    "quality_flag_events",
    "quality_flagged_points",
    "n_track_segments",
    "track_gap_points",
    "position_invalid_points",
    "position_jump_points",
    "altitude_invalid_points",
    "altitude_range_points",
    "altitude_jump_points",
    "altitude_spike_points",
    "altitude_ceiling_points",
)


def _quality_payload(summary_row: pd.Series | None) -> dict[str, int]:
    if summary_row is None:
        return {field: 0 for field in QUALITY_SUMMARY_FIELDS}
    result = {}
    for field in QUALITY_SUMMARY_FIELDS:
        value = summary_row.get(field, 0)
        result[field] = 0 if pd.isna(value) else int(value)
    return result


def occupancy_to_payload(
    occ: pd.DataFrame,
    summary: pd.DataFrame,
    bins: dict[str, float],
    box: dict,
    source: str,
) -> dict[str, Any]:
    sessions = []
    voxel_hits: dict[tuple[int, int, int], list[dict[str, Any]]] = defaultdict(list)
    for sid, group in occ.groupby("aircraft_session_id", sort=False, dropna=False):
        meta = summary.loc[sid] if sid in summary.index else None
        ix = group["ix"].to_numpy(dtype=np.int32, copy=False)
        iy = group["iy"].to_numpy(dtype=np.int32, copy=False)
        iz = group["iz"].to_numpy(dtype=np.int32, copy=False)
        it = group["it"].to_numpy(dtype=np.int32, copy=False)
        session_occ = np.column_stack([ix, iy, iz, it])
        session_id = str(sid)
        for vx, vy, vz, vt in session_occ:
            voxel_hits[(int(vx), int(vy), int(vz))].append(
                {"session_id": session_id, "it": int(vt)}
            )
        sessions.append(
            {
                "id": session_id,
                "aircraft": None if pd.isna(group["aircraft"].iloc[0]) else str(group["aircraft"].iloc[0]),
                "session_type": None
                if pd.isna(group["aircraft_session_type"].iloc[0])
                else str(group["aircraft_session_type"].iloc[0]),
                "complete_kind": None if meta is None else str(meta["complete_kind"]),
                "start_kind": None if meta is None else str(meta["start_kind"]),
                "end_kind": None if meta is None else str(meta["end_kind"]),
                "completeness_basis": None
                if meta is None
                else str(meta["completeness_basis"]),
                "edge_evidence": None
                if meta is None
                else {
                    "start": bool(meta.get("first_on_edge", False)),
                    "end": bool(meta.get("last_on_edge", False)),
                },
                "src": None if meta is None or pd.isna(meta["src"]) else str(meta["src"]),
                "dest": None if meta is None or pd.isna(meta["dest"]) else str(meta["dest"]),
                "quality": _quality_payload(meta),
                "t_max": float(group["t"].max()),
                "n_occ": int(len(group)),
                "occ": session_occ.tolist(),
            }
        )
    return {
        "meta": {
            "source": source,
            "sector": box,
            "sector_source": "preprocessor_config",
            "bins": bins,
            "n_sessions": len(sessions),
            "n_occupancy": int(len(occ)),
        },
        "sessions": sessions,
        "voxel_index": {
            f"{ix},{iy},{iz}": hits for (ix, iy, iz), hits in voxel_hits.items()
        },
    }


def continuous_sessions_to_payload(
    df: pd.DataFrame,
    session_ids: pd.Index | list[str],
    summary: pd.DataFrame,
    box: dict,
    dt: float,
    source: str | Path,
) -> dict[str, Any]:
    if not np.isfinite(dt) or dt <= 0:
        raise ValueError("Bin width dt must be positive and finite")

    selected = _trajectory_rows(df, session_ids, box)
    first_ts = selected.groupby("aircraft_session_id", sort=False)["ts"].transform("min")
    selected["it"] = np.floor(
        (selected["ts"] - first_ts) / (dt * 1000.0)
    ).astype(np.int32)

    sessions = []
    for session_id, group in selected.groupby("aircraft_session_id", sort=False):
        metadata = summary.loc[session_id]
        points = [
            [round(float(lon), 6), round(float(lat), 6), round(float(alt), 1), int(it)]
            for lon, lat, alt, it in group[["lon", "lat", "altitude", "it"]].itertuples(
                index=False, name=None
            )
        ]
        sessions.append(
            {
                "id": str(session_id),
                "aircraft": None
                if pd.isna(group["aircraft"].iloc[0])
                else str(group["aircraft"].iloc[0]),
                "session_type": None
                if pd.isna(group["aircraft_session_type"].iloc[0])
                else str(group["aircraft_session_type"].iloc[0]),
                "complete_kind": str(metadata["complete_kind"]),
                "start_kind": str(metadata["start_kind"]),
                "end_kind": str(metadata["end_kind"]),
                "completeness_basis": str(metadata["completeness_basis"]),
                "edge_evidence": {
                    "start": bool(metadata.get("first_on_edge", False)),
                    "end": bool(metadata.get("last_on_edge", False)),
                },
                "src": None if pd.isna(metadata["src"]) else str(metadata["src"]),
                "dest": None if pd.isna(metadata["dest"]) else str(metadata["dest"]),
                "quality": _quality_payload(metadata),
                "t_max": int(points[-1][3]) if points else 0,
                "n_points": len(points),
                "points": points,
            }
        )

    return {
        "meta": {
            "source_file": Path(source).name,
            "sector": box,
            "spatial_coordinates": "continuous lon/lat degrees and altitude feet",
            "time_step_seconds": float(dt),
            "n_sessions": len(sessions),
            "n_points": sum(session["n_points"] for session in sessions),
        },
        "sessions": sessions,
    }


def export_session_payload(
    df: pd.DataFrame,
    source: str | Path,
    session_ids: pd.Index | list[str],
    summary: pd.DataFrame,
    box: dict,
    mode: str = "discrete",
    bins: dict[str, float] | None = None,
    out_path: str | Path | None = None,
) -> tuple[Path, dict[str, Any]]:
    if mode not in {"discrete", "continuous"}:
        raise ValueError("mode must be either 'discrete' or 'continuous'")
    bins = {**DEFAULT_BINS, **(bins or {})}

    if mode == "discrete":
        occupancy = discretize_sessions(df, session_ids, bins=bins, box=box)
        payload = occupancy_to_payload(occupancy, summary, bins, box, Path(source).name)
        default_name = "complete_sessions.json"
    else:
        payload = continuous_sessions_to_payload(
            df, session_ids, summary, box, bins["dt"], source
        )
        default_name = "continuous_sessions.json"

    selected_summary = summary.reindex(pd.Index(session_ids))
    payload["meta"]["n_sessions_by_kind"] = {
        str(kind): int(count)
        for kind, count in selected_summary["complete_kind"].value_counts().items()
    }
    payload["meta"]["completeness"] = {
        "basis": "preprocessed S1-S4 session labels, cross-checked against event counts and track evidence",
        "edge_note": (
            "The configured edge bands have no observations in this source data. "
            "For S2/S3/S4, the inbound/outbound/pass-through interpretation comes "
            "from the existing session labels and observed track boundaries, not "
            "from direct edge-band crossings."
        ),
        "types": COMPLETENESS_BASIS,
        "filters": [
            "event signature agrees with S1-S4 label",
            "at least the configured number of valid in-sector track points",
            "not clipped at the collection start or end when a track endpoint is unobserved",
            "S4 sessions must show airborne altitude and not be ground-only",
            "reject S3/S4 sessions that re-enter the sector under the same session ID",
        ],
    }
    if "quality_flagged_points" in selected_summary.columns:
        flagged_points = selected_summary["quality_flagged_points"].fillna(0)
        flag_events = selected_summary["quality_flag_events"].fillna(0)
        payload["meta"]["quality"] = {
            "filtering": (
                "QC flags do not drop sessions; invalid, out-of-range, and "
                "above-ceiling altitude samples are omitted from trajectory coordinates"
            ),
            "sessions_with_flags": int((flagged_points > 0).sum()),
            "flagged_points": int(flagged_points.sum()),
            "flag_events": int(flag_events.sum()),
        }

    destination = (
        Path(out_path)
        if out_path is not None
        else Path(__file__).resolve().parent / default_name
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":"), allow_nan=False)
    return destination, payload["meta"]


def export_complete_sessions(
    feather_path: str | Path | None = None,
    out_path: str | Path | None = None,
    bins: dict[str, float] | None = None,
    max_sessions: int | None = None,
    random_state: int = 0,
    mode: str = "discrete",
    min_points: int = MIN_PTS_PER_SESSION,
) -> tuple[Path, pd.DataFrame, dict[str, Any]]:
    df, source = load_adsb(feather_path)
    keep, summary, box = complete_session_ids(df, min_points=min_points)
    if max_sessions is not None and len(keep) > max_sessions:
        keep = summary.loc[keep].sample(n=max_sessions, random_state=random_state).index
    output, meta = export_session_payload(
        df, source, keep, summary, box, mode=mode, bins=bins, out_path=out_path
    )
    return output, summary, meta


def completeness_counts(summary: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    if summary.empty:
        return pd.DataFrame(), pd.DataFrame(columns=["drop_reason", "n_sessions"])
    rows = []
    for kind, group in summary.groupby("complete_kind", dropna=False):
        rows.append(
            {
                "complete_kind": kind,
                "n_sessions": int(len(group)),
                "n_complete": int(group["is_complete"].sum()),
                "labeled_S1": int((group["session_type"] == "S1").sum()),
                "labeled_S2": int((group["session_type"] == "S2").sum()),
                "labeled_S3": int((group["session_type"] == "S3").sum()),
                "labeled_S4": int((group["session_type"] == "S4").sum()),
            }
        )
    by_drop = (
        summary.loc[~summary["is_complete"], "drop_reason"]
        .value_counts()
        .rename_axis("drop_reason")
        .reset_index(name="n_sessions")
    )
    return pd.DataFrame(rows), by_drop


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=None, help="Preprocessed Feather file")
    parser.add_argument("--output", type=Path, default=None, help="Output JSON path")
    parser.add_argument("--max-sessions", type=int, default=None, help="Optional random session cap")
    parser.add_argument(
        "--min-points",
        type=int,
        default=MIN_PTS_PER_SESSION,
        help="Minimum valid in-sector samples per session (default: 2; QC flags are reported)",
    )
    parser.add_argument(
        "--mode",
        choices=("discrete", "continuous"),
        default="discrete",
        help="Spatial output representation (default: discrete)",
    )
    args = parser.parse_args()
    output, summary, meta = export_complete_sessions(
        feather_path=args.input,
        out_path=args.output,
        max_sessions=args.max_sessions,
        mode=args.mode,
        min_points=args.min_points,
    )
    counts, drops = completeness_counts(summary)
    input_name = meta.get("source", meta.get("source_file", "unknown"))
    sector_source = meta.get("sector_source", "preprocessor_config")
    print(f"Input: {input_name}")
    print(f"Sector: {meta['sector']} ({sector_source})")
    print(f"Complete sessions: {meta['n_sessions']:,}")
    print(counts.to_string(index=False))
    print("Dropped:")
    print(drops.to_string(index=False))
    print(f"Wrote {output}")


if __name__ == "__main__":
    main()
