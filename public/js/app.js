/*
 * app.js — OrbitViz WS + Three.js
 *
 * Real‑time request visualizer. Each network event becomes an orbiting sphere:
 *  • Colour encodes HTTP status (2xx green, 3xx blue, 4xx orange, 5xx red)
 *  • Radius encodes duration (slower/longer ⇒ farther out)
 *  • Exceptions flash the nucleus; performance metrics are logged/extendable
 *
 * Enterprise‑grade niceties:
 *  • Robust WS reconnect with exponential backoff + jitter
 *  • HTTPS → wss auto‑switch; host/port/path/token overridable via query or globals
 *  • Heartbeat/ping watchdog
 *  • Lightweight privacy: optional URL redaction (domain‑only)
 *  • Filters UI (domain substring, status classes, min duration)
 *  • Object pooling + capacity guard to avoid GPU death spirals
 *
 * Query params (or window globals like DEX_WS_*):
 *   host, port, path, proto (ws|wss), token, retryIntervalMs, maxBackoffMs,
 *   maxRetryAttempts (0 = infinite), heartbeatMs, redact (1=domain‑only)
 *
 * Requires THREE and (optionally) THREE.OrbitControls on the page.
 */

(() => {
  // ---------- Config --------------------------------------------------------
  const params = new URLSearchParams(window.location.search);
  const cfg = {
    host: params.get('host') || window.DEX_WS_HOST || window.location.hostname || 'localhost',
    port: params.get('port') || window.DEX_WS_PORT || '8080',
    path: params.get('path') || window.DEX_WS_PATH || '/ws',
    proto: (params.get('proto') || window.DEX_WS_PROTO || (location.protocol === 'https:' ? 'wss' : 'ws')).replace(':',''),
    token: params.get('token') || window.DEX_WS_TOKEN || '',
    retryBaseMs: parseInt(params.get('retryIntervalMs') || window.DEX_WS_RETRY_INTERVAL_MS || '1000', 10),
    maxBackoffMs: parseInt(params.get('maxBackoffMs') || window.DEX_WS_MAX_BACKOFF_MS || '16000', 10),
    maxAttempts: parseInt(params.get('maxRetryAttempts') || window.DEX_WS_MAX_RETRY_ATTEMPTS || '0', 10), // 0 = infinite
    heartbeatMs: parseInt(params.get('heartbeatMs') || window.DEX_WS_HEARTBEAT_MS || '15000', 10),
    redact: (params.get('redact') || window.DEX_WS_REDACT || '0') === '1',
  };

  const MAX_SPHERES = 1200; // soft cap for on‑screen requests

  // ---------- Three.js scene -----------------------------------------------
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);
  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000);
  camera.position.z = 30;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  document.body.appendChild(renderer.domElement);

  let controls = null;
  if (THREE.OrbitControls) {
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
  }

  // Nucleus
  const nucleus = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 32),
    new THREE.MeshPhongMaterial({ color: 0x00aaff })
  );
  scene.add(nucleus);

  // Lights
  scene.add(new THREE.AmbientLight(0x666666));
  const pointLight = new THREE.PointLight(0xffffff, 1);
  pointLight.position.set(50, 50, 50);
  scene.add(pointLight);

  // Data structures
  const requestMap = new Map(); // id -> mesh
  const requestOrder = [];       // FIFO for capacity guard
  const requestGroup = new THREE.Group();
  scene.add(requestGroup);

  // Materials & geometry
  const requestGeometry = new THREE.SphereGeometry(0.3, 16, 16);
  const materialCache = Object.create(null);
  function statusToColor(status) {
    if (status >= 200 && status < 300) return 0x00ff00;
    if (status >= 300 && status < 400) return 0x00aaff;
    if (status >= 400 && status < 500) return 0xffa500;
    if (status >= 500) return 0xff0000;
    return 0xaaaaaa;
  }
  function getStatusMaterial(status) {
    const color = statusToColor(status);
    if (!materialCache[color]) materialCache[color] = new THREE.MeshPhongMaterial({ color });
    return materialCache[color];
  }
  const spherePool = [];

  // Filters ---------------------------------------------------------------
  const filters = {
    domainSubstr: '',
    statusClasses: new Set(['2xx','3xx','4xx','5xx']),
    minDurationMs: 0,
    paused: false,
  };
  function statusClassOf(code) {
    if (typeof code !== 'number') return 'other';
    return `${Math.floor(code / 100)}xx`;
  }
  function eventPassesFilters(ev) {
    try {
      const url = ev.url || ev.href || '';
      if (filters.domainSubstr) {
        const host = safeHost(url);
        if (!host.includes(filters.domainSubstr.toLowerCase())) return false;
      }
      const sc = statusClassOf(ev.status);
      if (!filters.statusClasses.has(sc)) return false;
      const dur = durationMs(ev);
      if (dur < filters.minDurationMs) return false;
      return true;
    } catch { return true; }
  }

  // UI overlay ------------------------------------------------------------
  makeOverlay();
  function makeOverlay() {
    const wrap = document.createElement('div');
    wrap.style.position = 'fixed';
    wrap.style.top = '10px';
    wrap.style.left = '10px';
    wrap.style.padding = '10px 12px';
    wrap.style.background = 'rgba(0,0,0,0.55)';
    wrap.style.color = '#fff';
    wrap.style.font = '12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    wrap.style.borderRadius = '8px';
    wrap.style.backdropFilter = 'blur(4px)';
    wrap.style.userSelect = 'none';
    wrap.style.zIndex = '9999';
    wrap.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
        <strong>OrbitViz</strong>
        <span id="ov-status" style="padding:2px 6px;border-radius:6px;background:#333">INIT</span>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
        <label>Domain <input id="ov-domain" placeholder="contains…" style="width:140px"></label>
        <label>Min ms <input id="ov-minms" type="number" value="0" min="0" style="width:70px"></label>
        <label><input id="ov-2xx" type="checkbox" checked>2xx</label>
        <label><input id="ov-3xx" type="checkbox" checked>3xx</label>
        <label><input id="ov-4xx" type="checkbox" checked>4xx</label>
        <label><input id="ov-5xx" type="checkbox" checked>5xx</label>
        <button id="ov-pause">Pause</button>
        <button id="ov-clear">Clear</button>
      </div>`;
    document.body.appendChild(wrap);

    const statusEl = wrap.querySelector('#ov-status');
    const domEl = wrap.querySelector('#ov-domain');
    const minEl = wrap.querySelector('#ov-minms');
    const cb = (c) => wrap.querySelector(`#ov-${c}`);
    domEl.addEventListener('input', () => filters.domainSubstr = domEl.value.trim().toLowerCase());
    minEl.addEventListener('change', () => filters.minDurationMs = Math.max(0, Number(minEl.value)||0));
    ['2xx','3xx','4xx','5xx'].forEach(k => {
      cb(k.replace('xx','xx')).addEventListener('change', (e) => {
        if (e.target.checked) filters.statusClasses.add(k); else filters.statusClasses.delete(k);
      });
    });
    wrap.querySelector('#ov-pause').addEventListener('click', () => {
      filters.paused = !filters.paused;
      wrap.querySelector('#ov-pause').textContent = filters.paused ? 'Resume' : 'Pause';
    });
    wrap.querySelector('#ov-clear').addEventListener('click', clearAll);

    updateStatus('INIT');
    function updateStatus(text, color = '#333') {
      statusEl.textContent = text;
      statusEl.style.background = color;
    }
    // expose for WS status updates
    window.__ovUpdateStatus = updateStatus;
  }

  function clearAll() {
    requestOrder.splice(0);
    requestMap.forEach(mesh => { requestGroup.remove(mesh); spherePool.push(mesh); });
    requestMap.clear();
  }

  // Helpers ------------------------------------------------------------------
  function durationMs(ev) {
    const d = ev.duration || ev.time || ev.elapsed || ev.timing?.duration || 0;
    return Number(d) || 0;
  }
  function safeHost(urlStr) {
    try {
      const u = new URL(urlStr);
      return (cfg.redact ? u.hostname : u.host) || '';
    } catch { return ''; }
  }

  function createRequestSphere(ev) {
    let sphere = spherePool.pop() || new THREE.Mesh(requestGeometry, getStatusMaterial(ev.status));
    sphere.material = getStatusMaterial(ev.status);

    // Map duration → radius (5..28). Use encoded length as a fallback proxy.
    const dur = durationMs(ev);
    const proxy = ev.encodedDataLength || ev.transferSize || 0;
    const norm = dur > 0 ? Math.min(dur, 5000) / 5000 : Math.min(proxy, 200000) / 200000;
    const radius = 5 + norm * 23; // 5..28

    // Random initial angle & slight z offset
    const angle = Math.random() * Math.PI * 2;
    sphere.position.set(radius * Math.cos(angle), radius * Math.sin(angle), (Math.random() - 0.5) * 2);

    // Speed inversely related to duration; clamp so tiny requests still move
    const speed = 0.001 + 0.005 / Math.max(1, dur || proxy || 1);
    sphere.userData = { angle, radius, speed, id: ev.id || Math.random().toString(36).slice(2) };
    return sphere;
  }

  function updateRequests(deltaMs) {
    if (filters.paused) return;
    const dt = deltaMs;
    for (let i = 0; i < requestGroup.children.length; i++) {
      const s = requestGroup.children[i];
      const u = s.userData;
      u.angle += u.speed * dt;
      const a = u.angle;
      s.position.x = u.radius * Math.cos(a);
      s.position.y = u.radius * Math.sin(a);
    }
  }

  // Resize
  function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener('resize', onWindowResize);

  // ---------- WebSocket w/ reconnect & heartbeat ----------------------------
  let ws = null;
  let attempts = 0;
  let heartbeatTimer = null;
  let lastPong = Date.now();

  function wsUrl() {
    const q = new URLSearchParams();
    if (cfg.token) q.set('token', cfg.token);
    const qs = q.toString();
    const path = cfg.path.startsWith('/') ? cfg.path : `/${cfg.path}`;
    const hostPort = cfg.port ? `${cfg.host}:${cfg.port}` : cfg.host;
    return `${cfg.proto}://${hostPort}${path}${qs ? `?${qs}` : ''}`;
  }

  function scheduleReconnect() {
    attempts += 1;
    if (cfg.maxAttempts > 0 && attempts > cfg.maxAttempts) {
      window.__ovUpdateStatus?.('MAX RETRIES', '#7a0000');
      return;
    }
    const backoff = Math.min(cfg.maxBackoffMs, cfg.retryBaseMs * Math.pow(2, attempts - 1));
    const jitter = Math.random() * 250;
    const delay = backoff + jitter;
    window.__ovUpdateStatus?.(`RETRY in ${Math.round(delay)}ms`, '#7a5500');
    setTimeout(connect, delay);
  }

  function startHeartbeat() {
    clearInterval(heartbeatTimer);
    lastPong = Date.now();
    heartbeatTimer = setInterval(() => {
      try { ws?.send(JSON.stringify({ type: 'ping', t: Date.now() })); } catch {}
      if (Date.now() - lastPong > cfg.heartbeatMs * 2.5) {
        try { ws?.close(); } catch {}
      }
    }, cfg.heartbeatMs);
  }

  function connect() {
    try { ws?.close(); } catch {}
    const url = wsUrl();
    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      window.__ovUpdateStatus?.('CONNECTED', '#0b5');
      attempts = 0;
      startHeartbeat();
    });

    ws.addEventListener('close', () => {
      window.__ovUpdateStatus?.('DISCONNECTED', '#a33');
      scheduleReconnect();
    });

    ws.addEventListener('error', (e) => {
      console.error('WebSocket error', e);
      try { ws.close(); } catch {}
    });

    ws.addEventListener('message', (message) => {
      try {
        const ev = JSON.parse(message.data);
        if (ev.type === 'pong') { lastPong = Date.now(); return; }

        if (ev.kind === 'network') {
          if (!eventPassesFilters(ev)) return;

          // Capacity guard
          if (requestOrder.length >= MAX_SPHERES) {
            const oldestId = requestOrder.shift();
            const old = requestMap.get(oldestId);
            if (old) { requestGroup.remove(old); spherePool.push(old); requestMap.delete(oldestId); }
          }

          const sphere = createRequestSphere(ev);
          requestMap.set(sphere.userData.id, sphere);
          requestOrder.push(sphere.userData.id);
          requestGroup.add(sphere);
        } else if (ev.kind === 'networkFinish') {
          const id = ev.id;
          const m = id && requestMap.get(id);
          if (m) {
            requestGroup.remove(m);
            requestMap.delete(id);
            const idx = requestOrder.indexOf(id);
            if (idx >= 0) requestOrder.splice(idx, 1);
            spherePool.push(m);
          }
        } else if (ev.kind === 'exception') {
          nucleus.material.color.setHex(0xff0000);
          setTimeout(() => nucleus.material.color.setHex(0x00aaff), 300);
        } else if (ev.kind === 'performance') {
          // Extend: draw gauges/rings based on ev.metrics
          console.log('Performance metrics:', ev.metrics);
        }
      } catch (err) {
        console.error('Error processing event', err);
      }
    });
  }

  connect();

  // ---------- Render loop ---------------------------------------------------
  let lastTime = performance.now();
  function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    const delta = now - lastTime;
    lastTime = now;
    updateRequests(delta);
    controls?.update?.();
    renderer.render(scene, camera);
  }
  animate();

  // Pause render when tab hidden to save cycles
  document.addEventListener('visibilitychange', () => {
    renderer.setAnimationLoop(document.hidden ? null : animate);
  });

  // Expose minimal control surface for debugging/automation
  window.__orbitviz__ = {
    clear: clearAll,
    pause: () => (filters.paused = true),
    resume: () => (filters.paused = false),
    setDomainFilter: (s) => (filters.domainSubstr = String(s||'').toLowerCase()),
    setMinDuration: (ms) => (filters.minDurationMs = Math.max(0, Number(ms)||0)),
    setStatuses: (arr) => {
      filters.statusClasses = new Set(arr.filter(Boolean));
    },
    reconnect: () => connect(),
    cfg,
  };
})();
