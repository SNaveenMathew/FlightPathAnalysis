"""Tag JFK-related ADS-B sessions with causal flight-phase estimates.

Run after 01-label_aircraft_id.ipynb. The output is a compact row-level Feather
sidecar keyed by (aircraft_session_id, ts), which the trajectory exporter joins
onto the full collection without copying the multi-gigabyte source Feather file.
The full processed source is used so the sidecar covers buffers and all rows of
each selected JFK session, not only rows in the JFK-destination subset.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.feather as feather

from flight_phase import (
    DEFAULT_AIRPORT_CODE,
    PHASE_MODEL_VERSION,
    PHASE_OUTPUT_COLUMNS,
    annotate_jfk_flight_phases,
    sample_session_ids,
    select_airport_session_scopes,
    summarize_phases,
)

PREPROCESSING_DIR = Path(__file__).resolve().parent
DEFAULT_INPUT = PREPROCESSING_DIR / "full_ac_data.feather"
DEFAULT_OUTPUT = PREPROCESSING_DIR / "jfk_flight_phase_tags.feather"
DEFAULT_AUDIT = PREPROCESSING_DIR / "jfk_flight_phase_sample.csv"
INPUT_COLUMNS = [
    "aircraft",
    "id",
    "aircraft_session_id",
    "aircraft_session_type",
    "ts",
    "lat",
    "lon",
    "altitude",
    "altitude_raw_ft",
    "ground_speed",
    "ground_flag",
    "ground_flag_confidence",
    "track_segment_id",
    "altitude_invalid_flag",
    "altitude_range_flag",
    "altitude_ceiling_flag",
    "altitude_jump_suspect_flag",
    "takeoff",
    "touchdown",
    "takeoff_candidate",
    "touchdown_candidate",
    "takeoff_airport",
    "airport",
    "session_src_airport",
    "session_dest_airport",
    "n_to_session",
    "n_ld_session",
]
AUDIT_COLUMNS = [
    "aircraft_session_id",
    "aircraft",
    "flight_phase_scope",
    "ts",
    "lat",
    "lon",
    "altitude_raw_ft",
    "ground_speed",
    "ground_flag",
    "track_segment_id",
    "flight_phase",
    "flight_phase_detail",
    "flight_phase_confidence",
    "flight_phase_changed",
    "flight_phase_event",
    "flight_phase_evidence",
    "flight_phase_vertical_rate_fpm",
    "flight_phase_distance_to_airport_nm",
    "flight_phase_closure_rate_kts",
]


def _read_input(path: Path) -> pd.DataFrame:
    if not path.is_file():
        raise FileNotFoundError(
            f"Missing {path}. Run 02-Preprocessing/01-label_aircraft_id.ipynb first."
        )
    try:
        table = feather.read_table(path, columns=INPUT_COLUMNS, memory_map=False)
    except pa.ArrowInvalid:
        table = feather.read_table(path, memory_map=False)
    available = set(table.schema.names)
    required = {"aircraft_session_id", "ts", "lat", "lon", "ground_flag"}
    missing = required - available
    if missing:
        raise ValueError(f"{path} is missing required columns: {sorted(missing)}")
    columns = [column for column in INPUT_COLUMNS if column in available]
    data = table.select(columns).to_pandas()
    for column in (
        "ts",
        "lat",
        "lon",
        "altitude",
        "altitude_raw_ft",
        "ground_speed",
        "ground_flag_confidence",
        "n_to_session",
        "n_ld_session",
    ):
        if column in data.columns:
            data[column] = pd.to_numeric(data[column], errors="coerce")
    return data


def _limit_sessions(
    data: pd.DataFrame,
    airport_code: str,
    limit: int | None,
    seed: int,
) -> pd.DataFrame:
    if limit is None:
        return data
    if limit <= 0:
        raise ValueError("--limit-sessions must be positive")
    scopes = select_airport_session_scopes(data, airport_code)
    ids = sorted(scopes)
    if len(ids) <= limit:
        return data
    rng = np.random.default_rng(seed)
    selected = sorted(rng.choice(ids, size=limit, replace=False).tolist())
    return data.loc[data["aircraft_session_id"].astype("string").isin(selected)].copy()


def run(
    input_path: Path = DEFAULT_INPUT,
    output_path: Path = DEFAULT_OUTPUT,
    audit_path: Path | None = DEFAULT_AUDIT,
    airport_code: str = DEFAULT_AIRPORT_CODE,
    audit_sample_size: int = 300,
    random_seed: int = 42,
    limit_sessions: int | None = None,
) -> tuple[Path, dict]:
    if audit_sample_size < 0:
        raise ValueError("--audit-sample-size cannot be negative")
    source = _read_input(Path(input_path))
    source = _limit_sessions(source, airport_code, limit_sessions, random_seed)
    annotated = annotate_jfk_flight_phases(
        source,
        airport_code=airport_code,
    )
    keys = ["aircraft_session_id", "ts"]
    duplicate_keys = annotated.duplicated(keys, keep=False)
    if duplicate_keys.any():
        examples = annotated.loc[duplicate_keys, keys].head(5).to_dict("records")
        raise ValueError(
            "Phase sidecar key is not unique; refusing an unsafe many-to-many join. "
            f"Example duplicate keys: {examples}"
        )

    sidecar_columns = keys + [
        column for column in ("aircraft", *PHASE_OUTPUT_COLUMNS) if column in annotated.columns
    ]
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    feather.write_feather(annotated[sidecar_columns], output_path, compression="zstd")

    sample_ids = sample_session_ids(annotated, audit_sample_size, random_seed)
    if audit_path is not None and sample_ids:
        audit_path = Path(audit_path)
        audit_path.parent.mkdir(parents=True, exist_ok=True)
        audit_columns = [column for column in AUDIT_COLUMNS if column in annotated.columns]
        annotated.loc[
            annotated["aircraft_session_id"].astype(str).isin(sample_ids), audit_columns
        ].to_csv(audit_path, index=False)

    summary = summarize_phases(annotated)
    summary["airport"] = airport_code.upper()
    summary["input"] = str(input_path)
    summary["output"] = str(output_path)
    summary["audit_sample_size_requested"] = audit_sample_size
    summary["audit_sample_size_written"] = len(sample_ids)
    summary["random_seed"] = random_seed
    summary["phase_change_points"] = int(annotated["flight_phase_changed"].sum())
    summary["duplicate_sidecar_keys"] = int(duplicate_keys.sum())
    summary["model_version"] = PHASE_MODEL_VERSION
    if audit_path is not None and sample_ids:
        summary["audit_output"] = str(audit_path)
    return output_path, summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--audit-output", type=Path, default=DEFAULT_AUDIT)
    parser.add_argument("--airport", default=DEFAULT_AIRPORT_CODE)
    parser.add_argument("--audit-sample-size", type=int, default=300)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--limit-sessions",
        type=int,
        default=None,
        help="Optional random session cap for a quick trial; default tags all matched sessions",
    )
    args = parser.parse_args()
    output, summary = run(
        input_path=args.input,
        output_path=args.output,
        audit_path=args.audit_output,
        airport_code=args.airport,
        audit_sample_size=args.audit_sample_size,
        random_seed=args.seed,
        limit_sessions=args.limit_sessions,
    )
    print(json.dumps(summary, indent=2, sort_keys=True))
    print(f"Wrote phase tags to {output}")


if __name__ == "__main__":
    main()
