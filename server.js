/* server.js
 * Real-time CDP -> WebSocket bridge (minimal, robust)
 *
 * Launch Chrome/Chromium with:  chrome --remote-debugging-port=9222
 *
 * ENV:
 *   CDP_PORT=9222
 *   WS_PORT=8080
 *   ALLOWED_ORIGIN=https://your.frontend.example
 *   SHARED_SECRET=supersecret
 *   RETRY_INTERVAL_MS=1000
 *   MAX_RETRY_ATTEMPTS=5
 */

'use strict';

const http = require('http');
const CDP = require('chrome-remote-interface');
const WebSocket = require('ws');
const { URL } = require('url');

// ---- Config ---------------------------------------------------------------
const CDP_PORT = parseInt(process.env.CDP_PORT || '9222', 10);
const WS_PORT = parseInt(process.env.WS_PORT || '8080', 10);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';     // optional
const SHARED_SECRET = process.env.SHARED_SECRET || '';       // optional
const RETRY_INTERVAL_MS = parseInt(process.env.RETRY_INTERVAL_MS || '1000', 10);
const MAX_RETRY_ATTEMPTS = parseInt(process.env.MAX_RETRY_ATTEMPTS || '5', 10);

// ---- HTTP server (for WS upgrade + /health) -------------------------------
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, cdpPort: CDP_PORT, wsPort: WS_PORT }));
    return;
  }
  res.writeHead(404).end();
});

// ---- WebSocket server (3D client connects here) --------------------------
// Verify incoming WebSocket upgrade requests before establishing a connection
const wss = new WebSocket.Server({
  server,
  verifyClient: (info, done) => {
    const origin = info.origin;
    const url = new URL(info.req.url ?? '/', 'http://localhost');
    const token = url.searchParams.get('token');

    if ((ALLOWED_ORIGIN && origin !== ALLOWED_ORIGIN) ||
        (SHARED_SECRET && token !== SHARED_SECRET)) {
      console.warn(`[${nowIso()}] WS rejected: remote=${info.req.socket.remoteAddress} origin=${origin}`);
      return done(false, 401, 'Unauthorized');
    }

    done(true);
  }
});

/** Track connected clients and ping/pong heartbeats */
const clients = new Set();
const HEARTBEAT_MS = 15_000;

function nowIso() { return new Date().toISOString(); }

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  clients.add(ws);
  console.log(`[${nowIso()}] WS client connected (count=${clients.size})`);

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[${nowIso()}] WS client disconnected (count=${clients.size})`);
  });

  ws.on('error', (err) => {
    console.warn(`[${nowIso()}] WS client error: ${err.message}`);
    clients.delete(ws);
    try {
      ws.terminate();
    } catch (closeErr) {
      console.error('Error terminating socket:', closeErr);
    }
  });
});

// Heartbeat to prune dead sockets
const heartbeat = setInterval(() => {
  for (const ws of clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      clients.delete(ws);
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, HEARTBEAT_MS);

// Broadcast helper with basic backpressure guard
function broadcast(event) {
  const payload = JSON.stringify(event);
  for (const ws of clients) {
    if (ws.readyState !== WebSocket.OPEN) {
      clients.delete(ws);
      continue;
    }
    try {
      ws.send(payload);
    } catch (err) {
      console.error('Error sending to client:', err);
      clients.delete(ws);
      try {
        ws.terminate();
      } catch (closeErr) {
        console.error('Error terminating socket:', closeErr);
      }
    }
  }
}

// ---- CDP attach / reattach logic -----------------------------------------
let cdpClient = null;
let shuttingDown = false;

/** Find a reasonable target (first page tab) */
async function findAttachableTarget() {
  const list = await CDP.List({ port: CDP_PORT });
  // Prefer type=page, not chrome://, not devtools
  const page = list.find(t =>
    (t.type === 'page' || t.type === 'background_page') &&
    t.url && !t.url.startsWith('devtools://') && !t.url.startsWith('chrome://')
  );
  return page || list[0];
}

async function attachToChromeWithRetry(label = 'initial') {
  let attempt = 0;
  while (!shuttingDown && attempt < MAX_RETRY_ATTEMPTS) {
    try {
      const target = await findAttachableTarget();
      if (!target) throw new Error('No debuggable targets found');

      console.log(`[${nowIso()}] Attaching to target (${label}): ${target.title || target.url}`);

      cdpClient = await CDP({ target, port: CDP_PORT });
      const { Network, Page, Runtime, Performance } = cdpClient;

      cdpClient.on('disconnect', () => {
        if (shuttingDown) return;
        console.warn(`[${nowIso()}] CDP disconnected. Reconnecting…`);
        // fire and forget reattach (no loop blocking)
        attachToChromeWithRetry('reconnect').catch(err =>
          console.error(`[${nowIso()}] Reconnect failed: ${err.message}`)
        );
      });

      // Enable domains (tuned buffers for lower overhead)
      await Promise.all([
        Network.enable({ maxTotalBufferSize: 65536, maxResourceBufferSize: 65536 }),
        Page.enable(),
        Runtime.enable(),
        Performance.enable(),
      ]);

      // Network events
      Network.responseReceived((params) => {
        const { requestId, response, type } = params;
        broadcast({
          kind: 'network',
          ts: Date.now(),
          id: requestId,
          url: response?.url,
          status: response?.status,
          type,
          protocol: response?.protocol,
          encodedDataLength: response?.encodedDataLength,
        });
      });

      Network.loadingFinished((params) => {
        const { requestId, encodedDataLength } = params;
        broadcast({
          kind: 'networkFinish',
          ts: Date.now(),
          id: requestId,
          encodedDataLength,
        });
      });

      // JS runtime exceptions
      Runtime.exceptionThrown((params) => {
        const d = params?.exceptionDetails || {};
        broadcast({
          kind: 'exception',
          ts: Date.now(),
          text: d.text,
          url: d.url,
          lineNumber: d.lineNumber,
          columnNumber: d.columnNumber,
        });
      });

      // Periodic performance metrics with self-scheduling guard
      let perfTimer = null;
      async function emitPerformanceMetrics() {
        if (!cdpClient || shuttingDown) return;
        try {
          const metrics = await Performance.getMetrics();
          broadcast({ kind: 'performance', ts: Date.now(), metrics: metrics.metrics });
        } catch (e) {
          // swallow transient errors (tab navigated, etc.)
        } finally {
          perfTimer = setTimeout(emitPerformanceMetrics, 1000);
        }
      }
      emitPerformanceMetrics();

      console.log(`[${nowIso()}] CDP attached. Broadcasting on ws://localhost:${WS_PORT}`);
      return; // success
    } catch (err) {
      attempt += 1;
      const delay = RETRY_INTERVAL_MS * Math.pow(2, attempt - 1);
      console.error(
        `[${nowIso()}] CDP connect failed (attempt ${attempt}/${MAX_RETRY_ATTEMPTS}): ${err.message}`
      );
      if (attempt >= MAX_RETRY_ATTEMPTS) {
        console.error(
          `[${nowIso()}] Exceeded max attempts. Ensure Chrome runs with --remote-debugging-port=${CDP_PORT}.`
        );
        break;
      }
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ---- Startup / Teardown ----------------------------------------------------
server.listen(WS_PORT, () => {
  console.log(`[${nowIso()}] WS listening on :${WS_PORT} (health: GET /health)`);
  attachToChromeWithRetry().catch(err =>
    console.error(`[${nowIso()}] Fatal CDP attach error: ${err.message}`)
  );
});

function shutdown(code = 0) {
  shuttingDown = true;
  console.log(`[${nowIso()}] Shutting down…`);
  clearInterval(heartbeat);
  try { if (cdpClient) cdpClient.close(); } catch {}
  for (const ws of clients) { try { ws.close(1001, 'Server shutdown'); } catch {} }
  server.close(() => process.exit(code));
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', (e) => {
  console.error(`[${nowIso()}] Uncaught exception:`, e);
  shutdown(1);
});
process.on('unhandledRejection', (e) => {
  console.error(`[${nowIso()}] Unhandled rejection:`, e);
  shutdown(1);
});
