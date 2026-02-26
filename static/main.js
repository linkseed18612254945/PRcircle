/* ============================================================
   PRcircle – Frontend Application  (v2 – full rewrite)

   Key design decisions:
   1. INCREMENTAL rendering – only append new DOM nodes; never
      clear + re-render the entire message list.  This fixes
      flicker, scroll-jumping, and collapsed <details> resets.
   2. Rich metadata components – search directives as pill tags,
      retrieval results as mini-cards, citations as numbered refs.
   3. Phase-aware UI – the backend now emits `round_start` and
      `phase` events; we surface them as round dividers and an
      "active agent" panel with a spinner.
   ============================================================ */

// ===== DOM refs =====
const tabs           = document.querySelectorAll('.nav-tab');
const pages          = document.querySelectorAll('.page');
const startBtn       = document.getElementById('startBtn');
const stopBtn        = document.getElementById('stopBtn');
const newSessionBtn  = document.getElementById('newSessionBtn');
const clearSessionBtn = document.getElementById('clearSessionBtn');
const sessionSelect  = document.getElementById('sessionSelect');
const runStatus      = document.getElementById('runStatus');
const statusDot      = document.getElementById('statusDot');
const progressWrap   = document.getElementById('progressWrap');
const progressFill   = document.getElementById('progressFill');
const progressLabel  = document.getElementById('progressLabel');
const progressPct    = document.getElementById('progressPct');
const agentPanel     = document.getElementById('agentPanel');
const agentPanelAvatar = document.getElementById('agentPanelAvatar');
const agentPanelName = document.getElementById('agentPanelName');
const agentPanelPhase = document.getElementById('agentPanelPhase');
const messagesArea   = document.getElementById('messages');
const emptyState     = document.getElementById('emptyState');
const msgCountEl     = document.getElementById('msgCount');

// ===== State =====
const sessions       = new Map();
let activeSessionId  = null;
let isRunning        = false;
let abortController  = null;
let maxRounds        = 3;
let renderedCount    = 0;   // how many messages already in DOM

// ===== Constants =====
const ROLE_LABELS = { A: 'Agent A · Analyst', B: 'Agent B · Challenger', C: 'Agent C · Observer', user: 'User' };
const ROLE_SHORT  = { A: 'Analyst', B: 'Challenger', C: 'Observer', user: 'User' };
const PHASE_LABELS = { searching: 'Searching & retrieving evidence...', generating: 'Generating response...', synthesizing: 'Synthesizing final report...' };

// SVG icons (inline, tiny)
const SEARCH_ICON = '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="5" fill="none" stroke="#fff" stroke-width="2"/><line x1="11" y1="11" x2="15" y2="15" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>';
const LINK_ICON = '<svg viewBox="0 0 16 16"><path d="M6.5 9.5a3.5 3.5 0 005-5l-1-1a3.5 3.5 0 00-5 0l-.5.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M9.5 6.5a3.5 3.5 0 00-5 5l1 1a3.5 3.5 0 005 0l.5-.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

// ======================================================================
//  Session management
// ======================================================================
function createSession(name) {
  const id = crypto.randomUUID();
  sessions.set(id, { id, name: name || `Session ${sessions.size + 1}`, topic: '', time_context: '', pr_goal: '', messages: [] });
  return id;
}

function refreshSessionOptions() {
  sessionSelect.innerHTML = '';
  sessions.forEach(s => {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = `${s.name} (${s.id.slice(0, 8)})`;
    sessionSelect.appendChild(o);
  });
  if (activeSessionId) sessionSelect.value = activeSessionId;
}

function switchSession(id) {
  activeSessionId = id;
  const s = sessions.get(id);
  if (!s) return;
  document.getElementById('topic').value = s.topic || '';
  document.getElementById('timeContext').value = s.time_context || '';
  document.getElementById('prGoal').value = s.pr_goal || '';
  // Full render when switching sessions (necessary)
  fullRender(s.messages);
  if (!isRunning) setStatus('idle', 'Ready');
}

// ======================================================================
//  Tab navigation
// ======================================================================
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    pages.forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.target).classList.add('active');
  });
});

// ======================================================================
//  Config extraction
// ======================================================================
function cfg(prefix) {
  return {
    model_name: document.getElementById(`${prefix}_model`).value,
    base_url:   document.getElementById(`${prefix}_base`).value,
    api_key:    document.getElementById(`${prefix}_key`).value,
    temperature: Number(document.getElementById(`${prefix}_temp`).value),
    max_tokens:  Number(document.getElementById(`${prefix}_max`).value),
    capability_prompt: document.getElementById(`${prefix}_capability`).value,
  };
}

// ======================================================================
//  Helpers
// ======================================================================
function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

function inlineMarkdown(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function markdownToHtml(raw) {
  const safe = escapeHtml(String(raw || '')).replace(/\r\n/g, '\n');
  const lines = safe.split('\n');
  let html = '', inList = false, inCode = false, code = '';
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      if (inCode) { html += `<pre><code>${code}</code></pre>`; code = ''; inCode = false; }
      else { closeList(); inCode = true; }
      continue;
    }
    if (inCode) { code += (code ? '\n' : '') + line; continue; }
    if (!line.trim()) { closeList(); continue; }
    if (line.startsWith('#### '))  { closeList(); html += `<h5>${inlineMarkdown(line.slice(5))}</h5>`; continue; }
    if (line.startsWith('### '))   { closeList(); html += `<h4>${inlineMarkdown(line.slice(4))}</h4>`; continue; }
    if (line.startsWith('## '))    { closeList(); html += `<h3>${inlineMarkdown(line.slice(3))}</h3>`; continue; }
    if (line.startsWith('# '))     { closeList(); html += `<h2>${inlineMarkdown(line.slice(2))}</h2>`; continue; }
    if (line.startsWith('&gt; '))  { closeList(); html += `<blockquote>${inlineMarkdown(line.slice(5))}</blockquote>`; continue; }
    if (/^\d+\.\s+/.test(line) || /^[-*]\s+/.test(line)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inlineMarkdown(line.replace(/^(\d+\.\s+|[-*]\s+)/, ''))}</li>`;
      continue;
    }
    closeList();
    html += `<p>${inlineMarkdown(line)}</p>`;
  }
  if (inCode && code) html += `<pre><code>${code}</code></pre>`;
  closeList();
  return html;
}

function formatTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  catch { return ''; }
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace('www.', ''); } catch { return ''; }
}

// ======================================================================
//  Build a single message DOM node  (the core rendering function)
// ======================================================================
function buildMessageNode(m) {
  const el = document.createElement('div');
  el.className = `msg ${m.role}`;

  // --- header ---
  const hdr = document.createElement('div');
  hdr.className = 'msg-header';
  hdr.innerHTML = `
    <div class="msg-avatar">${m.role === 'user' ? 'U' : m.role}</div>
    <div class="msg-info">
      <div class="msg-role">${ROLE_LABELS[m.role] || m.role}</div>
      <div class="msg-subtitle">
        ${m.search_directives?.length ? `<span>${m.search_directives.length} searches</span>` : ''}
        ${m.retrievals?.length ? `<span>${m.retrievals.length} sources retrieved</span>` : ''}
        ${m.citation_sources?.length ? `<span>${m.citation_sources.length} citations</span>` : ''}
      </div>
    </div>
    <span class="msg-time">${formatTime(m.timestamp)}</span>`;
  el.appendChild(hdr);

  // --- content ---
  const body = document.createElement('div');
  body.className = 'markdown-body';
  const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
  body.innerHTML = markdownToHtml(content);
  el.appendChild(body);

  // --- meta sections container ---
  const hasSearchDir = m.search_directives?.length > 0;
  const hasSearchQ   = m.search_queries?.length > 0;
  const hasCitations = m.citation_sources?.length > 0;
  const hasRetrievals = m.retrievals?.length > 0;
  const hasStructured = m.structured && Object.keys(m.structured).length > 0;
  const hasMeta = hasSearchDir || hasSearchQ || hasCitations || hasRetrievals || hasStructured;

  if (hasMeta) {
    const meta = document.createElement('div');
    meta.className = 'meta-sections';

    // Search directives (pills)
    if (hasSearchDir) {
      const sec = document.createElement('div');
      sec.innerHTML = `<div class="meta-header"><svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="11" y1="11" x2="15" y2="15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> Search Directives <span class="meta-count">${m.search_directives.length}</span></div>`;
      const pills = document.createElement('div');
      pills.className = 'search-directives';
      m.search_directives.forEach(d => {
        const pill = document.createElement('span');
        pill.className = 'search-pill';
        pill.innerHTML = `<span class="search-pill-icon">${SEARCH_ICON}</span><span class="search-pill-text" title="${escapeHtml(d.query)}">${escapeHtml(d.query)}</span>`;
        if (d.domains?.length) {
          d.domains.forEach(dm => {
            const tag = document.createElement('span');
            tag.className = 'search-pill-domain';
            tag.textContent = dm;
            pill.appendChild(tag);
          });
        }
        pills.appendChild(pill);
      });
      sec.appendChild(pills);
      meta.appendChild(sec);
    } else if (hasSearchQ) {
      const sec = document.createElement('div');
      sec.innerHTML = `<div class="meta-header"><svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="11" y1="11" x2="15" y2="15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> Search Queries <span class="meta-count">${m.search_queries.length}</span></div>`;
      const pills = document.createElement('div');
      pills.className = 'search-directives';
      m.search_queries.forEach(q => {
        const pill = document.createElement('span');
        pill.className = 'search-pill';
        pill.innerHTML = `<span class="search-pill-icon">${SEARCH_ICON}</span><span class="search-pill-text">${escapeHtml(q)}</span>`;
        pills.appendChild(pill);
      });
      sec.appendChild(pills);
      meta.appendChild(sec);
    }

    // Citations
    if (hasCitations) {
      const sec = document.createElement('div');
      sec.innerHTML = `<div class="meta-header"><svg viewBox="0 0 16 16"><path d="M3 3h10v10H3z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6 7h4M6 9h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg> Citations <span class="meta-count">${m.citation_sources.length}</span></div>`;
      const grid = document.createElement('div');
      grid.className = 'retrieval-grid';
      m.citation_sources.forEach((r, i) => {
        grid.appendChild(buildRetrievalCard(r, i + 1, 'cite'));
      });
      sec.appendChild(grid);
      meta.appendChild(sec);
    }

    // Retrievals
    if (hasRetrievals) {
      const sec = document.createElement('div');
      sec.innerHTML = `<div class="meta-header"><svg viewBox="0 0 16 16"><path d="M2 4l6-2 6 2v8l-6 2-6-2z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 2v12M2 4l6 2 6-2" fill="none" stroke="currentColor" stroke-width="1.2"/></svg> Retrieved Sources <span class="meta-count">${m.retrievals.length}</span></div>`;
      const grid = document.createElement('div');
      grid.className = 'retrieval-grid';
      m.retrievals.forEach((r, i) => {
        grid.appendChild(buildRetrievalCard(r, i + 1, 'ret'));
      });
      sec.appendChild(grid);
      meta.appendChild(sec);
    }

    // Structured JSON
    if (hasStructured) {
      const det = document.createElement('details');
      const sum = document.createElement('summary');
      sum.textContent = 'Structured JSON';
      det.appendChild(sum);
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify(m.structured, null, 2);
      det.appendChild(pre);
      meta.appendChild(det);
    }

    el.appendChild(meta);
  }

  return el;
}

// ======================================================================
//  Retrieval card builder
// ======================================================================
function buildRetrievalCard(r, idx, type) {
  const card = document.createElement('div');
  card.className = 'retrieval-card';
  const idxEl = document.createElement('div');
  idxEl.className = 'retrieval-idx';
  idxEl.textContent = type === 'cite' ? `R${idx}` : `${idx}`;
  if (type === 'cite') idxEl.style.background = '#8b5cf6';

  const body = document.createElement('div');
  body.className = 'retrieval-body';

  const title = document.createElement('div');
  title.className = 'retrieval-title';
  if (r.url) {
    title.innerHTML = `<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.title || 'Untitled')}</a>`;
  } else {
    title.textContent = r.title || 'Untitled';
  }
  body.appendChild(title);

  if (r.url) {
    const urlEl = document.createElement('div');
    urlEl.className = 'retrieval-url';
    urlEl.textContent = extractDomain(r.url) + ' — ' + r.url;
    body.appendChild(urlEl);
  }

  if (r.content) {
    const snippet = document.createElement('div');
    snippet.className = 'retrieval-snippet';
    snippet.textContent = r.content.slice(0, 200);
    body.appendChild(snippet);
  }

  card.appendChild(idxEl);
  card.appendChild(body);

  if (r.score > 0) {
    const score = document.createElement('div');
    score.className = 'retrieval-score';
    score.textContent = r.score.toFixed(2);
    card.appendChild(score);
  }
  return card;
}

// ======================================================================
//  Round divider builder
// ======================================================================
function buildRoundDivider(round, maxR) {
  const div = document.createElement('div');
  div.className = 'round-divider';
  div.innerHTML = `<div class="round-divider-line"></div><div class="round-badge"><span class="round-badge-dot"></span> ROUND ${round} / ${maxR}</div><div class="round-divider-line"></div>`;
  return div;
}

function buildSynthesisDivider() {
  const div = document.createElement('div');
  div.className = 'round-divider';
  div.innerHTML = `<div class="round-divider-line"></div><div class="round-badge synthesis"><span class="round-badge-dot"></span> FINAL SYNTHESIS</div><div class="round-divider-line"></div>`;
  return div;
}

// ======================================================================
//  INCREMENTAL append (only add what's new)
// ======================================================================
function appendMessage(m) {
  if (emptyState && emptyState.parentNode) emptyState.remove();
  messagesArea.appendChild(buildMessageNode(m));
  renderedCount++;
  updateMsgCount();
  scrollToBottom();
}

function appendRoundDivider(round, maxR) {
  if (emptyState && emptyState.parentNode) emptyState.remove();
  messagesArea.appendChild(buildRoundDivider(round, maxR));
  scrollToBottom();
}

function appendSynthesisDivider() {
  if (emptyState && emptyState.parentNode) emptyState.remove();
  messagesArea.appendChild(buildSynthesisDivider());
  scrollToBottom();
}

// ======================================================================
//  FULL render  (used on session switch / clear only)
// ======================================================================
function fullRender(messages) {
  messagesArea.innerHTML = '';
  renderedCount = 0;

  if (!messages || messages.length === 0) {
    messagesArea.innerHTML = `<div class="msg-empty" id="emptyState"><div class="msg-empty-icon">&#9672;</div><div class="msg-empty-text">No messages yet.<br/>Configure your topic and click <strong>Start Analysis</strong> to begin.</div></div>`;
    updateMsgCount();
    return;
  }

  // Reconstruct with round dividers inferred from message pattern
  let round = 0;
  let aCount = 0;
  let cSeen = false;

  messages.forEach(m => {
    if (m.role === 'A') {
      aCount++;
      if (aCount === 1 || (aCount > 1 && !cSeen)) {
        round++;
        messagesArea.appendChild(buildRoundDivider(round, maxRounds));
      }
    }
    if (m.role === 'C' && !cSeen) {
      cSeen = true;
      messagesArea.appendChild(buildSynthesisDivider());
    }
    messagesArea.appendChild(buildMessageNode(m));
    renderedCount++;
  });
  updateMsgCount();
  scrollToBottom();
}

// ======================================================================
//  Scroll & counters
// ======================================================================
function scrollToBottom() {
  requestAnimationFrame(() => { messagesArea.scrollTop = messagesArea.scrollHeight; });
}

function updateMsgCount() {
  const session = sessions.get(activeSessionId);
  const count = session ? session.messages.length : 0;
  msgCountEl.textContent = count ? `${count} message${count > 1 ? 's' : ''}` : '';
}

// ======================================================================
//  Status / Progress / Agent panel
// ======================================================================
function setStatus(state, text) {
  statusDot.className = 'status-dot';
  if (state === 'running') statusDot.classList.add('running');
  else if (state === 'done') statusDot.classList.add('done');
  else if (state === 'error') statusDot.classList.add('error');
  runStatus.textContent = text;
}

function showAgentPanel(agent, phase) {
  const colors = { A: 'var(--a-color)', B: 'var(--b-color)', C: 'var(--c-color)' };
  agentPanelAvatar.textContent = agent;
  agentPanelAvatar.style.background = colors[agent] || 'var(--pri)';
  agentPanelName.textContent = ROLE_LABELS[agent] || agent;
  agentPanelName.style.color = colors[agent] || 'var(--text)';
  agentPanelPhase.textContent = PHASE_LABELS[phase] || phase;
  document.getElementById('agentSpinner').style.borderTopColor = colors[agent] || 'var(--pri)';
  agentPanel.classList.add('active');
}

function hideAgentPanel() {
  agentPanel.classList.remove('active');
}

function updateProgress(round, maxR, phase) {
  const total = maxR * 2 + 1;
  let step = (round - 1) * 2 + (phase === 'B' ? 2 : phase === 'A' ? 1 : 0);
  if (phase === 'C') step = total;
  const pct = Math.min(Math.round((step / total) * 100), 100);
  progressFill.style.width = pct + '%';
  progressPct.textContent = pct + '%';
  progressLabel.textContent = phase === 'C' ? 'Final Synthesis' : `Round ${round} / ${maxR}`;
}

// ======================================================================
//  UI lock
// ======================================================================
function setRunning(running) {
  isRunning = running;
  startBtn.disabled = running;
  clearSessionBtn.disabled = running;
  ['topic', 'timeContext', 'prGoal', 'maxRounds'].forEach(id => document.getElementById(id).disabled = running);
  sessionSelect.disabled = running;
  newSessionBtn.disabled = running;
  if (running) {
    stopBtn.style.display = 'inline-flex';
    progressWrap.classList.add('active');
    progressFill.style.width = '0%';
    progressPct.textContent = '0%';
    setStatus('running', 'Running analysis...');
  } else {
    stopBtn.style.display = 'none';
    hideAgentPanel();
  }
}

// ======================================================================
//  SSE chunk processing  (bug-fixed, incremental)
// ======================================================================
let currentRound = 0;
let agentMsgCount = 0;    // counts A/B/C messages (not user)
let lastSynthDivider = false;

function processSSEChunk(rawChunk, targetSessionId) {
  const normalized = rawChunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const dataLines = normalized.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart());
  if (!dataLines.length) return;

  let event = null;
  const joined = dataLines.join('\n');
  try { event = JSON.parse(joined); }
  catch {
    for (const line of dataLines) {
      try { event = JSON.parse(line); break; } catch { /* next */ }
    }
  }
  if (!event) return;

  const sid = event.session_id || targetSessionId;
  const session = sessions.get(sid);
  if (!session) return;
  const isActive = (sid === activeSessionId);

  switch (event.type) {
    case 'session_started': {
      if (event.message) {
        session.messages = [event.message];
        agentMsgCount = 0;
        currentRound = 0;
        lastSynthDivider = false;
        maxRounds = event.max_rounds || maxRounds;
        if (isActive) {
          // Reset DOM
          messagesArea.innerHTML = '';
          renderedCount = 0;
          appendMessage(event.message);
        }
      }
      break;
    }

    case 'round_start': {
      currentRound = event.round || (currentRound + 1);
      maxRounds = event.max_rounds || maxRounds;
      if (isActive) {
        appendRoundDivider(currentRound, maxRounds);
        updateProgress(currentRound, maxRounds, 'A');
      }
      showAgentPanel('A', 'searching');
      break;
    }

    case 'phase': {
      const agent = event.agent || 'A';
      const phase = event.phase || 'generating';
      showAgentPanel(agent, phase);
      if (agent === 'C' && isActive && !lastSynthDivider) {
        appendSynthesisDivider();
        lastSynthDivider = true;
        updateProgress(currentRound, maxRounds, 'C');
      }
      break;
    }

    case 'message': {
      if (event.message) {
        session.messages.push(event.message);
        const role = event.message.role;

        if (role === 'A' || role === 'B' || role === 'C') agentMsgCount++;

        if (isActive) {
          appendMessage(event.message);

          if (role === 'A') {
            updateProgress(currentRound, maxRounds, 'A');
            showAgentPanel('B', 'searching');
          } else if (role === 'B') {
            updateProgress(currentRound, maxRounds, 'B');
            if (currentRound < maxRounds) {
              // next round_start will come from backend
            } else {
              showAgentPanel('C', 'synthesizing');
            }
          } else if (role === 'C') {
            updateProgress(currentRound, maxRounds, 'C');
            hideAgentPanel();
          }
        }
      }
      break;
    }

    case 'stopped': {
      // Agent B requested early stop → next is synthesis
      showAgentPanel('C', 'synthesizing');
      break;
    }

    case 'done': {
      // Use final messages array as source of truth
      if (event.messages) {
        session.messages = event.messages;
      }
      hideAgentPanel();
      if (isActive) {
        updateProgress(currentRound, maxRounds, 'C');
      }
      break;
    }
  }
}

// ======================================================================
//  Streaming fetch  (bug-fixed)
// ======================================================================
async function startStream(payload, targetSessionId) {
  abortController = new AbortController();
  const res = await fetch('/api/run/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(payload),
    cache: 'no-store',
    signal: abortController.signal,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => 'Unknown error');
    throw new Error(`HTTP ${res.status}: ${errText}`);
  }
  if (!res.body) throw new Error('Response body is not readable');

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

      let sep = buffer.indexOf('\n\n');
      while (sep !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (raw.trim()) processSSEChunk(raw, targetSessionId);
        sep = buffer.indexOf('\n\n');
      }
    }
    const remaining = decoder.decode();
    if (remaining) buffer += remaining;
    if (buffer.trim()) processSSEChunk(buffer, targetSessionId);
  } finally {
    reader.releaseLock();
  }
}

// ======================================================================
//  Event listeners
// ======================================================================
stopBtn.addEventListener('click', () => {
  if (abortController) { abortController.abort(); abortController = null; }
});

startBtn.addEventListener('click', async () => {
  if (isRunning) return;
  if (!activeSessionId) { activeSessionId = createSession(); refreshSessionOptions(); }

  const topic = document.getElementById('topic').value.trim();
  const timeContext = document.getElementById('timeContext').value.trim();
  const prGoal = document.getElementById('prGoal').value.trim();
  if (!topic) return alert('Please enter an event topic');
  if (!timeContext) return alert('Please enter time context');
  if (!prGoal) return alert('Please enter a PR goal');

  const sid = activeSessionId;
  const session = sessions.get(sid);
  session.topic = topic;
  session.time_context = timeContext;
  session.pr_goal = prGoal;
  session.name = topic.slice(0, 24) || session.name;
  refreshSessionOptions();

  maxRounds = Number(document.getElementById('maxRounds').value) || 3;
  currentRound = 0;
  agentMsgCount = 0;
  lastSynthDivider = false;

  const payload = {
    session_id: sid, topic, time_context: timeContext, pr_goal: prGoal,
    max_rounds: maxRounds,
    agentA_config: cfg('a'), agentB_config: cfg('b'), agentC_config: cfg('c'),
    tavily_api_key: document.getElementById('tavilyKey').value,
    search_topk: Number(document.getElementById('searchTopk').value),
    search_domains: document.getElementById('searchDomains').value.split(',').map(s => s.trim()).filter(Boolean),
  };

  try {
    setRunning(true);
    session.messages = [];
    messagesArea.innerHTML = '';
    renderedCount = 0;
    updateMsgCount();
    showAgentPanel('A', 'searching');
    await startStream(payload, sid);
    setStatus('done', 'Analysis complete');
    progressFill.style.width = '100%';
    progressPct.textContent = '100%';
  } catch (err) {
    if (err.name === 'AbortError') {
      setStatus('idle', 'Stopped by user');
    } else {
      setStatus('error', 'Analysis failed');
      alert(`Request failed: ${err.message || err}`);
    }
  } finally {
    setRunning(false);
    progressWrap.classList.add('active');
  }
});

newSessionBtn.addEventListener('click', () => {
  if (isRunning) return;
  const id = createSession();
  refreshSessionOptions();
  switchSession(id);
});

clearSessionBtn.addEventListener('click', () => {
  if (isRunning || !activeSessionId) return;
  const session = sessions.get(activeSessionId);
  if (!session) return;
  session.topic = ''; session.time_context = ''; session.pr_goal = ''; session.messages = [];
  document.getElementById('topic').value = '';
  document.getElementById('timeContext').value = '';
  document.getElementById('prGoal').value = '';
  fullRender([]);
  progressWrap.classList.remove('active');
  setStatus('idle', 'Session cleared');
});

sessionSelect.addEventListener('change', e => {
  if (isRunning) return;
  switchSession(e.target.value);
});

// ======================================================================
//  Initialize
// ======================================================================
const initId = createSession();
refreshSessionOptions();
switchSession(initId);
