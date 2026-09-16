import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT) || 3999;
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
  pendingReview: string | null; // JSON-encoded proposal, kept for SSE replay on reconnect
  resolveReview: ((urls: string[] | null) => void) | null;
  pendingConfirm: string | null; // JSON-encoded cost estimate, kept for SSE replay on reconnect
  resolveConfirm: ((proceed: boolean) => void) | null;
  abortController: AbortController;
};

// Not necessarily the job whose async work is still running: `force` on POST /api/clone
// supersedes a live job by pointing this at a fresh one while the old one's IIFE finishes
// tearing down in the background. Broadcasts always target the specific job passed in, not
// this variable, so a superseded job's late events never leak into the new job's stream.
let job: Job | null = null;

function broadcast(j: Job, event: string, data: string) {
  const payload = `event: ${event}\ndata: ${data}\n\n`;
  for (const res of j.subscribers) res.write(payload);
}

function jobLog(j: Job, line: string) {
  j.lines.push(line);
  broadcast(j, 'log', JSON.stringify(line));
}

/** Aborts a job and unblocks any gate it's parked on. Idempotent. Returns false if already done. */
function stopJob(j: Job, reason: string): boolean {
  if (j.done) return false;
  j.done = true;
  j.error = reason;
  if (j.resolveReview) {
    const resolve = j.resolveReview;
    j.pendingReview = null;
    j.resolveReview = null;
    resolve(null);
  }
  if (j.resolveConfirm) {
    const resolve = j.resolveConfirm;
    j.pendingConfirm = null;
    j.resolveConfirm = null;
    resolve(false);
  }
  j.abortController.abort();
  broadcast(j, 'error', JSON.stringify(reason));
  for (const res of j.subscribers) res.end();
  j.subscribers = [];
  return true;
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
  const j: Job = {
    id: randomUUID(),
    lines: [],
    done: false,
    error: null,
    subscribers: [],
    pendingReview: null,
    resolveReview: null,
    pendingConfirm: null,
    resolveConfirm: null,
    abortController: new AbortController(),
  };
  job = j;

  const onLog = (line: string) => jobLog(j, line);

  const onReview = (proposal: unknown): Promise<string[] | null> =>
    new Promise((resolve) => {
      j.pendingReview = JSON.stringify(proposal);
      j.resolveReview = resolve;
      broadcast(j, 'review', j.pendingReview);
    });

  const onConfirm = (estimate: unknown): Promise<boolean> =>
    new Promise((resolve) => {
      j.pendingConfirm = JSON.stringify(estimate);
      j.resolveConfirm = resolve;
      broadcast(j, 'confirm', j.pendingConfirm);
    });

  (async () => {
    try {
      const pipeline = await import('./pipeline').catch(() => {
        throw new Error('Pipeline module not found — Phase 1 has not built pipeline.ts yet.');
      });
      await pipeline.runClone(url, onLog, { onReview, onConfirm, abortController: j.abortController });
      if (j.done) return; // already terminated (e.g. stopped) — don't clobber that state
      j.done = true;
      broadcast(j, 'done', JSON.stringify(''));
    } catch (err) {
      if (j.done) return; // already terminated (e.g. stopped) — don't clobber that state
      j.error = err instanceof Error ? err.message : String(err);
      j.done = true;
      broadcast(j, 'error', JSON.stringify(j.error));
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
  #review, #confirm { display: none; border: 1px solid #ddd; border-radius: 4px; padding: 0.75rem; margin: 0.75rem 0; }
  #review h2, #confirm h2 { font-size: 1rem; margin: 0 0 0.5rem; }
  #review ul { list-style: none; padding: 0; margin: 0 0 0.5rem; max-height: 220px; overflow-y: auto; }
  #review li { padding: 0.15rem 0; }
  #review .filtered { color: #999; font-size: 0.85rem; }
  #review .actions, #confirm .actions { margin-top: 0.5rem; }
  #review .actions button, #confirm .actions button { margin-right: 0.5rem; }
  #stop { margin-left: 0.5rem; }
</style>
</head>
<body>
<h1>Clone a website</h1>
<input id="url" placeholder="https://example.com" />
<button id="go">Clone</button>
<button id="stop" disabled>Stop</button>
<ul id="steps"></ul>
<div id="review"></div>
<div id="confirm"></div>
<div id="log"></div>
<div id="error"></div>
<script>
const STEPS = ${JSON.stringify(STEPS)};
const stepsEl = document.getElementById('steps');
const logEl = document.getElementById('log');
const errEl = document.getElementById('error');
const urlEl = document.getElementById('url');
const goEl = document.getElementById('go');
const stopEl = document.getElementById('stop');
const reviewEl = document.getElementById('review');
const confirmEl = document.getElementById('confirm');
let currentJobId = null;

function hideReview() {
  reviewEl.style.display = 'none';
  reviewEl.innerHTML = '';
}

function hideConfirm() {
  confirmEl.style.display = 'none';
  confirmEl.innerHTML = '';
}

function renderConfirm(jobId, estimate) {
  confirmEl.innerHTML = '';
  confirmEl.style.display = 'block';

  const h2 = document.createElement('h2');
  h2.textContent = 'Approve rebuild';
  confirmEl.appendChild(h2);

  const p = document.createElement('p');
  p.textContent = 'Estimated cost ~$' + estimate.estimatedCost.toFixed(2) + ' for ' + estimate.pages + ' pages.';
  confirmEl.appendChild(p);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const proceedBtn = document.createElement('button');
  proceedBtn.textContent = 'Proceed';
  proceedBtn.addEventListener('click', async () => {
    proceedBtn.disabled = true;
    cancelBtn.disabled = true;
    try {
      await fetch('/api/clone/' + jobId + '/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proceed: true }),
      });
    } catch (e) {
      errEl.textContent = 'Approve failed: ' + e;
    }
    hideConfirm();
  });
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', async () => {
    proceedBtn.disabled = true;
    cancelBtn.disabled = true;
    try {
      await fetch('/api/clone/' + jobId + '/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proceed: false }),
      });
    } catch (e) {
      errEl.textContent = 'Cancel failed: ' + e;
    }
    hideConfirm();
  });
  actions.appendChild(proceedBtn);
  actions.appendChild(cancelBtn);
  confirmEl.appendChild(actions);
}

function renderReview(jobId, proposal) {
  reviewEl.innerHTML = '';
  reviewEl.style.display = 'block';

  const h2 = document.createElement('h2');
  h2.textContent = 'Review pages before rebuild (' + proposal.pages.length + ' selected)';
  reviewEl.appendChild(h2);

  const list = document.createElement('ul');
  const checkboxes = [];
  proposal.pages.forEach((p) => {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.value = p.url;
    checkboxes.push(cb);
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + p.title + ' — ' + p.url + (p.hasScreenshot ? '' : ' (no screenshot)')));
    li.appendChild(label);
    list.appendChild(li);
  });
  reviewEl.appendChild(list);

  if (proposal.filtered && proposal.filtered.length) {
    const fh = document.createElement('div');
    fh.className = 'filtered';
    fh.textContent = 'Filtered out (' + proposal.filtered.length + '):';
    reviewEl.appendChild(fh);
    const flist = document.createElement('ul');
    proposal.filtered.forEach((f) => {
      const li = document.createElement('li');
      li.className = 'filtered';
      li.textContent = f.url + ' — ' + f.reason;
      flist.appendChild(li);
    });
    reviewEl.appendChild(flist);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  const approveBtn = document.createElement('button');
  approveBtn.textContent = 'Approve';
  approveBtn.addEventListener('click', async () => {
    approveBtn.disabled = true;
    cancelBtn.disabled = true;
    const urls = checkboxes.filter((cb) => cb.checked).map((cb) => cb.value);
    try {
      await fetch('/api/clone/' + jobId + '/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls }),
      });
    } catch (e) {
      errEl.textContent = 'Approve failed: ' + e;
    }
    hideReview();
  });
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', async () => {
    approveBtn.disabled = true;
    cancelBtn.disabled = true;
    try {
      await fetch('/api/clone/' + jobId + '/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cancel: true }),
      });
    } catch (e) {
      errEl.textContent = 'Cancel failed: ' + e;
    }
    hideReview();
  });
  actions.appendChild(approveBtn);
  actions.appendChild(cancelBtn);
  reviewEl.appendChild(actions);
}

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

function renderForceRetry(url) {
  errEl.textContent = '';
  errEl.appendChild(document.createTextNode('A clone job is already running. '));
  const retryBtn = document.createElement('button');
  retryBtn.textContent = 'Force restart';
  retryBtn.addEventListener('click', () => startClone(url, true));
  errEl.appendChild(retryBtn);
}

function attachJob(id) {
  currentJobId = id;
  stopEl.disabled = false;
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
  es.addEventListener('review', (e) => {
    renderReview(id, JSON.parse(e.data));
  });
  es.addEventListener('confirm', (e) => {
    renderConfirm(id, JSON.parse(e.data));
  });
  es.addEventListener('done', () => {
    hideReview();
    hideConfirm();
    renderSteps(STEPS.length);
    goEl.disabled = false;
    stopEl.disabled = true;
    currentJobId = null;
    es.close();
  });
  es.addEventListener('error', (e) => {
    // Named "event: error" messages carry .data; transport-level errors don't.
    if (e.data) errEl.textContent = JSON.parse(e.data);
    hideReview();
    hideConfirm();
    goEl.disabled = false;
    stopEl.disabled = true;
    currentJobId = null;
    es.close();
  });
}

async function startClone(url, force) {
  errEl.textContent = '';
  logEl.textContent = '';
  hideReview();
  hideConfirm();
  renderSteps(-1);
  goEl.disabled = true;
  let res;
  try {
    res = await fetch('/api/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, force: !!force }),
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
    renderForceRetry(url);
    goEl.disabled = false;
    return;
  }
  const { id } = await res.json();
  attachJob(id);
}

goEl.addEventListener('click', () => startClone(urlEl.value, false));

stopEl.addEventListener('click', async () => {
  if (!currentJobId) return;
  stopEl.disabled = true;
  try {
    await fetch('/api/clone/' + currentJobId + '/stop', { method: 'POST' });
  } catch (e) {
    errEl.textContent = 'Stop failed: ' + e;
  }
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
    let parsedBody: any;
    try {
      parsedBody = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }
    const targetUrl = parsedBody?.url;
    if (typeof targetUrl !== 'string' || !isValidUrl(targetUrl)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid url' }));
      return;
    }
    if (job && !job.done) {
      if (parsedBody?.force === true) {
        stopJob(job, 'Superseded by a new clone request');
      } else {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'A job is already running', force: 'retry with { force: true } to supersede it' }));
        return;
      }
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
    if (job.pendingReview) {
      res.write(`event: review\ndata: ${job.pendingReview}\n\n`);
    }
    if (job.pendingConfirm) {
      res.write(`event: confirm\ndata: ${job.pendingConfirm}\n\n`);
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

  const approveMatch = url.pathname.match(/^\/api\/clone\/([^/]+)\/approve$/);
  if (req.method === 'POST' && approveMatch) {
    const id = approveMatch[1];
    if (!job || job.id !== id) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown job id' }));
      return;
    }
    if (!job.pendingReview || !job.resolveReview) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No pending review for this job' }));
      return;
    }
    const body = await readBody(req);
    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const resolve = job.resolveReview;
    const proposal = JSON.parse(job.pendingReview) as { pages: { url: string }[] };

    if (parsed?.cancel === true) {
      job.pendingReview = null;
      job.resolveReview = null;
      jobLog(job, 'Cancelled — operator declined the review.');
      resolve(null);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const urls = parsed?.urls;
    if (!Array.isArray(urls) || !urls.every((u) => typeof u === 'string')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'urls must be an array of strings' }));
      return;
    }
    const allowed = new Set(proposal.pages.map((p) => p.url));
    if (!urls.every((u) => allowed.has(u))) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'urls must be a subset of the proposed pages' }));
      return;
    }

    job.pendingReview = null;
    job.resolveReview = null;
    if (urls.length) {
      jobLog(job, `Capturing design — approved ${urls.length} of ${proposal.pages.length} pages`);
      resolve(urls);
    } else {
      jobLog(job, 'Cancelled — no pages selected.');
      resolve(null);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const confirmMatch = url.pathname.match(/^\/api\/clone\/([^/]+)\/confirm$/);
  if (req.method === 'POST' && confirmMatch) {
    const id = confirmMatch[1];
    if (!job || job.id !== id) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown job id' }));
      return;
    }
    if (!job.pendingConfirm || !job.resolveConfirm) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No pending confirmation for this job' }));
      return;
    }
    const body = await readBody(req);
    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }
    if (typeof parsed?.proceed !== 'boolean') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'proceed must be a boolean' }));
      return;
    }

    const resolve = job.resolveConfirm;
    job.pendingConfirm = null;
    job.resolveConfirm = null;
    if (parsed.proceed) {
      jobLog(job, 'Rebuilding site — cost approved, starting rebuild…');
      resolve(true);
    } else {
      jobLog(job, 'Cancelled — rebuild not approved.');
      resolve(false);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const stopMatch = url.pathname.match(/^\/api\/clone\/([^/]+)\/stop$/);
  if (req.method === 'POST' && stopMatch) {
    const id = stopMatch[1];
    if (!job || job.id !== id) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown job id' }));
      return;
    }
    const body = await readBody(req);
    if (body.trim()) {
      try {
        JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }
    }
    if (job.done) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Job already finished' }));
      return;
    }
    stopJob(job, 'Stopped by user');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`UI listening on http://localhost:${PORT}`);
});
