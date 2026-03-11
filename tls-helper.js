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

/** Health-check paths that bypass mTLS enforcement (Kubelet probes). */
const HEALTH_PATHS = new Set(['/healthz', '/readyz', '/health']);

/** Read a cert file, throw a clear error if missing. */
function readCert(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`[TLS] ${label} not found at: ${filePath}`);
  }
  return fs.readFileSync(filePath);
}

/**
 * Middleware that enforces mTLS on every route EXCEPT health-check paths.
 *
 * Why not rejectUnauthorized:true at the TLS layer?
 * Because Node's TLS stack rejects the TCP handshake before the HTTP request
 * is even parsed — the Kubelet prober (which sends no client cert) would get
 * a TLS alert and the probe would fail.
 *
 * Instead we set rejectUnauthorized:false so the handshake always completes,
 * then enforce the cert requirement here in userland for non-health routes.
 */
function mtlsEnforcer(req, res, next) {
  if (HEALTH_PATHS.has(req.path)) {
    return next(); // ← Kubelet probes pass straight through
  }

  if (!req.socket.authorized) {
    const reason = req.socket.authorizationError || 'No valid client certificate';
    console.warn(`[mTLS] Rejected ${req.method} ${req.path} — ${reason}`);
    return res.status(401).json({ error: 'mTLS required', reason });
  }

  next();
}

/**
 * Attach a /whoami diagnostic route that returns client cert details.
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
 * createServer(app, serviceName)
 *
 * Boots an HTTP/HTTPS server and attaches TLS middleware to `app`.
 * Returns the raw node server instance.
 */
function createServer(app, serviceName) {
  const ts = () => new Date().toISOString();

  app.use((req, res, next) => {
    req._tlsMode = TLS_MODE;
    next();
  });

  // Register mTLS enforcer BEFORE any app routes so it runs first.
  if (TLS_MODE === 'mtls') {
    app.use(mtlsEnforcer);
  }

  attachWhoami(app);

  let server;
  let protocol;

  try {
    if (TLS_MODE === 'none') {
      server   = http.createServer(app);
      protocol = 'HTTP';

    } else if (TLS_MODE === 'tls') {
      server = https.createServer({
        cert: readCert(CERT_FILE, 'Server certificate'),
        key:  readCert(KEY_FILE,  'Server private key'),
      }, app);
      protocol = 'HTTPS (one-way TLS)';

    } else if (TLS_MODE === 'mtls') {
      server = https.createServer({
        cert: readCert(CERT_FILE, 'Server certificate'),
        key:  readCert(KEY_FILE,  'Server private key'),
        ca:   readCert(CA_FILE,   'CA certificate'),
        requestCert:        true,
        rejectUnauthorized: false, // ← intentional: enforced in mtlsEnforcer()
      }, app);
      protocol = 'HTTPS (mutual TLS — probe-safe)';

    } else {
      throw new Error(`Unknown TLS_MODE="${TLS_MODE}". Valid: none | tls | mtls`);
    }

    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[${ts()}] ${serviceName} started`);
      console.log(`[${ts()}] Mode: ${protocol}  |  Port: ${PORT}  |  TLS_MODE=${TLS_MODE}`);
      if (TLS_MODE !== 'none') {
        console.log(`[${ts()}] Cert dir: ${CERT_DIR}`);
        if (TLS_MODE === 'mtls') {
          console.log(`[${ts()}] Health probe bypass: ${[...HEALTH_PATHS].join(', ')}`);
        }
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