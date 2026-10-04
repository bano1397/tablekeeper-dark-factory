'use strict';
// Tablekeeper browser client. Vanilla JS, no build step, no external assets.
//
// Correctness rules this file implements (stage 2):
// - Searches are numbered; only the latest search may render (late responses are dropped).
// - The booking form keeps one idempotency key per request body. Resubmitting an
//   unchanged form replays that key; changing a field mints a new key.
// - A booking whose response is lost shows `booking-uncertain`; the next submit of the
//   unchanged form retries with the same key and body and shows the server's answer.
// - The server is authoritative: nothing is shown as booked unless the server said so.

(function () {
  const bootstrap = JSON.parse(document.getElementById('bootstrap').textContent);
  const main = document.getElementById('main');
  const sessionBox = document.getElementById('session');
  const SESSION_KEY = 'tablekeeper.session';
  const REQUEST_TIMEOUT_MS = 15000;

  // ---- utilities ---------------------------------------------------------------

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'testid') el.setAttribute('data-testid', v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  function newKey() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function todayLocal() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // "2026-09-24T19:00" -> "Thu 24 Sep 2026"
  function formatLocalDate(local) {
    const [y, m, d] = local.slice(0, 10).split('-').map(Number);
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    }).format(new Date(Date.UTC(y, m - 1, d)));
  }

  const timeOf = (local) => local.slice(11, 16);

  function tableIdsOf(reservation) {
    if (Array.isArray(reservation.table_ids)) return reservation.table_ids;
    return reservation.table_id ? [reservation.table_id] : [];
  }

  function tableLabel(restaurant, id) {
    const t = restaurant && restaurant.tables && restaurant.tables.find((x) => x.id === id);
    return t ? t.label : id;
  }

  function tablesText(restaurant, ids) {
    const labels = ids.map((id) => tableLabel(restaurant, id));
    return labels.length === 1 ? `Table ${labels[0]}` : `Tables ${labels.join(' + ')}`;
  }

  function guests(n) {
    return `${n} ${Number(n) === 1 ? 'guest' : 'guests'}`;
  }

  // ---- session -------------------------------------------------------------------

  let session = null;
  try {
    session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
  } catch {
    session = null;
  }

  function setSession(value) {
    session = value;
    if (value) localStorage.setItem(SESSION_KEY, JSON.stringify(value));
    else localStorage.removeItem(SESSION_KEY);
    renderSession();
  }

  function renderSession() {
    sessionBox.replaceChildren();
    if (session) {
      sessionBox.append(
        h('span', { class: 'current-user', testid: 'current-user' },
          h('span', { class: 'avatar', 'aria-hidden': 'true', text: (session.display_name || '?').slice(0, 1).toUpperCase() }),
          h('span', { class: 'user-name' }, h('span', { class: 'sr-only', text: 'Signed in as ' }), session.display_name)),
        h('button', {
          type: 'button', class: 'button ghost small', testid: 'logout-button',
          onclick: () => { setSession(null); render(); },
        }, 'Sign out'),
      );
    } else {
      sessionBox.append(
        h('a', { href: '/login', 'data-link': true, class: 'button ghost small' }, 'Sign in'),
        h('a', { href: '/signup', 'data-link': true, class: 'button primary small' }, 'Create account'),
      );
    }
  }

  // ---- API -------------------------------------------------------------------------

  // Resolves to { status, data }. Rejects when no complete response arrived
  // (connection lost, timeout, unreadable body): the outcome is then unknown.
  async function api(method, path, { body, key } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (session) headers.Authorization = `Bearer ${session.token}`;
    if (key) headers['Idempotency-Key'] = key;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(path, {
        method, headers, signal: controller.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          if (res.ok) throw new Error('unreadable response');
        }
      }
      if (res.status === 401 && session) setSession(null);
      return { status: res.status, data };
    } finally {
      clearTimeout(timer);
    }
  }

  const errorCode = (resp) => resp && resp.data && resp.data.error && resp.data.error.code;

  // ---- routing -----------------------------------------------------------------------

  function screenFor(pathname) {
    return { '/': 'search', '/signup': 'signup', '/login': 'login', '/lookup': 'lookup' }[pathname] || 'search';
  }

  function navigate(href) {
    history.pushState({}, '', href);
    render();
    main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-link]');
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(link.getAttribute('href'));
  });
  window.addEventListener('popstate', render);

  const TITLES = { search: 'Find a table', signup: 'Create an account', login: 'Sign in', lookup: 'Your booking' };

  function render() {
    const screen = screenFor(location.pathname);
    document.title = `${TITLES[screen]} · Tablekeeper`;
    for (const a of document.querySelectorAll('[data-nav]')) {
      if (a.dataset.nav === screen) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    renderSession();
    main.replaceChildren();
    if (screen === 'signup') renderAuth('signup');
    else if (screen === 'login') renderAuth('login');
    else if (screen === 'lookup') renderLookup();
    else renderSearch();
  }

  // ---- auth screens ------------------------------------------------------------------

  function renderAuth(kind) {
    const isSignup = kind === 'signup';
    const feedback = h('div', { class: 'feedback', 'aria-live': 'polite' });
    const email = h('input', { id: `${kind}-email`, type: 'email', autocomplete: 'email', required: true, testid: `${kind}-email` });
    const password = h('input', {
      id: `${kind}-password`, type: 'password', required: true, testid: `${kind}-password`,
      autocomplete: isSignup ? 'new-password' : 'current-password', minlength: isSignup ? '8' : null,
    });
    const name = isSignup
      ? h('input', { id: 'signup-display-name', type: 'text', autocomplete: 'name', required: true, testid: 'signup-display-name' })
      : null;
    const submit = h('button', { type: 'submit', class: 'button primary wide', testid: `${kind}-submit` },
      isSignup ? 'Create account' : 'Sign in');

    function showError(message) {
      feedback.replaceChildren(h('p', { class: 'notice error', role: 'alert', testid: 'auth-error', text: message }));
    }

    async function onSubmit(event) {
      event.preventDefault();
      feedback.replaceChildren();
      submit.disabled = true;
      submit.textContent = isSignup ? 'Creating account…' : 'Signing in…';
      const body = isSignup
        ? { email: email.value.trim(), password: password.value, display_name: name.value.trim() }
        : { email: email.value.trim(), password: password.value };
      try {
        const resp = await api('POST', isSignup ? '/auth/signup' : '/auth/login', { body });
        if (resp.status === 200 || resp.status === 201) {
          setSession({ token: resp.data.token, user_id: resp.data.user_id, display_name: resp.data.display_name });
          navigate('/');
          return;
        }
        const code = errorCode(resp);
        if (code === 'email_taken') showError('An account with that email already exists. Try signing in instead.');
        else if (code === 'unauthenticated') showError('That email and password don’t match an account.');
        else if (code === 'validation_failed') {
          showError(isSignup
            ? 'Please enter a valid email address, your name, and a password of at least 8 characters.'
            : 'Please enter your email address and password.');
        } else showError('Something went wrong. Please try again.');
      } catch {
        showError('We couldn’t reach Tablekeeper. Check your connection and try again.');
      } finally {
        submit.disabled = false;
        submit.textContent = isSignup ? 'Create account' : 'Sign in';
      }
    }

    main.append(h('section', { class: 'auth-card card' },
      h('h1', {}, isSignup ? 'Create your account' : 'Welcome back'),
      h('p', { class: 'lede' }, isSignup
        ? 'One account for every table you book.'
        : 'Sign in to book tables and manage your reservations.'),
      h('form', { class: 'stack', onsubmit: onSubmit, novalidate: true },
        h('div', { class: 'field' }, h('label', { for: `${kind}-email` }, 'Email'), email),
        name && h('div', { class: 'field' }, h('label', { for: 'signup-display-name' }, 'Your name'), name),
        h('div', { class: 'field' },
          h('label', { for: `${kind}-password` }, 'Password'), password,
          isSignup && h('p', { class: 'hint' }, 'At least 8 characters.')),
        submit),
      feedback,
      h('p', { class: 'muted switch' }, isSignup ? 'Already have an account? ' : 'New to Tablekeeper? ',
        h('a', { href: isSignup ? '/login' : '/signup', 'data-link': true }, isSignup ? 'Sign in' : 'Create an account')),
    ));
  }

  // ---- search & availability -----------------------------------------------------------

  const search = {
    seq: 0,          // number of the latest search; older responses are ignored
    params: null,    // the params of the search whose results are on screen
    restaurant: null,
    capacities: null, // table capacities under the policy in force on the searched date
    availability: null,
    status: 'idle',  // idle | loading | ready | error
    error: null,
    signInPrompt: false,
  };
  let booking = null; // the open booking form, see openBooking()
  let searchEls = null;

  function renderSearch() {
    const restaurants = bootstrap.restaurants;
    const select = h('select', { id: 'restaurant', testid: 'restaurant-select' },
      restaurants.map((r) => h('option', { value: r.id }, r.name)));
    const date = h('input', { id: 'date', type: 'date', testid: 'date-input', value: todayLocal(), required: true });
    const party = h('input', {
      id: 'party', type: 'number', min: '1', step: '1', inputmode: 'numeric', testid: 'party-size-input', value: '2', required: true,
    });
    if (search.params) {
      select.value = search.params.restaurantId;
      date.value = search.params.date;
      party.value = search.params.partySize;
    }
    const submit = h('button', { type: 'submit', class: 'button primary', testid: 'search-button' }, 'Find a table');
    const message = h('div', { class: 'feedback', 'aria-live': 'polite' });
    const results = h('section', { class: 'results', 'aria-live': 'polite', 'aria-label': 'Availability' });
    const bookingBox = h('div', { class: 'booking-slot' });
    searchEls = { select, date, party, message, results, bookingBox };

    const form = h('form', {
      class: 'search-card card',
      onsubmit: (event) => {
        event.preventDefault();
        runSearch({ restaurantId: select.value, date: date.value, partySize: party.value.trim() });
      },
    },
    h('div', { class: 'field' }, h('label', { for: 'restaurant' }, 'Restaurant'),
      restaurants.length ? select : h('p', { class: 'muted' }, 'No restaurants are taking bookings yet.')),
    h('div', { class: 'field' }, h('label', { for: 'date' }, 'Date'), date),
    h('div', { class: 'field narrow' }, h('label', { for: 'party' }, 'Guests'), party),
    h('div', { class: 'field action' }, submit));

    main.append(
      h('section', { class: 'hero' },
        h('h1', {}, 'Find your table'),
        h('p', { class: 'lede' }, 'Choose a restaurant, a date and your party size. Pick any open time to book it in seconds.')),
      form, message, h('div', { class: 'layout' }, results, bookingBox),
    );
    renderMessage();
    renderResults();
    renderBooking();
  }

  async function runSearch(params, { refresh = false } = {}) {
    const seq = ++search.seq;
    if (!refresh) {
      booking = null; // the form must describe the new search, not the old one
      search.params = params;
      search.status = 'loading';
      search.restaurant = null;
      search.availability = null;
      search.signInPrompt = false;
      renderMessage();
      renderResults();
      renderBooking();
    }
    try {
      const query = new URLSearchParams({
        restaurant_id: params.restaurantId, date: params.date, party_size: params.partySize,
      });
      const [detail, avail, policies] = await Promise.all([
        api('GET', `/restaurants/${encodeURIComponent(params.restaurantId)}`),
        api('GET', `/availability?${query}`),
        api('GET', `/restaurants/${encodeURIComponent(params.restaurantId)}/policies`).catch(() => null),
      ]);
      if (seq !== search.seq) return; // a newer search owns the screen
      if (detail.status !== 200 || avail.status !== 200) {
        search.status = 'error';
        search.error = errorCode(avail) === 'validation_failed'
          ? 'Please choose a valid date and a party size of at least 1.'
          : 'We couldn’t load that restaurant. Please try again.';
      } else {
        search.status = 'ready';
        search.restaurant = detail.data;
        search.capacities = capacitiesFor(detail.data, policies && policies.status === 200 ? policies.data.policies : [], params.date);
        search.availability = avail.data;
        search.params = params;
      }
    } catch {
      if (seq !== search.seq) return;
      if (refresh) return; // keep the current grid; the form already shows what happened
      search.status = 'error';
      search.error = 'We couldn’t reach Tablekeeper. Check your connection and search again.';
    }
    renderResults();
    if (booking) renderBookingSummary();
  }

  // Table capacities on a date: the published policy with the greatest effective_from
  // not later than the date (ties: greatest version), else the restaurant's own tables.
  function capacitiesFor(restaurant, policies, date) {
    let best = null;
    for (const p of policies || []) {
      if (p.effective_from > date) continue;
      if (!best || p.effective_from > best.effective_from
        || (p.effective_from === best.effective_from && p.policy_version > best.policy_version)) best = p;
    }
    if (best) return { ...best.capacities };
    return Object.fromEntries((restaurant.tables || []).map((t) => [t.id, t.capacity]));
  }

  function renderMessage() {
    if (!searchEls) return;
    searchEls.message.replaceChildren();
    if (search.signInPrompt && !session) {
      searchEls.message.append(h('p', { class: 'notice error', role: 'alert', testid: 'auth-error' },
        'Please sign in to book a table. ',
        h('a', { href: '/login', 'data-link': true }, 'Sign in'), ' or ',
        h('a', { href: '/signup', 'data-link': true }, 'create an account'), ' — your search will be kept.'));
    }
  }

  function optionKey(ids) {
    return ids.join('+');
  }

  function renderResults() {
    if (!searchEls) return;
    const box = searchEls.results;
    box.replaceChildren();
    if (search.status === 'idle') {
      box.append(h('div', { class: 'empty card' },
        h('p', { class: 'empty-title' }, 'Your table is waiting'),
        h('p', { class: 'muted' }, 'Search to see every open time for the day.')));
      return;
    }
    if (search.status === 'loading') {
      box.setAttribute('aria-busy', 'true');
      box.append(h('div', { class: 'loading card', role: 'status' },
        h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Checking tables…'));
      return;
    }
    box.removeAttribute('aria-busy');
    if (search.status === 'error') {
      box.append(h('p', { class: 'notice error', role: 'alert', text: search.error }));
      return;
    }
    const restaurant = search.restaurant;
    const avail = search.availability;
    const partySize = Number(search.params.partySize);
    const heading = h('div', { class: 'results-head' },
      h('h2', {}, restaurant.name),
      h('p', { class: 'muted' }, `${formatLocalDate(`${avail.date}T00:00`)} · ${guests(search.params.partySize)}`));
    if (!avail.slots.length) {
      box.append(heading, h('div', { class: 'empty card', testid: 'no-slots' },
        h('p', { class: 'empty-title' }, 'No tables on this day'),
        h('p', { class: 'muted' }, `${restaurant.name} isn’t taking bookings on this date. Try another day.`)));
      return;
    }
    const tables = restaurant.tables || [];
    const caps = search.capacities || {};
    const capOf = (ids) => ids.reduce((n, id) => n + (caps[id] || 0), 0);
    const pairs = (restaurant.combinable || []).filter((pair) => capOf(pair) >= partySize);
    const selected = booking ? `${optionKey(booking.tableIds)}-${timeOf(booking.startsAtLocal)}` : null;

    const grid = h('div', { class: 'grid', testid: 'availability-grid' });
    for (const slot of avail.slots) {
      const time = timeOf(slot.starts_at_local);
      const freeSingles = new Set(slot.available_table_ids || []);
      const freePairs = new Set((slot.available_options || [])
        .filter((o) => o.table_ids.length === 2).map((o) => optionKey(o.table_ids)));
      const cells = [];
      for (const t of tables) cells.push(cell(slot, time, [t.id], freeSingles.has(t.id), capOf([t.id])));
      for (const pair of pairs) cells.push(cell(slot, time, pair, freePairs.has(optionKey(pair)), capOf(pair)));
      const open = cells.filter((c) => c.dataset.available === 'true').length;
      grid.append(h('div', { class: 'slot-row' },
        h('div', { class: 'slot-time' }, h('span', { class: 'time' }, time),
          h('span', { class: 'slot-count' }, open ? `${open} open` : 'Full')),
        h('div', { class: 'cells' }, cells)));
    }

    function cell(slot, time, ids, available, capacity) {
      const id = `${optionKey(ids)}-${time}`;
      const label = tablesText(restaurant, ids);
      const isSelected = id === selected;
      const tooSmall = !available && capacity < partySize;
      const reason = isSelected && booking.phase === 'confirmed' ? 'Your booking'
        : tooSmall ? `Too small · ${capacity} seats` : 'Taken';
      return h('button', {
        type: 'button',
        class: `cell ${available ? 'available' : 'unavailable'}${tooSmall ? ' too-small' : ''}${ids.length > 1 ? ' combo' : ''}${isSelected ? ' selected' : ''}`,
        testid: `slot-${id}`,
        'data-available': available ? 'true' : 'false',
        disabled: !available,
        'aria-pressed': isSelected ? 'true' : 'false',
        'aria-label': `${label}, ${capacity} seats, ${time}, ${available ? 'available' : tooSmall ? 'too small for your party' : 'taken'}`,
        onclick: () => {
          if (!available) return;
          openBooking(slot, ids);
        },
      },
      h('span', { class: 'cell-label' }, label),
      h('span', { class: 'cell-meta' }, available ? `${capacity} seats` : reason));
    }

    box.append(heading,
      h('ul', { class: 'legend', 'aria-label': 'Legend' },
        h('li', {}, h('span', { class: 'swatch available' }), 'Open'),
        h('li', {}, h('span', { class: 'swatch combo' }), 'Joined tables'),
        h('li', {}, h('span', { class: 'swatch selected' }), 'Your choice'),
        h('li', {}, h('span', { class: 'swatch unavailable' }), 'Taken'),
        h('li', {}, h('span', { class: 'swatch too-small' }), 'Too small for your party')),
      grid);
  }

  // ---- booking form --------------------------------------------------------------------

  function openBooking(slot, tableIds) {
    if (!session) {
      search.signInPrompt = true;
      renderMessage();
      return;
    }
    booking = {
      restaurant: search.restaurant,
      tableIds: [...tableIds],
      startsAtLocal: slot.starts_at_local,
      partySize: String(search.params.partySize),
      key: null,        // idempotency key for `sentBody`
      sentBody: null,   // canonical body the key belongs to
      phase: 'idle',    // idle | pending | confirmed | refused | uncertain
      reservation: null,
      message: null,
    };
    renderResults();
    renderBooking();
    const form = document.querySelector('[data-testid="booking-form"]');
    if (form) form.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function bookingBody() {
    const raw = booking.partyInput.value.trim();
    const party = /^\d+$/.test(raw) ? Number(raw) : raw;
    const body = { restaurant_id: booking.restaurant.id };
    // Single tables use the stage-1 request format, pairs use `table_ids`.
    if (booking.tableIds.length === 1) body.table_id = booking.tableIds[0];
    else body.table_ids = booking.tableIds;
    body.starts_at_local = booking.startsAtLocal;
    body.party_size = party;
    return body;
  }

  function renderBooking() {
    if (!searchEls) return;
    const box = searchEls.bookingBox;
    box.replaceChildren();
    if (!booking) return;
    const party = h('input', {
      id: 'booking-party', type: 'number', min: '1', step: '1', inputmode: 'numeric',
      testid: 'booking-party-size', value: booking.partySize,
    });
    party.addEventListener('input', () => { booking.partySize = party.value; });
    const submit = h('button', { type: 'submit', class: 'button primary wide', testid: 'booking-submit' }, 'Book this table');
    const summary = h('p', { class: 'summary', testid: 'booking-summary' });
    const feedback = h('div', { class: 'feedback', 'aria-live': 'polite' });
    booking.partyInput = party;
    booking.submit = submit;
    booking.summaryEl = summary;
    booking.feedback = feedback;
    box.append(h('form', { class: 'booking-card card', testid: 'booking-form', onsubmit: submitBooking },
      h('div', { class: 'booking-head' },
        h('h2', {}, 'Complete your booking'),
        h('button', {
          type: 'button', class: 'button ghost small', 'aria-label': 'Close booking form',
          onclick: () => { booking = null; renderBooking(); renderResults(); },
        }, 'Close')),
      summary,
      h('div', { class: 'field' }, h('label', { for: 'booking-party' }, 'Guests'), party),
      submit,
      feedback));
    renderBookingSummary();
    renderBookingFeedback();
  }

  function renderBookingSummary() {
    if (!booking || !booking.summaryEl) return;
    booking.summaryEl.replaceChildren(
      h('strong', {}, tablesText(booking.restaurant, booking.tableIds)),
      h('span', {}, ` · ${formatLocalDate(booking.startsAtLocal)} at `),
      h('strong', {}, timeOf(booking.startsAtLocal)),
      h('span', { class: 'muted' }, ` · ${booking.restaurant.name}`));
  }

  function renderBookingFeedback() {
    if (!booking || !booking.feedback) return;
    const fb = booking.feedback;
    fb.replaceChildren();
    booking.submit.disabled = booking.phase === 'pending';
    booking.submit.textContent = booking.phase === 'pending' ? 'Booking…' : 'Book this table';
    if (booking.phase === 'pending') {
      fb.append(h('p', { class: 'notice info', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Confirming with the restaurant…'));
    } else if (booking.phase === 'refused') {
      fb.append(h('p', { class: 'notice error', role: 'alert', testid: 'booking-error', text: booking.message }));
    } else if (booking.phase === 'uncertain') {
      fb.append(h('p', { class: 'notice warn', role: 'alert', testid: 'booking-uncertain', text: booking.message }));
    } else if (booking.phase === 'confirmed') {
      fb.append(confirmationView(booking.reservation, booking.restaurant));
    }
  }

  function confirmationView(reservation, restaurant) {
    const ids = tableIdsOf(reservation);
    return h('div', { class: 'confirmation', testid: 'confirmation', role: 'status' },
      h('p', { class: 'confirm-title' }, h('span', { class: 'tick', 'aria-hidden': 'true' }, '✓'), ' You’re booked'),
      h('p', { class: 'reference-line' }, 'Reference ',
        h('strong', { class: 'reference', testid: 'confirmation-reference' }, reservation.reference)),
      h('p', { class: 'details', testid: 'confirmation-details' },
        h('span', {}, restaurant.name), ' · ',
        h('span', { testid: 'confirmation-tables' }, tablesText(restaurant, ids)), ' · ',
        h('span', {}, `${formatLocalDate(reservation.starts_at_local)} at ${timeOf(reservation.starts_at_local)}`), ' · ',
        h('span', {}, guests(reservation.party_size))),
      h('p', { class: 'muted small-print' }, 'Keep your reference to look up or cancel this booking.'));
  }

  const REFUSALS = {
    table_unavailable: 'Sorry — that table was just taken. Availability has been refreshed; please pick another time or table.',
    party_exceeds_capacity: 'That party is too large for this table. Choose fewer guests or a larger table.',
    combination_not_allowed: 'Those tables can’t be joined. Please choose another option.',
    validation_failed: 'Please enter a party size of at least 1.',
    outside_opening_hours: 'The restaurant isn’t open for that time.',
    not_on_slot_grid: 'That start time isn’t bookable. Please pick a time from the grid.',
    invalid_local_time: 'That time doesn’t exist on this date because the clocks change. Please pick another.',
    idempotency_key_reuse: 'This booking request conflicts with an earlier one. Please change a detail and try again.',
    unauthenticated: 'Your session has ended. Please sign in again to book.',
    not_found: 'That table is no longer offered. Please search again.',
  };

  async function submitBooking(event) {
    event.preventDefault();
    if (!booking || booking.phase === 'pending') return;
    const current = booking;
    const body = bookingBody();
    const canonical = JSON.stringify(body);
    if (current.sentBody !== canonical) {
      // A changed form is a new booking request; an unchanged one replays its key.
      current.key = newKey();
      current.sentBody = canonical;
    }
    current.phase = 'pending';
    renderBookingFeedback();
    let resp;
    try {
      resp = await api('POST', '/reservations', { body, key: current.key });
    } catch {
      resp = null;
    }
    if (booking !== current) return; // the form was closed or replaced meanwhile
    if (!resp || resp.status >= 500) {
      current.phase = 'uncertain';
      current.message = 'We couldn’t confirm whether this booking went through. Press “Book this table” again to check — you won’t be booked twice.';
    } else if (resp.status === 200 || resp.status === 201) {
      current.phase = 'confirmed';
      current.reservation = resp.data;
      runSearch(search.params, { refresh: true });
      refreshConfirmation(current);
    } else {
      const code = errorCode(resp);
      current.phase = 'refused';
      current.message = REFUSALS[code] || 'This booking couldn’t be made. Please try again.';
      if (code === 'table_unavailable') runSearch(search.params, { refresh: true });
    }
    renderBookingFeedback();
  }

  // A replayed receipt is the original response; show the booking's current seating
  // (e.g. after a manager's seating change) by reading it back from the server.
  async function refreshConfirmation(current) {
    try {
      const latest = await api('GET', `/reservations/${encodeURIComponent(current.reservation.reference)}`);
      if (booking !== current || current.phase !== 'confirmed' || latest.status !== 200) return;
      current.reservation = latest.data;
      renderBookingFeedback();
    } catch {
      // keep the receipt we have
    }
  }

  // ---- lookup -----------------------------------------------------------------------------

  const lookup = { seq: 0 };

  function renderLookup() {
    const input = h('input', {
      id: 'lookup-reference', type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters',
      testid: 'lookup-reference-input', placeholder: 'e.g. K3P7QW', required: true,
    });
    const submit = h('button', { type: 'submit', class: 'button primary', testid: 'lookup-submit' }, 'Find booking');
    const result = h('div', { class: 'lookup-result', 'aria-live': 'polite' });

    function showError(message, keep) {
      for (const el of result.querySelectorAll('[data-testid="reservation-error"]')) el.remove();
      const err = h('p', { class: 'notice error', role: 'alert', testid: 'reservation-error' }, ...message);
      if (keep) result.append(err);
      else result.replaceChildren(err);
    }

    async function show(reference) {
      const seq = ++lookup.seq;
      result.replaceChildren(h('div', { class: 'loading card', role: 'status' },
        h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Looking up your booking…'));
      try {
        const resp = await api('GET', `/reservations/${encodeURIComponent(reference)}`);
        if (seq !== lookup.seq) return;
        if (resp.status === 401) {
          showError(['Please ', h('a', { href: '/login', 'data-link': true }, 'sign in'), ' to look up your booking.']);
          return;
        }
        if (resp.status !== 200) {
          showError(['We couldn’t find a booking with that reference on your account. Check the reference and try again.']);
          return;
        }
        const reservation = resp.data;
        const detail = await api('GET', `/restaurants/${encodeURIComponent(reservation.restaurant_id)}`);
        if (seq !== lookup.seq) return;
        renderDetail(reservation, detail.status === 200 ? detail.data : { name: reservation.restaurant_id, tables: [] });
      } catch {
        if (seq !== lookup.seq) return;
        showError(['We couldn’t reach Tablekeeper. Check your connection and try again.']);
      }
    }

    function renderDetail(reservation, restaurant) {
      const cancelled = reservation.status === 'cancelled';
      const cancel = cancelled ? null : h('button', {
        type: 'button', class: 'button danger', testid: 'reservation-cancel-button',
        onclick: async () => {
          cancel.disabled = true;
          cancel.textContent = 'Cancelling…';
          const seq = ++lookup.seq;
          try {
            const resp = await api('POST', `/reservations/${encodeURIComponent(reservation.reference)}/cancel`);
            if (seq !== lookup.seq) return;
            if (resp.status === 200) {
              renderDetail(resp.data, restaurant);
              return;
            }
            const code = errorCode(resp);
            showError([code === 'cutoff_passed'
              ? 'This booking starts too soon to cancel online. Please contact the restaurant.'
              : 'This booking couldn’t be cancelled. Please try again.'], true);
          } catch {
            if (seq !== lookup.seq) return;
            showError(['We couldn’t reach Tablekeeper, so the booking may not be cancelled yet. Please try again.'], true);
          }
          cancel.disabled = false;
          cancel.textContent = 'Cancel booking';
        },
      }, 'Cancel booking');
      result.replaceChildren(h('article', { class: `detail card ${cancelled ? 'is-cancelled' : ''}`, testid: 'reservation-detail' },
        h('div', { class: 'detail-head' },
          h('h2', {}, restaurant.name),
          h('span', { class: `badge ${cancelled ? 'badge-cancelled' : 'badge-confirmed'}`, testid: 'reservation-status' }, reservation.status)),
        h('dl', { class: 'facts' },
          h('div', {}, h('dt', {}, 'Reference'), h('dd', { class: 'reference' }, reservation.reference)),
          h('div', {}, h('dt', {}, 'Date'), h('dd', {}, formatLocalDate(reservation.starts_at_local))),
          h('div', {}, h('dt', {}, 'Time'), h('dd', {}, timeOf(reservation.starts_at_local))),
          h('div', {}, h('dt', {}, 'Table'), h('dd', { testid: 'reservation-tables' }, tablesText(restaurant, tableIdsOf(reservation)))),
          h('div', {}, h('dt', {}, 'Party'), h('dd', {}, guests(reservation.party_size)))),
        cancel && h('div', { class: 'detail-actions' }, cancel)));
    }

    main.append(
      h('section', { class: 'hero' },
        h('h1', {}, 'Your booking'),
        h('p', { class: 'lede' }, 'Enter the reference from your confirmation to see or cancel your reservation.')),
      h('form', {
        class: 'lookup-card card',
        onsubmit: (event) => {
          event.preventDefault();
          const reference = input.value.trim().toUpperCase();
          if (!reference) {
            showError(['Please enter your booking reference.']);
            return;
          }
          show(reference);
        },
      },
      h('div', { class: 'field grow' }, h('label', { for: 'lookup-reference' }, 'Booking reference'), input),
      h('div', { class: 'field action' }, submit)),
      result);
  }

  render();
}());
