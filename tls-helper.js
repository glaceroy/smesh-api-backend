/**
 * tls-helper.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared TLS / mTLS bootstrap module.
 * Used by all external APIs — import and call createServer(app, serviceName).
 *
 * Environment variables (set in Kubernetes Deployment / ConfigMap):
 *
 *   TLS_MODE      "none" | "tls" | "mtls"   (default: "mtls")
 *   TLS_CERT_DIR  path to mounted Secret dir  (default: /etc/tls)
 *   TLS_CERT_FILE server certificate filename  (default: tls.crt)
 *   TLS_KEY_FILE  server private key filename  (default: tls.key)
 *   TLS_CA_FILE   CA certificate filename      (default: ca.crt)  ← mTLS only
 *   PORT          listening port               (default: 8443)
 *
 * Kubernetes Secret layout (mounted at TLS_CERT_DIR):
 *   tls.crt  → server certificate  (PEM)
 *   tls.key  → server private key  (PEM)
 *   ca.crt   → CA certificate      (PEM)  ← required only for mTLS
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const TLS_MODE  = (process.env.TLS_MODE  || 'mtls').toLowerCase();
const CERT_DIR  =  process.env.TLS_CERT_DIR  || '/etc/tls';
const CERT_FILE = path.join(CERT_DIR, process.env.TLS_CERT_FILE || 'tls.crt');
const KEY_FILE  = path.join(CERT_DIR, process.env.TLS_KEY_FILE  || 'tls.key');
const CA_FILE   = path.join(CERT_DIR, process.env.TLS_CA_FILE   || 'ca.crt');
const PORT      = process.env.PORT || 8443;

/** Read a cert file, throw a clear error if missing. */
function readCert(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`[TLS] ${label} not found at: ${filePath}`);
  }
  return fs.readFileSync(filePath);
}

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

/**
 * Build the HTTPS options object and request logger TLS annotation.
 * Returns { server, protocol }.
 */
function createServer(app, serviceName) {
  const ts = () => new Date().toISOString();

  // Inject TLS info into the existing request logger
  app.use((req, res, next) => {
    req._tlsMode = TLS_MODE;
    next();
  });

  attachWhoami(app);

  let server;
  let protocol;

  try {
    if (TLS_MODE === 'none') {
      // ── Plain HTTP ──────────────────────────────────────────────────────
      server   = http.createServer(app);
      protocol = 'HTTP';

    } else if (TLS_MODE === 'tls') {
      // ── One-way TLS ─────────────────────────────────────────────────────
      server = https.createServer({
        cert: readCert(CERT_FILE, 'Server certificate'),
        key:  readCert(KEY_FILE,  'Server private key'),
      }, app);
      protocol = 'HTTPS (one-way TLS)';

    } else if (TLS_MODE === 'mtls') {
      // ── Mutual TLS ──────────────────────────────────────────────────────
      server = https.createServer({
        cert:               readCert(CERT_FILE, 'Server certificate'),
        key:                readCert(KEY_FILE,  'Server private key'),
        ca:                 readCert(CA_FILE,   'CA certificate'),
        requestCert:        true,   // request client cert
        rejectUnauthorized: true,   // reject if not signed by ca.crt
      }, app);
      protocol = 'HTTPS (mutual TLS)';

    } else {
      throw new Error(`Unknown TLS_MODE="${TLS_MODE}". Valid: none | tls | mtls`);
    }

    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[${ts()}] ${serviceName} started`);
      console.log(`[${ts()}] Mode: ${protocol}  |  Port: ${PORT}  |  TLS_MODE=${TLS_MODE}`);
      if (TLS_MODE !== 'none') {
        console.log(`[${ts()}] Cert dir: ${CERT_DIR}`);
      }
    });

    server.on('error', (err) => {
      console.error(`[${ts()}] Server error: ${err.message}`);
      process.exit(1);
    });

  } catch (err) {
    console.error(`[${ts()}] Fatal startup error: ${err.message}`);
    process.exit(1);
  }

  return server;
}

module.exports = { createServer, TLS_MODE, PORT };