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
const { mainServer, healthServer } = createServer(app, 'Cricket World Cup Champions API');

// ── Data ───────────────────────────────────────────────────────────────────
const champions = [
  { year: 1975, winner: "West Indies",  format: "ODI World Cup",  venue: "England" },
  { year: 1979, winner: "West Indies",  format: "ODI World Cup",  venue: "England" },
  { year: 1983, winner: "India",        format: "ODI World Cup",  venue: "England" },
  { year: 1987, winner: "Australia",    format: "ODI World Cup",  venue: "India & Pakistan" },
  { year: 1992, winner: "Pakistan",     format: "ODI World Cup",  venue: "Australia & NZ" },
  { year: 1996, winner: "Sri Lanka",    format: "ODI World Cup",  venue: "Asia" },
  { year: 1999, winner: "Australia",    format: "ODI World Cup",  venue: "England" },
  { year: 2003, winner: "Australia",    format: "ODI World Cup",  venue: "South Africa" },
  { year: 2007, winner: "Australia",    format: "ODI World Cup",  venue: "West Indies" },
  { year: 2011, winner: "India",        format: "ODI World Cup",  venue: "Asia" },
  { year: 2015, winner: "Australia",    format: "ODI World Cup",  venue: "Australia & NZ" },
  { year: 2019, winner: "England",      format: "ODI World Cup",  venue: "England" },
  { year: 2023, winner: "Australia",    format: "ODI World Cup",  venue: "India" },
  { year: 2007, winner: "India",        format: "T20 World Cup",  venue: "South Africa" },
  { year: 2009, winner: "Pakistan",     format: "T20 World Cup",  venue: "England" },
  { year: 2010, winner: "England",      format: "T20 World Cup",  venue: "West Indies" },
  { year: 2012, winner: "West Indies",  format: "T20 World Cup",  venue: "Sri Lanka" },
  { year: 2014, winner: "Sri Lanka",    format: "T20 World Cup",  venue: "Bangladesh" },
  { year: 2016, winner: "West Indies",  format: "T20 World Cup",  venue: "India" },
  { year: 2021, winner: "Australia",    format: "T20 World Cup",  venue: "UAE" },
  { year: 2022, winner: "England",      format: "T20 World Cup",  venue: "Australia" },
  { year: 2024, winner: "India",        format: "T20 World Cup",  venue: "West Indies & USA" },
  { year: 2026, winner: "India",        format: "T20 World Cup",  venue: "India & Sri Lanka" },
];

// 3. SECURED ROUTES
app.get('/health', (req, res) => res.json({
  status:    'ok',
  service:   'Cricket World Cup Champions API',
  tls_mode:  TLS_MODE,
  timestamp: new Date().toISOString(),
}));

app.get('/champions', (req, res) => {
  const { winner, format } = req.query;
  let data = champions;
  if (winner) data = data.filter(c => c.winner.toLowerCase().includes(winner.toLowerCase()));
  if (format) data = data.filter(c => c.format.toLowerCase().includes(format.toLowerCase()));
  res.json(data);
});