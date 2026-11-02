'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  advanceTimeline,
  buildTemplateGroups,
  calculateCameraFraming,
  displayedCounts,
  findLargestSharedPair,
  formatPlaybackSpeed,
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
