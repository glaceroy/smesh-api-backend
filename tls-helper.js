'use strict';

const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const express = require('express');

const TLS_MODE    = (process.env.TLS_MODE  || 'mtls').toLowerCase();
const CERT_DIR    =  process.env.TLS_CERT_DIR  || '/etc/tls';
const CERT_FILE   = path.join(CERT_DIR, process.env.TLS_CERT_FILE || 'tls.crt');
const KEY_FILE    = path.join(CERT_DIR, process.env.TLS_KEY_FILE  || 'tls.key');
const CA_FILE     = path.join(CERT_DIR, process.env.TLS_CA_FILE   || 'ca.crt');
const PORT        = process.env.PORT        || 8443;
const HEALTH_PORT = process.env.HEALTH_PORT || 8080;

/** Health-check paths that bypass mTLS enforcement on the main server. */
const HEALTH_PATHS = new Set(['/health', '/healthz', '/readyz']);

// ─────────────────────────────────────────────────────────────────────────────

/** Read a cert file, throw a clear error if missing. */
function readCert(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`[TLS] ${label} not found at: ${filePath}`);
  }
  return fs.readFileSync(filePath);
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Middleware that enforces mTLS on every route EXCEPT health-check paths.
 *
 * Why not rejectUnauthorized:true at the TLS layer?
 * Node rejects the TCP handshake before the HTTP request is even parsed —
 * the Kubelet prober (no client cert) would get a TLS alert and fail.
 * Instead we set rejectUnauthorized:false so the handshake always completes,
 * then enforce the cert requirement here in userland.
 */
function mtlsEnforcer(req, res, next) {
  if (HEALTH_PATHS.has(req.path)) {
    return next();
  }

  if (!req.socket.authorized) {
    const reason = req.socket.authorizationError || 'No valid client certificate';
    console.warn(`[mTLS] Rejected ${req.method} ${req.path} — ${reason}`);
    return res.status(401).json({ error: 'mTLS required', reason });
  }

  next();
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attach a /whoami diagnostic route that returns client cert details.
 * Useful for debugging mTLS handshakes.
 */
function attachWhoami(app) {
  app.get('/whoami', (req, res) => {
    if (!req.socket.encrypted) {
      return res.json({ tls: false, message: 'Running in plain HTTP mode' });
    }
    const cert = req.socket.getPeerCertificate();
    if (!cert || !cert.subject) {
      return res.json({ tls: true, mtls: false, message: 'No client certificate presented' });
    }
    res.json({
      tls:    true,
      mtls:   true,
      client: {
        subject:     cert.subject,
        issuer:      cert.issuer,
        valid_from:  cert.valid_from,
        valid_to:    cert.valid_to,
        fingerprint: cert.fingerprint,
      },
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Spin up a dedicated plain HTTP server on HEALTH_PORT for Kubelet probes.
 *
 * Kubelet sends no client cert, so it cannot reach an mTLS port.
 * This server is intentionally minimal — it responds ONLY to health paths
 * and returns 404 for everything else, so there is no accidental data exposure.
 *
 * Kubernetes probe config:
 *   livenessProbe/readinessProbe:
 *     httpGet:
 *       path: /health
 *       port: 9090        ← plain HTTP, no TLS
 */
function startHealthServer(serviceName) {
  const ts         = () => new Date().toISOString();
  const healthApp  = express();

  healthApp.get(['/health', '/healthz', '/readyz'], (_req, res) => {
    res.json({ status: 'ok' });
  });

  healthApp.use((_req, res) => {
    res.status(404).json({ error: 'Not found on health port' });
  });

  const srv = http.createServer(healthApp);

  srv.listen(HEALTH_PORT, '0.0.0.0', () => {
    console.log(`[${ts()}] ${serviceName} health server  →  HTTP :${HEALTH_PORT}  (probes only)`);
  });

  srv.on('error', (err) => {
    console.error(`[${ts()}] Health server error: ${err.message}`);
    process.exit(1);
  });

  return srv;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * createServer(app, serviceName)
 *
 * Boots the main HTTP/HTTPS server and a dedicated plain-HTTP health server.
 * Returns { mainServer, healthServer }.
 *
 * Environment variables:
 *   TLS_MODE      "none" | "tls" | "mtls"   (default: "mtls")
 *   TLS_CERT_DIR  path to mounted Secret dir  (default: /etc/tls)
 *   TLS_CERT_FILE server certificate filename  (default: tls.crt)
 *   TLS_KEY_FILE  server private key filename  (default: tls.key)
 *   TLS_CA_FILE   CA certificate filename      (default: ca.crt)
 *   PORT          main listening port          (default: 8443)
 *   HEALTH_PORT   probe listening port         (default: 9090)
 */
function createServer(app, serviceName) {
  const ts = () => new Date().toISOString();

  // Stamp TLS mode onto every request for downstream logging
  app.use((req, _res, next) => {
    req._tlsMode = TLS_MODE;
    next();
  });

  // mTLS enforcer must be registered BEFORE app routes
  if (TLS_MODE === 'mtls') {
    app.use(mtlsEnforcer);
  }

  attachWhoami(app);

  let mainServer;
  let protocol;

  try {
    if (TLS_MODE === 'none') {
      // ── Plain HTTP ────────────────────────────────────────────────────────
      mainServer = http.createServer(app);
      protocol   = 'HTTP';

    } else if (TLS_MODE === 'tls') {
      // ── One-way TLS ───────────────────────────────────────────────────────
      mainServer = https.createServer({
        cert: readCert(CERT_FILE, 'Server certificate'),
        key:  readCert(KEY_FILE,  'Server private key'),
      }, app);
      protocol = 'HTTPS (one-way TLS)';

    } else if (TLS_MODE === 'mtls') {
      // ── Mutual TLS ────────────────────────────────────────────────────────
      // rejectUnauthorized is intentionally false here.
      // Enforcement is handled by mtlsEnforcer middleware above so that
      // the TLS handshake completes for all clients (including Kubelet probers
      // that present no cert) — the middleware then gates access per-route.
      mainServer = https.createServer({
        cert:               readCert(CERT_FILE, 'Server certificate'),
        key:                readCert(KEY_FILE,  'Server private key'),
        ca:                 readCert(CA_FILE,   'CA certificate'),
        requestCert:        true,
        rejectUnauthorized: false,
      }, app);
      protocol = 'HTTPS (mutual TLS — probe-safe)';

    } else {
      throw new Error(`Unknown TLS_MODE="${TLS_MODE}". Valid: none | tls | mtls`);
    }

    mainServer.listen(PORT, '0.0.0.0', () => {
      console.log(`[${ts()}] ${serviceName} main server    →  ${protocol}  :${PORT}  (TLS_MODE=${TLS_MODE})`);
      if (TLS_MODE !== 'none') {
        console.log(`[${ts()}] Cert dir: ${CERT_DIR}`);
      }
      if (TLS_MODE === 'mtls') {
        console.log(`[${ts()}] mTLS bypass paths: ${[...HEALTH_PATHS].join(', ')}`);
      }
    });

    mainServer.on('error', (err) => {
      console.error(`[${ts()}] Main server error: ${err.message}`);
      process.exit(1);
    });

  } catch (err) {
    console.error(`[${ts()}] Fatal startup error: ${err.message}`);
    process.exit(1);
  }

  // Always start the plain-HTTP health server regardless of TLS_MODE
  const healthServer = startHealthServer(serviceName);

  return { mainServer, healthServer };
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = { createServer, TLS_MODE, PORT, HEALTH_PORT };