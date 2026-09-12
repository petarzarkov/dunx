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
readSession();

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
 * Five seconds because that is short enough to watch a counter move while
 * clicking a panel, and long enough that a page left open overnight is not
 * traffic worth counting. `/api/demo/vitals` is `@SkipThrottle()`d, so the poll
 * does not spend the visitor's rate-limit budget.
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
readVitals();
setInterval(readVitals, VITALS_MS);

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
showSource('ledger');

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
  } finally {
    button.disabled = false;
  }
});
