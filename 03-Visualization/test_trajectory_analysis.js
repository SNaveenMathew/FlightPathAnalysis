'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  advanceTimeline,
  displayedCounts,
  findLargestSharedPair,
  formatPlaybackSpeed,
  normalizeTimeline,
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
