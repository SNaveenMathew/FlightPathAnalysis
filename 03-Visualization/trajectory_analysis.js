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

  function buildTemplateGroups(
    sessions,
    { dimensions, tolerance, pointsOf, projectPoint, kindOf = (session) => session.complete_kind, sampleCount = 12 },
  ) {
    const groups = [];
    for (const session of sessions) {
      const points = pointsOf(session);
      if (points.length < 2) continue;
      const path = simplifyPath(points, projectPoint, 3);
      if (path.length < 2) continue;
      const profile = resamplePath(path, dimensions, sampleCount);
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
        const memberCount = best.members.length;
        for (let index = 0; index < best.profile.length; index += 1) {
          for (let axis = 0; axis < best.profile[index].length; axis += 1) {
            best.profile[index][axis] +=
              (profile[index][axis] - best.profile[index][axis]) / memberCount;
          }
        }
      } else {
        groups.push({
          kind: kindOf(session),
          dimensions,
          members: [session],
          profile: profile.map((point) => point.slice()),
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

  const api = {
    TIME_BIN_SECONDS,
    advanceTimeline,
    buildTemplateGroups,
    displayedCounts,
    findLargestSharedPair,
    formatPlaybackSpeed,
    normalizeTimeline,
    resamplePath,
    sessionPointCount,
    simplifyPath,
  };

  root.TrajectoryAnalysis = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
