/*
 * server.js
 *
 * This file implements a minimal Node.js service that attaches to the Chrome
 * DevTools Protocol (CDP) via the chrome-remote-interface library and
 * broadcasts a stream of instrumentation events to connected WebSocket clients.
 *
 * The goal of this project is to lay the foundations for a high‑performance,
 * real‑time visualization of what ordinarily hides behind the browser’s
 * developer tools. The architecture emphasises local‑first processing,
 * extensibility (new event types can be registered without restarting the
 * server) and clear separation between data ingestion and rendering.
 *
 * To use this prototype you must launch Chrome (or Chromium) with the
 * --remote-debugging-port flag, for example:
 *
 *   chrome --remote-debugging-port=9222
 *
 * By default the script attaches to the first tab. It listens for network
 * requests, page lifecycle events and performance metrics. Messages are
 * broadcast over a WebSocket connection on port 8080. The companion
 * client (see public/js/app.js) consumes these messages to animate a 3D
 * representation.
 */

const CDP = require('chrome-remote-interface');
const WebSocket = require('ws');

// Configuration
const CDP_PORT = process.env.CDP_PORT || 9222;
const WS_PORT = process.env.WS_PORT || 8080;

// Create a WebSocket server for clients (the 3D front‑end) to connect to.
const wss = new WebSocket.Server({ port: WS_PORT });

// Track connected clients
const clients = new Set();
wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('WebSocket client connected');
  ws.on('close', () => {
    clients.delete(ws);
  });
});

// Broadcast helper
function broadcast(event) {
  const payload = JSON.stringify(event);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

// Connect to the Chrome DevTools Protocol
async function attachToChrome() {
  try {
    const tabs = await CDP.List({ port: CDP_PORT });
    if (!tabs.length) {
      throw new Error('No tabs available for debugging');
    }
    const target = tabs[0];
    console.log(`Attaching to target: ${target.title}`);

    const client = await CDP({
      target,
      port: CDP_PORT,
    });
    const { Network, Page, Runtime, Performance } = client;

    // Enable domains we are interested in. More can be added here as the
    // product matures (e.g. DOM, CSS, Log, Security). Each domain comes with
    // additional overhead so selective enabling keeps the footprint low.
    await Promise.all([
      Network.enable({ maxTotalBufferSize: 65536, maxResourceBufferSize: 65536 }),
      Page.enable(),
      Runtime.enable(),
      Performance.enable(),
    ]);

    // Broadcast network request events. Only send essential fields to keep
    // bandwidth under control. This can be extended to include headers,
    // cookies, etc. Provide color code hints to the client.
    Network.responseReceived((params) => {
      const { requestId, response, loaderId, type } = params;
      broadcast({
        kind: 'network',
        id: requestId,
        url: response.url,
        status: response.status,
        type,
        protocol: response.protocol,
        encodedDataLength: response.encodedDataLength,
      });
    });

    Network.loadingFinished((params) => {
      const { requestId, encodedDataLength } = params;
      broadcast({
        kind: 'networkFinish',
        id: requestId,
        encodedDataLength,
      });
    });

    // Broadcast JavaScript runtime exceptions
    Runtime.exceptionThrown((params) => {
      broadcast({
        kind: 'exception',
        text: params.exceptionDetails.text,
        url: params.exceptionDetails.url,
        lineNumber: params.exceptionDetails.lineNumber,
        columnNumber: params.exceptionDetails.columnNumber,
      });
    });

    // Broadcast basic performance metrics periodically
    async function emitPerformanceMetrics() {
      const metrics = await Performance.getMetrics();
      broadcast({
        kind: 'performance',
        metrics: metrics.metrics,
      });
      setTimeout(emitPerformanceMetrics, 1000);
    }
    emitPerformanceMetrics();

    console.log(`Server ready. Navigate to http://localhost:${WS_PORT} in the client`);
  } catch (err) {
    console.error('Error connecting to Chrome:', err.message);
    console.error('Make sure Chrome is running with --remote-debugging-port=9222');
  }
}

attachToChrome();