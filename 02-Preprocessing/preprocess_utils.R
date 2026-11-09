ground_dist <- function(row) {
  lon_start <- suppressWarnings(as.numeric(row["last_lon"]))
  lat_start <- suppressWarnings(as.numeric(row["last_lat"]))
  lon_end <- suppressWarnings(as.numeric(row["lon"]))
  lat_end <- suppressWarnings(as.numeric(row["lat"]))
  if (!all(is.finite(c(lon_start, lat_start, lon_end, lat_end)))) {
    return(NA_real_)
  }
  geosphere::distHaversine(c(lon_start, lat_start), c(lon_end, lat_end))
}

ground_speed_knots <- function(distance_m, delta_ms) {
  distance_m <- suppressWarnings(as.numeric(distance_m))
  delta_ms <- suppressWarnings(as.numeric(delta_ms))
  if (length(distance_m) == 0L && length(delta_ms) == 0L) return(numeric(0))
  if (length(distance_m) == 0L || length(delta_ms) == 0L) {
    stop("distance_m and delta_ms must both be empty or non-empty")
  }
  if (length(distance_m) != length(delta_ms) &&
      length(distance_m) != 1L && length(delta_ms) != 1L) {
    stop("distance_m and delta_ms must have equal lengths or length one")
  }
  n <- max(length(distance_m), length(delta_ms))
  if (n == 0L) return(numeric(0))
  distance_m <- rep_len(distance_m, n)
  delta_ms <- rep_len(delta_ms, n)
  result <- rep(NA_real_, n)
  valid <- is.finite(distance_m) & is.finite(delta_ms) & delta_ms > 0
  result[valid] <- distance_m[valid] / (delta_ms[valid] / 1000) / 0.514444
  result
}

annotate_track_quality <- function(ac_df,
                                   max_track_gap_sec = 120,
                                   max_position_speed_kts = 900,
                                   max_vertical_rate_fpm = 12000,
                                   altitude_bounds_ft = c(-2000, 60000),
                                   altitude_spike_delta_ft = 3000,
                                   altitude_neighbor_tolerance_ft = 2000) {
  if (!requireNamespace("data.table", quietly = TRUE)) {
    stop("annotate_track_quality() requires data.table")
  }
  if (!requireNamespace("geosphere", quietly = TRUE)) {
    stop("annotate_track_quality() requires geosphere")
  }
  if (length(altitude_bounds_ft) != 2L ||
      !all(is.finite(altitude_bounds_ft)) ||
      altitude_bounds_ft[1L] >= altitude_bounds_ft[2L]) {
    stop("altitude_bounds_ft must be an increasing pair of finite values")
  }
  thresholds <- c(max_track_gap_sec, max_position_speed_kts,
                  max_vertical_rate_fpm, altitude_spike_delta_ft,
                  altitude_neighbor_tolerance_ft)
  if (!all(is.finite(thresholds)) || any(thresholds <= 0)) {
    stop("Quality thresholds must be positive and finite")
  }
  if (!all(c("aircraft", "ts") %in% names(ac_df))) {
    stop("ac_df must contain aircraft and ts columns")
  }

  out <- if (data.table::is.data.table(ac_df)) ac_df else data.table::as.data.table(ac_df)
  for (column in c("lon", "lat", "altitude_raw_ft", "altitude", "ground_speed")) {
    if (!column %in% names(out)) out[, (column) := NA_real_]
  }
  if (!"ground_flag" %in% names(out)) out[, ground_flag := FALSE]
  altitude_column <- if ("altitude_raw_ft" %in% names(ac_df)) {
    "altitude_raw_ft"
  } else {
    "altitude"
  }
  to_num <- function(x) {
    if (is.numeric(x)) as.numeric(x)
    else if (is.factor(x)) suppressWarnings(as.numeric(as.character(x)))
    else suppressWarnings(as.numeric(x))
  }
  out[, .qc_ts_ms := to_num(ts)]
  out[, .qc_lon := to_num(lon)]
  out[, .qc_lat := to_num(lat)]
  out[, .qc_alt_ft := to_num(get(altitude_column))]
  out[, .qc_ground := !is.na(ground_flag) & as.logical(ground_flag)]
  out[.qc_ground & !is.finite(.qc_alt_ft), .qc_alt_ft := 0]

  data.table::setorderv(out, c("aircraft", ".qc_ts_ms"), na.last = TRUE)

  max_gap_ms <- max_track_gap_sec * 1000
  out[, sample_gap_ms := c(NA_real_, diff(.qc_ts_ms)), by = aircraft]
  out[, track_gap_flag := is.finite(sample_gap_ms) & sample_gap_ms > max_gap_ms]
  out[, .qc_new_segment := !is.finite(sample_gap_ms) | sample_gap_ms > max_gap_ms]
  out[, track_segment_index := cumsum(.qc_new_segment), by = aircraft]
  out[, track_segment_id := ifelse(
    is.na(aircraft), NA_character_,
    paste0(as.character(aircraft), "_T", track_segment_index)
  )]

  out[, position_invalid_flag :=
        !is.finite(.qc_lon) | !is.finite(.qc_lat) |
        .qc_lon < -180 | .qc_lon > 180 | .qc_lat < -90 | .qc_lat > 90]
  out[, altitude_invalid_flag := !is.finite(.qc_alt_ft) & !.qc_ground]
  out[, altitude_range_flag := is.finite(.qc_alt_ft) &
        (.qc_alt_ft < altitude_bounds_ft[1L] |
         .qc_alt_ft > altitude_bounds_ft[2L])]

  out[, `:=`(
    .qc_prev_lon = data.table::shift(.qc_lon),
    .qc_prev_lat = data.table::shift(.qc_lat),
    .qc_prev_alt_ft = data.table::shift(.qc_alt_ft),
    .qc_prev_segment = data.table::shift(track_segment_index),
    .qc_next_alt_ft = data.table::shift(.qc_alt_ft, type = "lead"),
    .qc_next_segment = data.table::shift(track_segment_index, type = "lead"),
    .qc_next_gap_ms = data.table::shift(sample_gap_ms, type = "lead")
  ), by = aircraft]

  same_segment_as_previous <- out$track_segment_index == out$.qc_prev_segment
  valid_position_pair <- is.finite(out$sample_gap_ms) & out$sample_gap_ms > 0 &
    same_segment_as_previous & !out$position_invalid_flag &
    is.finite(out$.qc_prev_lon) & is.finite(out$.qc_prev_lat)
  distance_m <- rep(NA_real_, nrow(out))
  pair_rows <- which(valid_position_pair)
  if (length(pair_rows) > 0L) {
    distance_m[pair_rows] <- geosphere::distHaversine(
      cbind(out$.qc_prev_lon[pair_rows], out$.qc_prev_lat[pair_rows]),
      cbind(out$.qc_lon[pair_rows], out$.qc_lat[pair_rows])
    )
  }
  out[, position_speed_knots :=
        distance_m / (sample_gap_ms / 1000) / 0.514444]
  out[, altitude_rate_fpm :=
        60 * (.qc_alt_ft - .qc_prev_alt_ft) / (sample_gap_ms / 1000)]
  out[!is.finite(sample_gap_ms) | sample_gap_ms <= 0 |
        sample_gap_ms > max_gap_ms | track_segment_index != .qc_prev_segment,
      altitude_rate_fpm := NA_real_]
  out[, position_jump_suspect_flag :=
        is.finite(position_speed_knots) &
        position_speed_knots > max_position_speed_kts &
        sample_gap_ms <= max_gap_ms]
  out[, altitude_jump_suspect_flag :=
        is.finite(altitude_rate_fpm) &
        abs(altitude_rate_fpm) > max_vertical_rate_fpm &
        sample_gap_ms <= max_gap_ms]
  out[, altitude_spike_suspect_flag :=
        is.finite(.qc_alt_ft) & is.finite(.qc_prev_alt_ft) &
        is.finite(.qc_next_alt_ft) &
        track_segment_index == .qc_prev_segment &
        track_segment_index == .qc_next_segment &
        sample_gap_ms <= max_gap_ms & .qc_next_gap_ms <= max_gap_ms &
        abs(.qc_prev_alt_ft - .qc_next_alt_ft) <= altitude_neighbor_tolerance_ft &
        abs(.qc_alt_ft - (.qc_prev_alt_ft + .qc_next_alt_ft) / 2) >=
          altitude_spike_delta_ft]
  out[, altitude_phase_ft := .qc_alt_ft]
  out[altitude_spike_suspect_flag == TRUE,
      altitude_phase_ft := (.qc_prev_alt_ft + .qc_next_alt_ft) / 2]

  flag_columns <- c(
    "track_gap_flag", "position_invalid_flag", "altitude_invalid_flag",
    "altitude_range_flag", "position_jump_suspect_flag",
    "altitude_jump_suspect_flag", "altitude_spike_suspect_flag"
  )
  out[, quality_flag_count := rowSums(.SD), .SDcols = flag_columns]
  out[, c(".qc_ts_ms", ".qc_lon", ".qc_lat", ".qc_alt_ft",
          ".qc_ground", ".qc_new_segment", ".qc_prev_lon",
          ".qc_prev_lat", ".qc_prev_alt_ft", ".qc_prev_segment",
          ".qc_next_alt_ft", ".qc_next_segment", ".qc_next_gap_ms") := NULL]
  out
}

annotate_touchdown_segments <- function(ac_df) {
  if (!requireNamespace("data.table", quietly = TRUE)) {
    stop("annotate_touchdown_segments() requires data.table")
  }
  if (!all(c("aircraft", "ts", "touchdown") %in% names(ac_df))) {
    stop("ac_df must contain aircraft, ts, and touchdown columns")
  }
  altitude_column <- if ("altitude_phase_ft" %in% names(ac_df)) {
    "altitude_phase_ft"
  } else if ("altitude" %in% names(ac_df)) {
    "altitude"
  } else {
    stop("ac_df must contain altitude_phase_ft or altitude")
  }

  out <- if (data.table::is.data.table(ac_df)) ac_df else data.table::as.data.table(ac_df)
  out[, .touchdown_event := !is.na(touchdown) & as.logical(touchdown)]
  out[, touchdown_id := cumsum(.touchdown_event), by = aircraft]
  out[, touchdown_leg_id := touchdown_id - as.integer(.touchdown_event), by = aircraft]
  out[, max_touchdown := max(touchdown_id), by = aircraft]
  out[, max_alt_touchdown_seg := suppressWarnings(
    max(get(altitude_column), na.rm = TRUE)
  ), by = .(aircraft, touchdown_leg_id)]
  out[!is.finite(max_alt_touchdown_seg), max_alt_touchdown_seg := NA_real_]
  out[, c(".touchdown_event") := NULL]
  out
}

visualize_map <- function(ac_df, a_region, color_var = "id", sampl = T,
                          min_lon = NULL, max_lon = NULL, min_lat = NULL, max_lat = NULL) {
    ac_df$id <- sapply(strsplit(ac_df$aircraft_session_id, "_S"), function(x) x[2])
    ac_df$num_id <- as.numeric(ac_df$id)
    ac_df <- split(ac_df, ac_df$num_id)
    if(sampl)
      ac_df <- ac_df[sample(x = 1:length(ac_df), size = n_aircraft, replace = F)]
    ac_df <- do.call(rbind, ac_df)
    ac_df <- ac_df[order(ac_df$ts), ]
    p <- ggplot() +
      ggplot2::geom_polygon(data = a_region, aes(x = long, y = lat, group = group),
                            fill = "white", color = "black") +
      ggplot2::coord_quickmap(xlim = c(min_lon, max_lon), ylim = c(min_lat, max_lat), expand = FALSE) +
      ggplot2::geom_path(data = ac_df, arrow = arrow(type = "closed", angle = 18,
                                                     length = unit(0.1, "inches")),
                         aes(x = lon, y = lat, color = id))
    return(p)
}

plot_aircraft_ids <- function(jfk_data1, a_region, min_lon, min_lat, max_lon, max_lat) {
  plot_ids <- function(uniq_id) {
    for(id1 in uniq_id) {
      ac_df <- jfk_data1[jfk_data1$aircraft == id1, ]
      tryCatch({
        p <- visualize_map(ac_df, a_region = a_region, sampl = F, min_lon = min_lon,
                           max_lon = max_lon, min_lat = min_lat, max_lat = max_lat)
        png(paste0(id1, ".png"), width = 1366, height = 768)
        print(p)
        dev.off()
      }, error = function(e) NULL)
    }
    setwd("../")
  }
  return(plot_ids)
}

# +
most_frequent <- function(x, n = 1) {
    tbl <- table(x)
    tbl <- tbl[order(tbl, decreasing = T)]
    return(names(tbl)[n])
}

most_frequent_percent <- function(x, n = 1) {
    tbl <- table(x)
    tbl <- tbl[order(tbl, decreasing = T)]
    return(tbl[n] / length(x))
}
# -

# plot_ac_instances <- function(landing_ac_data, wd = "clean_landed_id") {
#   setwd(wd)
#   uniq_aircraft <- unique(landing_ac_data$aircraft)
#   plot_ids <- plot_aircraft_ids(jfk_data1 = landing_ac_data, a_region = )
#   plot_ids(uniq_id = uniq_aircraft)
# }
