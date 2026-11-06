/**
 * Flight Phase Explorer & Manual Tagging Studio
 * Interactive frontend application
 */

(() => {
  'use strict';

  // Standard Flight Phase Color Palette
  const PHASE_COLORS = {
    ground: '#9aa9bd',
    initial_climb: '#ff9f43',
    climb: '#ff5b5b',
    cruise: '#bb86fc',
    level_flight: '#45d6c5',
    descent: '#5fa8ff',
    approach: '#35d49a',
    landing: '#ffe066',
    landing_roll: '#f4a261',
    go_around_climb_candidate: '#ff5ec4',
    airborne_transition: '#d8e5f2',
    unknown: '#687588',
  };

  const SESSION_COLORS = [
    '#38bdf8', '#34d399', '#f472b6', '#facc15',
    '#a78bfa', '#fb923c', '#4ade80', '#22d3ee',
    '#e879f9', '#f87171', '#94a3b8', '#818cf8',
  ];

  // Application State
  const state = {
    aircraftList: [],
    selectedAircraft: null,
    aircraftDetails: null,
    selectedSessionIds: new Set(),
    focusedSessionId: null,
    sessionsData: [],
    bounds: null,
    airports: [],
    manualTags: [],
    activeTagPhase: 'approach',

    // Playback
    t: 0,
    maxT: 100,
    playing: false,
    speed: 10,
    loop: true,
    lastFrameTime: 0,

    // Visualization Options
    colorMode: 'phase', // 'phase' or 'session'
    showAirports: true,
    showTagsOverlay: true,
    followAircraft: true,

    // Map Transform
    mapZoom: 1,
    mapPan: { x: 0, y: 0 },
    isDraggingMap: false,
    dragStart: { x: 0, y: 0 },

    // Timeline Drag Selection
    isSelectingTimeline: false,
    timelineSelStartT: 0,
    timelineSelEndT: 0,
  };

  // DOM Elements
  const el = {
    selectionSummary: document.getElementById('selection-summary'),
    acSearchInput: document.getElementById('ac-search-input'),
    aircraftSelector: document.getElementById('aircraft-selector'),
    metaAcId: document.getElementById('meta-ac-id'),
    metaAcSessions: document.getElementById('meta-ac-sessions'),
    metaAcRoutes: document.getElementById('meta-ac-routes'),

    btnSelectAllSessions: document.getElementById('btn-select-all-sessions'),
    btnSelectNoneSessions: document.getElementById('btn-select-none-sessions'),
    sessionsContainer: document.getElementById('sessions-container'),

    tagTargetSession: document.getElementById('tag-target-session'),
    tagTStart: document.getElementById('tag-t-start'),
    tagTEnd: document.getElementById('tag-t-end'),
    btnSetTStart: document.getElementById('btn-set-t-start'),
    btnSetTEnd: document.getElementById('btn-set-t-end'),
    btnTagInstant: document.getElementById('btn-tag-instant'),
    phaseButtonsGrid: document.getElementById('phase-buttons-grid'),
    tagConfidence: document.getElementById('tag-confidence'),
    tagNotes: document.getElementById('tag-notes'),
    btnApplyTag: document.getElementById('btn-apply-tag'),
    tagsList: document.getElementById('tags-list'),
    tagsCount: document.getElementById('tags-count'),

    btnColorPhase: document.getElementById('btn-color-phase'),
    btnColorSession: document.getElementById('btn-color-session'),
    chkShowAirports: document.getElementById('chk-show-airports'),
    chkShowTagsOverlay: document.getElementById('chk-show-tags-overlay'),
    btnZoomIn: document.getElementById('btn-zoom-in'),
    btnZoomOut: document.getElementById('btn-zoom-out'),
    btnZoomReset: document.getElementById('btn-zoom-reset'),
    btnFollowAc: document.getElementById('btn-follow-ac'),

    radarCanvas: document.getElementById('radar-canvas'),
    hudAlt: document.getElementById('hud-alt'),
    hudSpd: document.getElementById('hud-spd'),
    hudVs: document.getElementById('hud-vs'),
    hudPredPhase: document.getElementById('hud-pred-phase'),
    hudManualPhase: document.getElementById('hud-manual-phase'),

    predictedRibbon: document.getElementById('predicted-ribbon'),
    manualRibbon: document.getElementById('manual-ribbon'),
    altitudeCanvas: document.getElementById('altitude-canvas'),
    scrubberLine: document.getElementById('timeline-scrubber-line'),
    selectionBox: document.getElementById('timeline-selection-box'),

    btnPlayPause: document.getElementById('btn-play-pause'),
    btnStepBack: document.getElementById('btn-step-back'),
    btnStepFwd: document.getElementById('btn-step-fwd'),
    btnLoop: document.getElementById('btn-loop'),
    timeScrubber: document.getElementById('time-scrubber'),
    timeDisplay: document.getElementById('time-display'),
    timeSecDisplay: document.getElementById('time-sec-display'),
    speedButtons: document.querySelectorAll('.btn-speed'),

    evalModal: document.getElementById('eval-modal'),
    btnEvalModal: document.getElementById('btn-eval-modal'),
    btnCloseEval: document.getElementById('btn-close-eval'),
    btnCloseEvalBottom: document.getElementById('btn-close-eval-bottom'),
    btnExportTags: document.getElementById('btn-export-tags'),
    btnDownloadAuditCsv: document.getElementById('btn-download-audit-csv'),

    evalAgreementRate: document.getElementById('eval-agreement-rate'),
    evalMatchedPoints: document.getElementById('eval-matched-points'),
    evalTotalTags: document.getElementById('eval-total-tags'),
    evalTotalDisagreements: document.getElementById('eval-total-disagreements'),
    evalSuggestionsBox: document.getElementById('eval-suggestions-box'),
    confusionMatrixTable: document.getElementById('confusion-matrix-table'),
    disagreementsBody: document.getElementById('disagreements-body'),

    helpModal: document.getElementById('help-modal'),
    btnHelpModal: document.getElementById('btn-help-modal'),
    btnCloseHelp: document.getElementById('btn-close-help'),
    btnCloseHelpBottom: document.getElementById('btn-close-help-bottom'),
  };

  const radarCtx = el.radarCanvas.getContext('2d');
  const altCtx = el.altitudeCanvas.getContext('2d');

  // Initialization
  async function init() {
    setupEventListeners();
    handleResize();
    window.addEventListener('resize', handleResize);

    try {
      el.selectionSummary.textContent = 'Loading aircraft list...';
      const resp = await fetch('/api/aircraft');
      if (!resp.ok) throw new Error('Failed to fetch aircraft list');
      state.aircraftList = await resp.json();

      renderAircraftList(state.aircraftList);

      // Auto-select first aircraft with multiple sessions
      if (state.aircraftList.length > 0) {
        const defaultAc = state.aircraftList[0].aircraft;
        selectAircraft(defaultAc);
      }
    } catch (err) {
      console.error(err);
      el.selectionSummary.textContent = 'Error connecting to server. Is backend running?';
    }

    requestAnimationFrame(animationLoop);
  }

  // Event Listeners Setup
  function setupEventListeners() {
    // Aircraft search
    el.acSearchInput.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      const filtered = state.aircraftList.filter(
        a => a.aircraft.toLowerCase().includes(q) || a.routes.some(r => r.toLowerCase().includes(q))
      );
      renderAircraftList(filtered);
    });

    // Aircraft dropdown change
    el.aircraftSelector.addEventListener('change', (e) => {
      if (e.target.value) {
        selectAircraft(e.target.value);
      }
    });

    // Session buttons
    el.btnSelectAllSessions.addEventListener('click', () => {
      if (!state.aircraftDetails) return;
      state.selectedSessionIds = new Set(state.aircraftDetails.sessions.map(s => s.id));
      syncSessionCheckboxes();
      fetchSelectedSessionsBatch();
    });

    el.btnSelectNoneSessions.addEventListener('click', () => {
      state.selectedSessionIds.clear();
      syncSessionCheckboxes();
      state.sessionsData = [];
      updateTimelineAndRibbons();
      renderRadar();
    });

    // Color mode toggle
    el.btnColorPhase.addEventListener('click', () => {
      state.colorMode = 'phase';
      el.btnColorPhase.classList.add('active');
      el.btnColorSession.classList.remove('active');
      renderRadar();
    });

    el.btnColorSession.addEventListener('click', () => {
      state.colorMode = 'session';
      el.btnColorSession.classList.add('active');
      el.btnColorPhase.classList.remove('active');
      renderRadar();
    });

    // Toggles
    el.chkShowAirports.addEventListener('change', (e) => {
      state.showAirports = e.target.checked;
      renderRadar();
    });

    el.chkShowTagsOverlay.addEventListener('change', (e) => {
      state.showTagsOverlay = e.target.checked;
      renderRadar();
    });

    el.btnFollowAc.addEventListener('click', () => {
      state.followAircraft = !state.followAircraft;
      el.btnFollowAc.classList.toggle('active', state.followAircraft);
      if (state.followAircraft) {
        state.mapPan = { x: 0, y: 0 };
        renderRadar();
      }
    });

    // Zoom controls
    el.btnZoomIn.addEventListener('click', () => {
      state.mapZoom *= 1.25;
      renderRadar();
    });
    el.btnZoomOut.addEventListener('click', () => {
      state.mapZoom = Math.max(0.5, state.mapZoom / 1.25);
      renderRadar();
    });
    el.btnZoomReset.addEventListener('click', () => {
      state.mapZoom = 1;
      state.mapPan = { x: 0, y: 0 };
      renderRadar();
    });

    // Playback Controls
    el.btnPlayPause.addEventListener('click', togglePlayPause);
    el.btnStepBack.addEventListener('click', () => seekTime(state.t - 5));
    el.btnStepFwd.addEventListener('click', () => seekTime(state.t + 5));

    el.btnLoop.addEventListener('click', () => {
      state.loop = !state.loop;
      el.btnLoop.classList.toggle('active', state.loop);
    });

    el.timeScrubber.addEventListener('input', (e) => {
      seekTime(parseFloat(e.target.value));
    });

    el.speedButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        el.speedButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.speed = parseFloat(btn.dataset.speed);
      });
    });

    // Tagging Buttons
    el.btnSetTStart.addEventListener('click', () => {
      el.tagTStart.value = Math.max(0, Math.floor(state.t));
      updateTimelineSelectionBox();
    });

    el.btnSetTEnd.addEventListener('click', () => {
      el.tagTEnd.value = Math.ceil(state.t);
      updateTimelineSelectionBox();
    });

    el.btnTagInstant.addEventListener('click', () => {
      const cur = Math.round(state.t);
      el.tagTStart.value = Math.max(0, cur - 2);
      el.tagTEnd.value = cur + 2;
      updateTimelineSelectionBox();
    });

    el.tagTStart.addEventListener('input', updateTimelineSelectionBox);
    el.tagTEnd.addEventListener('input', updateTimelineSelectionBox);

    // Phase selection buttons
    el.phaseButtonsGrid.querySelectorAll('.phase-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        el.phaseButtonsGrid.querySelectorAll('.phase-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        state.activeTagPhase = btn.dataset.phase;
      });
    });
    // Set default selected phase button
    const defaultPhaseBtn = el.phaseButtonsGrid.querySelector('[data-phase="approach"]');
    if (defaultPhaseBtn) defaultPhaseBtn.classList.add('selected');

    el.btnApplyTag.addEventListener('click', applyManualTag);

    // Target session dropdown change
    el.tagTargetSession.addEventListener('change', (e) => {
      state.focusedSessionId = e.target.value;
      updateTimelineAndRibbons();
      renderRadar();
    });

    // Radar Canvas Pan / Drag
    el.radarCanvas.addEventListener('mousedown', (e) => {
      state.isDraggingMap = true;
      state.dragStart = { x: e.clientX - state.mapPan.x, y: e.clientY - state.mapPan.y };
      state.followAircraft = false;
      el.btnFollowAc.classList.remove('active');
    });

    window.addEventListener('mousemove', (e) => {
      if (state.isDraggingMap) {
        state.mapPan.x = e.clientX - state.dragStart.x;
        state.mapPan.y = e.clientY - state.dragStart.y;
        renderRadar();
      }
    });

    window.addEventListener('mouseup', () => {
      state.isDraggingMap = false;
    });

    el.radarCanvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
      state.mapZoom = Math.max(0.3, Math.min(20, state.mapZoom * zoomFactor));
      renderRadar();
    });

    // Timeline Canvas Click & Drag Selection
    el.altitudeCanvas.addEventListener('mousedown', (e) => {
      state.isSelectingTimeline = true;
      const rect = el.altitudeCanvas.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, clickX / rect.width));
      const tClicked = ratio * state.maxT;
      state.timelineSelStartT = tClicked;
      state.timelineSelEndT = tClicked;

      seekTime(tClicked);
      el.tagTStart.value = Math.floor(tClicked);
      el.tagTEnd.value = Math.ceil(tClicked);
      updateTimelineSelectionBox();
    });

    window.addEventListener('mousemove', (e) => {
      if (state.isSelectingTimeline) {
        const rect = el.altitudeCanvas.getBoundingClientRect();
        const curX = e.clientX - rect.left;
        const ratio = Math.max(0, Math.min(1, curX / rect.width));
        const tCur = ratio * state.maxT;
        state.timelineSelEndT = tCur;

        const start = Math.min(state.timelineSelStartT, state.timelineSelEndT);
        const end = Math.max(state.timelineSelStartT, state.timelineSelEndT);
        el.tagTStart.value = Math.floor(start);
        el.tagTEnd.value = Math.ceil(end);
        updateTimelineSelectionBox();
      }
    });

    window.addEventListener('mouseup', () => {
      state.isSelectingTimeline = false;
    });

    // Modals
    el.btnEvalModal.addEventListener('click', openEvalModal);
    el.btnCloseEval.addEventListener('click', closeEvalModal);
    el.btnCloseEvalBottom.addEventListener('click', closeEvalModal);

    el.btnHelpModal.addEventListener('click', () => el.helpModal.classList.remove('hidden'));
    el.btnCloseHelp.addEventListener('click', () => el.helpModal.classList.add('hidden'));
    el.btnCloseHelpBottom.addEventListener('click', () => el.helpModal.classList.add('hidden'));

    el.btnExportTags.addEventListener('click', exportTags);
    el.btnDownloadAuditCsv.addEventListener('click', exportTags);

    // Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;

      if (e.code === 'Space') {
        e.preventDefault();
        togglePlayPause();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        seekTime(state.t - 5);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        seekTime(state.t + 5);
      } else if (e.key === '[') {
        el.tagTStart.value = Math.max(0, Math.floor(state.t));
        updateTimelineSelectionBox();
      } else if (e.key === ']') {
        el.tagTEnd.value = Math.ceil(state.t);
        updateTimelineSelectionBox();
      } else if (e.key === 'Escape') {
        closeEvalModal();
        el.helpModal.classList.add('hidden');
      }
    });
  }

  function handleResize() {
    const rRect = el.radarCanvas.parentElement.getBoundingClientRect();
    el.radarCanvas.width = rRect.width * window.devicePixelRatio;
    el.radarCanvas.height = rRect.height * window.devicePixelRatio;

    const aRect = el.altitudeCanvas.parentElement.getBoundingClientRect();
    el.altitudeCanvas.width = aRect.width * window.devicePixelRatio;
    el.altitudeCanvas.height = aRect.height * window.devicePixelRatio;

    renderRadar();
    renderAltitudeChart();
  }

  // Render Aircraft List Dropdown
  function renderAircraftList(list) {
    el.aircraftSelector.innerHTML = '';
    list.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.aircraft;
      const routesStr = a.routes.slice(0, 2).join(', ');
      opt.textContent = `${a.aircraft} · ${a.session_count} session${a.session_count > 1 ? 's' : ''} (${routesStr || 'local'})`;
      if (a.aircraft === state.selectedAircraft) {
        opt.selected = true;
      }
      el.aircraftSelector.appendChild(opt);
    });
  }

  // Aircraft Selection Flow
  async function selectAircraft(acId) {
    if (!acId) return;
    state.selectedAircraft = acId;

    try {
      el.selectionSummary.textContent = `Loading aircraft ${acId}...`;
      const resp = await fetch(`/api/aircraft/${acId}`);
      if (!resp.ok) throw new Error('Aircraft not found');
      state.aircraftDetails = await resp.json();

      // Update meta card
      el.metaAcId.textContent = acId;
      el.metaAcSessions.textContent = `${state.aircraftDetails.session_count} sessions`;
      const allRoutes = new Set(state.aircraftDetails.sessions.map(s => `${s.src || '?' }->${s.dest || '?'}`));
      el.metaAcRoutes.textContent = Array.from(allRoutes).slice(0, 3).join(', ');

      // RULE REQUIREMENT: Defaults to ALL sessions when only the aircraft is selected!
      state.selectedSessionIds = new Set(state.aircraftDetails.sessions.map(s => s.id));
      state.focusedSessionId = state.aircraftDetails.sessions[0]?.id || null;

      // Render Session Cards
      renderSessionCards();

      // Populate Tag Target Session Dropdown
      populateTagSessionDropdown();

      // Load Session Trajectories Batch
      await fetchSelectedSessionsBatch();

      // Load manual tags
      await loadManualTags();

      // Reset playback time to 0
      seekTime(0);

    } catch (err) {
      console.error(err);
      el.selectionSummary.textContent = `Error loading aircraft ${acId}`;
    }
  }

  // Render Sessions Selection List
  function renderSessionCards() {
    el.sessionsContainer.innerHTML = '';
    if (!state.aircraftDetails) return;

    state.aircraftDetails.sessions.forEach(sess => {
      const card = document.createElement('div');
      card.className = `session-card ${state.selectedSessionIds.has(sess.id) ? 'active' : ''}`;
      card.dataset.id = sess.id;

      const isChecked = state.selectedSessionIds.has(sess.id);
      const durSeconds = sess.duration_s || sess.t_max || 0;
      const minDuration = Math.floor(durSeconds / 60);
      const secDuration = Math.round(durSeconds % 60);
      const durStr = `${minDuration}m ${secDuration}s`;
      const routeStr = `${sess.src || '—'} → ${sess.dest || '—'}`;

      card.innerHTML = `
        <input type="checkbox" id="chk-${sess.id}" ${isChecked ? 'checked' : ''}>
        <div class="session-info">
          <div class="session-title-row">
            <span class="session-id">${sess.id}</span>
            <span class="badge-kind ${sess.complete_kind}">${sess.complete_kind || sess.session_type}</span>
            ${sess.manual_tag_count > 0 ? `<span class="badge-kind" style="background:#065f46;color:#6ee7b7;">${sess.manual_tag_count} Tag${sess.manual_tag_count > 1 ? 's' : ''}</span>` : ''}
          </div>
          <div class="session-sub-row">
            <span>Route: <strong>${routeStr}</strong></span>
            <span>·</span>
            <span>${sess.n_points} pts (${durStr})</span>
            <span>·</span>
            <span style="color:${PHASE_COLORS[sess.dominant_phase] || '#fff'};">● ${sess.dominant_phase}</span>
          </div>
        </div>
        <button class="session-focus-btn" title="Focus view & timeline on this session">Focus</button>
      `;

      // Checkbox handler
      const chk = card.querySelector('input[type="checkbox"]');
      chk.addEventListener('change', (e) => {
        e.stopPropagation();
        if (chk.checked) {
          state.selectedSessionIds.add(sess.id);
          card.classList.add('active');
        } else {
          state.selectedSessionIds.delete(sess.id);
          card.classList.remove('active');
        }
        fetchSelectedSessionsBatch();
      });

      // Card click
      card.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.classList.contains('session-focus-btn')) return;
        chk.checked = !chk.checked;
        chk.dispatchEvent(new Event('change'));
      });

      // Focus button handler
      card.querySelector('.session-focus-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        state.focusedSessionId = sess.id;
        el.tagTargetSession.value = sess.id;
        updateTimelineAndRibbons();
        renderRadar();
      });

      el.sessionsContainer.appendChild(card);
    });
  }

  function syncSessionCheckboxes() {
    el.sessionsContainer.querySelectorAll('.session-card').forEach(card => {
      const sid = card.dataset.id;
      const isSel = state.selectedSessionIds.has(sid);
      card.classList.toggle('active', isSel);
      const chk = card.querySelector('input[type="checkbox"]');
      if (chk) chk.checked = isSel;
    });
  }

  function populateTagSessionDropdown() {
    el.tagTargetSession.innerHTML = '';
    if (!state.aircraftDetails) return;

    state.aircraftDetails.sessions.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.id} (${s.src || '?'} → ${s.dest || '?'})`;
      if (s.id === state.focusedSessionId) opt.selected = true;
      el.tagTargetSession.appendChild(opt);
    });
  }

  // Fetch Batch Data for Selected Sessions
  async function fetchSelectedSessionsBatch() {
    const sids = Array.from(state.selectedSessionIds);
    if (sids.length === 0) {
      state.sessionsData = [];
      state.maxT = 100;
      updateHeaderSummary();
      updateTimelineAndRibbons();
      renderRadar();
      return;
    }

    try {
      el.selectionSummary.textContent = `Loading ${sids.length} session${sids.length > 1 ? 's' : ''}...`;
      const resp = await fetch('/api/sessions/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_ids: sids }),
      });
      if (!resp.ok) throw new Error('Failed to load session batch');

      const data = await resp.json();
      state.sessionsData = data.sessions;
      state.bounds = data.bounds;
      state.airports = data.airports || [];

      // Determine max time duration across selected sessions in real seconds
      const durations = state.sessionsData.map(s => {
        if (s.duration_s != null && s.duration_s > 0) return s.duration_s;
        if (s.phase_samples && s.phase_samples.length > 0) {
          return s.phase_samples[s.phase_samples.length - 1].time_s || 0;
        }
        return (s.t_max || 0);
      });
      state.maxT = Math.max(60, ...durations);
      el.timeScrubber.max = state.maxT;

      // Ensure focused session is in selected set
      if (!state.selectedSessionIds.has(state.focusedSessionId)) {
        state.focusedSessionId = sids[0];
        el.tagTargetSession.value = state.focusedSessionId;
      }

      updateHeaderSummary();
      updateTimelineAndRibbons();
      renderRadar();
      renderAltitudeChart();
    } catch (err) {
      console.error(err);
      el.selectionSummary.textContent = 'Error loading sessions batch';
    }
  }

  function updateHeaderSummary() {
    const n = state.selectedSessionIds.size;
    const total = state.aircraftDetails?.session_count || 0;
    if (n === total) {
      el.selectionSummary.textContent = `Aircraft ${state.selectedAircraft} · All ${n} Sessions Active (Default)`;
    } else {
      el.selectionSummary.textContent = `Aircraft ${state.selectedAircraft} · ${n} of ${total} Sessions Selected`;
    }
  }

  // Animation Loop & Playback Controls
  function togglePlayPause() {
    state.playing = !state.playing;
    el.btnPlayPause.innerHTML = state.playing
      ? '<span class="icon">⏸</span> Pause'
      : '<span class="icon">▶</span> Play';
    state.lastFrameTime = performance.now();
  }

  function seekTime(targetT) {
    state.t = Math.max(0, Math.min(state.maxT, targetT));
    el.timeScrubber.value = state.t;
    updateTimeDisplay();
    updateTimelineScrubberLine();
    updateHUD();
    renderRadar();
  }

  function animationLoop(timestamp) {
    if (state.playing) {
      const dt = (timestamp - state.lastFrameTime) / 1000;
      state.lastFrameTime = timestamp;

      state.t += dt * state.speed; // real simulation seconds advanced

      if (state.t >= state.maxT) {
        if (state.loop) {
          state.t = 0;
        } else {
          state.t = state.maxT;
          togglePlayPause();
        }
      }

      el.timeScrubber.value = state.t;
      updateTimeDisplay();
      updateTimelineScrubberLine();
      updateHUD();
      renderRadar();
    } else {
      state.lastFrameTime = timestamp;
    }

    requestAnimationFrame(animationLoop);
  }

  function updateTimeDisplay() {
    const curMin = Math.floor(state.t / 60);
    const curSec = Math.floor(state.t % 60);
    const maxMin = Math.floor(state.maxT / 60);
    const maxSec = Math.floor(state.maxT % 60);

    const pad = (n) => String(n).padStart(2, '0');
    el.timeDisplay.textContent = `${pad(curMin)}:${pad(curSec)} / ${pad(maxMin)}:${pad(maxSec)}`;
    el.timeSecDisplay.textContent = `(t = ${Math.round(state.t)}s)`;
  }

  function updateTimelineScrubberLine() {
    const ratio = state.maxT > 0 ? (state.t / state.maxT) * 100 : 0;
    el.scrubberLine.style.left = `${ratio}%`;
  }

  function updateTimelineSelectionBox() {
    const s = parseFloat(el.tagTStart.value) || 0;
    const e = parseFloat(el.tagTEnd.value) || 0;
    if (e > s && state.maxT > 0) {
      const leftRatio = (s / state.maxT) * 100;
      const widthRatio = ((e - s) / state.maxT) * 100;
      el.selectionBox.style.display = 'block';
      el.selectionBox.style.left = `${leftRatio}%`;
      el.selectionBox.style.width = `${widthRatio}%`;
    } else {
      el.selectionBox.style.display = 'none';
    }
  }

  // Update HUD with Active Flight Telemetry
  function updateHUD() {
    const focusedSession = state.sessionsData.find(s => s.id === state.focusedSessionId) || state.sessionsData[0];
    if (!focusedSession || !focusedSession.points || focusedSession.points.length === 0) {
      el.hudAlt.textContent = '— ft';
      el.hudSpd.textContent = '— kts';
      el.hudVs.textContent = '— fpm';
      el.hudPredPhase.textContent = '—';
      el.hudManualPhase.textContent = 'None';
      return;
    }

    const interp = interpolatePointAtTime(focusedSession, state.t);
    if (!interp) return;

    el.hudAlt.textContent = `${Math.round(interp.alt).toLocaleString()} ft`;
    el.hudSpd.textContent = interp.speed != null ? `${Math.round(interp.speed)} kts` : '— kts';
    el.hudVs.textContent = interp.vs != null ? `${interp.vs > 0 ? '+' : ''}${Math.round(interp.vs)} fpm` : '— fpm';

    // Predicted phase badge
    el.hudPredPhase.textContent = interp.phase.toUpperCase();
    el.hudPredPhase.style.background = PHASE_COLORS[interp.phase] || '#253856';
    el.hudPredPhase.style.color = '#fff';

    // Check if manual tag applies to this moment
    const manualTag = state.manualTags.find(t =>
      t.session_id === focusedSession.id && state.t >= t.t_start_s && state.t <= t.t_end_s
    );
    if (manualTag) {
      el.hudManualPhase.textContent = `${manualTag.manual_phase.toUpperCase()} [${manualTag.confidence}]`;
      el.hudManualPhase.style.background = PHASE_COLORS[manualTag.manual_phase] || '#065f46';
      el.hudManualPhase.style.color = '#fff';
    } else {
      el.hudManualPhase.textContent = 'None';
      el.hudManualPhase.style.background = '#1e293b';
      el.hudManualPhase.style.color = '#94a3b8';
    }
  }

  // Interpolation helper
  function interpolatePointAtTime(session, t) {
    const points = session.points;
    const samples = session.phase_samples || [];
    if (!points || points.length === 0) return null;

    if (t <= (samples[0]?.time_s || 0)) {
      const p = points[0];
      const s = samples[0] || {};
      return {
        lon: p[0], lat: p[1], alt: p[2],
        phase: s.phase || 'unknown',
        speed: s.ground_speed,
        vs: s.flight_phase_vertical_rate_fpm,
        heading: 0,
      };
    }

    for (let i = 0; i < samples.length - 1; i++) {
      const t0 = samples[i].time_s;
      const t1 = samples[i + 1].time_s;

      if (t >= t0 && t <= t1) {
        const factor = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
        const p0 = points[i];
        const p1 = points[i + 1];

        const lon = p0[0] + (p1[0] - p0[0]) * factor;
        const lat = p0[1] + (p1[1] - p0[1]) * factor;
        const alt = p0[2] + (p1[2] - p0[2]) * factor;

        // Heading in degrees
        const dLon = p1[0] - p0[0];
        const dLat = p1[1] - p0[1];
        const heading = (Math.atan2(dLon, dLat) * 180 / Math.PI + 360) % 360;

        return {
          lon, lat, alt,
          phase: samples[i].phase || 'unknown',
          speed: samples[i].ground_speed,
          vs: samples[i].flight_phase_vertical_rate_fpm,
          heading,
        };
      }
    }

    const lastP = points[points.length - 1];
    const lastS = samples[samples.length - 1] || {};
    let finalHeading = 0;
    if (points.length >= 2) {
      const pPrev = points[points.length - 2];
      finalHeading = (Math.atan2(lastP[0] - pPrev[0], lastP[1] - pPrev[1]) * 180 / Math.PI + 360) % 360;
    }
    return {
      lon: lastP[0], lat: lastP[1], alt: lastP[2],
      phase: lastS.phase || 'unknown',
      speed: lastS.ground_speed,
      vs: lastS.flight_phase_vertical_rate_fpm,
      heading: finalHeading,
    };
  }

  // 2D Radar Canvas Map Rendering
  function renderRadar() {
    const width = el.radarCanvas.width;
    const height = el.radarCanvas.height;
    if (width === 0 || height === 0) return;

    radarCtx.clearRect(0, 0, width, height);

    // Background grid & radar rings
    radarCtx.fillStyle = '#070c17';
    radarCtx.fillRect(0, 0, width, height);

    if (!state.bounds) {
      radarCtx.fillStyle = '#64748b';
      radarCtx.font = '14px Inter';
      radarCtx.textAlign = 'center';
      radarCtx.fillText('Select an aircraft to visualize radar flight paths', width / 2, height / 2);
      return;
    }

    // World to Screen Projection
    const b = state.bounds;
    const midLon = (b.min_lon + b.max_lon) / 2;
    const midLat = (b.min_lat + b.max_lat) / 2;
    const spanLon = Math.max(0.2, b.max_lon - b.min_lon);
    const spanLat = Math.max(0.2, b.max_lat - b.min_lat);

    // Keep aspect ratio
    const scale = Math.min(width / spanLon, height / spanLat) * 0.85 * state.mapZoom;

    function project(lon, lat) {
      const x = width / 2 + (lon - midLon) * scale + state.mapPan.x;
      const y = height / 2 - (lat - midLat) * scale * 1.35 + state.mapPan.y;
      return [x, y];
    }

    // Draw Radar Range Rings around JFK
    const jfk = state.airports.find(a => a.code === 'JFK') || { longitude: -73.7789, latitude: 40.6398 };
    const [jfkX, jfkY] = project(jfk.longitude, jfk.latitude);

    radarCtx.strokeStyle = 'rgba(56, 189, 248, 0.12)';
    radarCtx.lineWidth = 1;
    radarCtx.setLineDash([4, 4]);

    [10, 25, 50].forEach(nm => {
      const r = (nm / 60) * scale * 1.15;
      radarCtx.beginPath();
      radarCtx.arc(jfkX, jfkY, r, 0, Math.PI * 2);
      radarCtx.stroke();

      radarCtx.fillStyle = 'rgba(56, 189, 248, 0.4)';
      radarCtx.font = '9px JetBrains Mono';
      radarCtx.textAlign = 'left';
      radarCtx.fillText(`${nm} NM (JFK)`, jfkX + 4, jfkY - r + 10);
    });

    radarCtx.setLineDash([]);

    // Draw Flight Paths for all selected sessions
    state.sessionsData.forEach((session, sIdx) => {
      const isFocused = session.id === state.focusedSessionId;
      const points = session.points;
      const samples = session.phase_samples || [];
      if (!points || points.length < 2) return;

      const sessionColor = SESSION_COLORS[sIdx % SESSION_COLORS.length];

      // Draw trajectory segments
      radarCtx.lineCap = 'round';
      radarCtx.lineJoin = 'round';

      for (let i = 0; i < points.length - 1; i++) {
        const [x0, y0] = project(points[i][0], points[i][1]);
        const [x1, y1] = project(points[i + 1][0], points[i + 1][1]);

        radarCtx.beginPath();
        radarCtx.moveTo(x0, y0);
        radarCtx.lineTo(x1, y1);

        if (state.colorMode === 'session') {
          radarCtx.strokeStyle = isFocused ? sessionColor : 'rgba(100, 116, 139, 0.45)';
          radarCtx.lineWidth = isFocused ? 3 : 1.5;
        } else {
          // Color by predicted flight phase
          const ph = samples[i]?.phase || 'unknown';
          const baseColor = PHASE_COLORS[ph] || '#9aa9bd';
          radarCtx.strokeStyle = isFocused ? baseColor : 'rgba(148, 163, 184, 0.4)';
          radarCtx.lineWidth = isFocused ? 3.5 : 1.8;
        }

        radarCtx.stroke();
      }

      // Draw manual tag overlay brackets if enabled
      if (state.showTagsOverlay && session.manual_tags) {
        session.manual_tags.forEach(t => {
          radarCtx.strokeStyle = '#facc15';
          radarCtx.lineWidth = 5;
          radarCtx.setLineDash([3, 3]);

          for (let i = 0; i < samples.length - 1; i++) {
            const tSample = samples[i].time_s;
            if (tSample >= t.t_start_s && tSample <= t.t_end_s) {
              const [x0, y0] = project(points[i][0], points[i][1]);
              const [x1, y1] = project(points[i + 1][0], points[i + 1][1]);
              radarCtx.beginPath();
              radarCtx.moveTo(x0, y0);
              radarCtx.lineTo(x1, y1);
              radarCtx.stroke();
            }
          }
          radarCtx.setLineDash([]);
        });
      }
    });

    // Draw Airports
    if (state.showAirports) {
      state.airports.forEach(apt => {
        const [ax, ay] = project(apt.longitude, apt.latitude);
        radarCtx.fillStyle = '#38bdf8';
        radarCtx.fillRect(ax - 3, ay - 3, 6, 6);

        radarCtx.fillStyle = '#e2e8f0';
        radarCtx.font = 'bold 10px JetBrains Mono';
        radarCtx.textAlign = 'center';
        radarCtx.fillText(apt.code, ax, ay - 6);
      });
    }

    // Draw Active Aircraft Positions
    state.sessionsData.forEach((session, sIdx) => {
      const isFocused = session.id === state.focusedSessionId;
      const interp = interpolatePointAtTime(session, state.t);
      if (!interp) return;

      const [acX, acY] = project(interp.lon, interp.lat);

      // Follow focused aircraft if toggle is active
      if (isFocused && state.followAircraft) {
        state.mapPan.x = width / 2 - (interp.lon - midLon) * scale;
        state.mapPan.y = height / 2 + (interp.lat - midLat) * scale * 1.35;
      }

      // Aircraft symbol (triangle oriented by heading)
      radarCtx.save();
      radarCtx.translate(acX, acY);
      radarCtx.rotate((interp.heading * Math.PI) / 180);

      const symbolColor = isFocused ? '#fff' : SESSION_COLORS[sIdx % SESSION_COLORS.length];
      radarCtx.fillStyle = symbolColor;
      radarCtx.beginPath();
      radarCtx.moveTo(0, -9);
      radarCtx.lineTo(6, 7);
      radarCtx.lineTo(0, 4);
      radarCtx.lineTo(-6, 7);
      radarCtx.closePath();
      radarCtx.fill();

      // Outer glow for focused aircraft
      if (isFocused) {
        radarCtx.strokeStyle = '#38bdf8';
        radarCtx.lineWidth = 2;
        radarCtx.stroke();
      }

      radarCtx.restore();

      // Callout tag next to aircraft
      if (isFocused) {
        radarCtx.fillStyle = 'rgba(15, 23, 42, 0.9)';
        radarCtx.strokeStyle = '#38bdf8';
        radarCtx.lineWidth = 1;
        radarCtx.strokeRect(acX + 12, acY - 14, 110, 26);
        radarCtx.fillRect(acX + 12, acY - 14, 110, 26);

        radarCtx.fillStyle = '#fff';
        radarCtx.font = 'bold 9.5px JetBrains Mono';
        radarCtx.textAlign = 'left';
        radarCtx.fillText(`${session.aircraft} (${session.id})`, acX + 16, acY - 2);

        radarCtx.fillStyle = PHASE_COLORS[interp.phase] || '#38bdf8';
        radarCtx.font = '9px JetBrains Mono';
        radarCtx.fillText(`${Math.round(interp.alt)}ft · ${interp.phase}`, acX + 16, acY + 9);
      }
    });
  }

  // Render Synchronized Timeline Ribbons & Altitude Chart
  function updateTimelineAndRibbons() {
    renderPhaseRibbons();
    renderAltitudeChart();
    updateTimelineSelectionBox();
  }

  function renderPhaseRibbons() {
    el.predictedRibbon.innerHTML = '';
    el.manualRibbon.innerHTML = '';

    const session = state.sessionsData.find(s => s.id === state.focusedSessionId) || state.sessionsData[0];
    if (!session || state.maxT <= 0) return;

    // 1. Predicted Phases Ribbon
    const intervals = session.phase_intervals || [];
    intervals.forEach(int => {
      const s = int.start_sample_s;
      const e = int.end_sample_s;
      const leftRatio = (s / state.maxT) * 100;
      const widthRatio = Math.max(0.5, ((e - s) / state.maxT) * 100);

      const seg = document.createElement('div');
      seg.className = 'ribbon-seg';
      seg.style.left = `${leftRatio}%`;
      seg.style.width = `${widthRatio}%`;
      seg.style.backgroundColor = PHASE_COLORS[int.phase] || '#687588';
      seg.title = `Predicted: ${int.phase} (${Math.round(s)}s - ${Math.round(e)}s)`;

      seg.addEventListener('click', () => {
        el.tagTStart.value = Math.floor(s);
        el.tagTEnd.value = Math.ceil(e);
        updateTimelineSelectionBox();
        seekTime(s);
      });

      el.predictedRibbon.appendChild(seg);
    });

    // 2. Manual Tags Ribbon
    const tags = state.manualTags.filter(t => t.session_id === session.id);
    tags.forEach(t => {
      const leftRatio = (t.t_start_s / state.maxT) * 100;
      const widthRatio = Math.max(0.5, ((t.t_end_s - t.t_start_s) / state.maxT) * 100);

      const seg = document.createElement('div');
      seg.className = 'ribbon-seg';
      seg.style.left = `${leftRatio}%`;
      seg.style.width = `${widthRatio}%`;
      seg.style.backgroundColor = PHASE_COLORS[t.manual_phase] || '#facc15';
      seg.style.border = '1px solid #fff';
      seg.title = `Manual: ${t.manual_phase} [${t.confidence}] (${t.t_start_s}s - ${t.t_end_s}s): ${t.notes}`;

      seg.addEventListener('click', () => {
        el.tagTStart.value = Math.floor(t.t_start_s);
        el.tagTEnd.value = Math.ceil(t.t_end_s);
        updateTimelineSelectionBox();
        seekTime(t.t_start_s);
      });

      el.manualRibbon.appendChild(seg);
    });
  }

  function renderAltitudeChart() {
    const width = el.altitudeCanvas.width;
    const height = el.altitudeCanvas.height;
    if (width === 0 || height === 0) return;

    altCtx.clearRect(0, 0, width, height);

    const session = state.sessionsData.find(s => s.id === state.focusedSessionId) || state.sessionsData[0];
    if (!session || !session.points || session.points.length < 2) return;

    const points = session.points;
    const samples = session.phase_samples || [];

    // Altitude range
    let minAlt = 0;
    let maxAlt = Math.max(1000, ...points.map(p => p[2]));
    maxAlt = Math.ceil(maxAlt / 5000) * 5000;

    // Draw horizontal altitude grid lines
    altCtx.strokeStyle = 'rgba(35, 53, 82, 0.6)';
    altCtx.lineWidth = 1;

    for (let alt = 5000; alt <= maxAlt; alt += 5000) {
      const y = height - (alt / maxAlt) * height * 0.85 - 10;
      altCtx.beginPath();
      altCtx.moveTo(0, y);
      altCtx.lineTo(width, y);
      altCtx.stroke();

      altCtx.fillStyle = '#64748b';
      altCtx.font = '9px JetBrains Mono';
      altCtx.textAlign = 'left';
      altCtx.fillText(`${alt / 1000}k ft`, 6, y - 2);
    }

    // Gradient fill under altitude curve
    const gradient = altCtx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(56, 189, 248, 0.35)');
    gradient.addColorStop(1, 'rgba(56, 189, 248, 0.0)');

    altCtx.beginPath();
    altCtx.moveTo(0, height);

    for (let i = 0; i < points.length; i++) {
      const t = samples[i]?.time_s || 0;
      const alt = points[i][2];
      const x = (t / state.maxT) * width;
      const y = height - (alt / maxAlt) * height * 0.85 - 10;

      if (i === 0) altCtx.lineTo(x, y);
      else altCtx.lineTo(x, y);
    }

    altCtx.lineTo(width, height);
    altCtx.closePath();
    altCtx.fillStyle = gradient;
    altCtx.fill();

    // Draw segment colored altitude stroke
    altCtx.lineWidth = 2.5;
    for (let i = 0; i < points.length - 1; i++) {
      const t0 = samples[i]?.time_s || 0;
      const t1 = samples[i + 1]?.time_s || 0;
      const alt0 = points[i][2];
      const alt1 = points[i + 1][2];

      const x0 = (t0 / state.maxT) * width;
      const y0 = height - (alt0 / maxAlt) * height * 0.85 - 10;
      const x1 = (t1 / state.maxT) * width;
      const y1 = height - (alt1 / maxAlt) * height * 0.85 - 10;

      const ph = samples[i]?.phase || 'unknown';
      altCtx.strokeStyle = PHASE_COLORS[ph] || '#38bdf8';

      altCtx.beginPath();
      altCtx.moveTo(x0, y0);
      altCtx.lineTo(x1, y1);
      altCtx.stroke();
    }
  }

  // Manual Tagging Operations
  async function loadManualTags() {
    if (!state.selectedAircraft) return;
    try {
      const resp = await fetch(`/api/tags?aircraft=${state.selectedAircraft}`);
      if (resp.ok) {
        state.manualTags = await resp.json();
        renderTagsList();
        updateTimelineAndRibbons();
        renderRadar();
      }
    } catch (err) {
      console.error(err);
    }
  }

  function renderTagsList() {
    el.tagsList.innerHTML = '';
    el.tagsCount.textContent = state.manualTags.length;

    if (state.manualTags.length === 0) {
      el.tagsList.innerHTML = '<div class="empty-hint">No manual tags applied to this aircraft yet.</div>';
      return;
    }

    state.manualTags.forEach(tag => {
      const item = document.createElement('div');
      item.className = 'tag-item';

      const phaseColor = PHASE_COLORS[tag.manual_phase] || '#9aa9bd';

      item.innerHTML = `
        <div class="tag-item-info">
          <span class="tag-badge" style="border-left: 3px solid ${phaseColor};">${tag.manual_phase}</span>
          <span class="mono">${Math.round(tag.t_start_s)}s-${Math.round(tag.t_end_s)}s</span>
          <span style="color:var(--text-dim);">(${tag.session_id})</span>
        </div>
        <div class="tag-actions">
          <button class="btn-micro btn-jump" title="Jump to this tag">Jump</button>
          <button class="btn-tag-del" title="Delete tag">✕</button>
        </div>
      `;

      item.querySelector('.btn-jump').addEventListener('click', () => {
        state.focusedSessionId = tag.session_id;
        el.tagTargetSession.value = tag.session_id;
        seekTime(tag.t_start_s);
        updateTimelineAndRibbons();
      });

      item.querySelector('.btn-tag-del').addEventListener('click', async () => {
        await deleteManualTag(tag.tag_id);
      });

      el.tagsList.appendChild(item);
    });
  }

  async function applyManualTag() {
    const sid = el.tagTargetSession.value || state.focusedSessionId;
    if (!sid) {
      alert('Please select a target session.');
      return;
    }

    const tStart = parseFloat(el.tagTStart.value) || 0;
    const tEnd = parseFloat(el.tagTEnd.value) || 0;
    if (tEnd <= tStart) {
      alert('End time must be greater than start time.');
      return;
    }

    const payload = {
      session_id: sid,
      aircraft: state.selectedAircraft,
      t_start_s: tStart,
      t_end_s: tEnd,
      manual_phase: state.activeTagPhase,
      confidence: el.tagConfidence.value,
      notes: el.tagNotes.value.trim(),
    };

    try {
      const resp = await fetch('/api/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) throw new Error('Failed to save manual tag');
      await loadManualTags();

      // Clear notes & show brief success state
      el.btnApplyTag.innerHTML = '<span class="icon">✓</span> Saved!';
      setTimeout(() => {
        el.btnApplyTag.innerHTML = '<span class="icon">🏷️</span> Save Manual Tag';
      }, 1500);

    } catch (err) {
      console.error(err);
      alert('Error saving tag: ' + err.message);
    }
  }

  async function deleteManualTag(tagId) {
    if (!confirm('Delete this manual tag?')) return;
    try {
      const resp = await fetch(`/api/tags/${tagId}`, { method: 'DELETE' });
      if (resp.ok) {
        await loadManualTags();
      }
    } catch (err) {
      console.error(err);
    }
  }

  async function exportTags() {
    try {
      const resp = await fetch('/api/tags/export', { method: 'POST' });
      const res = await resp.json();
      alert(`Manual tags exported successfully! File saved at:\n${res.csv_path}\nTotal tags: ${res.tag_count}`);
    } catch (err) {
      alert('Failed to export tags: ' + err.message);
    }
  }

  // Refinement & Evaluation Studio Modal
  async function openEvalModal() {
    el.evalModal.classList.remove('hidden');
    el.evalSuggestionsBox.textContent = 'Running model heuristic evaluation...';

    try {
      const resp = await fetch(`/api/evaluate?aircraft=${state.selectedAircraft || ''}`);
      if (!resp.ok) throw new Error('Evaluation failed');
      const data = await resp.json();

      el.evalAgreementRate.textContent = `${data.agreement_rate_pct}%`;
      el.evalMatchedPoints.textContent = `${data.matching_points} / ${data.total_points_evaluated} points`;
      el.evalTotalTags.textContent = data.total_tags;
      el.evalTotalDisagreements.textContent = data.mismatching_points;

      // Suggestions
      el.evalSuggestionsBox.innerHTML = data.refinement_suggestions
        .map(s => `<p style="margin-bottom:6px;">🔹 ${s}</p>`)
        .join('');

      // Confusion matrix
      renderConfusionMatrix(data.confusion_matrix);

      // Disagreements
      renderDisagreementsTable(data.disagreements);
    } catch (err) {
      el.evalSuggestionsBox.textContent = 'Error computing evaluation: ' + err.message;
    }
  }

  function closeEvalModal() {
    el.evalModal.classList.add('hidden');
  }

  function renderConfusionMatrix(matrix) {
    const table = el.confusionMatrixTable;
    table.innerHTML = '';

    const manualPhases = Object.keys(matrix);
    if (manualPhases.length === 0) {
      table.innerHTML = '<tr><td colspan="4" class="empty-hint">No data evaluated yet.</td></tr>';
      return;
    }

    const predPhasesSet = new Set();
    manualPhases.forEach(m => {
      Object.keys(matrix[m]).forEach(p => predPhasesSet.add(p));
    });
    const predPhases = Array.from(predPhasesSet);

    // Header row
    const thead = document.createElement('thead');
    const hRow = document.createElement('tr');
    hRow.innerHTML = '<th>Manual Ground Truth ↓ / Predicted →</th>';
    predPhases.forEach(p => {
      hRow.innerHTML += `<th>${p}</th>`;
    });
    thead.appendChild(hRow);
    table.appendChild(thead);

    // Body rows
    const tbody = document.createElement('tbody');
    manualPhases.forEach(m => {
      const row = document.createElement('tr');
      row.innerHTML = `<td><strong>${m}</strong></td>`;
      predPhases.forEach(p => {
        const count = matrix[m][p] || 0;
        const isDiagonal = (m === p);
        const style = isDiagonal
          ? (count > 0 ? 'background:rgba(52, 211, 153, 0.2); font-weight:700;' : '')
          : (count > 0 ? 'background:rgba(248, 113, 113, 0.25); color:#fca5a5;' : '');
        row.innerHTML += `<td style="${style}">${count}</td>`;
      });
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
  }

  function renderDisagreementsTable(disagreements) {
    el.disagreementsBody.innerHTML = '';
    if (!disagreements || disagreements.length === 0) {
      el.disagreementsBody.innerHTML = '<tr><td colspan="7" class="empty-hint">No disagreements found in evaluated samples!</td></tr>';
      return;
    }

    disagreements.forEach(d => {
      const row = document.createElement('tr');
      const evidenceStr = Array.isArray(d.model_evidence) ? d.model_evidence.join(', ') : '';

      row.innerHTML = `
        <td class="mono">${Math.round(d.time_s)}s</td>
        <td class="mono">${Math.round(d.altitude_ft)} ft</td>
        <td style="color:${PHASE_COLORS[d.manual_phase] || '#fff'}; font-weight:600;">${d.manual_phase}</td>
        <td style="color:${PHASE_COLORS[d.predicted_phase] || '#f87171'}; font-weight:600;">${d.predicted_phase}</td>
        <td>${d.model_confidence}</td>
        <td style="font-size:10px; color:var(--text-muted);">${evidenceStr || d.model_detail || '—'}</td>
        <td style="font-size:10.5px;">${d.tag_notes || '—'}</td>
      `;
      el.disagreementsBody.appendChild(row);
    });
  }

  // Start app on DOMContentLoaded
  document.addEventListener('DOMContentLoaded', init);
})();

