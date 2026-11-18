'use strict';
// Startpunkt für Railway (npm start). HTTPS beendet Railway vor dem Container;
// im Produktivbetrieb lehnt die App Anfragen ab, die nicht über HTTPS kamen.

const http = require('node:http');
const config = require('./config');
const { createLogger } = require('./lib/logger');
const { createApp } = require('./app');

const cfg = config.load();
const logger = createLogger({ level: cfg.logLevel });
const { handler } = createApp({ config: cfg, logger });

const server = http.createServer(handler);
server.requestTimeout = 0; // lange Streams erlaubt; OpenAI-Timeout regelt das Ende
server.headersTimeout = 30000;
server.keepAliveTimeout = 65000;

server.listen(cfg.port, () => {
  logger.info('started', { port: cfg.port, env: cfg.env, configured: config.readiness(cfg) });
  if (cfg.production) {
    const missing = Object.entries(config.readiness(cfg)).filter(([, ok]) => !ok).map(([k]) => k);
    if (missing.length) logger.warn('not_configured', { parts: missing });
  }
});

const stop = (signal) => {
  logger.info('stopping', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
process.on('unhandledRejection', (err) => logger.error('unhandled_rejection', { error: err }));
