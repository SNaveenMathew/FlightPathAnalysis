# FlightPathAnalysis

This repository contains code to:

1. download ADS-B (flight path) data and airport lists
2. preprocess ADS-B data and label aircraft sessions
3. visualize, animate, and analyze flight paths
4. explore air-traffic-control modeling

## Execution order

The numbered directories are the broad workflow stages. Numbered files within a
stage are local execution steps; files with the same number are independent
prerequisites or alternatives.

### Core data-to-visualization path

1. **Acquire source data** (the two tasks can run independently):
   - `01-Downloaders/01-get_airports.sh` downloads
     `GlobalAirportDatabase.txt`.
   - `01-Downloaders/01-fetch_live_adsb_data.ipynb` collects ADS-B data into
     `ads-b_extra.csv`.

   Both currently write to `data/` when run with `01-Downloaders` as the
   working directory. If you already have these source files, this download
   step can be skipped.

2. **Label and preprocess sessions:** run
   `02-Preprocessing/01-label_aircraft_id.ipynb`. It reads `ads-b*.csv` and
   `GlobalAirportDatabase.txt` from `../data` when run from `02-Preprocessing/`
   and writes
   `full_ac_data.feather` and `ac_data_processed.feather` there. It preserves
   reported altitude separately from derived ground/phase values and adds
   per-sample QC flags for long gaps, invalid coordinates/altitudes, and
   position/altitude jumps. Suspect points are flagged rather than silently
   deleted or interpolated. A `track_segment_id` marks gaps over 120 seconds;
   this is separate from the aircraft session labels. The downloader outputs
   should be present in the repository's `data/` directory.

3. **Export complete-session data:** run
   `03-Visualization/01-complete_sessions.ipynb`. Set `MODE` in the notebook to
   `"discrete"` for binned `(x, y, z, t)` output (`complete_sessions.json`), or
   `"continuous"` for continuous lon/lat/altitude with discretized time
   (`continuous_sessions.json`). Both use the same S1–S4 completeness filter and
   `BINS["dt"]` time-bin width. S1 is local takeoff-and-landing; S2/S3/S4 map to
   arrival, departure, and airborne transit candidates. Non-local endpoints are
   inferred from the existing session labels when edge samples are unavailable;
   the current collection has no samples in the configured edge bands. Sessions
   clipped at the collection limits, parked/ground-only S4 tracks, event-label
   mismatches, same-ID re-entries, and tracks with fewer than two valid in-sector
   points are excluded. The notebook reports counts and plots sample tracks.
   Exported trajectories contain only in-sector points and set `t=0` at the
   first retained sample. QC flags are summarized but do not otherwise exclude
   sessions.

4. **View the trajectories:** from `03-Visualization/`, start
   `python -m http.server 8765`, then open either:
   - <http://127.0.0.1:8765/02-session_space_viz.html> for discretized
     `(x, y, z, t)`.
   - <http://127.0.0.1:8765/02-session_space_viz_continuous.html> for
     continuous `(x, y, z)` with discretized `t`.

   Each page fetches its corresponding JSON by default; use its Load button
   if automatic loading fails.

This repository currently contains preprocessing and trajectory exploration,
not an RL environment, policy, or training loop.

### Optional analyses and experiments

These are not inputs to the core path above:

- `02-Preprocessing/02-visualize_aircraft.ipynb` inspects/filter sessions and
  writes `ac_data_final.feather`.
- `02-Preprocessing/optional-clean_landing.ipynb` creates a landing-focused
  subset.
- `02-Preprocessing/optional-more_to_understand.ipynb` contains exploratory
  analyses. It writes to `full_ac_data.feather`; run it on a copy if you need
  to preserve the primary labeling output.
- `01-Downloaders/optional-get_ads-b_with_id.sh` filters on the third CSV
  field, but the labeling notebook does not consume its output.
- `01-Downloaders/optional-opensky_api_try.ipynb` and
  `01-Downloaders/optional-fetch_adsb_aircraft.ipynb` are API/aircraft-specific
  experiments.
