import express from 'express';
import { connectLazyIo, readLazyIo } from './io/lazy.js';
import {
  echo,
  invalid,
  jsonPayload,
  personSchema,
  PLAINTEXT,
  port,
} from './shared.js';

const app = express();

const ioReady = await connectLazyIo();

// Both are on by default and are work no other subject does. Leaving them on would
// measure Express's defaults rather than the shared workload; the README says so.
app.set('etag', false);
app.disable('x-powered-by');

app.get('/plaintext', (_req, res) => {
  res.type('text/plain').send(PLAINTEXT);
});

app.get('/json', (_req, res) => {
  res.json(jsonPayload());
});

app.get('/params/:id', (req, res) => {
  res.json({ id: req.params.id });
});

app.post('/validate', express.json(), (req, res) => {
  const parsed = personSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(invalid);
    return;
  }
  res.json(echo(parsed.data));
});

if (ioReady) {
  // The rejection is handled rather than left to Node's default, which exits the
  // process - see the note in servers/node-http.ts.
  app.get('/io', (_req, res) => {
    void readLazyIo().then(
      (payload) => res.json(payload),
      (error: unknown) => res.status(500).json({ error: String(error) }),
    );
  });
}

app.listen(port());
