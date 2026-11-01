(() => {
  'use strict';

  const Analysis = window.TrajectoryAnalysis;
  const mode = document.body.dataset.mode;
  const continuous = mode === 'continuous';
  const pointsKey = continuous ? 'points' : 'occ';
  const map = document.getElementById('map');
  const mapContext = map.getContext('2d');
  const mapBase = document.createElement('canvas');
  const baseContext = mapBase.getContext('2d');
  const slider = document.getElementById('scrubber');
  const timeLabel = document.getElementById('time');
  const status = document.getElementById('status');
  const speedNote = document.getElementById('speed-note');
  const summary = document.getElementById('dataset-summary');
  const groupingSummary = document.getElementById('grouping-summary');
  const edgeNote = document.getElementById('edge-note');
  const qualityNote = document.getElementById('quality-note');
  const sourceFilter = document.getElementById('source-airport');
  const destinationFilter = document.getElementById('destination-airport');
  const toleranceSelector = document.querySelector('#route-tolerance, #tolerance');
  const kindInputs = [...document.querySelectorAll('#filters input[data-kind]')];
  const state = { t: 0, max: 0, speed: 4, playing: false, lastFrame: 0 };
  const sessions = [];
  const categoryColors = {
    arrival: '#4ecdc4',
    departure: '#f5a65b',
    local: '#c792ea',
    transit: '#70a1ff',
  };
  const gold = '#f4c542';
  let timeBinSeconds = Analysis.TIME_BIN_SECONDS;
  let metadata = {};
  let sector = { lon_min: -78, lon_max: -68, lat_min: 35, lat_max: 45 };
  let bins = { dx: 0.05, dy: 0.05, dz: 500, dt: timeBinSeconds };
  let origin = { lon: -73, lat: 40 };
  let kmPerLon = 111.32 * Math.cos((origin.lat * Math.PI) / 180);
  const kmPerLat = 111.32;
  let geoBounds = { lonMin: -78, lonMax: -68, latMin: 35, latMax: 45 };
  let worldBounds = null;
  let renderer;
  let scene;
  let camera;
  let orbit;
  let trackObject;
  let routeObject;
  let sharedObject;
  let markerObject;
  let xyGroups = [];
  let xyzGroups = [];
  let sharedPair = { xyGroup: null, xyzGroup: null, sessionIds: [], count: 0 };

  function categoryColor(kind) {
    return categoryColors[kind] || '#70a1ff';
  }

  function markerColor(altitudeFeet) {
    const stops = [
      [0, [59, 130, 246]],
      [8000, [6, 182, 212]],
      [18000, [34, 197, 128]],
      [28000, [234, 179, 8]],
      [36000, [249, 115, 22]],
      [42000, [239, 68, 68]],
    ];
    const altitude = Math.max(0, Math.min(42000, altitudeFeet));
    let index = stops.findIndex((stop) => stop[0] >= altitude);
    if (index < 1) index = 1;
    const [low, high] = [stops[index - 1], stops[index]];
    const fraction = (altitude - low[0]) / (high[0] - low[0]);
    return low[1].map((value, axis) =>
      Math.round(value + fraction * (high[1][axis] - value)),
    );
  }

  function sessionPoints(session) {
    return session[pointsKey] || [];
  }

  function pointGeo(point) {
    if (continuous) return { lon: point[0], lat: point[1], altitude: point[2] };
    return {
      lon: sector.lon_min + (point[0] + 0.5) * bins.dx,
      lat: sector.lat_min + (point[1] + 0.5) * bins.dy,
      altitude: (point[2] + 0.5) * bins.dz,
    };
  }

  function geoWorld(lon, lat, altitude) {
    return [
      (lon - origin.lon) * kmPerLon,
      (lat - origin.lat) * kmPerLat,
      altitude * 0.0003048,
    ];
  }

  function pointWorld(point) {
    const geo = pointGeo(point);
    return geoWorld(geo.lon, geo.lat, geo.altitude);
  }

  function visibleSessions() {
    const enabledKinds = new Set(
      kindInputs.filter((input) => input.checked).map((input) => input.dataset.kind),
    );
    const selectedSource = sourceFilter.value;
    const selectedDestination = destinationFilter.value;
    return sessions.filter((session) => {
      if (!enabledKinds.has(session.complete_kind)) return false;
      if (!airportMatches(session.src, selectedSource)) return false;
      return airportMatches(session.dest, selectedDestination);
    });
  }

  function airportMatches(value, selected) {
    if (selected === '*') return true;
    const airport = String(value || '').trim();
    if (selected === '__unspecified__') return airport === '';
    return airport === selected;
  }

  function populateAirportFilter(select, key, label) {
    const values = new Set();
    let hasUnspecified = false;
    for (const session of sessions) {
      const value = String(session[key] || '').trim();
      if (value) values.add(value);
      else hasUnspecified = true;
    }
    select.replaceChildren(new Option(`All ${label.toLowerCase()}s`, '*'));
    for (const value of [...values].sort((a, b) => a.localeCompare(b))) {
      select.add(new Option(value, value));
    }
    if (hasUnspecified) select.add(new Option('Unspecified', '__unspecified__'));
  }

  function projectTolerance() {
    const value = Number(toleranceSelector.value);
    if (continuous) return value;
    const cellSizeKm = Math.sqrt(bins.dx * kmPerLon * bins.dy * kmPerLat);
    return value * cellSizeKm;
  }

  function computeBounds() {
    const low = geoWorld(sector.lon_min, sector.lat_min, 0);
    const high = geoWorld(sector.lon_max, sector.lat_max, 42000);
    worldBounds = {
      xmin: low[0],
      xmax: high[0],
      ymin: low[1],
      ymax: high[1],
      zmin: 0,
      zmax: high[2],
    };
    if (worldBounds.xmin === worldBounds.xmax) worldBounds.xmax += 1;
    if (worldBounds.ymin === worldBounds.ymax) worldBounds.ymax += 1;
    if (worldBounds.zmin === worldBounds.zmax) worldBounds.zmax += 1;
  }

  function worldTransform() {
    const cx = (worldBounds.xmin + worldBounds.xmax) / 2;
    const cy = (worldBounds.ymin + worldBounds.ymax) / 2;
    const cz = (worldBounds.zmin + worldBounds.zmax) / 2;
    const horizontalSpan = Math.max(worldBounds.xmax - worldBounds.xmin, worldBounds.ymax - worldBounds.ymin, 1);
    const scale = 80 / horizontalSpan;
    return { cx, cy, cz, scale, verticalScale: scale * 10 };
  }

  function mapPosition(lon, lat) {
    const padding = 38;
    const width = map.width;
    const height = map.height;
    const scale = Math.min(
      (width - 2 * padding) / (geoBounds.lonMax - geoBounds.lonMin || 1),
      (height - 2 * padding) / (geoBounds.latMax - geoBounds.latMin || 1),
    );
    const drawnWidth = (geoBounds.lonMax - geoBounds.lonMin) * scale;
    const drawnHeight = (geoBounds.latMax - geoBounds.latMin) * scale;
    const left = (width - drawnWidth) / 2;
    const top = (height - drawnHeight) / 2;
    return {
      x: left + (lon - geoBounds.lonMin) * scale,
      y: height - top - (lat - geoBounds.latMin) * scale,
    };
  }

  function drawPath(context, profile, dimensions, transformPoint) {
    if (profile.length < 2) return;
    context.beginPath();
    profile.forEach((point, index) => {
      const position = transformPoint(point);
      if (index) context.lineTo(position.x, position.y);
      else context.moveTo(position.x, position.y);
    });
    context.stroke();
  }

  function profileToMap(point) {
    return mapPosition(
      origin.lon + point[0] / kmPerLon,
      origin.lat + point[1] / kmPerLat,
    );
  }

  function drawMapBase() {
    baseContext.fillStyle = '#09111f';
    baseContext.fillRect(0, 0, mapBase.width, mapBase.height);
    if (!sessions.length) return;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const visible = visibleSessions();

    for (const session of visible) {
      const profile = Analysis.resamplePath(
        Analysis.simplifyPath(sessionPoints(session), pointWorld, 2, 0.45),
        2,
        28,
      );
      if (profile.length < 2) continue;
      baseContext.strokeStyle = categoryColor(session.complete_kind);
      baseContext.globalAlpha = 0.12;
      baseContext.lineWidth = 0.65 * pixelRatio;
      baseContext.lineCap = 'round';
      drawPath(baseContext, profile, 2, profileToMap);
    }

    baseContext.globalAlpha = 1;
    for (const group of xyGroups) {
      const highlighted = group === sharedPair.xyGroup;
      baseContext.strokeStyle = highlighted ? gold : categoryColor(group.kind);
      baseContext.globalAlpha = highlighted
        ? 1
        : Math.min(0.96, 0.48 + 0.09 * Math.log2(group.members.length + 1));
      baseContext.lineWidth =
        (highlighted
          ? 3.5
          : Math.min(6, 1.25 + Math.log10(group.members.length) * 1.35)) * pixelRatio;
      baseContext.lineCap = 'round';
      baseContext.lineJoin = 'round';
      drawPath(baseContext, group.profile, 2, profileToMap);
    }
    baseContext.globalAlpha = 1;
  }

  function drawMapMarkers() {
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    for (const group of xyGroups) {
      const mean = meanActivePosition(group);
      if (!mean) continue;
      const position = profileToMap(mean.position);
      const radius = Math.min(16, 3.5 + Math.sqrt(group.members.length) * 0.7) * pixelRatio;
      mapContext.beginPath();
      mapContext.arc(position.x, position.y, radius, 0, Math.PI * 2);
      mapContext.fillStyle = `rgb(${markerColor(mean.position[2] / 0.0003048).join(',')})`;
      mapContext.fill();
      mapContext.strokeStyle = group === sharedPair.xyGroup ? gold : '#09111f';
      mapContext.lineWidth = group === sharedPair.xyGroup ? 2 * pixelRatio : pixelRatio;
      mapContext.stroke();
    }

    mapContext.fillStyle = '#91a2ba';
    mapContext.font = `${11 * pixelRatio}px system-ui`;
    mapContext.fillText(
      `${visibleSessions().length.toLocaleString()} filtered sessions · ${xyGroups.length} XY templates`,
      12 * pixelRatio,
      map.height - 12 * pixelRatio,
    );
  }

  function drawMap() {
    mapContext.fillStyle = '#09111f';
    mapContext.fillRect(0, 0, map.width, map.height);
    if (mapBase.width && mapBase.height) {
      mapContext.drawImage(mapBase, 0, 0);
      drawMapMarkers();
    }
  }

  function dispose(object) {
    if (!object || !scene) return;
    scene.remove(object);
    object.geometry?.dispose();
    if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
    else object.material?.dispose();
  }

  function makeGeometry(positions, colors, sizes) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    if (sizes) geometry.setAttribute('size', new THREE.Float32BufferAttribute(sizes, 1));
    return geometry;
  }

  function worldToThree(point, transform) {
    return [
      (point[0] - transform.cx) * transform.scale,
      (point[2] - transform.cz) * transform.verticalScale,
      (point[1] - transform.cy) * transform.scale,
    ];
  }

  function categoryRgb(kind, strength = 1) {
    const color = new THREE.Color(categoryColor(kind));
    return [color.r * strength, color.g * strength, color.b * strength];
  }

  function build3dRoutes() {
    dispose(trackObject);
    dispose(routeObject);
    dispose(sharedObject);
    trackObject = null;
    routeObject = null;
    sharedObject = null;
    if (!scene || !worldBounds) return;

    const transform = worldTransform();
    const trackPositions = [];
    const trackColors = [];
    const routePositions = [];
    const routeColors = [];
    const sharedPositions = [];
    const sharedColors = [];
    const largestGroup = Math.max(1, ...xyzGroups.map((group) => group.members.length));

    for (const session of visibleSessions()) {
      const profile = Analysis.resamplePath(
        Analysis.simplifyPath(sessionPoints(session), pointWorld, 2, 0.45),
        2,
        28,
      );
      const tint = categoryRgb(session.complete_kind, 0.55);
      for (let index = 1; index < profile.length; index += 1) {
        trackPositions.push(...worldToThree(profile[index - 1], transform), ...worldToThree(profile[index], transform));
        trackColors.push(...tint, ...tint);
      }
    }

    for (const group of xyzGroups) {
      const highlighted = group === sharedPair.xyzGroup;
      const strength = 0.38 + 0.54 * (Math.log1p(group.members.length) / Math.log1p(largestGroup));
      const tint = categoryRgb(group.kind, strength);
      const positions = highlighted ? sharedPositions : routePositions;
      const colors = highlighted ? sharedColors : routeColors;
      for (let index = 1; index < group.profile.length; index += 1) {
        positions.push(
          ...worldToThree(group.profile[index - 1], transform),
          ...worldToThree(group.profile[index], transform),
        );
        colors.push(...(highlighted ? [1, 0.78, 0.16] : tint), ...(highlighted ? [1, 0.78, 0.16] : tint));
      }
    }

    trackObject = new THREE.LineSegments(
      makeGeometry(trackPositions, trackColors),
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.22 }),
    );
    routeObject = new THREE.LineSegments(
      makeGeometry(routePositions, routeColors),
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 }),
    );
    sharedObject = new THREE.LineSegments(
      makeGeometry(sharedPositions, sharedColors),
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 1, linewidth: 3 }),
    );
    scene.add(trackObject, routeObject, sharedObject);
    update3dMarkers(transform);
  }

  function meanActivePosition(group) {
    let x = 0;
    let y = 0;
    let z = 0;
    let count = 0;
    for (const member of group.members) {
      const position = pointAtTime(member);
      if (!position) continue;
      x += position[0];
      y += position[1];
      z += position[2];
      count += 1;
    }
    if (!count) return null;
    return { position: [x / count, y / count, z / count], activeCount: count };
  }

  function pointAtTime(session) {
    const points = sessionPoints(session);
    if (!points.length || state.t < points[0][3] || state.t > points[points.length - 1][3]) return null;
    let low = 0;
    let high = points.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (points[middle][3] <= state.t) low = middle + 1;
      else high = middle;
    }
    const previous = low > 0 ? points[low - 1] : null;
    const next = low < points.length ? points[low] : null;
    if (!previous) return null;
    if (!next) return pointWorld(previous);
    const span = next[3] - previous[3];
    if (span <= 0) return previous;
    const fraction = (state.t - previous[3]) / span;
    const a = pointWorld(previous);
    const b = pointWorld(next);
    return a.map((value, axis) => value + fraction * (b[axis] - value));
  }

  function update3dMarkers(transform = worldTransform()) {
    dispose(markerObject);
    markerObject = null;
    if (!scene) return;
    const positions = [];
    const colors = [];
    const sizes = [];
    for (const group of xyzGroups) {
      const mean = meanActivePosition(group);
      if (!mean) continue;
      positions.push(...worldToThree(mean.position, transform));
      colors.push(...markerColor(mean.position[2] / 0.0003048).map((value) => value / 255));
      sizes.push(Math.min(24, 5 + Math.sqrt(group.members.length) * 0.85));
    }
    const geometry = makeGeometry(positions, colors, sizes);
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexShader: `
        attribute float size;
        attribute vec3 color;
        varying vec3 vColor;
        void main() {
          vColor = color;
          vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size;
          gl_Position = projectionMatrix * viewPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        void main() {
          vec2 centered = gl_PointCoord - vec2(0.5);
          float radius = length(centered);
          if (radius > 0.5) discard;
          float edge = 1.0 - smoothstep(0.38, 0.5, radius);
          gl_FragColor = vec4(vColor, edge);
        }
      `,
    });
    markerObject = new THREE.Points(geometry, material);
    scene.add(markerObject);
  }

  function updateTimeLabel() {
    const seconds = Math.floor(state.t * timeBinSeconds);
    const totalSeconds = state.max * timeBinSeconds;
    timeLabel.textContent = `t = ${seconds.toLocaleString()} / ${totalSeconds.toLocaleString()} s · ${timeBinSeconds}s bins`;
    slider.value = String(Math.floor(state.t));
  }

  function renderCounts() {
    const visible = visibleSessions();
    const counts = Analysis.displayedCounts(metadata, sessions, visible, pointsKey);
    summary.textContent =
      `Loaded export: ${counts.loadedSessions.toLocaleString()} sessions · ` +
      `${counts.loadedPoints.toLocaleString()} in-sector points · ` +
      `${counts.loadedQcPoints.toLocaleString()} QC-flagged points. ` +
      `Current filters: ${counts.filteredSessions.toLocaleString()} sessions · ` +
      `${counts.filteredPoints.toLocaleString()} points · ` +
      `${counts.filteredQcPoints.toLocaleString()} QC-flagged points.`;
    const sharedText = sharedPair.count
      ? `${sharedPair.count.toLocaleString()} sessions shared by the most-overlapping XY/XYZ template pair`
      : 'No shared XY/XYZ template membership in the current filters';
    groupingSummary.textContent =
      `Independent grouping: ${xyGroups.length} XY / ${xyzGroups.length} XYZ templates · ${sharedText}. ` +
      `Equal template counts do not imply equal membership.`;
    status.textContent = `${xyGroups.length} XY · ${xyzGroups.length} XYZ templates`;
  }

  function update() {
    updateTimeLabel();
    drawMap();
    update3dMarkers();
  }

  function regroup() {
    const visible = visibleSessions();
    const tolerance = projectTolerance();
    xyGroups = Analysis.buildTemplateGroups(visible, {
      dimensions: 2,
      tolerance,
      pointsOf: sessionPoints,
      projectPoint: pointWorld,
    });
    xyzGroups = Analysis.buildTemplateGroups(visible, {
      dimensions: 3,
      tolerance,
      pointsOf: sessionPoints,
      projectPoint: pointWorld,
    });
    sharedPair = Analysis.findLargestSharedPair(xyGroups, xyzGroups);
    drawMapBase();
    build3dRoutes();
    update();
    renderCounts();
  }

  function resetCamera() {
    if (!camera || !orbit || !worldBounds) return;
    orbit.target.set(0, 0, 0);
    orbit.radius = 112;
    orbit.theta = 0.8;
    orbit.phi = 1.05;
    camera.near = 0.1;
    camera.far = 2000;
    camera.updateProjectionMatrix();
    orbit.update();
  }

  function ingest(payload) {
    if (!payload?.meta?.sector || !Array.isArray(payload.sessions)) {
      throw new Error(`Invalid ${continuous ? 'continuous' : 'discrete'} sessions JSON`);
    }
    metadata = payload.meta;
    const exportedTimeBin = Number(
      continuous ? metadata.time_step_seconds : metadata.bins?.dt,
    );
    timeBinSeconds =
      Number.isFinite(exportedTimeBin) && exportedTimeBin > 0
        ? exportedTimeBin
        : Analysis.TIME_BIN_SECONDS;
    const stepLabel = timeBinSeconds.toLocaleString(undefined, { maximumFractionDigits: 2 });
    speedNote.textContent = `real-time speed · ${stepLabel} seconds per bin`;
    slider.setAttribute('aria-label', `Session-relative time in ${stepLabel}-second bins`);
    edgeNote.textContent =
      metadata.completeness?.edge_note || 'Sector-edge evidence is not specified in this export.';
    qualityNote.textContent =
      metadata.quality?.filtering ||
      'QC flags are shown as quality information and do not silently remove whole sessions.';
    sector = payload.meta.sector;
    bins = { ...bins, ...(payload.meta.bins || {}) };
    origin = {
      lon: (sector.lon_min + sector.lon_max) / 2,
      lat: (sector.lat_min + sector.lat_max) / 2,
    };
    kmPerLon = 111.32 * Math.cos((origin.lat * Math.PI) / 180);
    geoBounds = {
      lonMin: sector.lon_min,
      lonMax: sector.lon_max,
      latMin: sector.lat_min,
      latMax: sector.lat_max,
    };
    const normalized = Analysis.normalizeTimeline(payload.sessions, pointsKey);
    sessions.length = 0;
    for (const session of normalized) {
      if (sessionPoints(session).length) sessions.push(session);
    }
    if (!sessions.length) throw new Error('No trajectory points found in the selected export');

    computeBounds();
    populateAirportFilter(sourceFilter, 'src', 'Origin');
    populateAirportFilter(destinationFilter, 'dest', 'Destination');
    state.t = 0;
    state.max = sessions.reduce(
      (maximum, session) => Math.max(maximum, sessionPoints(session).at(-1)[3]),
      0,
    );
    slider.max = String(state.max);
    regroup();
    resetCamera();
    update();
  }

  function seek(value) {
    state.t = Math.max(0, Math.min(state.max, Number(value) || 0));
    state.lastFrame = 0;
    update();
  }

  function togglePlayback() {
    if (!sessions.length) return;
    if (!state.playing && state.t >= state.max) seek(0);
    state.playing = !state.playing;
    state.lastFrame = 0;
    document.getElementById('play').textContent = state.playing ? '❚❚ Pause' : '▶ Play';
  }

  function animate(now) {
    if (state.playing) {
      if (state.lastFrame) {
        const elapsedSeconds = (now - state.lastFrame) / 1000;
        state.t = Math.min(
          state.max,
          Analysis.advanceTimeline(state.t, elapsedSeconds, state.speed, timeBinSeconds),
        );
        if (state.t >= state.max) {
          state.playing = false;
          document.getElementById('play').textContent = '▶ Play';
        }
        update();
      }
      state.lastFrame = now;
    }
    if (orbit) orbit.update();
    if (renderer && scene) renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }

  function resize() {
    const bounds = map.getBoundingClientRect();
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    map.width = Math.max(1, Math.floor(bounds.width * pixelRatio));
    map.height = Math.max(1, Math.floor(bounds.height * pixelRatio));
    mapBase.width = map.width;
    mapBase.height = map.height;
    drawMapBase();
    drawMap();
    if (renderer && camera) {
      const host = document.getElementById('three');
      renderer.setSize(host.clientWidth, host.clientHeight);
      camera.aspect = host.clientWidth / Math.max(1, host.clientHeight);
      camera.updateProjectionMatrix();
    }
  }

  function initialize3d() {
    const host = document.getElementById('three');
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.setClearColor('#09111f');
    host.appendChild(renderer.domElement);
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(
      48,
      host.clientWidth / Math.max(1, host.clientHeight),
      0.1,
      2000,
    );
    scene.add(new THREE.GridHelper(100, 20, 0x243650, 0x172840));
    orbit = {
      target: new THREE.Vector3(),
      theta: 0.8,
      phi: 1.05,
      radius: 112,
      dragging: false,
      x: 0,
      y: 0,
      update() {
        camera.position.set(
          this.target.x + this.radius * Math.sin(this.phi) * Math.cos(this.theta),
          this.target.y + this.radius * Math.cos(this.phi),
          this.target.z + this.radius * Math.sin(this.phi) * Math.sin(this.theta),
        );
        camera.lookAt(this.target);
      },
    };

    const canvas = renderer.domElement;
    canvas.addEventListener('pointerdown', (event) => {
      orbit.dragging = true;
      orbit.x = event.clientX;
      orbit.y = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointerup', (event) => {
      orbit.dragging = false;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!orbit.dragging) return;
      orbit.theta -= (event.clientX - orbit.x) * 0.006;
      orbit.phi = Math.max(
        0.08,
        Math.min(Math.PI - 0.08, orbit.phi + (event.clientY - orbit.y) * 0.006),
      );
      orbit.x = event.clientX;
      orbit.y = event.clientY;
      orbit.update();
    });
    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        orbit.radius = Math.max(8, Math.min(1500, orbit.radius * Math.exp(event.deltaY * 0.001)));
        orbit.update();
      },
      { passive: false },
    );
    orbit.update();
  }

  document.getElementById('play').addEventListener('click', togglePlayback);
  document.querySelectorAll('.speed').forEach((button) => {
    button.addEventListener('click', () => {
      state.speed = Number(button.dataset.speed);
      document.querySelectorAll('.speed').forEach((candidate) => {
        candidate.classList.toggle('active', candidate === button);
      });
      button.title = Analysis.formatPlaybackSpeed(state.speed);
    });
  });
  slider.addEventListener('input', (event) => seek(event.target.value));
  kindInputs.forEach((input) => input.addEventListener('change', regroup));
  sourceFilter.addEventListener('change', regroup);
  destinationFilter.addEventListener('change', regroup);
  toleranceSelector.addEventListener('change', regroup);
  document.getElementById('load').addEventListener('click', () => document.getElementById('file').click());
  document.getElementById('file').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    status.textContent = `Loading ${file.name}…`;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        ingest(JSON.parse(reader.result));
      } catch (error) {
        status.textContent = `JSON error: ${error.message}`;
      }
    };
    reader.onerror = () => {
      status.textContent = 'Could not read the selected JSON';
    };
    reader.readAsText(file);
  });

  try {
    if (!window.THREE) throw new Error('Three.js failed to load');
    initialize3d();
    resize();
    const exportName = continuous ? 'continuous_sessions.json' : 'complete_sessions.json';
    fetch(exportName)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then(ingest)
      .catch((error) => {
        status.textContent = `Load ${exportName} with button (${error.message})`;
      });
  } catch (error) {
    status.textContent = `3D initialization error: ${error.message}`;
    console.error(error);
  }
  window.addEventListener('resize', resize);
  requestAnimationFrame(animate);
})();
