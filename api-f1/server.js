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
const { mainServer, healthServer } = createServer(app, 'Formula 1 Champions API');

// ── Data ───────────────────────────────────────────────────────────────────
const champions = [
  { year: 1950, driver: "Nino Farina",        team: "Alfa Romeo" },
  // ... (rest of your data)
  { year: 2025, driver: "Lando Norris",       team: "McLaren" },
];

// 3. SECURED ROUTES
app.get('/health', (req, res) => res.json({
  status:    'ok',
  service:   'Formula 1 Champions API',
  tls_mode:  TLS_MODE,
  timestamp: new Date().toISOString(),
}));

app.get('/champions', (req, res) => {
  const { year, driver } = req.query;
  let data = champions;
  if (year)   data = data.filter(c => c.year === parseInt(year));
  if (driver) data = data.filter(c => c.driver.toLowerCase().includes(driver.toLowerCase()));
  res.json(data);
});

app.get('/champions/:year', (req, res) => {
  const record = champions.find(c => c.year === parseInt(req.params.year));
  if (!record) return res.status(404).json({ error: 'Year not found' });
  res.json(record);
});