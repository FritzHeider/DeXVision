# XVision Project

This repository contains a prototype implementation of the **XVision 3D DevTools Visualizer**, a tool designed to transform hidden browser telemetry into a real‑time, navigable 3D universe. The goal is to provide developers and performance engineers with instant visual insight into network activity, JavaScript execution and runtime metrics without having to wade through verbose text logs.

## Architecture Overview

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

1. **server.js** attaches to a running instance of Chrome via the **Chrome DevTools Protocol**. It enables selective domains (Network, Performance, Runtime) to minimise overhead and broadcasts a concise stream of events (requests, finishes, exceptions, metrics) via WebSocket.
2. **public/index.html** and **public/js/app.js** implement a rudimentary 3D renderer using **Three.js**. Each network request is visualised as a coloured sphere orbiting a central nucleus; the colour encodes HTTP status, and the orbit radius/speed map to payload size and duration. Exceptions flash the nucleus to attract attention. Performance metrics are logged and ready for custom gauges.

### Key Design Principles

* **Local‑first processing** – No network data ever leaves the machine. Events remain on the developer’s workstation, satisfying strict security and privacy requirements.
* **Modular ingestion** – Additional CDP domains (e.g. DOM events, CSS parsing, Security warnings) can be turned on without altering the rendering layer. Event objects include a `kind` field for easy dispatch on the client side.
* **Scalable rendering** – Although this prototype handles a modest number of spheres, the client code is structured to support GPU instancing and batching to render thousands of events per frame. See inline TODO comments for guidance.
* **Extensible controls** – The orbit controls allow users to explore the 3D scene. Additional UI (filters, search, heatmaps) can be layered on top to help manage complexity and avoid information overload.
* **Cross‑browser potential** – While Chrome is the first implementation target (due to the stability of its DevTools Protocol), the architecture supports adapters for Firefox (`Remote Debugging Protocol`) and Safari (`Web Inspector Protocol`).

## Running the Prototype

1. **Start Chrome with remote debugging enabled**

   ```bash
   chrome --remote-debugging-port=9222
   ```

2. **Install dependencies and start the server**

   ```bash
   cd xvision_project
   npm install
   npm start
   ```

   Optionally restrict incoming WebSocket connections by setting
   `ALLOWED_ORIGIN` to a specific origin or `SHARED_SECRET` to require a
   token. When using `SHARED_SECRET`, clients must include
   `?token=<your-token>` in the WebSocket URL.

3. **Open the client**

   Navigate to `file:///<path>/xvision_project/public/index.html` in any browser. For full functionality you may need to run a static server (e.g. `npx http-server ./public`).

4. **Open DevTools in the tab you wish to inspect** and interact with the page. You should see coloured orbits correspond to network requests, with exceptions causing a flash.

### Configuration

The server retries connections to Chrome when an initial attempt fails or a session disconnects. You can tune this behaviour with environment variables:

- `RETRY_INTERVAL_MS` – base delay in milliseconds between retry attempts (default `1000`).
- `MAX_RETRY_ATTEMPTS` – maximum number of attempts before giving up (default `5`).

The browser client will also retry the WebSocket connection to the server using exponential backoff. This can be configured via query parameters or global variables:

- `retryIntervalMs` (or `DEX_WS_RETRY_INTERVAL_MS`) – base delay between reconnection attempts in milliseconds (default `1000`).
- `maxRetryAttempts` (or `DEX_WS_MAX_RETRY_ATTEMPTS`) – maximum number of reconnection attempts before giving up (default `5`).

## Next Steps for a Production‑Ready Release

This prototype is a foundation. To achieve a 10/10 on all metrics, consider the following enhancements:

1. **Innovation & Differentiation** – Integrate anomaly detection powered by machine learning to highlight outliers, memory leaks and regressions. Patent the unique combination of event types and 3D mappings.
2. **Problem Severity / Outcome Lift** – Conduct user studies to quantify the reduction in debugging time. Add automated root‑cause suggestions and shareable trace exports.
3. **Monetization & Pricing Power** – Offer tiered subscriptions with advanced analytics, team dashboards and on‑prem deployment. Provide a free OSS tier to drive adoption.
4. **Scalability & Performance** – Implement GPU instancing for thousands of concurrent events; offload physics to web workers; compress and sample event streams; support remote debugging of mobile Safari/Firefox.
5. **Security & Privacy** – Add configurable redaction rules (strip PII from URLs), local encryption of trace files and compliance documentation (GDPR, SOC2).
6. **Enterprise Readiness** – Provide SSO (SAML/OAuth), fine‑grained role‑based access control, audit logging, and an on‑premises deployment mode using Docker/Kubernetes.
7. **Platform Risk Mitigation** – Abstract the CDP layer behind a domain interface so changes to Chrome DevTools Protocol require only a small adapter update. Implement adapters for Firefox and Edge.

## Disclaimer

This is a conceptual prototype intended for demonstration purposes. It is not production‑ready and has not been performance‑tuned. Use at your own risk. Contributions and feedback are welcome!# DeXVision
