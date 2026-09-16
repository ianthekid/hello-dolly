import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = 3999;
const STEPS = [
  'Mapping pages',
  'Extracting content',
  'Capturing design',
  'Rebuilding site',
  'Verifying against original',
  'Publishing local preview',
];

type Job = {
  id: string;
  lines: string[];
  done: boolean;
  error: string | null;
  subscribers: ServerResponse[];
};

let job: Job | null = null;

function broadcast(event: string, data: string) {
  if (!job) return;
  const payload = `event: ${event}\ndata: ${data}\n\n`;
  for (const res of job.subscribers) res.write(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function startJob(url: string) {
  const j: Job = { id: randomUUID(), lines: [], done: false, error: null, subscribers: [] };
  job = j;

  const onLog = (line: string) => {
    j.lines.push(line);
    broadcast('log', JSON.stringify(line));
  };

  (async () => {
    try {
      const pipeline = await import('./pipeline').catch(() => {
        throw new Error('Pipeline module not found — Phase 1 has not built pipeline.ts yet.');
      });
      await pipeline.runClone(url, onLog);
      j.done = true;
      broadcast('done', JSON.stringify(''));
    } catch (err) {
      j.error = err instanceof Error ? err.message : String(err);
      j.done = true;
      broadcast('error', JSON.stringify(j.error));
    } finally {
      for (const res of j.subscribers) res.end();
      j.subscribers = [];
    }
  })();

  return j;
}

function isValidUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Website Clone</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 680px; margin: 3rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.4rem; }
  #url { width: 70%; padding: 0.5rem; font-size: 1rem; }
  button { padding: 0.5rem 1rem; font-size: 1rem; cursor: pointer; }
  ul#steps { list-style: none; padding: 0; }
  ul#steps li { padding: 0.3rem 0; color: #999; }
  ul#steps li.active { color: #0366d6; font-weight: 600; }
  ul#steps li.done { color: #22863a; }
  ul#steps li.done::before { content: "✓ "; }
  ul#steps li.active::before { content: "… "; }
  ul#steps li.pending::before { content: "○ "; }
  #log { background: #f6f8fa; border: 1px solid #ddd; border-radius: 4px; padding: 0.75rem; height: 220px; overflow-y: auto; font-family: monospace; font-size: 0.85rem; white-space: pre-wrap; }
  #error { color: #cb2431; margin-top: 0.5rem; }
</style>
</head>
<body>
<h1>Clone a website</h1>
<input id="url" placeholder="https://example.com" />
<button id="go">Clone</button>
<ul id="steps"></ul>
<div id="log"></div>
<div id="error"></div>
<script>
const STEPS = ${JSON.stringify(STEPS)};
const stepsEl = document.getElementById('steps');
const logEl = document.getElementById('log');
const errEl = document.getElementById('error');
const urlEl = document.getElementById('url');
const goEl = document.getElementById('go');

function renderSteps(activeIdx) {
  stepsEl.innerHTML = '';
  STEPS.forEach((s, i) => {
    const li = document.createElement('li');
    li.textContent = s;
    li.className = activeIdx === -1 ? 'pending' : i < activeIdx ? 'done' : i === activeIdx ? 'active' : 'pending';
    stepsEl.appendChild(li);
  });
}
renderSteps(-1);

function linkify(text) {
  return text.replace(/(https?:\\/\\/[^\\s]+)/g, '<a href="$1" target="_blank">$1</a>');
}

goEl.addEventListener('click', async () => {
  errEl.textContent = '';
  logEl.textContent = '';
  renderSteps(-1);
  goEl.disabled = true;
  let res;
  try {
    res = await fetch('/api/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: urlEl.value }),
    });
  } catch (e) {
    errEl.textContent = 'Request failed: ' + e;
    goEl.disabled = false;
    return;
  }
  if (res.status === 400) {
    errEl.textContent = 'Invalid URL.';
    goEl.disabled = false;
    return;
  }
  if (res.status === 409) {
    errEl.textContent = 'A clone job is already running.';
    goEl.disabled = false;
    return;
  }
  const { id } = await res.json();
  const es = new EventSource('/api/clone/' + id + '/events');
  let activeIdx = -1;
  es.addEventListener('log', (e) => {
    const line = JSON.parse(e.data);
    const div = document.createElement('div');
    div.innerHTML = linkify(line);
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
    const idx = STEPS.findIndex((s) => line.startsWith(s));
    if (idx !== -1) {
      activeIdx = idx;
      renderSteps(activeIdx);
    }
  });
  es.addEventListener('done', () => {
    renderSteps(STEPS.length);
    goEl.disabled = false;
    es.close();
  });
  es.addEventListener('error', (e) => {
    // Named "event: error" messages carry .data; transport-level errors don't.
    if (e.data) errEl.textContent = JSON.parse(e.data);
    goEl.disabled = false;
    es.close();
  });
});
</script>
</body>
</html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/clone') {
    const body = await readBody(req);
    let targetUrl: string;
    try {
      targetUrl = JSON.parse(body).url;
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }
    if (typeof targetUrl !== 'string' || !isValidUrl(targetUrl)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid url' }));
      return;
    }
    if (job && !job.done) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'A job is already running' }));
      return;
    }
    const j = startJob(targetUrl);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: j.id }));
    return;
  }

  const eventsMatch = url.pathname.match(/^\/api\/clone\/([^/]+)\/events$/);
  if (req.method === 'GET' && eventsMatch) {
    const id = eventsMatch[1];
    if (!job || job.id !== id) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown job id' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    for (const line of job.lines) {
      res.write(`event: log\ndata: ${JSON.stringify(line)}\n\n`);
    }
    if (job.done) {
      if (job.error) {
        res.write(`event: error\ndata: ${JSON.stringify(job.error)}\n\n`);
      } else {
        res.write(`event: done\ndata: ${JSON.stringify('')}\n\n`);
      }
      res.end();
      return;
    }
    job.subscribers.push(res);
    req.on('close', () => {
      if (job) job.subscribers = job.subscribers.filter((r) => r !== res);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`UI listening on http://localhost:${PORT}`);
});
