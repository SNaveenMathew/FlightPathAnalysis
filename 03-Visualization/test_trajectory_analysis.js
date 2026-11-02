'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  advanceTimeline,
  assignSegmentTraffic,
  buildTemplateGroups,
  calculateCameraFraming,
  displayedCounts,
  findLargestSharedPair,
  formatPlaybackSpeed,
  mergeNearbyMarkers,
  normalizeTimeline,
  phaseProfileForSession,
} = require('./trajectory_analysis.js');

test('shared membership is calculated from session IDs, not group IDs', () => {
  const xy = [
    { id: 'same-group-number', members: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
    { id: 'other', members: [{ id: 'd' }, { id: 'e' }] },
  ];
  const xyz = [
    { id: 'same-group-number', members: [{ id: 'a' }, { id: 'e' }] },
    { id: 'different-group-number', members: [{ id: 'b' }, { id: 'c' }, { id: 'd' }] },
  ];

  const largest = findLargestSharedPair(xy, xyz);

  assert.equal(largest.count, 2);
  assert.deepEqual(largest.sessionIds.sort(), ['b', 'c']);
  assert.equal(largest.xyGroup, xy[0]);
  assert.equal(largest.xyzGroup, xyz[1]);
});

test('nearby active marker counts merge with a weighted position', () => {
  const merged = mergeNearbyMarkers(
    [
      { position: [0, 0, 2], count: 3, highlighted: true },
      { position: [4, 0, 6], count: 5 },
      { position: [40, 0, 12], count: 2 },
    ],
    2,
    6,
  );

  assert.equal(merged.length, 2);
  assert.equal(merged[0].count, 8);
  assert.equal(merged[0].groupCount, 2);
  assert.deepEqual(merged[0].position, [2.5, 0, 4.5]);
  assert.equal(merged[0].highlighted, true);
  assert.equal(merged[1].count, 2);
});

test('marker merging avoids chaining a distant route through an intermediate group', () => {
  const merged = mergeNearbyMarkers(
    [
      { position: [0, 0, 0], count: 20 },
      { position: [4, 0, 0], count: 10 },
      { position: [8, 0, 0], count: 1 },
    ],
    2,
    5,
  );

  assert.deepEqual(merged.map((marker) => marker.count), [30, 1]);
});

test('XYZ marker merging respects altitude while XY can merge crossing positions', () => {
  const markers = [
    { position: [0, 0, 0], count: 3 },
    { position: [0, 0, 8], count: 4 },
  ];

  assert.equal(mergeNearbyMarkers(markers, 2, 6)[0].count, 7);
  assert.equal(mergeNearbyMarkers(markers, 3, 6).length, 2);
});

test('timeline normalization starts each session at its first retained point', () => {
  const normalized = normalizeTimeline(
    [
      { id: 'a', points: [[1, 2, 3, 7], [4, 5, 6, 3], [7, 8, 9, 11]] },
      { id: 'b', points: [[1, 1, 1, 21], [2, 2, 2, 25]] },
    ],
    'points',
  );

  assert.deepEqual(normalized[0].points.map((point) => point[3]), [0, 4, 8]);
  assert.deepEqual(normalized[1].points.map((point) => point[3]), [0, 4]);
  assert.deepEqual(normalized[0].points[0].slice(0, 3), [4, 5, 6]);
});

test('playback speed labels match real-time advancement and five-second bins', () => {
  assert.equal(formatPlaybackSpeed(16), '16× real time');
  assert.equal(advanceTimeline(0, 1, 16, 5), 3.2);
  assert.equal(advanceTimeline(0, 0.25, 16, 5) * 5, 4);
});

test('arrival framing starts with aircraft and moves toward the selected airport', () => {
  const positions = [[-30, 0, 8], [30, 0, 6]];
  const airportPosition = [0, 0, 0];
  const start = calculateCameraFraming({
    positions,
    airportPosition,
    progress: 0,
    mode: 'arrival',
    baseSpan: 100,
  });
  const end = calculateCameraFraming({
    positions: [[-1, 0, 2], [1, 0, 1]],
    airportPosition,
    progress: 1,
    mode: 'arrival',
    baseSpan: 100,
  });

  assert.deepEqual(start.center, [0, 0, 7]);
  assert.ok(end.center[2] < start.center[2]);
  assert.ok(end.zoom > start.zoom);
});

test('departure framing starts at the origin and zooms out with progress', () => {
  const airportPosition = [0, 0, 0];
  const start = calculateCameraFraming({
    positions: [[-2, 0, 0], [2, 0, 0]],
    airportPosition,
    progress: 0,
    mode: 'departure',
    baseSpan: 100,
  });
  const end = calculateCameraFraming({
    positions: [[-30, 0, 10], [30, 0, 20]],
    airportPosition,
    progress: 1,
    mode: 'departure',
    baseSpan: 100,
  });

  assert.deepEqual(start.center, airportPosition);
  assert.deepEqual(end.center, [0, 0, 15]);
  assert.ok(end.zoom < start.zoom);
  assert.ok(end.zoom < 0.8, 'departure framing should continue zooming out beyond the cohort minimum');
});

test('broad cohorts use bounded framing when airports are not singularly selected', () => {
  const frame = calculateCameraFraming({
    positions: [[-100, -40, 5], [100, 40, 10]],
    progress: 0.7,
    baseSpan: 200,
    maxZoom: 12,
  });

  assert.equal(frame.mode, 'cohort');
  assert.ok(frame.zoom <= 2.2);
});

test('displayed counts use export totals and current-filter session counts', () => {
  const sessions = [
    { n_points: 20, quality: { quality_flagged_points: 2 } },
    { n_points: 15, quality: { quality_flagged_points: 0 } },
    { n_points: 65, quality: { quality_flagged_points: 5 } },
  ];
  const counts = displayedCounts(
    { n_sessions: 3, n_in_sector_points: 100, quality: { flagged_points: 7 } },
    sessions,
    sessions.slice(0, 2),
    'points',
  );

  assert.deepEqual(counts, {
    loadedSessions: 3,
    loadedPoints: 100,
    loadedQcPoints: 7,
    filteredSessions: 2,
    filteredPoints: 35,
    filteredQcPoints: 2,
  });
});

test('continuous phase profiles follow route position and session-majority phase', () => {
  const session = {
    points: [[0, 0, 0, 0], [1, 0, 0, 1], [2, 0, 0, 2], [3, 0, 0, 3]],
    phase_samples: [
      { phase: 'climb' },
      { phase: 'climb' },
      { phase: 'cruise' },
      { phase: 'descent' },
    ],
  };

  const phaseData = phaseProfileForSession(session, {
    pointsKey: 'points',
    projectPoint: (point) => point.slice(0, 3),
    dimensions: 3,
    sampleCount: 4,
  });

  assert.deepEqual(phaseData.profile, ['climb', 'climb', 'cruise', 'descent']);
  assert.equal(phaseData.dominantPhase, 'climb');
});

test('discrete phase samples vote within their exported time bins', () => {
  const session = {
    occ: [[0, 0, 0, 0], [1, 0, 0, 1]],
    phase_samples: [
      { time_s: 0.1, phase: 'climb' },
      { time_s: 4.7, phase: 'climb' },
      { time_s: 5.2, phase: 'descent' },
      { time_s: 9.8, phase: 'descent' },
    ],
  };

  const phaseData = phaseProfileForSession(session, {
    pointsKey: 'occ',
    timeBinSeconds: 5,
    projectPoint: (point) => point.slice(0, 3),
    dimensions: 3,
    sampleCount: 2,
  });

  assert.deepEqual(phaseData.profile, ['climb', 'descent']);
  assert.equal(phaseData.dominantPhase, 'climb');
});

test('group segment colors and clicked-path phase share are recomputed from members', () => {
  const makeSession = (id, y, phases) => ({
    id,
    complete_kind: 'arrival',
    points: [[0, y, 0, 0], [1, y, 0, 1], [2, y, 0, 2], [3, y, 0, 3]],
    phase_samples: phases.map((phase) => ({ phase })),
  });
  const sessions = [
    makeSession('a', 0, ['climb', 'climb', 'cruise', 'descent']),
    makeSession('b', 0.01, ['climb', 'descent', 'descent', 'descent']),
    makeSession('c', 20, ['approach', 'approach', 'approach', 'landing']),
  ];

  const groups = buildTemplateGroups(sessions, {
    dimensions: 2,
    tolerance: 1,
    pointsOf: (session) => session.points,
    projectPoint: (point) => point.slice(0, 3),
    sampleCount: 4,
    phaseProfileOf: (session, dimensions, sampleCount) =>
      phaseProfileForSession(session, {
        pointsKey: 'points',
        projectPoint: (point) => point.slice(0, 3),
        dimensions,
        sampleCount,
      }),
  });

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].dominantPhase, {
    phase: 'climb',
    count: 1,
    total: 2,
    share: 0.5,
  });
  assert.equal(groups[0].phaseSegments.length, 3);
  assert.deepEqual(groups[0].phaseSegments[0], {
    phase: 'climb',
    count: 2,
    total: 2,
    share: 1,
  });

  const broaderGroups = buildTemplateGroups(sessions, {
    dimensions: 2,
    tolerance: 25,
    pointsOf: (session) => session.points,
    projectPoint: (point) => point.slice(0, 3),
    sampleCount: 4,
    phaseProfileOf: (session, dimensions, sampleCount) =>
      phaseProfileForSession(session, {
        pointsKey: 'points',
        projectPoint: (point) => point.slice(0, 3),
        dimensions,
        sampleCount,
      }),
  });
  assert.equal(broaderGroups.length, 1);
  assert.equal(broaderGroups[0].dominantPhase.total, 3);
});

test('local section support counts distinct sessions across different full routes', () => {
  const sessions = [
    { id: 'arrival', points: [[0, 0, 0, 0], [5, 0, 0, 1], [10, 0, 0, 2]] },
    { id: 'departure', points: [[0, 10, 0, 0], [5, 10, 0, 1], [10, 0, 0, 2]] },
    { id: 'local-crossing', points: [[5.2, 0.2, 0, 0], [7, 0.2, 0, 1], [9.8, 0.2, 0, 2]] },
  ];
  const groups = [
    { members: [sessions[0]], profile: [[0, 0, 0], [5, 0, 0], [10, 0, 0]] },
    { members: [sessions[1]], profile: [[0, 10, 0], [5, 10, 0], [10, 0, 0]] },
  ];

  assignSegmentTraffic(groups, sessions, {
    dimensions: 2,
    tolerance: 2,
    pointsOf: (session) => session.points,
    projectPoint: (point) => point.slice(0, 3),
    subdivisions: 3,
  });

  assert.equal(groups[0].trafficProfile.length, 7);
  assert.deepEqual(groups[0].trafficSegmentParents, [0, 0, 0, 1, 1, 1]);
  assert.equal(groups[0].segmentTraffic[0].count, 1);
  assert.equal(groups[0].segmentTraffic[0].total, 3);
  assert.equal(groups[0].segmentTraffic[0].share, 1 / 3);
  assert.equal(groups[0].segmentTraffic[5].count, 3);
  assert.equal(groups[0].segmentTraffic[5].share, 1);
});

test('XYZ local section support respects altitude while XY support does not', () => {
  const sessions = [0, 5].map((altitude, index) => ({
    id: `altitude-${index}`,
    points: [[0, 0, altitude, 0], [5, 0, altitude, 1], [10, 0, altitude, 2]],
  }));
  const makeGroup = () => [{ profile: [[0, 0, 0], [10, 0, 0]] }];
  const options = {
    tolerance: 4,
    pointsOf: (session) => session.points,
    projectPoint: (point) => point.slice(0, 3),
  };
  const xyGroups = makeGroup();
  const xyzGroups = makeGroup();

  assignSegmentTraffic(xyGroups, sessions, { ...options, dimensions: 2 });
  assignSegmentTraffic(xyzGroups, sessions, { ...options, dimensions: 3 });

  assert.equal(xyGroups[0].segmentTraffic[0].count, 2);
  assert.equal(xyzGroups[0].segmentTraffic[0].count, 1);
});

test('template segment votes use midpoint phase profiles when supplied', () => {
  const sessions = ['a', 'b'].map((id) => ({
    id,
    complete_kind: 'departure',
    points: [[0, 0, 0, 0], [1, 0, 0, 1]],
  }));
  const groups = buildTemplateGroups(sessions, {
    dimensions: 2,
    tolerance: 1,
    pointsOf: (session) => session.points,
    projectPoint: (point) => point.slice(0, 3),
    sampleCount: 2,
    phaseProfileOf: () => ({
      profile: ['climb', 'descent'],
      segmentProfile: ['descent'],
      dominantPhase: 'descent',
    }),
  });

  assert.equal(groups[0].phaseSegments[0].phase, 'descent');
  assert.equal(groups[0].phaseSegments[0].share, 1);
});
