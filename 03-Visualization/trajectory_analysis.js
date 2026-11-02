(function (root) {
  'use strict';

  const TIME_BIN_SECONDS = 5;

  function normalizeTimeline(sessions, pointsKey) {
    return sessions.map((session) => {
      const points = (session[pointsKey] || [])
        .map((point) => point.slice())
        .sort((a, b) => a[3] - b[3]);
      if (points.length) {
        const firstTime = Number(points[0][3]);
        for (const point of points) point[3] = Number(point[3]) - firstTime;
      }
      return { ...session, [pointsKey]: points };
    });
  }

  function simplifyPath(points, projectPoint, dimensions, minimumStep = 0.15) {
    const path = [];
    let last = null;
    let lastSource = null;
    for (const point of points) {
      const projected = projectPoint(point);
      let distanceSquared = 0;
      if (last) {
        for (let axis = 0; axis < dimensions; axis += 1) {
          distanceSquared += (projected[axis] - last[axis]) ** 2;
        }
      }
      if (!last || Math.sqrt(distanceSquared) >= minimumStep) {
        path.push(projected);
        last = projected;
        lastSource = point;
      }
    }
    if (points.length > 1 && lastSource !== points[points.length - 1]) {
      path.push(projectPoint(points[points.length - 1]));
    }
    return path;
  }

  function resamplePath(path, dimensions, count) {
    if (!path.length) return [];
    if (path.length === 1) return Array.from({ length: count }, () => path[0].slice());

    const lengths = [0];
    for (let index = 1; index < path.length; index += 1) {
      let distanceSquared = 0;
      for (let axis = 0; axis < dimensions; axis += 1) {
        distanceSquared += (path[index][axis] - path[index - 1][axis]) ** 2;
      }
      lengths.push(lengths[index - 1] + Math.sqrt(distanceSquared));
    }

    const totalLength = lengths[lengths.length - 1];
    if (totalLength === 0) return Array.from({ length: count }, () => path[0].slice());

    const samples = [];
    for (let sample = 0; sample < count; sample += 1) {
      const target = (totalLength * sample) / (count - 1);
      let index = 1;
      while (index < lengths.length - 1 && lengths[index] < target) index += 1;
      const span = lengths[index] - lengths[index - 1];
      const fraction = span ? (target - lengths[index - 1]) / span : 0;
      samples.push(
        path[index - 1].map(
          (value, axis) => value + fraction * (path[index][axis] - value),
        ),
      );
    }
    return samples;
  }

  function normalizedPhase(value) {
    const phase = String(value ?? '').trim().toLowerCase();
    return phase || 'unknown';
  }

  function dominantValue(values) {
    const counts = new Map();
    for (const value of values) {
      const phase = normalizedPhase(value);
      counts.set(phase, (counts.get(phase) || 0) + 1);
    }
    const ranked = [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
    if (!ranked.length) return { phase: 'unknown', count: 0, total: 0, share: 0 };
    return {
      phase: ranked[0][0],
      count: ranked[0][1],
      total: values.length,
      share: ranked[0][1] / values.length,
    };
  }

  function phaseProfileForSession(
    session,
    {
      pointsKey = 'points',
      timeBinSeconds = TIME_BIN_SECONDS,
      projectPoint = (point) => point,
      dimensions = 3,
      sampleCount = 12,
    } = {},
  ) {
    const points = session[pointsKey] || [];
    const samples = Array.isArray(session.phase_samples) ? session.phase_samples : [];
    const validBinSeconds = Number(timeBinSeconds) > 0 ? Number(timeBinSeconds) : TIME_BIN_SECONDS;
    let pointPhases;

    if (pointsKey === 'points' && samples.length === points.length) {
      pointPhases = samples.map((sample) => normalizedPhase(sample.phase));
    } else {
      const phasesByBin = new Map();
      for (const sample of samples) {
        const seconds = Number(sample.time_s);
        if (!Number.isFinite(seconds)) continue;
        const bin = Math.floor(seconds / validBinSeconds + 1e-9);
        const phases = phasesByBin.get(bin) || [];
        phases.push(normalizedPhase(sample.phase));
        phasesByBin.set(bin, phases);
      }
      pointPhases = points.map((point) => {
        const bin = Math.floor(Number(point[3]) + 1e-9);
        return dominantValue(phasesByBin.get(bin) || []).phase;
      });
    }

    if (!points.length || sampleCount <= 0) {
      return {
        profile: Array.from({ length: Math.max(0, sampleCount) }, () => 'unknown'),
        dominantPhase: dominantValue(samples.map((sample) => sample.phase)).phase,
      };
    }

    const projected = points.map(projectPoint);
    const cumulative = [0];
    for (let index = 1; index < projected.length; index += 1) {
      let distanceSquared = 0;
      for (let axis = 0; axis < dimensions; axis += 1) {
        distanceSquared += (projected[index][axis] - projected[index - 1][axis]) ** 2;
      }
      cumulative.push(cumulative[index - 1] + Math.sqrt(distanceSquared));
    }

    const totalDistance = cumulative[cumulative.length - 1];
    const profile = [];
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const fraction = sampleCount === 1 ? 0 : sample / (sampleCount - 1);
      const target = totalDistance * fraction;
      let right = 1;
      while (right < cumulative.length - 1 && cumulative[right] < target) right += 1;
      const left = Math.max(0, right - 1);
      const nearest = target - cumulative[left] <= cumulative[right] - target ? left : right;
      const index = totalDistance === 0
        ? Math.round(fraction * (points.length - 1))
        : nearest;
      profile.push(pointPhases[index] || 'unknown');
    }

    const sessionPhases = samples.length
      ? samples.map((sample) => normalizedPhase(sample.phase))
      : pointPhases;
    return { profile, dominantPhase: dominantValue(sessionPhases).phase };
  }

  function buildTemplateGroups(
    sessions,
    {
      dimensions,
      tolerance,
      pointsOf,
      projectPoint,
      kindOf = (session) => session.complete_kind,
      sampleCount = 12,
      phaseProfileOf = null,
    },
  ) {
    const groups = [];
    for (const session of sessions) {
      const points = pointsOf(session);
      if (points.length < 2) continue;
      const path = simplifyPath(points, projectPoint, 3);
      if (path.length < 2) continue;
      const profile = resamplePath(path, dimensions, sampleCount);
      const phaseData = phaseProfileOf
        ? phaseProfileOf(session, dimensions, sampleCount)
        : null;
      const phaseProfile = phaseData?.profile || [];
      const phaseSegmentProfile = phaseData?.segmentProfile || null;
      const sessionDominantPhase = normalizedPhase(phaseData?.dominantPhase);
      let best = null;
      let bestScore = Infinity;

      for (const group of groups) {
        if (group.kind !== kindOf(session)) continue;
        const startDistance = Math.hypot(
          ...profile[0].slice(0, dimensions).map((value, axis) => value - group.profile[0][axis]),
        );
        const lastIndex = profile.length - 1;
        const endDistance = Math.hypot(
          ...profile[lastIndex]
            .slice(0, dimensions)
            .map((value, axis) => value - group.profile[lastIndex][axis]),
        );
        if (startDistance > tolerance * 2 || endDistance > tolerance * 2) continue;

        let totalDistance = 0;
        for (let index = 0; index < profile.length; index += 1) {
          totalDistance += Math.hypot(
            ...profile[index]
              .slice(0, dimensions)
              .map((value, axis) => value - group.profile[index][axis]),
          );
        }
        const score = totalDistance / profile.length;
        if (score < bestScore) {
          best = group;
          bestScore = score;
        }
      }

      if (best && bestScore <= tolerance) {
        best.members.push(session);
        if (phaseProfileOf) {
          best.phaseProfiles.push(phaseProfile);
          best.phaseSegmentProfiles.push(phaseSegmentProfile);
          best.memberDominantPhases.push(sessionDominantPhase);
        }
        const memberCount = best.members.length;
        for (let index = 0; index < best.profile.length; index += 1) {
          for (let axis = 0; axis < best.profile[index].length; axis += 1) {
            best.profile[index][axis] +=
              (profile[index][axis] - best.profile[index][axis]) / memberCount;
          }
        }
      } else {
        const group = {
          kind: kindOf(session),
          dimensions,
          members: [session],
          profile: profile.map((point) => point.slice()),
        };
        if (phaseProfileOf) {
          group.phaseProfiles = [phaseProfile];
          group.phaseSegmentProfiles = [phaseSegmentProfile];
          group.memberDominantPhases = [sessionDominantPhase];
        }
        groups.push(group);
      }
    }

    if (phaseProfileOf) {
      for (const group of groups) {
        const segmentCount = Math.max(0, group.phaseProfiles[0]?.length - 1 || 0);
        const hasMidpointProfiles = group.phaseSegmentProfiles.every(Array.isArray);
        group.phaseSegments = Array.from({ length: segmentCount }, (_, index) =>
          dominantValue(
            hasMidpointProfiles
              ? group.phaseSegmentProfiles.map((profile) => normalizedPhase(profile[index]))
              : group.phaseProfiles.map((profile) =>
                  dominantValue([profile[index], profile[index + 1]]).phase,
                ),
          ),
        );
        group.dominantPhase = dominantValue(group.memberDominantPhases);
      }
    }
    return groups;
  }

  function pointSegmentDistanceSquared(point, start, end, dimensions) {
    let lengthSquared = 0;
    let projection = 0;
    for (let axis = 0; axis < dimensions; axis += 1) {
      const delta = end[axis] - start[axis];
      lengthSquared += delta * delta;
      projection += (point[axis] - start[axis]) * delta;
    }
    const fraction = lengthSquared
      ? Math.max(0, Math.min(1, projection / lengthSquared))
      : 0;
    let distanceSquared = 0;
    for (let axis = 0; axis < dimensions; axis += 1) {
      const nearest = start[axis] + fraction * (end[axis] - start[axis]);
      distanceSquared += (point[axis] - nearest) ** 2;
    }
    return distanceSquared;
  }

  function assignSegmentTraffic(
    groups,
    sessions,
    {
      dimensions,
      tolerance,
      pointsOf,
      projectPoint,
      minimumStep = 0.45,
      subdivisions = 3,
    },
  ) {
    if (!groups.length) return groups;
    const dimensionCount = Math.max(2, Math.min(3, Number(dimensions) || 2));
    const cellSize = Math.max(1, (Number(tolerance) || 0) * 0.5);
    const radiusSquared = cellSize * cellSize;
    const segmentSubdivisions = Math.max(1, Math.floor(Number(subdivisions) || 1));
    const sessionPaths = sessions.map((session) =>
      simplifyPath(pointsOf(session), projectPoint, dimensionCount, minimumStep),
    );
    const cells = new Map();

    for (let sessionIndex = 0; sessionIndex < sessionPaths.length; sessionIndex += 1) {
      for (const point of sessionPaths[sessionIndex]) {
        if (!point.slice(0, dimensionCount).every(Number.isFinite)) continue;
        const key = point
          .slice(0, dimensionCount)
          .map((value) => Math.floor(value / cellSize))
          .join(',');
        const entries = cells.get(key) || [];
        entries.push([sessionIndex, point]);
        cells.set(key, entries);
      }
    }

    for (const group of groups) {
      const trafficProfile = [group.profile[0].slice()];
      const trafficSegmentParents = [];
      for (let index = 1; index < group.profile.length; index += 1) {
        const start = group.profile[index - 1];
        const end = group.profile[index];
        for (let part = 1; part <= segmentSubdivisions; part += 1) {
          const fraction = part / segmentSubdivisions;
          trafficProfile.push(
            start.map((value, axis) => value + fraction * (end[axis] - value)),
          );
          trafficSegmentParents.push(index - 1);
        }
      }

      group.trafficProfile = trafficProfile;
      group.trafficSegmentParents = trafficSegmentParents;
      group.segmentTraffic = [];
      for (let index = 1; index < trafficProfile.length; index += 1) {
        const start = trafficProfile[index - 1];
        const end = trafficProfile[index];
        const minimumCell = [];
        const maximumCell = [];
        for (let axis = 0; axis < dimensionCount; axis += 1) {
          minimumCell.push(Math.floor((Math.min(start[axis], end[axis]) - cellSize) / cellSize));
          maximumCell.push(Math.floor((Math.max(start[axis], end[axis]) + cellSize) / cellSize));
        }

        const candidates = new Map();
        const addCell = (coordinates) => {
          const entries = cells.get(coordinates.join(','));
          if (!entries) return;
          for (const [sessionIndex, point] of entries) {
            const points = candidates.get(sessionIndex) || [];
            points.push(point);
            candidates.set(sessionIndex, points);
          }
        };
        for (let x = minimumCell[0]; x <= maximumCell[0]; x += 1) {
          for (let y = minimumCell[1]; y <= maximumCell[1]; y += 1) {
            if (dimensionCount === 2) {
              addCell([x, y]);
              continue;
            }
            for (let z = minimumCell[2]; z <= maximumCell[2]; z += 1) {
              addCell([x, y, z]);
            }
          }
        }

        let count = 0;
        for (const points of candidates.values()) {
          if (points.some((point) =>
            pointSegmentDistanceSquared(point, start, end, dimensionCount) <= radiusSquared,
          )) {
            count += 1;
          }
        }
        group.segmentTraffic.push({
          count,
          total: sessions.length,
          share: sessions.length ? count / sessions.length : 0,
        });
      }
    }
    return groups;
  }

  function findLargestSharedPair(xyGroups, xyzGroups) {
    let largest = { xyGroup: null, xyzGroup: null, sessionIds: [], count: 0 };
    const xyzBySession = new Map();
    for (const xyzGroup of xyzGroups) {
      for (const session of xyzGroup.members) {
        xyzBySession.set(String(session.id), xyzGroup);
      }
    }

    for (const xyGroup of xyGroups) {
      const overlaps = new Map();
      for (const session of xyGroup.members) {
        const id = String(session.id);
        const xyzGroup = xyzBySession.get(id);
        if (!xyzGroup) continue;
        let pair = overlaps.get(xyzGroup);
        if (!pair) {
          pair = { xyGroup, xyzGroup, sessionIds: [], count: 0 };
          overlaps.set(xyzGroup, pair);
        }
        pair.sessionIds.push(id);
        pair.count += 1;
        if (pair.count > largest.count) largest = pair;
      }
    }
    return largest;
  }

  function mergeNearbyMarkers(markers, dimensions, distanceThreshold) {
    const axisCount = dimensions === 3 ? 3 : 2;
    const threshold = Number(distanceThreshold);
    if (!Number.isFinite(threshold) || threshold < 0) return [];

    const candidates = markers
      .filter((marker) =>
        Array.isArray(marker.position) &&
        marker.position.length >= 3 &&
        marker.position.slice(0, 3).every(Number.isFinite) &&
        Number.isFinite(Number(marker.count)) &&
        Number(marker.count) > 0,
      )
      .map((marker) => ({
        position: marker.position.slice(0, 3),
        count: Number(marker.count),
        groupCount: Math.max(1, Number(marker.groupCount) || 1),
        highlighted: Boolean(marker.highlighted),
      }))
      .sort((a, b) => b.count - a.count);
    const thresholdSquared = threshold * threshold;
    const clusters = [];

    for (const marker of candidates) {
      let nearestCluster = null;
      let nearestDistanceSquared = Infinity;
      for (const cluster of clusters) {
        const compatible = cluster.members.every((member) => {
          let distanceSquared = 0;
          for (let axis = 0; axis < axisCount; axis += 1) {
            distanceSquared += (marker.position[axis] - member.position[axis]) ** 2;
          }
          return distanceSquared <= thresholdSquared;
        });
        if (!compatible) continue;

        let centerDistanceSquared = 0;
        for (let axis = 0; axis < axisCount; axis += 1) {
          centerDistanceSquared += (marker.position[axis] - cluster.position[axis]) ** 2;
        }
        if (centerDistanceSquared < nearestDistanceSquared) {
          nearestCluster = cluster;
          nearestDistanceSquared = centerDistanceSquared;
        }
      }

      if (!nearestCluster) {
        clusters.push({
          ...marker,
          members: [marker],
        });
        continue;
      }

      const combinedCount = nearestCluster.count + marker.count;
      nearestCluster.position = nearestCluster.position.map(
        (value, axis) =>
          (value * nearestCluster.count + marker.position[axis] * marker.count) / combinedCount,
      );
      nearestCluster.count = combinedCount;
      nearestCluster.groupCount += marker.groupCount;
      nearestCluster.highlighted ||= marker.highlighted;
      nearestCluster.members.push(marker);
    }

    return clusters.map(({ members, ...cluster }) => cluster);
  }

  function sessionPointCount(session, pointsKey) {
    const explicit = Number(session.n_points ?? session.n_in_sector_points);
    return Number.isFinite(explicit) && explicit >= 0
      ? explicit
      : (session[pointsKey] || []).length;
  }

  function displayedCounts(meta, allSessions, filteredSessions, pointsKey) {
    const sumPoints = (sessions) =>
      sessions.reduce((total, session) => total + sessionPointCount(session, pointsKey), 0);
    const sumQcPoints = (sessions) =>
      sessions.reduce(
        (total, session) => total + Number(session.quality?.quality_flagged_points || 0),
        0,
      );
    const loadedPoints = Number(
      meta.n_in_sector_points ?? meta.n_points ?? sumPoints(allSessions),
    );
    const loadedQcPoints = Number(meta.quality?.flagged_points ?? sumQcPoints(allSessions));
    return {
      loadedSessions: Number(meta.n_sessions ?? allSessions.length),
      loadedPoints,
      loadedQcPoints,
      filteredSessions: filteredSessions.length,
      filteredPoints: sumPoints(filteredSessions),
      filteredQcPoints: sumQcPoints(filteredSessions),
    };
  }

  function formatPlaybackSpeed(rate) {
    return `${Number(rate)}× real time`;
  }

  function advanceTimeline(positionBins, elapsedSeconds, rate, binSeconds = TIME_BIN_SECONDS) {
    return positionBins + (elapsedSeconds * rate) / binSeconds;
  }

  function calculateCameraFraming({
    positions,
    airportPosition = null,
    progress = 0,
    mode = 'cohort',
    baseSpan = 1,
    maxZoom = 12,
  }) {
    const validPositions = positions.filter(
      (position) => position.length >= 3 && position.every(Number.isFinite),
    );
    if (!validPositions.length) return null;

    const centroid = [0, 0, 0];
    const minimum = [Infinity, Infinity];
    const maximum = [-Infinity, -Infinity];
    for (const position of validPositions) {
      for (let axis = 0; axis < 3; axis += 1) centroid[axis] += position[axis];
      for (let axis = 0; axis < 2; axis += 1) {
        minimum[axis] = Math.min(minimum[axis], position[axis]);
        maximum[axis] = Math.max(maximum[axis], position[axis]);
      }
    }
    for (let axis = 0; axis < 3; axis += 1) centroid[axis] /= validPositions.length;

    const safeBaseSpan = Math.max(Number(baseSpan) || 1, 1);
    const safeMaxZoom = Math.max(Number(maxZoom) || 1, 1);
    const activeSpan = Math.max(
      maximum[0] - minimum[0],
      maximum[1] - minimum[1],
      safeBaseSpan / safeMaxZoom,
    );
    const fitZoom = safeBaseSpan / (activeSpan * 1.25);
    const progressValue = Math.max(0, Math.min(1, Number(progress) || 0));
    const easedProgress = progressValue * progressValue * (3 - 2 * progressValue);
    const hasAirport =
      Array.isArray(airportPosition) &&
      airportPosition.length >= 3 &&
      airportPosition.every(Number.isFinite);
    let center = centroid.slice();
    let zoom = Math.max(0.8, Math.min(2.2, fitZoom));

    if (hasAirport && mode === 'arrival') {
      const airportBlend = easedProgress * 0.78;
      center = centroid.map(
        (value, axis) => value + (airportPosition[axis] - value) * airportBlend,
      );
      center[2] = centroid[2] + (airportPosition[2] - centroid[2]) * easedProgress * 0.35;
      zoom = fitZoom * (1 + 2.2 * easedProgress);
    } else if (hasAirport && mode === 'departure') {
      center = centroid.map(
        (value, axis) => airportPosition[axis] + (value - airportPosition[axis]) * easedProgress,
      );
      zoom = fitZoom / (1 + 3 * easedProgress);
    }

    const minimumZoom = hasAirport && mode === 'departure' ? 0.35 : 0.8;
    return {
      center,
      zoom: Math.max(minimumZoom, Math.min(safeMaxZoom, zoom)),
      mode: hasAirport ? mode : 'cohort',
    };
  }

  const api = {
    TIME_BIN_SECONDS,
    advanceTimeline,
    assignSegmentTraffic,
    buildTemplateGroups,
    calculateCameraFraming,
    displayedCounts,
    dominantValue,
    findLargestSharedPair,
    formatPlaybackSpeed,
    mergeNearbyMarkers,
    normalizeTimeline,
    phaseProfileForSession,
    resamplePath,
    sessionPointCount,
    simplifyPath,
  };

  root.TrajectoryAnalysis = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
