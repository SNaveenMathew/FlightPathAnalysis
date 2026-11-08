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

3. **Infer JFK flight phases:** run
   `python 02-Preprocessing/02-tag_flight_phases.py`
   after session preprocessing. It reads `full_ac_data.feather` and writes the
   compact `jfk_flight_phase_tags.feather` sidecar keyed by
   `(aircraft_session_id, ts)`, plus `jfk_flight_phase_sample.csv` for a
   deterministic 300-session audit sample. Unlike the JFK-destination-only
   subset, this input preserves all processed points in selected sessions,
   including buffers. The phase labels are causal ADS-B-based estimates; JFK
   event flags select the cohort but do not
   determine the per-sample phase.

4. **Export complete-session data:** run
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
   sessions. The notebook exports the complete JFK phase-tagged cohort and
   includes exact per-point `phase_samples`, run-length `phase_intervals`, and
   `flight_phase_changed` alongside the existing coordinate arrays. The change
   flag is false at each track-segment start and true only when the current
   estimated label differs from its prior sample in that segment.

5. **Spatial-Temporal Neighborhood Indexing (FAA Air Traffic Separation):**
   Run:
   ```bash
   conda run -n flight_path python 03-Visualization/build_neighborhood_index.py
   ```
   Reads `continuous_sessions.json`, indexes all concurrent flights across the 48-hour dataset in 4D space-time, and builds the intermediate `neighborhood_index.json`. Grounded in FAA / ICAO air traffic control standards:
   - **Terminal Radar Separation:** 3.0 NM lateral, 1,000 ft vertical (FAA Order JO 7110.65). Flags loss of separation alerts.
   - **En-route / Traffic Advisory:** 5.0 NM lateral, 2,000 ft vertical proximity caution envelope.
   - **Safe Longitudinal Separation:** <= 180 s (3 minutes) in-trail spacing for flights along the same approach/departure corridor.
   - **Airspace Surveillance Neighborhood:** 15.0 NM lateral, 4,000 ft vertical envelope.

6. **Interactive Flight Phase Explorer & Manual Tagging Studio:**
   Launch the dedicated interactive application with:
   ```bash
   conda run -n flight_path python run_app.py
   # Or if flight_path is activated:
   python run_app.py
   ```
   Open <http://127.0.0.1:8000> to:
   - **Choose an Aircraft:** Search and pick any aircraft (e.g. `a387f0`, `a0be05`).
   - **Select Sessions:** Defaults to all sessions of the aircraft automatically; toggle individual sessions on/off to compare or isolate specific flights.
   - **Animate Predicted Phases in 3D:** Watch the aircraft traverse its trajectory in an interactive 3D WebGL scene preserving the radar look and feel. Starts in top-down `(lon, lat)` planar view and smoothly rotates/orbits into 3D to inspect the vertical altitude dimension, with synchronized altitude profile and telemetry.
   - **4D Neighborhood "Ghost" Traffic Animation:** Click on any aircraft or trajectory in 3D to reveal its concurrent neighborhood. Neighbor flights flying at the same real-world time are rendered as animated "ghosts" (translucent holographic models with dashed trajectory ribbons). Real-time 3D proximity vectors display live separation in NM and vertical altitude difference, with dynamic visual alerts when standard FAA separation minimums (<3 NM & <1,000 ft) are breached.
   - **Manual Phase Tagging:** Select time ranges by clicking/dragging on the timeline or using `[` and `]`, assign manual phase labels (`ground`, `initial_climb`, `climb`, `cruise`, `level_flight`, `descent`, `approach`, `landing`, `landing_roll`, `go_around_climb_candidate`, `airborne_transition`), and save rationale notes.
   - **Model Refinement & Evaluation:** Open the in-app *Refinement & Report* modal or run `python evaluate_manual_tags.py` to evaluate agreement rate, inspect confusion matrices, and view concrete recommendations for tuning heuristic thresholds in `02-Preprocessing/flight_phase.py`.

7. **View static route templates (Alternative legacy viewers):** from `03-Visualization/`, start
   `python -m http.server 8765`, then open either:
   - <http://127.0.0.1:8765/02-session_space_viz.html> for discretized
     `(x, y, z, t)`.
   - <http://127.0.0.1:8765/02-session_space_viz_continuous.html> for
     continuous `(x, y, z)` with discretized `t`.
   - <http://127.0.0.1:8765/03-session_space_viz_phase.html> for the separate
     phase-colored discrete route-template animation.
   - <http://127.0.0.1:8765/03-session_space_viz_continuous_phase.html> for the
     corresponding continuous-coordinate phase animation.

   Both the standard and phase-variant pages keep route groups colored by
   category initially. Click an XY or XYZ template to overlay its segment phases
   and show the path-wide dominant-phase percentage for that group; click empty
   XY space to clear the selection. Segment colors are the local majority among
   group members at the segment midpoint (ties break alphabetically). Segment
   width and brightness now encode the number/share of all filtered sessions
   passing through each short local section, including sessions from other
   full-route groups. Each template interval is split into three short sections;
   a filtered session counts once for a section if a simplified trajectory sample
   lies within half the active template tolerance (at least 1 km). This share is
   normalized by all currently filtered sessions. A spatial index narrows candidate
   checks. The path-wide phase percentage still uses each member's most frequent
   phase over its exported samples.

   Each page fetches its corresponding JSON by default; use its Load button
   if automatic loading fails. Both pages independently group the same filtered
   sessions in XY and XYZ, compare actual shared membership, and animate template
   mean positions in five-second session-relative bins. Origin/destination filters
   use airport codes attached to takeoff/touchdown events; missing event codes are
   left unspecified rather than inferred from endpoint proximity. The Zoom −/+
   buttons adjust both views and preserve Auto frame's live tracking scale; turn
   Auto frame off for manual 3D orbit. The viewer shows export and filter counts,
   including QC-flagged points, without dropping entire sessions for QC flags.

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
