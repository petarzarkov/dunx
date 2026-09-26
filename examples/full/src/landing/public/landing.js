const $ = (id) => document.getElementById(id);
const show = (el, value) => {
  el.textContent =
    typeof value === 'string' ? value : JSON.stringify(value, null, 2);
};
const append = (el, line) => {
  el.textContent = `${line}\n${el.textContent}`.slice(0, 4000);
};

/** Status strip, from the app's own readiness report. */
const readStatus = async () => {
  const strip = $('strip');
  try {
    const res = await fetch('/api/health/ready', {
      headers: { accept: 'application/json' },
    });
    const body = await res.json();
    const mins = Math.floor((body.uptimeMs ?? 0) / 60000);
    const parts = [
      `<span class="pill">status <b class="${body.status}">${body.status}</b></span>`,
      `<span class="pill">up <b>${mins} min</b></span>`,
    ];
    for (const check of body.checks ?? []) {
      parts.push(
        `<span class="pill">${check.name} <b class="${check.state}">${check.state}</b></span>`,
      );
    }
    strip.innerHTML = parts.join('');
  } catch {
    strip.innerHTML =
      '<span class="pill">status <b class="down">unreachable</b></span>';
  }
};
readStatus();
setInterval(readStatus, 15000);

/** Websocket. One socket, reconnected on demand. */
let socket;
$('ws-connect').addEventListener('click', () => {
  const out = $('ws-out');
  const say = $('ws-say');
  // Disabled before the replacement exists: send() on a CONNECTING socket
  // throws InvalidStateError, and Connect is clickable at any time.
  say.disabled = true;
  if (socket) socket.close();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const nick = encodeURIComponent($('nick').value || 'visitor');
  const ws = new WebSocket(`${proto}://${location.host}/chat?as=${nick}`);
  socket = ws;
  append(out, `connecting as ${nick}`);
  // Each handler ignores itself once a newer socket has replaced it. The
  // predecessor's close arrives after the new socket has opened, and
  // without this it would disable Send on a live connection.
  const current = () => socket === ws;
  ws.onopen = () => {
    if (!current()) return;
    append(out, 'open');
    say.disabled = false;
  };
  ws.onmessage = (event) => {
    if (current()) append(out, `<- ${event.data}`);
  };
  ws.onclose = (event) => {
    if (!current()) return;
    append(out, `closed with ${event.code}`);
    say.disabled = true;
  };
  ws.onerror = () => {
    if (current()) append(out, 'error');
  };
});
$('ws-say').addEventListener('click', () => {
  const text = $('say').value;
  if (!text || !socket) return;
  // The wire format is one JSON object: an event name and a payload.
  socket.send(JSON.stringify({ event: 'say', data: text }));
  append($('ws-out'), `-> say ${text}`);
  $('say').value = '';
});

/** Rate limit, five calls so the fourth shows the 429. */
$('burst').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const out = $('burst-out');
  button.disabled = true;
  out.textContent = '';
  try {
    for (let i = 1; i <= 5; i++) {
      const res = await fetch('/api/limits/burst');
      const remaining = res.headers.get('ratelimit-remaining') ?? '-';
      const retry = res.headers.get('retry-after');
      out.textContent += `${i}. ${res.status} remaining=${remaining}${
        retry ? ` retry-after=${retry}s` : ''
      }\n`;
    }
  } finally {
    button.disabled = false;
  }
});

/** Image, straight into an <img> so the browser decodes what Bun encoded. */
$('img-go').addEventListener('click', async () => {
  const width = $('img-w').value;
  const format = $('img-f').value;
  const query = `width=${width}&format=${format}`;
  const img = $('img-out');
  img.src = `/api/images/render?${query}&t=${Date.now()}`;
  img.hidden = false;
  const res = await fetch(`/api/images/metadata?${query}`);
  show($('img-meta'), await res.json());
});

/** Queue: enqueue, then poll the job until it settles. */
$('job-go').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const out = $('job-out');
  button.disabled = true;
  out.textContent = '';
  try {
    const res = await fetch('/api/jobs/thumbnails', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ width: 96, format: 'webp' }),
    });
    const job = await res.json();
    append(out, `${res.status} ${JSON.stringify(job)}`);
    if (!res.ok) return;
    for (let i = 0; i < 8; i++) {
      await new Promise((done) => setTimeout(done, 600));
      const poll = await fetch(`/api/jobs/thumbnails/${job.id}`);
      const state = await poll.json();
      append(out, `poll ${poll.status} ${JSON.stringify(state)}`);
      if (poll.ok && state.state !== 'waiting' && state.state !== 'active')
        break;
    }
  } finally {
    button.disabled = false;
  }
});

/**
 * Message broker: publish, then read back what the consumers in this same
 * process received.
 */

/** Appends, where `append` prepends. Oldest first like the transactions panel,
 * because a delivery line means nothing without the publish line above it. */
const trail = (el, line) => {
  el.textContent = `${el.textContent}${line}\n`.slice(-4000);
};

const DELIVERY_TRIES = 10;
const DELIVERY_MS = 400;
/**
 * The app answers 503 once `publishTimeoutMs` is up, which the example sets to
 * 2 s. This is the backstop for the request itself going nowhere, and `connected`
 * below is read first so the usual case reports immediately rather than after
 * that wait.
 */
const PUBLISH_MS = 8_000;

/** Whether the consuming side is attached, which is also whether publishing is
 * worth attempting. */
const brokerReady = async (out) => {
  const res = await fetch('/api/messaging/orders');
  if (!res.ok) {
    trail(out, `GET /api/messaging/orders -> ${res.status}`);
    return false;
  }
  const { connected } = await res.json();
  if (!connected) trail(out, 'no broker reachable - nothing is consuming');
  return connected;
};

/**
 * Waits for **this** publish rather than for a count. `handled` keeps the last
 * hundred deliveries the process has seen, so a count crosses the moment anyone
 * else on the page publishes anything.
 */
const awaitDelivery = async (id, out) => {
  for (let i = 0; i < DELIVERY_TRIES; i++) {
    await new Promise((done) => setTimeout(done, DELIVERY_MS));
    const res = await fetch('/api/messaging/orders');
    if (!res.ok) {
      trail(out, `   GET /api/messaging/orders -> ${res.status}`);
      return;
    }
    const { connected, handled } = await res.json();
    const mine = handled.filter((entry) => entry.id === id);
    for (const entry of mine) {
      trail(out, `<- ${entry.queue} traceId=${entry.traceId ?? '(none)'}`);
    }
    if (mine.length > 0) return;
    // A broker that went away mid-poll, rather than a delivery still in flight.
    if (!connected) {
      trail(out, '   no broker reachable - nothing consumed this');
      return;
    }
  }
  trail(out, `   nothing arrived in ${(DELIVERY_TRIES * DELIVERY_MS) / 1000}s`);
};

/**
 * One publish for all three buttons: refuse early with no broker, bound the
 * request, and hand the parsed body back for the caller to narrate. Returns
 * nothing when there was no answer worth narrating.
 */
const publish = async (button, path, payload) => {
  const out = $('mq-out');
  button.disabled = true;
  try {
    if (!(await brokerReady(out))) return undefined;
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(PUBLISH_MS),
    });
    const body = await res.json();
    if (res.ok) return body;
    trail(out, `POST ${path} -> ${res.status} ${body.error}`);
    return undefined;
  } catch (error) {
    // A timeout here is the broker going away between the readiness read and
    // this publish, which is the case `connected` above cannot rule out.
    trail(
      out,
      error.name === 'TimeoutError'
        ? `POST ${path} did not answer in ${PUBLISH_MS / 1000}s`
        : `POST ${path} failed: ${String(error)}`,
    );
    return undefined;
  } finally {
    button.disabled = false;
  }
};

const publishOrder = async (event, shipped) => {
  const out = $('mq-out');
  // Short and per click, so two visitors publishing at once still each read
  // back their own delivery.
  const id = `web-${Math.random().toString(36).slice(2, 8)}`;
  const body = await publish(event.currentTarget, '/api/messaging/orders', {
    id,
    total: 42,
    shipped,
  });
  if (body === undefined) return;
  trail(out, `-> ${body.routingKey} on ${body.exchange} as ${id}`);
  await awaitDelivery(id, out);
};
$('mq-place').addEventListener('click', (event) => publishOrder(event, false));
$('mq-ship').addEventListener('click', (event) => publishOrder(event, true));

/**
 * The same exchange with a body that is not an order. The handler returns DROP
 * rather than throwing, so the broker discards it instead of redelivering it
 * forever - which is what a throw on a `requeue: true` queue would cause.
 */
$('mq-bad').addEventListener('click', async (event) => {
  const out = $('mq-out');
  const sent = await publish(event.currentTarget, '/api/messaging/raw', {
    not: 'an order',
  });
  if (sent === undefined) return;
  trail(out, '-> order.placed carrying {"not":"an order"}');
  trail(out, '   dropped by the handler, so it is never redelivered');
});

/** Validation, both directions. */
const postUser = async (body, label) => {
  const out = $('bad-out');
  const res = await fetch('/api/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  out.textContent = `${label} -> ${res.status}\n${JSON.stringify(json, null, 2)}`;
};
$('bad-go').addEventListener('click', () => postUser({ name: 42 }, 'name: 42'));
$('good-go').addEventListener('click', () =>
  postUser(
    { name: `visitor-${Math.floor(Math.random() * 1000)}`, tags: [] },
    'a valid user',
  ),
);

/** Session: signed in on arrival, with no form to fill in. */
const signedIn = async () => {
  const res = await fetch('/api/profile', {
    headers: { accept: 'application/json' },
  });
  if (res.ok) return res.json();
  // Only 401 means there is no session yet. A 429 from the rate limiter or
  // a 500 is a different fact, and signing in would replace it with a
  // misleading answer.
  if (res.status !== 401) return { note: `profile ${res.status}` };
  // Guest mode issues one on demand. Without the plugin this route is not
  // mounted, which is what `bun start` does by default.
  const guest = await fetch('/api/auth/sign-in/anonymous', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  if (!guest.ok) return { note: 'guest sign-in is not enabled here' };
  const retry = await fetch('/api/profile', {
    headers: { accept: 'application/json' },
  });
  return retry.ok ? retry.json() : { note: `profile ${retry.status}` };
};
const readSession = async () => {
  try {
    show($('auth-out'), await signedIn());
  } catch (error) {
    // A rejected fetch is a dropped connection, not a status. Reported
    // rather than left as an unhandled rejection nobody sees.
    show($('auth-out'), `request failed: ${String(error)}`);
  }
};
$('who').addEventListener('click', readSession);

$('audit').addEventListener('click', async () => {
  const res = await fetch('/api/profile/audit', {
    headers: { accept: 'application/json' },
  });
  show(
    $('auth-out'),
    `GET /api/profile/audit -> ${res.status}\n${JSON.stringify(
      await res.json(),
      null,
      2,
    )}`,
  );
});

/** Trace context: send a known traceparent and see it adopted. */
$('trace-go').addEventListener('click', async () => {
  const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  const res = await fetch('/api/trace', { headers: { traceparent } });
  const body = await res.json();
  show(
    $('trace-out'),
    `sent  ${traceparent}\n\n${JSON.stringify(body, null, 2)}`,
  );
});

/**
 * Vitals, from the process rather than from a build-time claim.
 *
 * Polled only while its step is open, every five seconds: short enough to watch
 * a counter move, and no traffic at all from a tab parked on another step.
 * `/api/demo/vitals` is `@SkipThrottle()`d, so the poll does not spend the
 * visitor's rate-limit budget.
 */
const VITALS_MS = 5000;

const num = (value) =>
  value === null || value === undefined ? '-' : value.toLocaleString();
const millis = (value) => (value === null ? '-' : `${value.toFixed(2)} ms`);

const readVitals = async () => {
  const grid = $('vitals');
  const rows = $('routes');
  try {
    const res = await fetch('/api/demo/vitals', {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(String(res.status));
    const v = await res.json();

    const mins = Math.floor(v.uptimeMs / 60000);
    const hours = Math.floor(mins / 60);
    const cells = [
      ['uptime', hours > 0 ? `${hours}h ${mins % 60}m` : `${mins}m`],
      ['requests', num(v.http.requests)],
      ['in flight', num(v.http.inFlight)],
      ['sockets', num(v.http.sockets)],
      ['db queries', num(v.db.queries)],
      ['loop p99', millis(v.loop.p99Ms)],
    ];
    grid.innerHTML = cells
      .map(
        ([label, value]) =>
          `<div class="vital"><b>${value}</b><span>${label}</span></div>`,
      )
      .join('');

    rows.innerHTML = v.http.routes
      .map(
        (route) =>
          `<tr><td>${route.method} ${route.route}</td><td>${num(route.count)}</td>` +
          `<td>${millis(route.p50Ms)}</td><td>${millis(route.p99Ms)}</td></tr>`,
      )
      .join('');
  } catch {
    grid.innerHTML =
      '<div class="vital"><b>-</b><span>vitals unreachable</span></div>';
    rows.innerHTML = '';
  }
};

/** The DI panel: real source, cut at the end of the constructor. */
const showSource = async (name) => {
  const out = $('src-out');
  const path = $('src-path');
  out.textContent = 'reading...';
  path.textContent = '';
  const res = await fetch(`/api/demo/source/${name}`);
  const body = await res.json();
  if (!res.ok) {
    show(out, body);
    return;
  }
  // The constructor line is the claim, so it is the line that is coloured.
  out.innerHTML = body.code
    .split('\n')
    .map((line) => {
      const escaped = line.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      return /^\s*(constructor\(|private readonly|readonly )/.test(line)
        ? `<span class="hl">${escaped}</span>`
        : escaped;
    })
    .join('\n');
  path.innerHTML = `Read from <b>${body.path}</b> with <code>Bun.file</code>. Nothing above annotates a parameter.`;
};
$('src-ledger').addEventListener('click', () => showSource('ledger'));
$('src-gateway').addEventListener('click', () => showSource('gateway'));

/**
 * Transactions, and the rollback the 409 proves.
 *
 * The output stacks rather than replacing itself, because the proof is the
 * `rows` count across two calls: a committed transfer moves it by two, and a
 * failed one leaves it where it was. A balance would show nothing - a transfer
 * nets to zero whether or not it committed.
 */
const transfer = async (path, fail, label) => {
  const out = $('tx-out');
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      from: 'checking',
      to: 'savings',
      amount: 25,
      fail,
    }),
  });
  const body = await res.json();
  // Oldest first, unlike the websocket panel: the proof is the second `rows`
  // matching the first, and a reader comparing them should meet them in order.
  out.textContent = `${out.textContent}${label}\n  ${res.status} ${
    body.error ?? `rows now ${body.rows}, balance ${body.balance}`
  }\n`.slice(-4000);
};
$('tx-ok').addEventListener('click', () =>
  transfer('/api/ledger/transfer', false, 'POST /api/ledger/transfer'),
);
$('tx-fail').addEventListener('click', () =>
  transfer('/api/ledger/transfer', true, 'the same call with fail: true'),
);
$('tx-sync').addEventListener('click', () =>
  transfer(
    '/api/ledger/transfer-sync',
    false,
    'POST /api/ledger/transfer-sync (no await anywhere)',
  ),
);

/** Retry: the attempts the outbound client made, not the ones this page made. */
$('retry-go').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const out = $('retry-out');
  button.disabled = true;
  out.textContent = 'calling...';
  try {
    const res = await fetch('/api/demo/retry');
    const body = await res.json();
    const lines = body.attempts.map(
      (a) => `attempt ${a.attempt}${a.retry ? ' (retry)' : ''} at ${a.atMs} ms`,
    );
    out.textContent = `${lines.join('\n')}\n\n${body.outcome} in ${body.elapsedMs} ms`;
  } finally {
    button.disabled = false;
  }
});

/** Guards: the same controller answering 200, 401 and 403. */
const callReport = async (label, path, init) => {
  const res = await fetch(path, init);
  const body = await res.text();
  return `${label}\n  ${init?.method ?? 'GET'} ${path} -> ${res.status} ${body}\n`;
};
$('g-public').addEventListener('click', async () => {
  show(
    $('g-out'),
    await callReport(
      '@Public() - the class guard skips it',
      '/api/reports/health',
    ),
  );
});
$('g-read').addEventListener('click', async () => {
  const out = $('g-out');
  out.textContent = 'calling...';
  out.textContent =
    (await callReport('no credentials', '/api/reports')) +
    (await callReport('Authorization: Bearer viewer', '/api/reports', {
      headers: { authorization: 'Bearer viewer' },
    }));
});
$('g-write').addEventListener('click', async () => {
  const out = $('g-out');
  const post = (role) => ({
    method: 'POST',
    headers: {
      authorization: `Bearer ${role}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ title: `filed by ${role}` }),
  });
  out.textContent = 'calling...';
  out.textContent =
    (await callReport(
      'as viewer, @Roles("admin") refuses',
      '/api/reports',
      post('viewer'),
    )) + (await callReport('as admin', '/api/reports', post('admin')));
});

$('explorers-go').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const out = $('explorers-out');
  button.disabled = true;
  out.textContent = 'fetching...';
  try {
    const pages = [
      ['swagger-ui', '/api/docs'],
      ['scalar', '/api/reference'],
    ];
    const lines = [];
    for (const [name, path] of pages) {
      const res = await fetch(path);
      const html = await res.text();
      // Anything the page would pull from another host. Both renderers are
      // served out of the install, so the honest answer here is zero.
      const offOrigin = [
        ...html.matchAll(/(?:src|href)="(https?:)?\/\/[^"]+/g),
      ];
      lines.push(
        `${name.padEnd(10)} ${path.padEnd(16)} ${res.status} ` +
          `${(html.length / 1024).toFixed(0)} KiB, ${offOrigin.length} off-origin`,
      );
    }
    const doc = await fetch('/api/openapi.json');
    const spec = await doc.json();
    lines.push(
      '',
      `both render ${Object.keys(spec.paths).length} paths from one document`,
    );
    out.textContent = lines.join('\n');
  } catch (error) {
    // Without this the pane reads "fetching..." for as long as the tab is open.
    out.textContent = `could not read the explorers: ${String(error)}`;
  } finally {
    button.disabled = false;
  }
});

/**
 * The event bus. `handled` and `failures` are the dispatch the publisher got
 * back, so a subscriber that threw is visible here rather than only in the log.
 */
const placeThrough = async (button, total, label) => {
  const out = $('bus-out');
  button.disabled = true;
  try {
    const res = await fetch('/api/events/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ total }),
    });
    const body = await res.json();
    trail(out, `${label} -> ${res.status} ${body.event}`);
    trail(out, `   ${body.handled} subscriber(s) handled it`);
    for (const failure of body.failures ?? []) {
      trail(out, `   ${failure.subscriber} threw: ${failure.error}`);
    }
    if ((body.failures ?? []).length > 0) {
      trail(out, `   the request is still ${res.status}, not a 500`);
    }
  } finally {
    button.disabled = false;
  }
};
$('bus-ok').addEventListener('click', (event) =>
  placeThrough(event.currentTarget, 42, 'POST /api/events/orders total 42'),
);
$('bus-fail').addEventListener('click', (event) =>
  placeThrough(event.currentTarget, 100_000, 'the same call, total 100000'),
);
$('bus-list').addEventListener('click', async () => {
  const out = $('bus-out');
  const res = await fetch('/api/events/subscriptions');
  const rows = await res.json();
  out.textContent = rows
    .map(
      (row) =>
        `${row.event.padEnd(12)} ${row.subscriber.padEnd(30)} ` +
        `handled ${row.handled}, failed ${row.failed}`,
    )
    .join('\n');
});

/**
 * Server-sent events, read with the browser's own `EventSource`.
 *
 * Closed once the generator's last frame arrives: the handler ends the stream
 * after `count` ticks, and `EventSource` treats any end as a disconnect and
 * reconnects. Left open it would count forever.
 */
const SSE_COUNT = 5;
$('sse-go').addEventListener('click', (event) => {
  const button = event.currentTarget;
  const out = $('sse-out');
  button.disabled = true;
  out.textContent = '';
  const source = new EventSource(`/api/events/ticks?count=${SSE_COUNT}`);
  const done = () => {
    source.close();
    button.disabled = false;
  };
  trail(out, `EventSource /api/events/ticks?count=${SSE_COUNT}`);
  source.addEventListener('tick', (frame) => {
    trail(out, `<- id=${frame.lastEventId} ${frame.data}`);
    if (Number(frame.lastEventId) >= SSE_COUNT) {
      trail(out, 'stream ended, closed before it could reconnect');
      done();
    }
  });
  source.onerror = () => {
    trail(out, 'stream error');
    done();
  };
});

/** Connect, called as what it is on the wire: a POST carrying JSON. */
$('rpc-go').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const out = $('rpc-out');
  button.disabled = true;
  try {
    const path = '/greet.v1.GreetService/Say';
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'visitor' }),
    });
    const body = await res.json();
    out.textContent =
      `POST ${path} -> ${res.status}\n` +
      `${JSON.stringify(body, null, 2)}\n\n` +
      'greeted is a counter on an injected provider, so the RPC went through ' +
      'the same container the routes use.';
  } finally {
    button.disabled = false;
  }
});

/**
 * Cache tiers. The symbol is fresh per click for the reason the tour's own
 * single-flight step is: L2 is Redis, so a fixed key is still cached from the
 * last visitor and "loads" would move by zero on the first read too.
 */
$('cache-go').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const out = $('cache-out');
  const symbol = `web${Math.random().toString(36).slice(2, 8)}`;
  const loads = async () => (await (await fetch('/api/catalog')).json()).loads;
  const read = async () => (await fetch(`/api/catalog/${symbol}`)).json();
  button.disabled = true;
  out.textContent = '';
  try {
    const before = await loads();
    const first = await read();
    const afterFirst = await loads();
    trail(out, `GET /api/catalog/${symbol} -> ${first.price}`);
    trail(out, `   loads ${before} -> ${afterFirst}, a miss that loaded`);

    await read();
    trail(out, 'the same read again');
    trail(out, `   loads ${afterFirst} -> ${await loads()}, served from cache`);

    const evicted = await fetch(`/api/catalog/${symbol}`, { method: 'DELETE' });
    trail(out, `DELETE -> ${JSON.stringify(await evicted.json())}`);
    const atEvict = await loads();
    await read();
    trail(out, `   loads ${atEvict} -> ${await loads()}, loading again`);
  } finally {
    button.disabled = false;
  }
});

/** Keyset pagination: follow the cursor rather than count offsets. */
$('page-go').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const out = $('page-out');
  button.disabled = true;
  out.textContent = '';
  try {
    let cursor;
    // Bounded rather than `while (hasNextPage)`: a cursor that stopped advancing
    // would spin this forever against a page nobody is watching.
    for (let page = 1; page <= 10; page++) {
      const query = cursor === undefined ? '' : `&cursor=${cursor}`;
      const res = await fetch(`/api/notes/page?take=1${query}`);
      const body = await res.json();
      const rows = body.data.map((row) => row.text).join(', ');
      trail(out, `page ${page} -> ${rows || '(empty)'}`);
      if (!body.meta.hasNextPage) {
        trail(out, `   hasNextPage false after ${page} page(s)`);
        return;
      }
      cursor = encodeURIComponent(body.meta.nextCursor);
      trail(out, `   nextCursor ${body.meta.nextCursor}`);
    }
  } finally {
    button.disabled = false;
  }
});

/** API versioning: the same path at two versions, and what v1 says about itself. */
const readVersion = async (version) => {
  const path = `/api/v${version}/swatches`;
  const res = await fetch(path);
  const body = await res.json();
  const lines = [`GET ${path} -> ${res.status}`];
  for (const name of ['deprecation', 'sunset', 'link']) {
    lines.push(`  ${name}: ${res.headers.get(name) ?? '(not sent)'}`);
  }
  const shown = Array.isArray(body) ? body.slice(0, 2) : body;
  lines.push('', JSON.stringify(shown, null, 2));
  if (Array.isArray(body) && body.length > 2) {
    lines.push(`... ${body.length} in all`);
  }
  show($('ver-out'), lines.join('\n'));
};
$('ver-v1').addEventListener('click', () => readVersion(1));
$('ver-v2').addEventListener('click', () => readVersion(2));

/**
 * Conditional GET. `no-store` on every call, so the browser's own cache neither
 * answers for the server nor turns the 304 into a 200 before the script sees it.
 */
$('etag-go').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const out = $('etag-out');
  const get = (headers) => fetch('/api/colors', { headers, cache: 'no-store' });
  button.disabled = true;
  out.textContent = '';
  try {
    const first = await get({});
    const bytes = (await first.arrayBuffer()).byteLength;
    const tag = first.headers.get('etag');
    trail(out, `GET /api/colors -> ${first.status}, ${bytes} bytes`);
    trail(out, `   ETag: ${tag ?? '(not sent)'}`);
    if (tag === null) return;

    const again = await get({ 'if-none-match': tag });
    const empty = (await again.arrayBuffer()).byteLength;
    trail(out, `If-None-Match: ${tag}`);
    trail(
      out,
      `   ${again.status}, ${empty} bytes: the copy you hold is current`,
    );

    const stale = await get({ 'if-none-match': 'W/"0000000000000000"' });
    await stale.arrayBuffer();
    trail(out, 'If-None-Match: a tag the server never sent');
    trail(out, `   ${stale.status}, the full body again`);
  } finally {
    button.disabled = false;
  }
});

/**
 * Signed cookies. The page never reads the cookie, because it cannot: the theme
 * it applies is the one the server verified and sent back as JSON.
 */
const applyTheme = (theme) => {
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
};
const readPreference = async () => {
  const res = await fetch('/api/preferences', { cache: 'no-store' });
  if (!res.ok) return undefined;
  const { theme } = await res.json();
  applyTheme(theme);
  return theme;
};
const writePreference = async (event, theme) => {
  const button = event.currentTarget;
  const out = $('pref-out');
  button.disabled = true;
  try {
    const res = await fetch(
      '/api/preferences',
      theme === undefined
        ? { method: 'DELETE' }
        : {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ theme }),
          },
    );
    await res.arrayBuffer();
    const label = theme === undefined ? 'DELETE' : `PUT {"theme":"${theme}"}`;
    const read = await readPreference();
    show(
      out,
      `${label} /api/preferences -> ${res.status}\n` +
        `GET /api/preferences -> ${JSON.stringify({ theme: read })}\n\n` +
        `document.cookie mentions prefs: ${document.cookie.includes('prefs')}` +
        ' (HttpOnly)',
    );
  } finally {
    button.disabled = false;
  }
};
$('pref-dark').addEventListener('click', (event) =>
  writePreference(event, 'dark'),
);
$('pref-light').addEventListener('click', (event) =>
  writePreference(event, 'light'),
);
$('pref-clear').addEventListener('click', (event) =>
  writePreference(event, undefined),
);
readPreference().catch(() => undefined);

/** The headers `securityHeaders` adds, read off a route that sets none itself. */
const SECURITY_HEADERS = [
  'content-security-policy',
  'strict-transport-security',
  'x-content-type-options',
  'referrer-policy',
  'x-frame-options',
  'cross-origin-opener-policy',
  'origin-agent-cluster',
];
$('sec-headers').addEventListener('click', async () => {
  const res = await fetch('/api/health/live', { cache: 'no-store' });
  await res.arrayBuffer();
  const lines = SECURITY_HEADERS.map(
    (name) => `${name}: ${res.headers.get(name) ?? '(not sent)'}`,
  );
  show(
    $('sec-out'),
    `GET /api/health/live -> ${res.status}\n\n${lines.join('\n')}`,
  );
});
$('sec-csrf').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const res = await fetch('/api/demo/csrf');
    const rows = await res.json();
    if (!res.ok) {
      show($('sec-out'), rows);
      return;
    }
    const lines = rows.map(
      (row) =>
        `Sec-Fetch-Site: ${(row.secFetchSite ?? '(absent)').padEnd(11)} ` +
        `${row.caller.padEnd(22)} -> ${row.status} ` +
        (row.status === 403 ? 'refused' : 'let through, then validated'),
    );
    show(
      $('sec-out'),
      `POST /api/users with an empty body\n\n${lines.join('\n')}`,
    );
  } finally {
    button.disabled = false;
  }
});

/**
 * Idempotency. The subscribers' `handled` total is the proof the handler ran
 * once: a replay answers from the store and publishes nothing. Another visitor
 * placing an order at the same moment would move it too.
 */
const handledTotal = async () => {
  const rows = await (await fetch('/api/events/subscriptions')).json();
  return rows.reduce((sum, row) => sum + row.handled, 0);
};
const newKey = () =>
  crypto.randomUUID?.() ?? `k-${Math.random().toString(36).slice(2)}`;
$('idem-go').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const out = $('idem-out');
  const key = newKey();
  const post = (total) =>
    fetch('/api/events/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ total }),
    });
  button.disabled = true;
  out.textContent = '';
  try {
    trail(out, `Idempotency-Key: ${key}`);
    let before = await handledTotal();
    for (const label of ['POST /api/events/orders', 'the same POST again']) {
      const res = await post(42);
      await res.arrayBuffer();
      const after = await handledTotal();
      const replayed = res.headers.get('idempotent-replayed');
      trail(out, label);
      trail(
        out,
        `   ${res.status}, replayed: ${replayed ?? 'no'}, ` +
          `subscribers ran ${after - before} time(s)`,
      );
      before = after;
    }
    const changed = await post(43);
    const body = await changed.json();
    trail(out, 'the same key with a different body');
    trail(out, `   ${changed.status} ${body.message ?? body.error ?? ''}`);
  } finally {
    button.disabled = false;
  }
});

/** Email: the bound transport, since a public demo must not send anything. */
$('mail-go').addEventListener('click', async () => {
  const res = await fetch('/api/email');
  show(
    $('mail-out'),
    `GET /api/email -> ${res.status}\n${JSON.stringify(await res.json(), null, 2)}`,
  );
});

/**
 * The walkthrough. Every `[data-step]` is one screen, shown alone, and the
 * location hash names it so a step can be linked to and the back button works.
 * The contents are built from the sections, so a step added to the page is
 * listed without a second copy of its title here.
 */
const steps = [...document.querySelectorAll('[data-step]')];
const sections = steps.filter((step) => step.tagName === 'SECTION');
const chapters = [];
for (const section of sections) {
  const name = section.dataset.chapter;
  let chapter = chapters.at(-1);
  if (chapter?.name !== name) {
    chapter = { name, blurb: section.dataset.blurb ?? '', steps: [] };
    chapters.push(chapter);
  }
  chapter.steps.push(section);
}

const DONE_KEY = 'dunx-demo-done';
const done = new Set();
try {
  for (const name of JSON.parse(localStorage.getItem(DONE_KEY) ?? '[]')) {
    done.add(name);
  }
} catch {
  // Storage blocked or unparseable: progress is a convenience, not state.
}
const markDone = (name) => {
  if (done.has(name)) return;
  done.add(name);
  try {
    localStorage.setItem(DONE_KEY, JSON.stringify([...done]));
  } catch {
    // As above.
  }
  renderProgress();
};

const titleOf = (section) => section.querySelector('h2').textContent;
const links = new Map();
const toc = $('toc');
const outline = $('outline');
chapters.forEach((chapter, index) => {
  const item = document.createElement('li');
  const head = document.createElement('span');
  head.className = 'chapter';
  head.textContent = `${index + 1}. ${chapter.name}`;
  const list = document.createElement('ol');
  for (const section of chapter.steps) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `#${section.dataset.step}`;
    a.textContent = titleOf(section);
    li.append(a);
    list.append(li);
    links.set(section.dataset.step, a);
  }
  item.append(head, list);
  toc.append(item);

  const line = document.createElement('li');
  const first = document.createElement('a');
  first.href = `#${chapter.steps[0].dataset.step}`;
  first.textContent = chapter.name;
  const blurb = document.createElement('span');
  blurb.textContent = ` ${chapter.blurb} ${chapter.steps.length} steps.`;
  line.append(first, blurb);
  outline.append(line);
});

const renderProgress = () => {
  for (const [name, a] of links) a.classList.toggle('done', done.has(name));
  $('progress').textContent = `${done.size} of ${sections.length} tried`;
};

/** What a step does when it opens, and undoes when it closes. */
let vitalsTimer;
const ENTER = {
  di: () => showSource('ledger'),
  session: readSession,
  cookies: () => readPreference().catch(() => undefined),
  vitals: () => {
    readVitals();
    vitalsTimer = setInterval(readVitals, VITALS_MS);
  },
};
const LEAVE = {
  vitals: () => clearInterval(vitalsTimer),
};

const narrow = matchMedia('(max-width: 860px)');
let current;
const open = (name) => {
  const index = Math.max(
    0,
    steps.findIndex((step) => step.dataset.step === name),
  );
  const step = steps[index];
  if (step === current) return;
  if (current !== undefined) LEAVE[current.dataset.step]?.();
  for (const other of steps) other.hidden = other !== step;
  current = step;

  for (const [key, a] of links) {
    if (key === step.dataset.step) a.setAttribute('aria-current', 'step');
    else a.removeAttribute('aria-current');
  }
  const position = sections.indexOf(step);
  const pager = document.querySelector('.pager');
  pager.hidden = position === -1;
  $('prev').disabled = position <= 0;
  $('next').disabled = position === sections.length - 1;
  $('position').textContent =
    position === -1
      ? ''
      : `Step ${position + 1} of ${sections.length} · ${step.dataset.chapter}`;
  document.title =
    position === -1 ? 'dunx live demo' : `${titleOf(step)} · dunx live demo`;

  if (narrow.matches) document.querySelector('.toc details').open = false;
  window.scrollTo({ top: 0 });
  ENTER[step.dataset.step]?.();
};
const go = (offset) => {
  const next = steps[steps.indexOf(current) + offset];
  if (next !== undefined) location.hash = next.dataset.step;
};

$('start').addEventListener('click', () => {
  location.hash = sections[0].dataset.step;
});
$('prev').addEventListener('click', () => go(-1));
$('next').addEventListener('click', () => go(1));
addEventListener('hashchange', () => open(location.hash.slice(1)));
addEventListener('keydown', (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.target.closest('input, select, textarea')) return;
  if (event.key === 'ArrowRight') go(1);
  if (event.key === 'ArrowLeft') go(-1);
});
// A click on any button inside a step counts that step as tried.
document.querySelector('main').addEventListener('click', (event) => {
  const section = event.target.closest('section[data-step]');
  if (section !== null && event.target.closest('button') !== null) {
    markDone(section.dataset.step);
  }
});

if (narrow.matches) document.querySelector('.toc details').open = false;
renderProgress();
open(location.hash.slice(1));
