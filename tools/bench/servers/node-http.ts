import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {
  echo,
  invalid,
  jsonPayload,
  personSchema,
  PLAINTEXT,
  port,
} from './shared.js';

const TEXT = { 'content-type': 'text/plain; charset=utf-8' };
const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' };

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });

const validate = async (
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  const parsed = personSchema.safeParse(JSON.parse(await readBody(req)));
  if (!parsed.success) {
    res.writeHead(400, JSON_TYPE);
    res.end(JSON.stringify(invalid));
    return;
  }
  res.writeHead(200, JSON_TYPE);
  res.end(JSON.stringify(echo(parsed.data)));
};

createServer((req, res) => {
  const url = req.url ?? '/';
  if (url === '/plaintext') {
    res.writeHead(200, TEXT);
    res.end(PLAINTEXT);
    return;
  }
  if (url === '/json') {
    res.writeHead(200, JSON_TYPE);
    res.end(JSON.stringify(jsonPayload()));
    return;
  }
  if (url.startsWith('/params/')) {
    res.writeHead(200, JSON_TYPE);
    res.end(JSON.stringify({ id: url.slice('/params/'.length) }));
    return;
  }
  if (url === '/validate' && req.method === 'POST') {
    void validate(req, res);
    return;
  }
  res.writeHead(404, TEXT);
  res.end('Not Found');
}).listen(port());
