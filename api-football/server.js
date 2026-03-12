'use strict';

const express = require('express');
const { createServer, TLS_MODE } = require('./tls-helper');

const app = express();
app.use(express.json());

// 1. GLOBAL LOGGER
app.use((req, res, next) => {
  const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const cert = req.socket.getPeerCertificate ? req.socket.getPeerCertificate() : null;
  const tlsInfo = req.socket.encrypted
    ? (cert && cert.subject ? `mTLS:${cert.subject.CN}` : 'TLS')
    : 'HTTP';
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - IP: ${clientIP} - ${tlsInfo}`);
  next();
});

// 2. INITIALIZE SERVER & mTLS ENFORCEMENT
const { mainServer, healthServer } = createServer(app, 'Premier League Champions API');

// ── Data ───────────────────────────────────────────────────────────────────
const champions = [
  { year: "1992-93", team: "Manchester United",  manager: "Alex Ferguson" },
  // ... (rest of your data)
  { year: "2024-25", team: "Liverpool",          manager: "Arne Slot" },
];

// 3. SECURED ROUTES
app.get('/health', (req, res) => res.json({
  status:    'ok',
  service:   'Premier League Champions API',
  tls_mode:  TLS_MODE,
  timestamp: new Date().toISOString(),
}));

app.get('/champions', (req, res) => {
  const { team, manager } = req.query;
  let data = champions;
  if (team)    data = data.filter(c => c.team.toLowerCase().includes(team.toLowerCase()));
  if (manager) data = data.filter(c => c.manager.toLowerCase().includes(manager.toLowerCase()));
  res.json(data);
});