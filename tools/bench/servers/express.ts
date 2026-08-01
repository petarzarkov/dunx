import express from 'express';
import {
  echo,
  invalid,
  jsonPayload,
  personSchema,
  PLAINTEXT,
  port,
} from './shared.js';

const app = express();

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

app.listen(port());
