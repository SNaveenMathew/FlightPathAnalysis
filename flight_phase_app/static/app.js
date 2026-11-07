/**
 * Flight Phase Explorer & Manual Tagging Studio
 * 3D Trajectory Animation & Manual Tagging Studio
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
    selectedAircraftIds: new Set(),
    selectedSessionIds: new Set(),
    focusedSessionId: null,
    sessionsData: [],
    allSessionsData: [],
    visible: [],
    bounds: null,
    allBounds: null,
    airports: [],
    allAirports: [],
    manualTags: [],
    manualTagLoadVersion: 0,
    activeTagPhase: 'approach',

    // Playback
    t: 0,
    maxT: 100,
    playing: false,
    speed: 10,
    loop: true,
    lastFrameTime: 0,

    // 3D Visualization Options
    viewMode: 'planar', // 'planar' (top-down lon, lat) or '3d' (isometric / rotated)
    verticalScale: 2.5, // vertical altitude scale factor
    colorMode: 'phase', // 'phase' or 'session'
    showAirports: true,
    showGroundTrack: true,
    showTagsOverlay: true,
    followAircraft: true,

    // Timeline Drag Selection
    isSelectingTimeline: false,
    timelineSelStartT: 0,
    timelineSelEndT: 0,
  };

  // DOM Elements
  const el = {
    selectionSummary: document.getElementById('selection-summary'),
    acSearchInput: document.getElementById('ac-search-input'),
    aircraftContainer: document.getElementById('aircraft-container'),
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

    btnViewPlanar: document.getElementById('btn-view-planar'),
    btnView3D: document.getElementById('btn-view-3d'),
    btnColorPhase: document.getElementById('btn-color-phase'),
    btnColorSession: document.getElementById('btn-color-session'),
    chkShowAirports: document.getElementById('chk-show-airports'),
    chkShowShadow: document.getElementById('chk-show-shadow'),
    chkShowTagsOverlay: document.getElementById('chk-show-tags-overlay'),
    btnZoomIn: document.getElementById('btn-zoom-in'),
    btnZoomOut: document.getElementById('btn-zoom-out'),
    btnZoomReset: document.getElementById('btn-zoom-reset'),
    btnFollowAc: document.getElementById('btn-follow-ac'),

    threeContainer: document.getElementById('three-container'),
    hudAlt: document.getElementById('hud-alt'),
    hudSpd: document.getElementById('hud-spd'),
    hudVs: document.getElementById('hud-vs'),
    hudPredPhase: document.getElementById('hud-pred-phase'),
    hudManualPhase: document.getElementById('hud-manual-phase'),

    predictedRibbon: document.getElementById('predicted-ribbon'),
    manualRibbon: document.getElementById('manual-ribbon'),
    altitudeCanvas: document.getElementById('altitude-canvas'),
    altitudeTooltip: document.getElementById('altitude-tooltip'),
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

  const altCtx = el.altitudeCanvas.getContext('2d');

  // Three.js Objects
  let renderer = null;
  let scene = null;
  let camera = null;
  let groundGroup = null;
  let trajectoriesGroup = null;
  let aircraftGroup = null;
  let airportSpritesGroup = null;
  let aircraftMeshes = new Map(); // sessionId -> { mesh, dropLine, sprite }
  let trajectoryObjects = [];

  // Anchor & Geographic projection reference (JFK)
  const REF_ORIGIN = { lon: -73.7789, lat: 40.6398 };
  const KM_PER_LAT = 111.32;
  const KM_PER_LON = 111.32 * Math.cos((REF_ORIGIN.lat * Math.PI) / 180.0);

  // 3D Orbit Camera Controller
  const orbit = {
    target: new THREE.Vector3(0, 0, 0),
    theta: 0,            // Azimuth angle around Y axis
    phi: 0.001,          // Polar angle from Y axis (0.001 = Planar Top-Down looking straight down)
    radius: 180,         // Distance from target
    dragging: false,
    dragButton: 0,       // 0 = left (rotate), 2 = right (pan)
    lastX: 0,
    lastY: 0,
    isPlanar: true,

    setPlanar() {
      this.phi = 0.001;
      this.theta = 0;
      this.isPlanar = true;
      state.viewMode = 'planar';
      if (el.btnViewPlanar) el.btnViewPlanar.classList.add('active');
      if (el.btnView3D) el.btnView3D.classList.remove('active');
      this.update();
    },

    set3D() {
      this.phi = Math.PI / 3.4; // ~53° elevation
      this.theta = 0.55;        // slight angle
      this.isPlanar = false;
      state.viewMode = '3d';
      if (el.btnView3D) el.btnView3D.classList.add('active');
      if (el.btnViewPlanar) el.btnViewPlanar.classList.remove('active');
      this.update();
    },

    update() {
      if (!camera) return;
      const sinPhi = Math.sin(this.phi);
      const cosPhi = Math.cos(this.phi);

      camera.position.set(
        this.target.x + this.radius * sinPhi * Math.sin(this.theta),
        this.target.y + this.radius * cosPhi,
        this.target.z + this.radius * sinPhi * Math.cos(this.theta)
      );

      // In pure planar top-down view (looking down along -Y), set camera.up to North (0, 0, -1)
      if (this.phi < 0.05) {
        camera.up.set(0, 0, -1);
      } else {
        camera.up.set(0, 1, 0);
      }

      camera.lookAt(this.target);
    },
  };

  // Convert (lon, lat, alt_ft) to 3D Cartesian coordinates
  function worldTo3D(lon, lat, altFt, midLon, midLat) {
    const x = (lon - midLon) * KM_PER_LON;
    // Y is Altitude in km * vertical scale
    const y = ((altFt || 0) * 0.0003048) * state.verticalScale;
    // Z is Latitude (North is -Z, South is +Z)
    const z = -(lat - midLat) * KM_PER_LAT;
    return new THREE.Vector3(x, y, z);
  }

  // Initialization
  async function init() {
    initThreeScene();
    setupEventListeners();
    handleResize();
    window.addEventListener('resize', handleResize);

    try {
      el.selectionSummary.textContent = 'Loading aircraft list...';
      const resp = await fetch('/api/aircraft');
      if (!resp.ok) throw new Error('Failed to fetch aircraft list');
      state.aircraftList = await resp.json();

      const sessionIds = state.aircraftList.flatMap((aircraft) => aircraft.session_ids || []);
      if (sessionIds.length === 0) throw new Error('No sessions are available');

      const sessionsResp = await fetch('/api/sessions/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_ids: sessionIds }),
      });
      if (!sessionsResp.ok) throw new Error('Failed to fetch all sessions');

      const allData = await sessionsResp.json();
      state.allSessionsData = allData.sessions;
      state.allBounds = allData.bounds;
      state.allAirports = allData.airports || [];
      populateAirportFilter(document.getElementById('source-airport'), 'src', 'Origin');
      populateAirportFilter(document.getElementById('destination-airport'), 'dest', 'Destination');
      regroup();

      const firstAircraft = state.aircraftList[0]?.aircraft;
      if (firstAircraft) {
        state.selectedAircraftIds = new Set([firstAircraft]);
        state.selectedAircraft = firstAircraft;
        state.selectedSessionIds = new Set(
          state.allSessionsData
            .filter((session) => session.aircraft === firstAircraft)
            .map((session) => session.id),
        );
        renderAircraftList(state.aircraftList);
        renderSessionCards();
        updateAircraftSummary();
        regroup();
        updateSelectedSessions();
        await loadManualTags();
      }
    } catch (err) {
      console.error(err);
      el.selectionSummary.textContent = 'Error connecting to server. Is backend running?';
    }

    requestAnimationFrame(animationLoop);
  }

  // Initialize Three.js 3D WebGL Scene
  function initThreeScene() {
    const container = el.threeContainer;
    const width = container.clientWidth || 800;
    const height = container.clientHeight || 500;

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    renderer.setClearColor('#070c17', 1);
    container.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x070c17, 0.0007);

    // Perspective camera
    camera = new THREE.PerspectiveCamera(46, width / Math.max(1, height), 0.1, 4000);

    // Ambient and directional lighting for 3D depth
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
    dirLight.position.set(100, 200, 100);
    scene.add(dirLight);

    // Groups for organized rendering
    groundGroup = new THREE.Group();
    trajectoriesGroup = new THREE.Group();
    aircraftGroup = new THREE.Group();
    airportSpritesGroup = new THREE.Group();

    scene.add(groundGroup);
    scene.add(trajectoriesGroup);
    scene.add(aircraftGroup);
    scene.add(airportSpritesGroup);

    // Start in Planar Top-Down View (Requirement: "Show the (lon, lat) planar view at first")
    orbit.setPlanar();
  }

  // Setup Event Listeners
  function setupEventListeners() {
    document.querySelectorAll(
      '#filters input[data-kind], #source-airport, #destination-airport',
    ).forEach((control) => control.addEventListener('change', regroup));

    // Aircraft search
    el.acSearchInput.addEventListener('input', (e) => {
      renderAircraftList(getFilteredAircraftList());
    });

    // Sessions Selection buttons
    el.btnSelectAllSessions.addEventListener('click', () => {
      state.selectedSessionIds = new Set(
        state.allSessionsData
          .filter((session) => state.selectedAircraftIds.has(session.aircraft))
          .map((session) => session.id),
      );
      syncSessionCheckboxes();
      regroup();
      updateSelectedSessions();
    });

    el.btnSelectNoneSessions.addEventListener('click', () => {
      state.selectedSessionIds.clear();
      syncSessionCheckboxes();
      state.focusedSessionId = null;
      regroup();
      updateSelectedSessions();
    });

    // 2D Planar vs 3D Orbit View Toggles
    if (el.btnViewPlanar) {
      el.btnViewPlanar.addEventListener('click', () => {
        orbit.setPlanar();
      });
    }

    if (el.btnView3D) {
      el.btnView3D.addEventListener('click', () => {
        orbit.set3D();
      });
    }

    // Color mode toggle
    el.btnColorPhase.addEventListener('click', () => {
      state.colorMode = 'phase';
      el.btnColorPhase.classList.add('active');
      el.btnColorSession.classList.remove('active');
      rebuild3DScene();
    });

    el.btnColorSession.addEventListener('click', () => {
      state.colorMode = 'session';
      el.btnColorSession.classList.add('active');
      el.btnColorPhase.classList.remove('active');
      rebuild3DScene();
    });

    // Toggles
    el.chkShowAirports.addEventListener('change', (e) => {
      state.showAirports = e.target.checked;
      if (airportSpritesGroup) airportSpritesGroup.visible = state.showAirports;
    });

    if (el.chkShowShadow) {
      el.chkShowShadow.addEventListener('change', (e) => {
        state.showGroundTrack = e.target.checked;
        rebuild3DScene();
      });
    }

    el.chkShowTagsOverlay.addEventListener('change', (e) => {
      state.showTagsOverlay = e.target.checked;
      rebuild3DScene();
    });

    el.btnFollowAc.addEventListener('click', () => {
      state.followAircraft = !state.followAircraft;
      el.btnFollowAc.classList.toggle('active', state.followAircraft);
    });

    // Zoom and Camera Controls
    el.btnZoomIn.addEventListener('click', () => {
      orbit.radius = Math.max(15, orbit.radius * 0.8);
      orbit.update();
    });
    el.btnZoomOut.addEventListener('click', () => {
      orbit.radius = Math.min(1000, orbit.radius * 1.25);
      orbit.update();
    });
    el.btnZoomReset.addEventListener('click', () => {
      orbit.target.set(0, 0, 0);
      orbit.radius = 180;
      if (state.viewMode === 'planar') orbit.setPlanar();
      else orbit.set3D();
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
    const defaultPhaseBtn = el.phaseButtonsGrid.querySelector('[data-phase="approach"]');
    if (defaultPhaseBtn) defaultPhaseBtn.classList.add('selected');

    el.btnApplyTag.addEventListener('click', applyManualTag);

    // Target session dropdown
    el.tagTargetSession.addEventListener('change', (e) => {
      const session = state.allSessionsData.find((candidate) => candidate.id === e.target.value);
      if (session) focusSession(session);
    });

    // 3D Mouse & Orbit Interaction (Rotate, Pan, Zoom, Click)
    const dom = renderer.domElement;
    let mouseDownPos = { x: 0, y: 0 };

    dom.addEventListener('contextmenu', (e) => e.preventDefault());

    dom.addEventListener('pointerdown', (e) => {
      orbit.dragging = true;
      orbit.dragButton = e.button; // 0 = rotate, 2 = pan
      orbit.lastX = e.clientX;
      orbit.lastY = e.clientY;
      mouseDownPos = { x: e.clientX, y: e.clientY };
      dom.setPointerCapture(e.pointerId);
    });

    dom.addEventListener('pointermove', (e) => {
      if (!orbit.dragging) return;
      const dx = e.clientX - orbit.lastX;
      const dy = e.clientY - orbit.lastY;
      orbit.lastX = e.clientX;
      orbit.lastY = e.clientY;

      if (orbit.dragButton === 0) {
        // Orbit Rotate (Left Button)
        orbit.theta -= dx * 0.006;
        orbit.phi = Math.max(0.001, Math.min(Math.PI / 2 - 0.02, orbit.phi + dy * 0.006));

        // When tilted away from top-down, update view mode indicator to 3D Orbit
        if (orbit.phi > 0.08) {
          orbit.isPlanar = false;
          state.viewMode = '3d';
          if (el.btnView3D) el.btnView3D.classList.add('active');
          if (el.btnViewPlanar) el.btnViewPlanar.classList.remove('active');
        } else {
          orbit.isPlanar = true;
          state.viewMode = 'planar';
          if (el.btnViewPlanar) el.btnViewPlanar.classList.add('active');
          if (el.btnView3D) el.btnView3D.classList.remove('active');
        }

        orbit.update();
      } else if (orbit.dragButton === 2) {
        // Pan Target (Right Button)
        state.followAircraft = false;
        el.btnFollowAc.classList.remove('active');

        const panSpeed = orbit.radius * 0.0012;
        const forward = new THREE.Vector3();
        camera.getWorldDirection(forward);
        const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
        const up = new THREE.Vector3().crossVectors(right, forward).normalize();

        orbit.target.addScaledVector(right, -dx * panSpeed);
        orbit.target.addScaledVector(up, dy * panSpeed);
        orbit.update();
      }
    });

    dom.addEventListener('pointerup', (e) => {
      orbit.dragging = false;
      if (dom.hasPointerCapture(e.pointerId)) {
        dom.releasePointerCapture(e.pointerId);
      }

      // Detect click (not drag) for 3D trajectory segment picking
      if (Math.hypot(e.clientX - mouseDownPos.x, e.clientY - mouseDownPos.y) < 5) {
        handle3DClick(e);
      }
    });

    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 0.9 : 1.1;
      orbit.radius = Math.max(10, Math.min(1200, orbit.radius * zoomFactor));
      orbit.update();
    }, { passive: false });

    // Timeline Canvas Drag-to-Select & Hover
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

    // Altitude Chart Hover Tooltip
    el.altitudeCanvas.addEventListener('mousemove', (e) => {
      if (state.isSelectingTimeline || !el.altitudeTooltip) return;
      const rect = el.altitudeCanvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, mouseX / rect.width));
      const tHover = ratio * state.maxT;

      const session = state.sessionsData.find(s => s.id === state.focusedSessionId) || state.sessionsData[0];
      if (!session) {
        el.altitudeTooltip.style.display = 'none';
        return;
      }

      const interp = interpolatePointAtTime(session, tHover);
      if (!interp) {
        el.altitudeTooltip.style.display = 'none';
        return;
      }

      const min = Math.floor(tHover / 60);
      const sec = Math.floor(tHover % 60);
      el.altitudeTooltip.innerHTML = `
        <strong>${min}m ${sec}s (${Math.round(tHover)}s)</strong> ·
        ALT: ${Math.round(interp.alt).toLocaleString()}ft ·
        <span style="color:${PHASE_COLORS[interp.phase] || '#fff'}; font-weight:700;">${interp.phase.toUpperCase()}</span>
        ${interp.speed != null ? `· ${Math.round(interp.speed)} kts` : ''}
      `;
      el.altitudeTooltip.style.display = 'block';
      el.altitudeTooltip.style.left = `${Math.min(rect.width - 230, Math.max(10, mouseX - 70))}px`;
    });

    el.altitudeCanvas.addEventListener('mouseleave', () => {
      if (el.altitudeTooltip) el.altitudeTooltip.style.display = 'none';
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

  // Handle Resize
  function handleResize() {
    const container = el.threeContainer;
    if (renderer && camera && container) {
      const width = container.clientWidth || 800;
      const height = container.clientHeight || 500;
      renderer.setSize(width, height);
      camera.aspect = width / Math.max(1, height);
      camera.updateProjectionMatrix();
    }

    const aRect = el.altitudeCanvas.parentElement.getBoundingClientRect();
    el.altitudeCanvas.width = aRect.width * window.devicePixelRatio;
    el.altitudeCanvas.height = aRect.height * window.devicePixelRatio;

    renderAltitudeChart();
  }

  // Render searchable aircraft multi-select
  function renderAircraftList(list) {
    el.aircraftContainer.innerHTML = '';
    list.forEach(a => {
      const card = document.createElement('div');
      const isSelected = state.selectedAircraftIds.has(a.aircraft);
      card.className = `session-card aircraft-card ${isSelected ? 'active' : ''}`;
      card.dataset.aircraft = a.aircraft;
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = isSelected;
      checkbox.setAttribute('aria-label', `Select aircraft ${a.aircraft}`);

      const info = document.createElement('div');
      info.className = 'session-info';
      const title = document.createElement('div');
      title.className = 'session-title-row';
      const aircraftId = document.createElement('span');
      aircraftId.className = 'session-id';
      aircraftId.textContent = a.aircraft;
      const sessionCount = document.createElement('span');
      sessionCount.className = 'badge-kind';
      sessionCount.textContent = `${a.session_count} session${a.session_count === 1 ? '' : 's'}`;
      title.append(aircraftId, sessionCount);

      const routes = document.createElement('div');
      routes.className = 'session-sub-row';
      routes.textContent = a.routes.slice(0, 2).join(', ') || 'Routes unavailable';
      info.append(title, routes);
      card.append(checkbox, info);

      checkbox.addEventListener('change', (event) => {
        event.stopPropagation();
        toggleAircraftSelection(a.aircraft, checkbox.checked);
      });
      card.addEventListener('click', (event) => {
        if (event.target.tagName === 'INPUT') return;
        checkbox.checked = !checkbox.checked;
        toggleAircraftSelection(a.aircraft, checkbox.checked);
      });
      el.aircraftContainer.appendChild(card);
    });
  }

  function toggleAircraftSelection(aircraftId, selected) {
    const aircraftSessionIds = state.allSessionsData
      .filter((session) => session.aircraft === aircraftId)
      .map((session) => session.id);

    if (selected) {
      state.selectedAircraftIds.add(aircraftId);
      aircraftSessionIds.forEach((sessionId) => state.selectedSessionIds.add(sessionId));
      state.selectedAircraft = aircraftId;
    } else {
      state.selectedAircraftIds.delete(aircraftId);
      aircraftSessionIds.forEach((sessionId) => state.selectedSessionIds.delete(sessionId));
      if (state.selectedAircraft === aircraftId) {
        state.selectedAircraft = state.selectedAircraftIds.values().next().value || null;
      }
    }

    if (!state.selectedSessionIds.has(state.focusedSessionId)) {
      state.focusedSessionId = state.selectedSessionIds.values().next().value || null;
    }
    const aircraftCard = [...el.aircraftContainer.children]
      .find((card) => card.dataset.aircraft === aircraftId);
    if (aircraftCard) {
      aircraftCard.classList.toggle('active', selected);
      aircraftCard.querySelector('input[type="checkbox"]').checked = selected;
    }
    renderSessionCards();
    updateAircraftSummary();
    regroup();
    updateSelectedSessions();
    loadManualTags();
  }

  function getFilteredAircraftList() {
    const query = el.acSearchInput.value.toLowerCase().trim();
    return state.aircraftList.filter((aircraft) =>
      aircraft.aircraft.toLowerCase().includes(query) ||
      aircraft.routes.some((route) => route.toLowerCase().includes(query)),
    );
  }

  function updateAircraftSummary() {
    const aircraft = state.aircraftList.filter((item) =>
      state.selectedAircraftIds.has(item.aircraft),
    );
    const sessions = state.allSessionsData.filter((session) =>
      state.selectedAircraftIds.has(session.aircraft),
    );
    const routes = new Set(sessions.map((session) => `${session.src || '?'}->${session.dest || '?'}`));
    state.selectedAircraft = aircraft.some((item) => item.aircraft === state.selectedAircraft)
      ? state.selectedAircraft
      : (aircraft[0]?.aircraft || null);
    el.metaAcId.textContent = aircraft.length
      ? `${aircraft.length} aircraft selected`
      : 'None';
    el.metaAcSessions.textContent = `${sessions.length} sessions`;
    el.metaAcRoutes.textContent = [...routes].slice(0, 3).join(', ') || '-';
  }

  // Render Session Cards
  function renderSessionCards() {
    el.sessionsContainer.innerHTML = '';
    const sessions = state.allSessionsData.filter((session) =>
      state.selectedAircraftIds.has(session.aircraft),
    );
    sessions.forEach(sess => {
      const card = document.createElement('div');
      card.className = `session-card ${state.selectedSessionIds.has(sess.id) ? 'active' : ''} ${sess.id === state.focusedSessionId ? 'focused' : ''}`;
      card.dataset.id = sess.id;

      const isChecked = state.selectedSessionIds.has(sess.id);
      const durSeconds = sess.duration_s || sess.t_max || 0;
      const minDuration = Math.floor(durSeconds / 60);
      const secDuration = Math.round(durSeconds % 60);
      const durStr = `${minDuration}m ${secDuration}s`;
      const routeStr = `${sess.src || '—'} → ${sess.dest || '—'}`;
      const phaseCounts = (sess.phase_samples || []).reduce((counts, sample) => {
        counts[sample.phase || 'unknown'] = (counts[sample.phase || 'unknown'] || 0) + 1;
        return counts;
      }, {});
      const dominantPhase = sess.dominant_phase ||
        Object.entries(phaseCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
      const manualTagCount = state.manualTags.filter((tag) => tag.session_id === sess.id).length;

      card.innerHTML = `
        <input type="checkbox" id="chk-${sess.id}" ${isChecked ? 'checked' : ''}>
        <div class="session-info">
          <div class="session-title-row">
            <span class="badge-kind">${sess.aircraft}</span>
            <span class="session-id">${sess.id}</span>
            <span class="badge-kind ${sess.complete_kind}">${sess.complete_kind || sess.session_type}</span>
            ${manualTagCount > 0 ? `<span class="badge-kind" style="background:#065f46;color:#6ee7b7;">${manualTagCount} Tag${manualTagCount > 1 ? 's' : ''}</span>` : ''}
          </div>
          <div class="session-sub-row">
            <span>Route: <strong>${routeStr}</strong></span>
            <span>·</span>
            <span>${sess.n_points || sess.points?.length || 0} pts (${durStr})</span>
            <span>·</span>
            <span style="color:${PHASE_COLORS[dominantPhase] || '#fff'};">● ${dominantPhase}</span>
          </div>
        </div>
        <button class="session-focus-btn" title="Focus 3D camera & timeline on this session">Focus</button>
      `;

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
        if (!state.selectedSessionIds.has(state.focusedSessionId)) {
          state.focusedSessionId = state.selectedSessionIds.values().next().value || null;
        }
        syncSessionCheckboxes();
        regroup();
        updateSelectedSessions();
      });

      card.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.classList.contains('session-focus-btn')) return;
        chk.checked = !chk.checked;
        chk.dispatchEvent(new Event('change'));
      });

      card.querySelector('.session-focus-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        state.focusedSessionId = sess.id;
        state.selectedAircraft = sess.aircraft;
        el.tagTargetSession.value = sess.id;
        updateAircraftSummary();
        updateTimelineAndRibbons();
        renderAltitudeChart();
        syncSessionFocusHighlight();
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

  function syncSessionFocusHighlight() {
    el.sessionsContainer.querySelectorAll('.session-card').forEach(card => {
      card.classList.toggle('focused', card.dataset.id === state.focusedSessionId);
    });
  }

  function populateTagSessionDropdown() {
    el.tagTargetSession.innerHTML = '';
    state.sessionsData.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.aircraft} · ${s.id} (${s.src || '?'} → ${s.dest || '?'})`;
      if (s.id === state.focusedSessionId) opt.selected = true;
      el.tagTargetSession.appendChild(opt);
    });
  }

  function populateAirportFilter(select, key, label) {
    const values = new Set();
    let hasUnspecified = false;
    for (const session of state.allSessionsData) {
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

  function regroup() {
    if (!state.allSessionsData.length) return;

    const enabledKinds = new Set(
      [...document.querySelectorAll('#filters input[data-kind]:checked')]
        .map((input) => input.dataset.kind),
    );
    const source = document.getElementById('source-airport').value;
    const destination = document.getElementById('destination-airport').value;
    const airportMatches = (value, selected) => {
      if (selected === '*') return true;
      const airport = String(value || '').trim();
      return selected === '__unspecified__' ? !airport : airport === selected;
    };

    state.visible = state.allSessionsData.filter((session) =>
      enabledKinds.has(session.complete_kind) &&
      airportMatches(session.src, source) &&
      airportMatches(session.dest, destination) &&
      state.selectedAircraftIds.has(session.aircraft) &&
      state.selectedSessionIds.has(session.id),
    );
    populateTagSessionDropdown();
    rebuild3DScene();
  }

  function updateSelectedSessions() {
    state.sessionsData = state.allSessionsData.filter((session) =>
      state.selectedAircraftIds.has(session.aircraft) &&
      state.selectedSessionIds.has(session.id),
    );
    state.bounds = state.allBounds;
    state.airports = state.allAirports;
    const durations = state.sessionsData.map((session) =>
      Number(session.duration_s || session.t_max) || 0,
    );
    state.maxT = Math.max(60, ...durations);
    state.t = Math.min(state.t, state.maxT);
    el.timeScrubber.max = state.maxT;

    if (!state.selectedSessionIds.has(state.focusedSessionId)) {
      state.focusedSessionId = state.sessionsData[0]?.id || null;
    }
    if (state.focusedSessionId) el.tagTargetSession.value = state.focusedSessionId;

    populateTagSessionDropdown();
    updateHeaderSummary();
    seekTime(state.t);
    updateTimelineAndRibbons();
    rebuild3DScene();
    renderAltitudeChart();
  }

  function updateHeaderSummary() {
    const totalSessions = state.allSessionsData.filter((session) =>
      state.selectedAircraftIds.has(session.aircraft),
    ).length;
    const aircraftCount = state.selectedAircraftIds.size;
    el.selectionSummary.textContent = `${aircraftCount} aircraft · ${state.sessionsData.length} of ${totalSessions} sessions selected`;
  }

  // Rebuild 3D Scene (Ground grid, radar rings, 3D trajectory lines, airport markers)
  function rebuild3DScene() {
    if (!scene) return;

    // Clear existing dynamic objects
    while (groundGroup.children.length > 0) {
      groundGroup.remove(groundGroup.children[0]);
    }
    while (trajectoriesGroup.children.length > 0) {
      trajectoriesGroup.remove(trajectoriesGroup.children[0]);
    }
    while (airportSpritesGroup.children.length > 0) {
      airportSpritesGroup.remove(airportSpritesGroup.children[0]);
    }
    aircraftMeshes.clear();
    while (aircraftGroup.children.length > 0) {
      aircraftGroup.remove(aircraftGroup.children[0]);
    }
    trajectoryObjects = [];

    if (!(state.allBounds || state.bounds) || state.visible.length === 0) return;

    const b = state.allBounds || state.bounds;
    const midLon = (b.min_lon + b.max_lon) / 2;
    const midLat = (b.min_lat + b.max_lat) / 2;

    // 1. Ground Grid (Aesthetic: dark navy radar style)
    const grid = new THREE.GridHelper(300, 30, 0x243650, 0x111c2e);
    grid.position.y = 0;
    groundGroup.add(grid);

    // 2. Concentric Radar Range Rings on the ground around JFK
    const airports = state.allAirports.length ? state.allAirports : state.airports;
    const jfkApt = airports.find(a => a.code === 'JFK') || { longitude: -73.7789, latitude: 40.6398 };
    const jfkPos = worldTo3D(jfkApt.longitude, jfkApt.latitude, 0, midLon, midLat);

    [10, 25, 50].forEach(nm => {
      const radiusKm = nm * 1.852;
      const segments = 64;
      const ringGeom = new THREE.BufferGeometry();
      const ringPts = [];

      for (let i = 0; i <= segments; i++) {
        const theta = (i / segments) * Math.PI * 2;
        ringPts.push(
          jfkPos.x + Math.sin(theta) * radiusKm,
          0.05,
          jfkPos.z + Math.cos(theta) * radiusKm
        );
      }
      ringGeom.setAttribute('position', new THREE.Float32BufferAttribute(ringPts, 3));
      const ringMat = new THREE.LineDashedMaterial({
        color: 0x38bdf8,
        dashSize: 3,
        gapSize: 2,
        transparent: true,
        opacity: 0.35,
      });
      const ringLine = new THREE.Line(ringGeom, ringMat);
      ringLine.computeLineDistances();
      groundGroup.add(ringLine);

      // Distance label sprite
      const distSprite = createTextSprite(`${nm} NM (JFK)`, '#0d192a', '#38bdf8', '#233552');
      distSprite.position.set(jfkPos.x + 4, 0.2, jfkPos.z - radiusKm);
      distSprite.scale.set(8, 2, 1);
      groundGroup.add(distSprite);
    });

    // 3. Airport Ground Markers and Labels
    airports.forEach(apt => {
      const aptPos = worldTo3D(apt.longitude, apt.latitude, 0, midLon, midLat);

      // Glowing pad
      const padGeom = new THREE.CylinderGeometry(1.2, 1.2, 0.3, 16);
      const padMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
      const pad = new THREE.Mesh(padGeom, padMat);
      pad.position.set(aptPos.x, 0.15, aptPos.z);
      groundGroup.add(pad);

      // Floating airport label badge
      const aptSprite = createTextSprite(apt.code, '#0f172a', '#38bdf8', '#38bdf8');
      aptSprite.position.set(aptPos.x, 3.5, aptPos.z);
      aptSprite.scale.set(7, 2.2, 1);
      airportSpritesGroup.add(aptSprite);
    });

    // 4. 3D Flight Trajectories
    state.visible.forEach((session, sIdx) => {
      const isFocused = session.id === state.focusedSessionId;
      const points = session.points || [];
      const samples = session.phase_samples || [];
      if (points.length < 2) return;

      const sessionColor = new THREE.Color(SESSION_COLORS[sIdx % SESSION_COLORS.length]);

      const positions = [];
      const colors = [];
      const groundPositions = [];

      for (let i = 0; i < points.length; i++) {
        const pt = points[i];
        const v3 = worldTo3D(pt[0], pt[1], pt[2], midLon, midLat);

        positions.push(v3.x, v3.y, v3.z);
        groundPositions.push(v3.x, 0.05, v3.z);

        if (state.colorMode === 'session') {
          colors.push(sessionColor.r, sessionColor.g, sessionColor.b);
        } else {
          const ph = samples[i]?.phase || 'unknown';
          const phColor = new THREE.Color(PHASE_COLORS[ph] || '#9aa9bd');
          colors.push(phColor.r, phColor.g, phColor.b);
        }
      }

      // 3D Path Line
      const trajGeom = new THREE.BufferGeometry();
      trajGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      trajGeom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

      const trajMat = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: isFocused ? 1.0 : 0.45,
        linewidth: isFocused ? 3 : 1.5,
      });

      const trajLine = new THREE.Line(trajGeom, trajMat);
      trajLine.userData = { sessionId: session.id };
      trajectoriesGroup.add(trajLine);
      trajectoryObjects.push(trajLine);

      // Ground Shadow Track (beneath the 3D path)
      if (state.showGroundTrack) {
        const shadowGeom = new THREE.BufferGeometry();
        shadowGeom.setAttribute('position', new THREE.Float32BufferAttribute(groundPositions, 3));
        const shadowMat = new THREE.LineBasicMaterial({
          color: isFocused ? 0x38bdf8 : 0x1e293b,
          transparent: true,
          opacity: isFocused ? 0.4 : 0.2,
          linewidth: 1,
        });
        const shadowLine = new THREE.Line(shadowGeom, shadowMat);
        trajectoriesGroup.add(shadowLine);
      }

      // Manual Tag Highlights in 3D (Gold glow along tagged segments)
      if (state.showTagsOverlay && session.manual_tags) {
        session.manual_tags.forEach(t => {
          const tagPositions = [];
          for (let i = 0; i < samples.length; i++) {
            const tSample = samples[i].time_s;
            if (tSample >= t.t_start_s && tSample <= t.t_end_s) {
              const pt = points[i];
              const v3 = worldTo3D(pt[0], pt[1], pt[2], midLon, midLat);
              tagPositions.push(v3.x, v3.y, v3.z);
            }
          }

          if (tagPositions.length >= 6) {
            const tagGeom = new THREE.BufferGeometry();
            tagGeom.setAttribute('position', new THREE.Float32BufferAttribute(tagPositions, 3));
            const tagMat = new THREE.LineBasicMaterial({
              color: 0xfacc15,
              linewidth: 5,
              transparent: true,
              opacity: 0.95,
            });
            const tagLine = new THREE.Line(tagGeom, tagMat);
            trajectoriesGroup.add(tagLine);
          }
        });
      }

      // Create 3D Aircraft Model for this session
      const acModel = create3DAircraftModel(isFocused ? 0xffffff : sessionColor.getHex());
      aircraftGroup.add(acModel);

      // Vertical altitude drop line from aircraft to ground
      const dropGeom = new THREE.BufferGeometry();
      dropGeom.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
      const dropMat = new THREE.LineDashedMaterial({
        color: 0x38bdf8,
        dashSize: 1,
        gapSize: 0.5,
        transparent: true,
        opacity: isFocused ? 0.6 : 0.25,
      });
      const dropLine = new THREE.Line(dropGeom, dropMat);
      aircraftGroup.add(dropLine);

      // Floating aircraft HUD callout sprite
      const calloutSprite = createTextSprite(`${session.aircraft}`, '#0f172a', '#ffffff', '#38bdf8');
      calloutSprite.scale.set(10, 2.8, 1);
      calloutSprite.visible = isFocused;
      aircraftGroup.add(calloutSprite);

      aircraftMeshes.set(session.id, {
        mesh: acModel,
        dropLine,
        sprite: calloutSprite,
        session,
      });
    });

    // Update 3D Camera Focus position
    const focusedSession = state.sessionsData.find(s => s.id === state.focusedSessionId) || state.sessionsData[0];
    if (focusedSession && focusedSession.points.length > 0) {
      const midIdx = Math.floor(focusedSession.points.length / 2);
      const midPt = focusedSession.points[midIdx];
      const targetPos = worldTo3D(midPt[0], midPt[1], 0, midLon, midLat);
      orbit.target.set(targetPos.x, 0, targetPos.z);
      orbit.update();
    }
  }

  // Create 3D Stylized Aircraft Model
  function create3DAircraftModel(colorHex) {
    const group = new THREE.Group();

    // Fuselage
    const fuseGeom = new THREE.CylinderGeometry(0.35, 0.45, 3.8, 8);
    fuseGeom.rotateZ(Math.PI / 2);
    const fuseMat = new THREE.MeshStandardMaterial({
      color: colorHex,
      roughness: 0.4,
      metalness: 0.6,
    });
    const fuse = new THREE.Mesh(fuseGeom, fuseMat);
    group.add(fuse);

    // Nose Cone
    const noseGeom = new THREE.ConeGeometry(0.38, 1.1, 8);
    noseGeom.rotateZ(-Math.PI / 2);
    const noseMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8 });
    const nose = new THREE.Mesh(noseGeom, noseMat);
    nose.position.x = 2.4;
    group.add(nose);

    // Main Wings (swept back)
    const wingGeom = new THREE.BoxGeometry(1.2, 0.08, 4.2);
    const wingMat = new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.4 });
    const wing = new THREE.Mesh(wingGeom, wingMat);
    wing.position.set(0.2, 0.0, 0);
    group.add(wing);

    // Tail Fin
    const tailGeom = new THREE.BoxGeometry(0.8, 1.1, 0.08);
    const tailMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8 });
    const tail = new THREE.Mesh(tailGeom, tailMat);
    tail.position.set(-1.4, 0.6, 0);
    group.add(tail);

    group.scale.set(1.4, 1.4, 1.4);
    return group;
  }

  // Helper: Create Text Sprite Badge
  function createTextSprite(text, bgColor = '#0f172a', textColor = '#ffffff', borderColor = '#38bdf8') {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');

    // Rounded card background
    ctx.fillStyle = bgColor;
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(4, 4, 248, 56, 10);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = textColor;
    ctx.font = 'bold 24px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 32);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: texture, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.renderOrder = 999;
    return sprite;
  }

  // Handle Click on 3D Trajectory (Raycasting)
  function handle3DClick(event) {
    if (!camera || trajectoryObjects.length === 0) return;

    const rect = renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );

    const raycaster = new THREE.Raycaster();
    raycaster.params.Line = { threshold: 4.0 };
    raycaster.setFromCamera(mouse, camera);

    const intersects = raycaster.intersectObjects(trajectoryObjects);
    if (intersects.length > 0) {
      const hit = intersects[0];
      const sid = hit.object.userData.sessionId;
      if (sid) {
        const session = state.visible.find((candidate) => candidate.id === sid);
        if (session) focusSession(session, hit.point);
      }
    }
  }

  async function focusSession(session, hitPoint) {
    state.selectedAircraft = session.aircraft;
    state.focusedSessionId = session.id;
    el.tagTargetSession.value = session.id;
    updateAircraftSummary();
    updateTimelineAndRibbons();
    renderAltitudeChart();
    if (hitPoint) {
      const b = state.allBounds || state.bounds;
      const midLon = (b.min_lon + b.max_lon) / 2;
      const midLat = (b.min_lat + b.max_lat) / 2;
      let nearestTime = 0;
      let minDSq = Infinity;

      session.points.forEach((point, index) => {
        const position = worldTo3D(point[0], point[1], point[2], midLon, midLat);
        const distanceSq = position.distanceToSquared(hitPoint);
        if (distanceSq < minDSq) {
          minDSq = distanceSq;
          nearestTime = session.phase_samples[index]?.time_s || 0;
        }
      });
      seekTime(nearestTime);
    }

    updateTimelineAndRibbons();
    syncSessionFocusHighlight();
    rebuild3DScene();
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
    update3DAircraftPositions();
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
    } else {
      state.lastFrameTime = timestamp;
    }

    update3DAircraftPositions();

    if (renderer && scene && camera) {
      renderer.render(scene, camera);
    }

    requestAnimationFrame(animationLoop);
  }

  // Update 3D Aircraft Positions, Orientations, and Altitude Drop Lines
  function update3DAircraftPositions() {
    if (!(state.allBounds || state.bounds) || state.visible.length === 0) return;

    const b = state.allBounds || state.bounds;
    const midLon = (b.min_lon + b.max_lon) / 2;
    const midLat = (b.min_lat + b.max_lat) / 2;

    aircraftMeshes.forEach(({ mesh, dropLine, sprite, session }, sid) => {
      const isFocused = sid === state.focusedSessionId;
      const interp = interpolatePointAtTime(session, state.t);
      if (!interp) return;

      const pos = worldTo3D(interp.lon, interp.lat, interp.alt, midLon, midLat);
      mesh.position.copy(pos);

      // Orientation in 3D: orient along flight direction vector
      if (interp.nextPos) {
        const next3D = worldTo3D(interp.nextPos[0], interp.nextPos[1], interp.nextPos[2], midLon, midLat);
        const dir = new THREE.Vector3().subVectors(next3D, pos).normalize();
        if (dir.lengthSq() > 0.001) {
          // Align fuselage (+X) along travel direction
          const targetRot = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
          mesh.quaternion.slerp(targetRot, 0.4);
        }
      } else {
        mesh.rotation.y = -(interp.heading * Math.PI) / 180;
      }

      // Check if session has concluded
      const isCompleted = state.t >= (session.duration_s || session.t_max || 0);
      mesh.traverse(child => {
        if (child.isMesh && child.material) {
          child.material.opacity = isCompleted ? 0.35 : (isFocused ? 1.0 : 0.65);
          child.material.transparent = true;
        }
      });

      // Update vertical drop line to ground
      const dropGeom = dropLine.geometry;
      const dropPositions = [pos.x, pos.y, pos.z, pos.x, 0.05, pos.z];
      dropGeom.setAttribute('position', new THREE.Float32BufferAttribute(dropPositions, 3));
      dropLine.computeLineDistances();
      dropLine.visible = !isCompleted;

      // Update floating callout sprite badge
      if (sprite) {
        sprite.visible = isFocused;
        sprite.position.set(pos.x, pos.y + 4.5, pos.z);
      }

      // Follow focused aircraft if active
      if (isFocused && state.followAircraft) {
        orbit.target.lerp(new THREE.Vector3(pos.x, 0, pos.z), 0.1);
        orbit.update();
      }
    });
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

    // Manual tag badge
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
      const nextP = points[1] || p;
      return {
        lon: p[0], lat: p[1], alt: p[2],
        phase: s.phase || 'unknown',
        speed: s.ground_speed,
        vs: s.flight_phase_vertical_rate_fpm,
        heading: 0,
        nextPos: nextP,
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

        const dLon = p1[0] - p0[0];
        const dLat = p1[1] - p0[1];
        const heading = (Math.atan2(dLon, dLat) * 180 / Math.PI + 360) % 360;

        return {
          lon, lat, alt,
          phase: samples[i].phase || 'unknown',
          speed: samples[i].ground_speed,
          vs: samples[i].flight_phase_vertical_rate_fpm,
          heading,
          nextPos: p1,
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
      nextPos: null,
    };
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
      const widthRatio = Math.max(0.4, ((e - s) / state.maxT) * 100);

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
      const widthRatio = Math.max(0.4, ((t.t_end_s - t.t_start_s) / state.maxT) * 100);

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

    let minAlt = 0;
    let maxAlt = Math.max(1000, ...points.map(p => p[2]));
    maxAlt = Math.ceil(maxAlt / 5000) * 5000;

    // Grid lines
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

    // Colored stroke along altitude curve
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
    const requestVersion = ++state.manualTagLoadVersion;
    const aircraftIds = [...state.selectedAircraftIds];
    if (aircraftIds.length === 0) {
      state.manualTags = [];
      renderTagsList();
      updateTimelineAndRibbons();
      rebuild3DScene();
      return;
    }

    try {
      const responses = await Promise.all(aircraftIds.map(async (aircraftId) => {
        const resp = await fetch(`/api/tags?aircraft=${encodeURIComponent(aircraftId)}`);
        if (!resp.ok) throw new Error(`Failed to load tags for aircraft ${aircraftId}`);
        return resp.json();
      }));
      if (requestVersion !== state.manualTagLoadVersion) return;

      state.manualTags = responses.flat();
      for (const session of state.allSessionsData) {
        session.manual_tags = state.manualTags.filter((tag) => tag.session_id === session.id);
      }
      renderSessionCards();
      renderTagsList();
      updateTimelineAndRibbons();
      rebuild3DScene();
    } catch (err) {
      console.error(err);
    }
  }

  function renderTagsList() {
    el.tagsList.innerHTML = '';
    el.tagsCount.textContent = state.manualTags.length;

    if (state.manualTags.length === 0) {
      el.tagsList.innerHTML = '<div class="empty-hint">No manual tags applied to the selected aircraft.</div>';
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
        const session = state.allSessionsData.find((candidate) => candidate.id === tag.session_id);
        if (!session) return;
        if (!state.selectedSessionIds.has(session.id)) {
          state.selectedSessionIds.add(session.id);
          renderSessionCards();
          regroup();
          updateSelectedSessions();
        }
        state.selectedAircraft = session.aircraft;
        state.focusedSessionId = tag.session_id;
        el.tagTargetSession.value = tag.session_id;
        seekTime(tag.t_start_s);
        updateAircraftSummary();
        updateTimelineAndRibbons();
        renderAltitudeChart();
        syncSessionFocusHighlight();
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
      aircraft: state.allSessionsData.find((session) => session.id === sid)?.aircraft || state.selectedAircraft,
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

      el.evalSuggestionsBox.innerHTML = data.refinement_suggestions
        .map(s => `<p style="margin-bottom:6px;">🔹 ${s}</p>`)
        .join('');

      renderConfusionMatrix(data.confusion_matrix);
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

    const thead = document.createElement('thead');
    const hRow = document.createElement('tr');
    hRow.innerHTML = '<th>Manual Ground Truth ↓ / Predicted →</th>';
    predPhases.forEach(p => {
      hRow.innerHTML += `<th>${p}</th>`;
    });
    thead.appendChild(hRow);
    table.appendChild(thead);

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
