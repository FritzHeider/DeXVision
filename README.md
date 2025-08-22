# DeXVision

DeXVision is a prototype 3D DevTools visualizer that transforms Chrome DevTools Protocol telemetry into an interactive Three.js scene. It offers a real-time view of network requests, runtime events, and performance metrics to help developers diagnose issues quickly.

## Features

- Connects to a local Chrome instance through the Chrome DevTools Protocol.
- Streams selected events (Network, Performance, Runtime) over WebSocket.
- Renders each request as an orbiting sphere whose colour, radius, and speed encode status, size, and duration.
- Extensible architecture to ingest more CDP domains or adapt to other browsers.

## Architecture

```
chrome --remote-debugging-port=9222
        │
        ▼
  chrome-remote-interface (server.js)
        │                     ▲
        ▼                     │
   WebSocket (port 8080) ────► client (Three.js)
        │                     ▲
        ▼                     │
   WebSocket clients       Developer's browser
```

## Getting Started

1. **Launch Chrome with remote debugging**

   ```bash
   chrome --remote-debugging-port=9222
   ```

2. **Install dependencies and start the server**

   ```bash
   npm install
   npm start
   ```

   Environment variables:

   - `ALLOWED_ORIGIN` – restricts WebSocket connections.
   - `SHARED_SECRET` – require a token via `?token=<your-token>`.

3. **Open the client**

   - Navigate to `public/index.html` directly or serve the folder, e.g.:

     ```bash
     npx http-server ./public
     ```

   - Open DevTools in the tab you want to inspect and interact with the page to see events visualised.

## Configuration

Connection retries to Chrome can be tuned with:

- `RETRY_INTERVAL_MS` – base delay between attempts (default `1000`).
- `MAX_RETRY_ATTEMPTS` – maximum retries before giving up (default `5`).

## Roadmap

- GPU instancing for thousands of events.
- Machine-learning powered anomaly detection.
- Cross-browser adapters for Firefox and Safari.
- Security features such as PII redaction and token-based auth.

## Disclaimer

This project is a proof of concept and not production-ready. Use at your own risk and feel free to contribute!

