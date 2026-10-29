"""Filter geometrically complete aircraft sessions and discretize (x, y, z, t)."""

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
MIN_PTS_PER_SESSION = 20
CLIP_TOLERANCE_MS = 60_000

NEEDED_COLS = [
    "aircraft",
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
    for column in ("ts", "lon", "lat", "altitude", "n_to_session", "n_ld_session"):
        if column in df.columns:
            df[column] = pd.to_numeric(df[column], errors="coerce")
    for flag in ("takeoff_in_sector", "touchdown_in_sector", "takeoff", "touchdown"):
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
        "session_src_airport",
        "session_dest_airport",
    ):
        if column not in work.columns:
            work[column] = 0 if column in {"n_to_session", "n_ld_session"} else (
                False if column in {"takeoff_in_sector", "touchdown_in_sector", "takeoff", "touchdown", "ground_flag"} else pd.NA
            )
    work = work.dropna(subset=["ts"]).sort_values(
        ["aircraft_session_id", "ts"], kind="mergesort"
    )
    work["in_bbox"] = in_box(work["lat"].to_numpy(), work["lon"].to_numpy(), box)
    work["on_edge"] = on_edge_band(work["lat"].to_numpy(), work["lon"].to_numpy(), box)

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
        min_alt=("altitude", "min"),
        ground_only=("ground_flag", "all"),
        first_session_alt=("altitude", "first"),
        last_session_alt=("altitude", "last"),
        src=("session_src_airport", "first"),
        dest=("session_dest_airport", "first"),
    )
    point_summary = pd.DataFrame(
        {
            "first_on_edge": first["on_edge"].to_numpy(),
            "last_on_edge": last["on_edge"].to_numpy(),
            "first_lat": first["lat"].to_numpy(),
            "first_lon": first["lon"].to_numpy(),
            "last_lat": last["lat"].to_numpy(),
            "last_lon": last["lon"].to_numpy(),
            "first_alt": first_all["altitude"].reindex(first.index).to_numpy(),
            "last_alt": last_all["altitude"].reindex(first.index).to_numpy(),
            "n_in_bbox": inb.groupby("aircraft_session_id", sort=False).size().to_numpy(),
        },
        index=first.index,
    )
    out = agg.join(point_summary, how="inner")
    out["has_to"] = (
        (out["n_to"].fillna(0) > 0)
        | out["flag_to"].fillna(False)
        | out["raw_to"].fillna(False)
    )
    out["has_ld"] = (
        (out["n_ld"].fillna(0) > 0)
        | out["flag_ld"].fillna(False)
        | out["raw_ld"].fillna(False)
    )
    out["n_bbox_runs"] = n_runs.reindex(out.index).fillna(0).astype(int)
    out["first_on_edge"] = out["first_on_edge"].fillna(False).astype(bool)
    out["last_on_edge"] = out["last_on_edge"].fillna(False).astype(bool)
    out["n_in_bbox"] = out["n_in_bbox"].fillna(0).astype(int)
    return out


def classify_complete(
    summary: pd.DataFrame,
    ts_global_min: float,
    ts_global_max: float,
) -> pd.DataFrame:
    s = summary.copy()
    if s.empty:
        s["start_kind"] = pd.Series(dtype=str)
        s["end_kind"] = pd.Series(dtype=str)
        s["complete_kind"] = pd.Series(dtype=str)
        s["drop_reason"] = pd.Series(dtype=str)
        s["is_complete"] = pd.Series(dtype=bool)
        return s

    has_src_airport = s["src"].fillna("").astype(str).str.strip().ne("")
    has_dest_airport = s["dest"].fillna("").astype(str).str.strip().ne("")
    has_airport_takeoff = (
        has_src_airport
        & (s["raw_to"].fillna(False) | (s["first_alt"].fillna(0) <= 1000))
        & s["session_type"].isin(["S1", "S3"])
    )
    has_airport_landing = (
        has_dest_airport
        & (s["raw_ld"].fillna(False) | (s["last_alt"].fillna(0) <= 1000))
        & s["session_type"].isin(["S1", "S2"])
    )
    s["airport_start"] = has_airport_takeoff
    s["airport_end"] = has_airport_landing

    start = np.where(
        s["has_to"] | has_airport_takeoff,
        "S_TO",
        np.where(
            has_airport_landing & (s["ts_first"] > ts_global_min + CLIP_TOLERANCE_MS),
            "S_EDGE",
            np.where(s["first_on_edge"], "S_EDGE", "S_TRUNC"),
        ),
    )
    end = np.where(
        s["has_ld"] | has_airport_landing,
        "E_LD",
        np.where(
            has_airport_takeoff & (s["ts_last"] < ts_global_max - CLIP_TOLERANCE_MS),
            "E_EDGE",
            np.where(s["last_on_edge"], "E_EDGE", "E_TRUNC"),
        ),
    )
    s["start_kind"] = start
    s["end_kind"] = end
    s["complete_kind"] = [
        COMPLETE_KIND.get((a, b), "incomplete") for a, b in zip(s["start_kind"], s["end_kind"])
    ]

    returned = (s["end_kind"] == "E_EDGE") & (s["n_bbox_runs"] > 1)
    too_short = s["n_pts"] < MIN_PTS_PER_SESSION
    no_bbox = s["n_in_bbox"] < 2
    parked = (
        ~s["has_to"]
        & ~s["has_ld"]
        & ~has_airport_takeoff
        & ~has_airport_landing
        & ~s["first_on_edge"]
        & ~s["last_on_edge"]
        & (
            s["ground_only"].fillna(False)
            | (s["max_alt"].fillna(0) < 2000)
        )
    )
    clip_open = (
        ~s["has_to"]
        & ~has_airport_takeoff
        & (s["ts_first"] <= ts_global_min + CLIP_TOLERANCE_MS)
    )
    clip_close = (
        ~s["has_ld"]
        & ~has_airport_landing
        & (s["ts_last"] >= ts_global_max - CLIP_TOLERANCE_MS)
    )

    reason = np.full(len(s), "", dtype=object)
    reason = np.where(too_short, "too_few_points", reason)
    reason = np.where((reason == "") & no_bbox, "no_in_sector_track", reason)
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
) -> tuple[pd.Index, pd.DataFrame, dict]:
    if box is None:
        box = coverage_box(df)
    labeled_ts = df.loc[df["aircraft_session_id"].notna(), "ts"].dropna()
    if labeled_ts.empty:
        raise ValueError("No non-null aircraft_session_id / ts rows found")
    summary = classify_complete(
        _session_summaries(df, box), float(labeled_ts.min()), float(labeled_ts.max())
    )
    keep = summary.index[summary["is_complete"]]
    return keep, summary, box


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
    cols = [
        "aircraft",
        "aircraft_session_id",
        "aircraft_session_type",
        "ts",
        "lon",
        "lat",
        "altitude",
    ]
    available = [col for col in cols if col in df.columns]
    sub = df.loc[df["aircraft_session_id"].isin(list(session_ids)), available].copy()
    for col in ("aircraft", "aircraft_session_type"):
        if col not in sub.columns:
            sub[col] = pd.NA
    sub = sub.dropna(subset=["ts", "lon", "lat", "altitude"])
    sub = sub.sort_values(["aircraft_session_id", "ts"], kind="mergesort")
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
                "src": None if meta is None or pd.isna(meta["src"]) else str(meta["src"]),
                "dest": None if meta is None or pd.isna(meta["dest"]) else str(meta["dest"]),
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


def export_complete_sessions(
    feather_path: str | Path | None = None,
    out_path: str | Path | None = None,
    bins: dict[str, float] | None = None,
    max_sessions: int | None = None,
    random_state: int = 0,
) -> tuple[Path, pd.DataFrame, dict[str, Any]]:
    bins = {**DEFAULT_BINS, **(bins or {})}
    df, source = load_adsb(feather_path)
    keep, summary, box = complete_session_ids(df)
    if max_sessions is not None and len(keep) > max_sessions:
        keep = summary.loc[keep].sample(n=max_sessions, random_state=random_state).index
    occupancy = discretize_sessions(df, keep, bins=bins, box=box)
    payload = occupancy_to_payload(occupancy, summary, bins, box, str(source))
    if out_path is None:
        out_path = Path(__file__).resolve().parent / "complete_sessions.json"
    else:
        out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":"), allow_nan=False)
    return out_path, summary, payload["meta"]


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
    args = parser.parse_args()
    output, summary, meta = export_complete_sessions(
        feather_path=args.input,
        out_path=args.output,
        max_sessions=args.max_sessions,
    )
    counts, drops = completeness_counts(summary)
    print(f"Input: {meta['source']}")
    print(f"Sector: {meta['sector']} ({meta['sector_source']})")
    print(f"Complete sessions: {meta['n_sessions']:,}")
    print(counts.to_string(index=False))
    print("Dropped:")
    print(drops.to_string(index=False))
    print(f"Wrote {output}")


if __name__ == "__main__":
    main()
