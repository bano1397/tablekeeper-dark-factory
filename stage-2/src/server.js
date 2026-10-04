'use strict';
// HTTP plumbing: body collection, routing, JSON responses and the error envelope.

const http = require('node:http');
const { route } = require('./app');
const { ApiError } = require('./errors');

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const JSON_TYPE = 'application/json; charset=utf-8';

function send(res, status, body) {
  if (status === 204 || body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': JSON_TYPE, 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function sendError(res, status, code, message) {
  send(res, status, { error: { code, message } });
}

function parseQuery(searchParams) {
  const query = {};
  for (const [k, val] of searchParams) {
    if (!(k in query)) query[k] = val; // first occurrence wins
  }
  return query;
}

function decodeSegments(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

async function handle(req, res, rawBody) {
  const url = new URL(req.url, 'http://localhost');
  let path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  const { handler, params, pathMatched } = route(req.method, path);
  if (!handler) {
    if (pathMatched) return sendError(res, 405, 'method_not_allowed', 'method not allowed');
    return sendError(res, 404, 'not_found', 'no such endpoint');
  }
  for (const k of Object.keys(params)) {
    const decoded = decodeSegments(params[k]);
    if (decoded === null) return sendError(res, 404, 'not_found', 'not found');
    params[k] = decoded;
  }
  const ctx = {
    method: req.method,
    path,
    params,
    query: parseQuery(url.searchParams),
    headers: req.headers,
    rawBody,
  };
  const result = await handler(ctx);
  if (result.raw !== undefined) {
    res.writeHead(result.status, {
      'Content-Type': result.type,
      'Content-Length': Buffer.byteLength(result.raw),
      'Cache-Control': 'no-cache',
    });
    res.end(result.raw);
    return;
  }
  send(res, result.status, result.body);
}

function createServer() {
  return http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        sendError(res, 413, 'payload_too_large', 'request body too large');
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      handle(req, res, Buffer.concat(chunks)).catch((err) => {
        if (res.headersSent) return;
        if (err instanceof ApiError) {
          sendError(res, err.status, err.code, err.message);
        } else {
          console.error(err);
          sendError(res, 500, 'internal_error', 'internal error');
        }
      });
    });
    req.on('error', () => {});
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  const server = createServer();
  server.keepAliveTimeout = 65 * 1000;
  server.listen(port, '0.0.0.0', () => {
    console.log(`tablekeeper listening on 0.0.0.0:${port}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { createServer };
