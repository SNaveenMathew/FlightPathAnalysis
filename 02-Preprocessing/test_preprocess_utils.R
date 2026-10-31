suppressPackageStartupMessages({
  library(data.table)
  library(geosphere)
})

source("02-Preprocessing/preprocess_utils.R")

track <- data.table(
  aircraft = rep("TEST01", 6),
  ts = c(100000, 110000, 120000, 130000, 140000, 400000),
  lon = c(-74.00, -73.99, -73.98, -73.00, -73.97, -73.96),
  lat = rep(40, 6),
  altitude_raw_ft = c(1000, 1000, 1200, 20000, 1200, 1300),
  altitude = c(1000, 1000, 1200, 20000, 1200, 1300),
  ground_speed = rep(200, 6)
)

annotated <- annotate_track_quality(track)
stopifnot(nrow(annotated) == nrow(track))
stopifnot(annotated$track_gap_flag[6])
stopifnot(annotated$track_segment_index[5] == 1L)
stopifnot(annotated$track_segment_index[6] == 2L)
stopifnot(annotated$position_jump_suspect_flag[4])
stopifnot(annotated$altitude_spike_suspect_flag[4])
stopifnot(annotated$altitude_phase_ft[4] == 1200)
stopifnot(annotated$altitude_raw_ft[4] == 20000)
stopifnot(annotated$altitude_rate_fpm[3] == 1200)
stopifnot(is.na(annotated$altitude_rate_fpm[6]))
stopifnot(all(annotated$quality_flag_count >= 0L))

ground_sample <- data.table(
  aircraft = "TEST02", ts = 100000, lon = -74, lat = 40,
  altitude_raw_ft = NA_real_, altitude = 0, ground_speed = 0,
  ground_flag = TRUE
)
ground_qc <- annotate_track_quality(ground_sample)
stopifnot(!ground_qc$altitude_invalid_flag)
stopifnot(ground_qc$altitude_phase_ft == 0)

touchdown_track <- data.table(
  aircraft = "TEST03",
  ts = seq(100000, 150000, by = 10000),
  altitude_phase_ft = c(0, 5000, 9000, 10000, 0, 5000),
  touchdown = c(FALSE, FALSE, FALSE, TRUE, FALSE, TRUE)
)
touchdown_summary <- annotate_touchdown_segments(touchdown_track)
stopifnot(touchdown_summary$max_alt_touchdown_seg[4] == 10000)
stopifnot(touchdown_summary$max_alt_touchdown_seg[6] == 5000)

# Haversine inputs are (longitude, latitude), and distances are metres.
distance_m <- ground_dist(list(
  last_lon = -74.00, last_lat = 40,
  lon = -73.99, lat = 40
))
stopifnot(is.finite(distance_m), distance_m > 800, distance_m < 900)
speed_kts <- ground_speed_knots(distance_m = 1000, delta_ms = 1000)
stopifnot(is.finite(speed_kts), speed_kts > 1900, speed_kts < 2000)
stopifnot(is.na(ground_speed_knots(distance_m = 1000, delta_ms = 0)))

cat("preprocess utility tests passed\n")
