'use strict';
// Browser screens: one HTML shell for every screen route plus static assets. The shell
// embeds the restaurant list so the search form is usable as soon as the page loads.

const fs = require('node:fs');
const path = require('node:path');
const { notFound } = require('./errors');

const PUBLIC = path.join(__dirname, 'public');
const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const assets = new Map();
for (const name of fs.readdirSync(PUBLIC)) {
  const type = TYPES[path.extname(name)];
  if (type) assets.set(name, { type, body: fs.readFileSync(path.join(PUBLIC, name)) });
}

const SCREEN_TITLES = {
  search: 'Find a table',
  signup: 'Create an account',
  login: 'Sign in',
  lookup: 'Your booking',
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function page(ctx, store) {
  const screen = ctx.params.screen || 'search';
  const bootstrap = {
    restaurants: store.data.restaurants.map((r) => ({ id: r.id, name: r.name, timezone: r.timezone })),
  };
  const json = JSON.stringify(bootstrap).replace(/</g, '\\u003c');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(SCREEN_TITLES[screen])} · Tablekeeper</title>
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/app.css">
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="/" data-link><span class="brand-mark" aria-hidden="true">◆</span> Tablekeeper</a>
    <nav class="nav" aria-label="Main">
      <a href="/" data-link data-nav="search">Find a table</a>
      <a href="/lookup" data-link data-nav="lookup">My booking</a>
    </nav>
    <div class="session" id="session"></div>
  </div>
</header>
<main id="main" class="container" tabindex="-1"></main>
<footer class="footer"><div class="container">Tablekeeper · Reserve with confidence</div></footer>
<script id="bootstrap" type="application/json">${json}</script>
<script src="/assets/app.js" defer></script>
</body>
</html>
`;
  return { status: 200, raw: html, type: 'text/html; charset=utf-8' };
}

function asset(ctx) {
  const a = assets.get(ctx.params.name);
  if (!a) throw notFound('no such asset');
  return { status: 200, raw: a.body, type: a.type };
}

module.exports = { page, asset };
