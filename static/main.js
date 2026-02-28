/* ============================================================
   PRcircle – Frontend (v3 – complete streaming rewrite)

   Architecture:
   ┌─────────────────────────────────────────────────────────┐
   │  SSE event stream                                       │
   │  session_started → round_start → phase(searching) →    │
   │  phase(generating) → token × N → message →             │
   │  synthesis_start → phase(synthesizing) → token × N →   │
   │  message(C) → done                                      │
   └─────────────────────────────────────────────────────────┘

   Key design choices:
   1. INCREMENTAL DOM – only append, never wipe-and-rebuild
   2. TOKEN STREAMING – build message text character-by-char
      in a "streaming card"; replace with full rendered card
      on `message` event
   3. ROBUST SSE PARSING – handles chunked delivery,
      multi-byte UTF-8, and malformed frames gracefully
   ============================================================ */

// ─── DOM refs ────────────────────────────────────────────────
const tabs             = document.querySelectorAll('.nav-tab');
const pages            = document.querySelectorAll('.page');
const startBtn         = document.getElementById('startBtn');
const stopBtn          = document.getElementById('stopBtn');
const newSessionBtn    = document.getElementById('newSessionBtn');
const clearSessionBtn  = document.getElementById('clearSessionBtn');
const sessionSelect    = document.getElementById('sessionSelect');
const runStatus        = document.getElementById('runStatus');
const statusDot        = document.getElementById('statusDot');
const progressWrap     = document.getElementById('progressWrap');
const progressFill     = document.getElementById('progressFill');
const progressLabel    = document.getElementById('progressLabel');
const progressPct      = document.getElementById('progressPct');
const agentPanel       = document.getElementById('agentPanel');
const agentPanelAvatar = document.getElementById('agentPanelAvatar');
const agentPanelName   = document.getElementById('agentPanelName');
const agentPanelPhase  = document.getElementById('agentPanelPhase');
const messagesArea     = document.getElementById('messages');
const msgCountEl       = document.getElementById('msgCount');

// ─── App state ───────────────────────────────────────────────
const sessions      = new Map();
let activeSessionId = null;
let isRunning       = false;
let abortCtrl       = null;
let maxRounds       = 3;
let currentRound    = 0;
let synthDivAdded   = false;

// ─── Streaming card state (one agent streams at a time) ──────
let streamNode      = null;   // DOM node of the in-progress card
let streamTextEl    = null;   // <div class="stream-text"> inside it
let streamAgent     = null;   // 'A' | 'B' | 'C'
let streamBuffer    = '';     // accumulated raw text

// ─── Constants ───────────────────────────────────────────────
const ROLE_LABEL = {
  A: 'Agent A · Analyst',
  B: 'Agent B · Challenger',
  C: 'Agent C · Observer',
  user: 'User',
};
const PHASE_LABEL = {
  searching:    'Searching & retrieving evidence…',
  generating:   'Generating response…',
  synthesizing: 'Synthesizing final report…',
};
const AGENT_COLOR = {
  A: 'var(--a)',
  B: 'var(--b)',
  C: 'var(--c)',
};

// ─────────────────────────────────────────────────────────────
//  Session management
// ─────────────────────────────────────────────────────────────
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
  _clearStreamState();
  const s = sessions.get(id);
  if (!s) return;
  document.getElementById('topic').value       = s.topic       || '';
  document.getElementById('timeContext').value = s.time_context || '';
  document.getElementById('prGoal').value      = s.pr_goal     || '';
  fullRender(s.messages);
  if (!isRunning) setStatus('idle', 'Ready');
}

// ─────────────────────────────────────────────────────────────
//  Tab navigation
// ─────────────────────────────────────────────────────────────
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    pages.forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.target).classList.add('active');
  });
});

// ─────────────────────────────────────────────────────────────
//  Config extraction
// ─────────────────────────────────────────────────────────────
function cfg(prefix) {
  return {
    model_name:        document.getElementById(`${prefix}_model`).value,
    base_url:          document.getElementById(`${prefix}_base`).value,
    api_key:           document.getElementById(`${prefix}_key`).value,
    temperature:       Number(document.getElementById(`${prefix}_temp`).value),
    max_tokens:        Number(document.getElementById(`${prefix}_max`).value),
    capability_prompt: document.getElementById(`${prefix}_capability`).value,
  };
}

// ─────────────────────────────────────────────────────────────
//  HTML / Markdown helpers
// ─────────────────────────────────────────────────────────────
function esc(t) {
  const d = document.createElement('div');
  d.textContent = t;
  return d.innerHTML;
}

function inlineMd(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function mdToHtml(raw) {
  const safe  = esc(String(raw || '')).replace(/\r\n/g, '\n');
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
    if (line.startsWith('#### '))  { closeList(); html += `<h5>${inlineMd(line.slice(5))}</h5>`; continue; }
    if (line.startsWith('### '))   { closeList(); html += `<h4>${inlineMd(line.slice(4))}</h4>`; continue; }
    if (line.startsWith('## '))    { closeList(); html += `<h3>${inlineMd(line.slice(3))}</h3>`; continue; }
    if (line.startsWith('# '))     { closeList(); html += `<h2>${inlineMd(line.slice(2))}</h2>`; continue; }
    if (line.startsWith('&gt; '))  { closeList(); html += `<blockquote>${inlineMd(line.slice(5))}</blockquote>`; continue; }
    if (/^\d+\.\s+/.test(line) || /^[-*]\s+/.test(line)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inlineMd(line.replace(/^(\d+\.\s+|[-*]\s+)/, ''))}</li>`;
      continue;
    }
    closeList();
    html += `<p>${inlineMd(line)}</p>`;
  }
  if (inCode && code) html += `<pre><code>${code}</code></pre>`;
  closeList();
  return html;
}

function fmtTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  catch { return ''; }
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// ─────────────────────────────────────────────────────────────
//  DOM builders
// ─────────────────────────────────────────────────────────────

/** Build a retrieval mini-card */
function buildRetrievalCard(r, idx, isCite) {
  const card = document.createElement('div');
  card.className = 'retrieval-card';
  const badge = document.createElement('div');
  badge.className = 'retrieval-idx';
  badge.textContent = isCite ? `R${idx}` : String(idx);
  if (isCite) badge.style.background = '#8b5cf6';

  const body = document.createElement('div');
  body.className = 'retrieval-body';

  const titleEl = document.createElement('div');
  titleEl.className = 'retrieval-title';
  titleEl.innerHTML = r.url
    ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title || 'Untitled')}</a>`
    : esc(r.title || 'Untitled');
  body.appendChild(titleEl);

  if (r.url) {
    const urlEl = document.createElement('div');
    urlEl.className = 'retrieval-url';
    urlEl.textContent = `${extractDomain(r.url)} — ${r.url}`;
    body.appendChild(urlEl);
  }
  if (r.content) {
    const snip = document.createElement('div');
    snip.className = 'retrieval-snippet';
    snip.textContent = r.content.slice(0, 220);
    body.appendChild(snip);
  }
  card.appendChild(badge);
  card.appendChild(body);
  if (r.score > 0) {
    const sc = document.createElement('div');
    sc.className = 'retrieval-score';
    sc.textContent = r.score.toFixed(2);
    card.appendChild(sc);
  }
  return card;
}

/** Build complete (fully rendered) message card */
function buildMessageNode(m) {
  const el = document.createElement('div');
  el.className = `msg ${m.role}`;
  el.dataset.role = m.role;

  // header
  const hdr = document.createElement('div');
  hdr.className = 'msg-header';
  const subtitleParts = [];
  if (m.search_directives?.length) subtitleParts.push(`${m.search_directives.length} searches`);
  if (m.retrievals?.length)        subtitleParts.push(`${m.retrievals.length} sources`);
  if (m.citation_sources?.length)  subtitleParts.push(`${m.citation_sources.length} citations`);
  hdr.innerHTML = `
    <div class="msg-avatar">${m.role === 'user' ? 'U' : m.role}</div>
    <div class="msg-info">
      <div class="msg-role">${ROLE_LABEL[m.role] || m.role}</div>
      ${subtitleParts.length ? `<div class="msg-subtitle">${subtitleParts.join(' · ')}</div>` : ''}
    </div>
    <span class="msg-time">${fmtTime(m.timestamp)}</span>`;
  el.appendChild(hdr);

  // markdown body
  const body = document.createElement('div');
  body.className = 'markdown-body';
  const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
  body.innerHTML = mdToHtml(content);
  el.appendChild(body);

  const hasDir  = m.search_directives?.length > 0;
  const hasQ    = m.search_queries?.length > 0;
  const hasCite = m.citation_sources?.length > 0;
  const hasRet  = m.retrievals?.length > 0;
  const hasJson = m.structured && Object.keys(m.structured).length > 0;

  if (hasDir || hasQ || hasCite || hasRet || hasJson) {
    const meta = document.createElement('div');
    meta.className = 'meta-sections';

    // search directives
    if (hasDir) {
      const sec = document.createElement('div');
      sec.innerHTML = `<div class="meta-header">
        <svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="11" y1="11" x2="15" y2="15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        Search Directives <span class="meta-count">${m.search_directives.length}</span></div>`;
      const pills = document.createElement('div');
      pills.className = 'search-directives';
      m.search_directives.forEach(d => {
        const pill = document.createElement('span');
        pill.className = 'search-pill';
        pill.title = d.query;
        pill.innerHTML = `<span class="search-pill-icon">
          <svg viewBox="0 0 16 16" style="width:9px;height:9px;fill:#fff"><circle cx="7" cy="7" r="5" fill="none" stroke="#fff" stroke-width="2"/><line x1="11" y1="11" x2="15" y2="15" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>
        </span><span class="search-pill-text">${esc(d.query)}</span>`;
        (d.domains || []).forEach(dm => {
          const t = document.createElement('span');
          t.className = 'search-pill-domain';
          t.textContent = dm;
          pill.appendChild(t);
        });
        pills.appendChild(pill);
      });
      sec.appendChild(pills);
      meta.appendChild(sec);
    } else if (hasQ) {
      const sec = document.createElement('div');
      sec.innerHTML = `<div class="meta-header">
        <svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="11" y1="11" x2="15" y2="15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        Search Queries <span class="meta-count">${m.search_queries.length}</span></div>`;
      const pills = document.createElement('div');
      pills.className = 'search-directives';
      m.search_queries.forEach(q => {
        const p = document.createElement('span');
        p.className = 'search-pill';
        p.textContent = q;
        pills.appendChild(p);
      });
      sec.appendChild(pills);
      meta.appendChild(sec);
    }

    // citations
    if (hasCite) {
      const sec = document.createElement('div');
      sec.innerHTML = `<div class="meta-header">
        <svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="5" y1="6" x2="11" y2="6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="5" y1="9" x2="9" y2="9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
        Citations <span class="meta-count">${m.citation_sources.length}</span></div>`;
      const grid = document.createElement('div');
      grid.className = 'retrieval-grid';
      m.citation_sources.forEach((r, i) => grid.appendChild(buildRetrievalCard(r, i + 1, true)));
      sec.appendChild(grid);
      meta.appendChild(sec);
    }

    // retrievals
    if (hasRet) {
      const sec = document.createElement('div');
      sec.innerHTML = `<div class="meta-header">
        <svg viewBox="0 0 16 16"><path d="M2 4l6-2 6 2v8l-6 2-6-2z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
        Retrieved Sources <span class="meta-count">${m.retrievals.length}</span></div>`;
      const grid = document.createElement('div');
      grid.className = 'retrieval-grid';
      m.retrievals.forEach((r, i) => grid.appendChild(buildRetrievalCard(r, i + 1, false)));
      sec.appendChild(grid);
      meta.appendChild(sec);
    }

    // structured JSON
    if (hasJson) {
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

/** Build the streaming placeholder card (header + raw text + cursor) */
function buildStreamCard(role) {
  const el = document.createElement('div');
  el.className = `msg ${role} msg-streaming`;
  el.dataset.role = role;

  const hdr = document.createElement('div');
  hdr.className = 'msg-header';
  hdr.innerHTML = `
    <div class="msg-avatar">${role}</div>
    <div class="msg-info">
      <div class="msg-role" style="color:${AGENT_COLOR[role]}">${ROLE_LABEL[role]}</div>
      <div class="msg-subtitle"><span class="stream-badge">Generating…</span></div>
    </div>`;
  el.appendChild(hdr);

  const textEl = document.createElement('div');
  textEl.className = 'stream-text';
  el.appendChild(textEl);

  const cursor = document.createElement('span');
  cursor.className = 'stream-cursor';
  el.appendChild(cursor);

  return el;
}

/** Round dividers */
function buildRoundDivider(round, maxR) {
  const d = document.createElement('div');
  d.className = 'round-divider';
  d.innerHTML = `<div class="round-divider-line"></div>
    <div class="round-badge"><span class="round-badge-dot"></span> ROUND ${round} / ${maxR}</div>
    <div class="round-divider-line"></div>`;
  return d;
}

function buildSynthesisDivider() {
  const d = document.createElement('div');
  d.className = 'round-divider';
  d.innerHTML = `<div class="round-divider-line"></div>
    <div class="round-badge synthesis"><span class="round-badge-dot"></span> FINAL SYNTHESIS</div>
    <div class="round-divider-line"></div>`;
  return d;
}

// ─────────────────────────────────────────────────────────────
//  Rendering helpers
// ─────────────────────────────────────────────────────────────
function showEmptyState() {
  if (!document.getElementById('emptyState')) {
    messagesArea.innerHTML = `<div class="msg-empty" id="emptyState">
      <div class="msg-empty-icon">&#9672;</div>
      <div class="msg-empty-text">No messages yet.<br/>Configure your topic and click <strong>Start Analysis</strong> to begin.</div>
    </div>`;
  }
}

function hideEmptyState() {
  const es = document.getElementById('emptyState');
  if (es) es.remove();
}

function appendNode(node) {
  hideEmptyState();
  messagesArea.appendChild(node);
  scrollToBottom();
}

/** Full re-render (session switch / clear only) */
function fullRender(messages) {
  _clearStreamState();
  messagesArea.innerHTML = '';
  if (!messages?.length) { showEmptyState(); updateMsgCount(0); return; }

  let round = 0, aSeen = 0, cSeen = false;
  messages.forEach(m => {
    if (m.role === 'A') {
      aSeen++;
      if (aSeen === 1 || (aSeen > 1 && !cSeen)) {
        round++;
        messagesArea.appendChild(buildRoundDivider(round, maxRounds));
      }
    }
    if (m.role === 'C' && !cSeen) {
      cSeen = true;
      messagesArea.appendChild(buildSynthesisDivider());
    }
    messagesArea.appendChild(buildMessageNode(m));
  });
  updateMsgCount(messages.length);
  scrollToBottom();
}

function scrollToBottom() {
  requestAnimationFrame(() => { messagesArea.scrollTop = messagesArea.scrollHeight; });
}

function updateMsgCount(n) {
  const count = (n !== undefined) ? n : (sessions.get(activeSessionId)?.messages?.length ?? 0);
  msgCountEl.textContent = count ? `${count} message${count !== 1 ? 's' : ''}` : '';
}

// ─────────────────────────────────────────────────────────────
//  Streaming card state helpers
// ─────────────────────────────────────────────────────────────
function _clearStreamState() {
  streamNode   = null;
  streamTextEl = null;
  streamAgent  = null;
  streamBuffer = '';
}

/** Start or continue streaming text for `role` */
function streamToken(role, token) {
  if (streamAgent !== role || !streamNode) {
    // Finalize previous streaming card if different agent
    _finalizeCurrentStreamCard();

    streamAgent  = role;
    streamBuffer = '';
    streamNode   = buildStreamCard(role);
    streamTextEl = streamNode.querySelector('.stream-text');
    hideEmptyState();
    messagesArea.appendChild(streamNode);
  }
  streamBuffer += token;
  streamTextEl.textContent = streamBuffer;
  scrollToBottom();
}

/**
 * Replace the streaming card with a fully-rendered message card.
 * Called when `message` event arrives for the current streaming agent.
 */
function finalizeStreamCard(m) {
  const finalCard = buildMessageNode(m);

  if (streamNode && streamNode.parentNode && streamAgent === m.role) {
    messagesArea.replaceChild(finalCard, streamNode);
  } else {
    // No streaming card – just append (fallback for non-streaming LLM)
    hideEmptyState();
    messagesArea.appendChild(finalCard);
  }
  _clearStreamState();
  scrollToBottom();
}

function _finalizeCurrentStreamCard() {
  if (streamNode && streamNode.parentNode) {
    // Streaming card without a message event – remove cursor to indicate done
    const cursor = streamNode.querySelector('.stream-cursor');
    if (cursor) cursor.remove();
  }
  _clearStreamState();
}

// ─────────────────────────────────────────────────────────────
//  Status / progress / agent panel
// ─────────────────────────────────────────────────────────────
function setStatus(state, text) {
  statusDot.className = 'status-dot';
  if (state === 'running') statusDot.classList.add('running');
  else if (state === 'done')  statusDot.classList.add('done');
  else if (state === 'error') statusDot.classList.add('error');
  runStatus.textContent = text;
}

function showAgentPanel(agent, phase) {
  const color = AGENT_COLOR[agent] || 'var(--pri)';
  agentPanelAvatar.textContent        = agent;
  agentPanelAvatar.style.background   = color;
  agentPanelName.textContent          = ROLE_LABEL[agent] || agent;
  agentPanelName.style.color          = color;
  agentPanelPhase.textContent         = PHASE_LABEL[phase] || phase;
  document.getElementById('agentSpinner').style.borderTopColor = color;
  agentPanel.classList.add('active');
}

function hideAgentPanel() {
  agentPanel.classList.remove('active');
}

function updateProgress(step, total, label) {
  const pct = total > 0 ? Math.min(Math.round((step / total) * 100), 100) : 0;
  progressFill.style.width  = pct + '%';
  progressPct.textContent   = pct + '%';
  progressLabel.textContent = label;
}

// ─────────────────────────────────────────────────────────────
//  SSE event dispatcher
// ─────────────────────────────────────────────────────────────
function dispatchSSEEvent(event, targetSessionId) {
  const sid     = event.session_id || targetSessionId;
  const session = sessions.get(sid);
  if (!session) return;
  const isActive = (sid === activeSessionId);

  switch (event.type) {

    case 'session_started': {
      if (event.message) {
        session.messages = [event.message];
        maxRounds    = event.max_rounds || maxRounds;
        currentRound = 0;
        synthDivAdded = false;
        if (isActive) {
          messagesArea.innerHTML = '';
          _clearStreamState();
          hideAgentPanel();
          appendNode(buildMessageNode(event.message));
          updateMsgCount(1);
        }
      }
      break;
    }

    case 'round_start': {
      currentRound = event.round || (currentRound + 1);
      maxRounds    = event.max_rounds || maxRounds;
      const total  = maxRounds * 2 + 1;
      const step   = (currentRound - 1) * 2;
      if (isActive) {
        appendNode(buildRoundDivider(currentRound, maxRounds));
        updateProgress(step, total, `Round ${currentRound} / ${maxRounds}`);
      }
      showAgentPanel('A', 'searching');
      break;
    }

    case 'synthesis_start': {
      if (isActive && !synthDivAdded) {
        synthDivAdded = true;
        appendNode(buildSynthesisDivider());
        const total = maxRounds * 2 + 1;
        updateProgress(total - 1, total, 'Final Synthesis');
      }
      showAgentPanel('C', 'synthesizing');
      break;
    }

    case 'phase': {
      const { agent, phase } = event;
      showAgentPanel(agent, phase);

      if (isActive) {
        const total = maxRounds * 2 + 1;
        if (agent === 'A' && phase === 'generating') {
          updateProgress((currentRound - 1) * 2 + 1, total, `Round ${currentRound} / ${maxRounds} · Agent A`);
        } else if (agent === 'B' && phase === 'generating') {
          updateProgress((currentRound - 1) * 2 + 2, total, `Round ${currentRound} / ${maxRounds} · Agent B`);
        }
      }
      break;
    }

    case 'token': {
      if (isActive) {
        streamToken(event.agent, event.content);
      } else {
        // For non-active sessions just buffer (no DOM work)
        if (streamAgent !== event.agent) {
          streamAgent  = event.agent;
          streamBuffer = '';
        }
        streamBuffer += event.content;
      }
      break;
    }

    case 'message': {
      if (event.message) {
        session.messages.push(event.message);
        const role = event.message.role;
        if (isActive) {
          finalizeStreamCard(event.message);
          updateMsgCount();

          const total = maxRounds * 2 + 1;
          if (role === 'A') {
            updateProgress((currentRound - 1) * 2 + 1, total, `Round ${currentRound} / ${maxRounds} · Agent A done`);
            showAgentPanel('B', 'searching');
          } else if (role === 'B') {
            updateProgress((currentRound - 1) * 2 + 2, total, `Round ${currentRound} / ${maxRounds} · Agent B done`);
          } else if (role === 'C') {
            updateProgress(total, total, 'Synthesis complete');
            hideAgentPanel();
          }
        }
        // For non-active sessions, clear pending stream buffer
        if (!isActive) {
          streamBuffer = '';
          streamAgent  = null;
        }
      }
      break;
    }

    case 'stopped': {
      if (isActive) _finalizeCurrentStreamCard();
      showAgentPanel('C', 'synthesizing');
      break;
    }

    case 'done': {
      // Authoritative final state from server
      if (event.messages) session.messages = event.messages;
      if (isActive) {
        _finalizeCurrentStreamCard();
        hideAgentPanel();
        const total = maxRounds * 2 + 1;
        updateProgress(total, total, 'Complete');
        updateMsgCount();
      }
      break;
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  SSE chunk parser  (handles chunked delivery robustly)
// ─────────────────────────────────────────────────────────────
function parseSSEChunk(rawChunk, targetSessionId) {
  // Normalise line endings
  const norm = rawChunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Skip SSE comment lines (our keepalive padding starts with ':')
  const dataLines = norm.split('\n')
    .filter(l => l.startsWith('data:'))
    .map(l => l.slice(5).trimStart());

  if (!dataLines.length) return;

  // Try the joined string first (single JSON payload, most common case)
  let event = null;
  try { event = JSON.parse(dataLines.join('')); } catch { /* try individual */ }

  if (!event) {
    for (const line of dataLines) {
      try { event = JSON.parse(line); break; } catch { /* next */ }
    }
  }
  if (!event) return;

  dispatchSSEEvent(event, targetSessionId);
}

// ─────────────────────────────────────────────────────────────
//  Streaming fetch
// ─────────────────────────────────────────────────────────────
async function startStream(payload, targetSessionId) {
  abortCtrl = new AbortController();

  const res = await fetch('/api/run/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(payload),
    cache: 'no-store',
    signal: abortCtrl.signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => 'Unknown error');
    throw new Error(`HTTP ${res.status}: ${errText}`);
  }
  if (!res.body) throw new Error('Response body is not readable');

  const reader  = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer    = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      // stream:true handles multi-byte chars split across network chunks
      buffer += decoder.decode(value, { stream: true });
      buffer  = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

      // Process complete SSE events (terminated by \n\n)
      let sep = buffer.indexOf('\n\n');
      while (sep !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (raw.trim()) parseSSEChunk(raw, targetSessionId);
        sep = buffer.indexOf('\n\n');
      }
    }

    // Flush decoder
    const tail = decoder.decode();
    if (tail) buffer += tail;
    if (buffer.trim()) parseSSEChunk(buffer, targetSessionId);

  } finally {
    reader.releaseLock();
  }
}

// ─────────────────────────────────────────────────────────────
//  UI lock
// ─────────────────────────────────────────────────────────────
function setRunning(running) {
  isRunning = running;
  startBtn.disabled = running;
  clearSessionBtn.disabled = running;
  ['topic', 'timeContext', 'prGoal', 'maxRounds'].forEach(id => {
    document.getElementById(id).disabled = running;
  });
  sessionSelect.disabled = running;
  newSessionBtn.disabled = running;

  if (running) {
    stopBtn.style.display = 'inline-flex';
    progressWrap.classList.add('active');
    progressFill.style.width = '0%';
    progressPct.textContent  = '0%';
    setStatus('running', 'Running analysis…');
  } else {
    stopBtn.style.display = 'none';
    hideAgentPanel();
    _clearStreamState();
  }
}

// ─────────────────────────────────────────────────────────────
//  Event listeners
// ─────────────────────────────────────────────────────────────
stopBtn.addEventListener('click', () => {
  if (abortCtrl) { abortCtrl.abort(); abortCtrl = null; }
});

startBtn.addEventListener('click', async () => {
  if (isRunning) return;
  if (!activeSessionId) { activeSessionId = createSession(); refreshSessionOptions(); }

  const topic       = document.getElementById('topic').value.trim();
  const timeContext = document.getElementById('timeContext').value.trim();
  const prGoal      = document.getElementById('prGoal').value.trim();
  if (!topic)       return alert('Please enter an event topic');
  if (!timeContext) return alert('Please enter time context');
  if (!prGoal)      return alert('Please enter a PR goal');

  const sid     = activeSessionId;
  const session = sessions.get(sid);
  session.topic       = topic;
  session.time_context = timeContext;
  session.pr_goal     = prGoal;
  session.name        = topic.slice(0, 24) || session.name;
  refreshSessionOptions();

  maxRounds    = Number(document.getElementById('maxRounds').value) || 3;
  currentRound = 0;
  synthDivAdded = false;

  const payload = {
    session_id:   sid,
    topic,
    time_context: timeContext,
    pr_goal:      prGoal,
    max_rounds:   maxRounds,
    agentA_config: cfg('a'),
    agentB_config: cfg('b'),
    agentC_config: cfg('c'),
    tavily_api_key: document.getElementById('tavilyKey').value,
    search_topk:   Number(document.getElementById('searchTopk').value),
    search_domains: document.getElementById('searchDomains').value
      .split(',').map(s => s.trim()).filter(Boolean),
  };

  try {
    setRunning(true);
    session.messages = [];
    messagesArea.innerHTML = '';
    showEmptyState();
    updateMsgCount(0);
    await startStream(payload, sid);
    setStatus('done', 'Analysis complete');
    updateProgress(maxRounds * 2 + 1, maxRounds * 2 + 1, 'Complete');
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
  document.getElementById('topic').value       = '';
  document.getElementById('timeContext').value = '';
  document.getElementById('prGoal').value      = '';
  fullRender([]);
  progressWrap.classList.remove('active');
  setStatus('idle', 'Session cleared');
});

sessionSelect.addEventListener('change', e => {
  if (isRunning) return;
  switchSession(e.target.value);
});

// ─────────────────────────────────────────────────────────────
//  Init
// ─────────────────────────────────────────────────────────────
const initId = createSession();
refreshSessionOptions();
switchSession(initId);
