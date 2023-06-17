ground_dist <- function(row) {
  lon_start <- row["last_lon"]
  lat_start <- row["last_lat"]
  lon_end <- row["lon"]
  lat_end <- row["lat"]
  distm (c(lat_start, lon_start), c(lat_end, lon_end), fun = distHaversine)
}

visualize_map <- function(ac_df, world, color_var = "id", sampl = T,
                          min_lon = NULL, max_lon = NULL, min_lat = NULL, max_lat = NULL) {
    ac_df$num_id <- as.integer(as.factor(ac_df$id))
    ac_df <- split(ac_df, ac_df$num_id)
    if(sampl)
      ac_df <- ac_df[sample(x = 1:length(ac_df), size = n_aircraft, replace = F)]
    ac_df <- do.call(rbind, ac_df)
    ac_df <- ac_df[order(ac_df$ts), ]
    p <- ggplot() +
      geom_sf(data = world) +
      coord_sf(xlim = c(min_lon, max_lon), ylim = c(min_lat, max_lat), expand = F) +
      geom_path(data = ac_df, arrow = arrow(type = "closed", angle = 18,
                                            length = unit(0.1, "inches")),
                aes(x = lon, y = lat, frame = ts, color = id)) +
      xlim(c(min_lon, max_lon)) +
      ylim(c(min_lat, max_lat))
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
