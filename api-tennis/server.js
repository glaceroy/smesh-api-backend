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
const { mainServer, healthServer } = createServer(app, 'Tennis Grand Slam Champions API');

// ── Data ───────────────────────────────────────────────────────────────────
const champions = [
  // Australian Open
  { year: 2010, tournament: "Australian Open", winner: "Roger Federer",   nationality: "Switzerland" },
  // ... (rest of your data)
  { year: 2025, tournament: "US Open",         winner: "Carlos Alcaraz",  nationality: "Spain" },
];

// 3. SECURED ROUTES
app.get('/health', (req, res) => res.json({
  status:    'ok',
  service:   'Tennis Grand Slam Champions API',
  tls_mode:  TLS_MODE,
  timestamp: new Date().toISOString(),
}));

app.get('/champions', (req, res) => {
  const { winner, tournament, year } = req.query;
  let data = champions;
  if (winner)     data = data.filter(c => c.winner.toLowerCase().includes(winner.toLowerCase()));
  if (tournament) data = data.filter(c => c.tournament.toLowerCase().includes(tournament.toLowerCase()));
  if (year)       data = data.filter(c => c.year === parseInt(year));
  res.json(data);
});