/* ============================================================
   PRcircle – Frontend Application
   - Session management
   - Streaming SSE with robust buffering & error recovery
   - Modern message rendering with markdown support
   - Progress tracking & typing indicators
   ============================================================ */

// ===== DOM References =====
const tabs = document.querySelectorAll('.nav-tab');
const pages = document.querySelectorAll('.page');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const newSessionBtn = document.getElementById('newSessionBtn');
const clearSessionBtn = document.getElementById('clearSessionBtn');
const sessionSelect = document.getElementById('sessionSelect');
const runStatus = document.getElementById('runStatus');
const statusDot = document.getElementById('statusDot');
const progressWrap = document.getElementById('progressWrap');
const progressFill = document.getElementById('progressFill');
const progressLabel = document.getElementById('progressLabel');
const progressPct = document.getElementById('progressPct');
const typingIndicator = document.getElementById('typingIndicator');
const typingLabel = document.getElementById('typingLabel');
const messagesArea = document.getElementById('messages');

// ===== State =====
const sessions = new Map();
let activeSessionId = null;
let isRunning = false;
let abortController = null;
let currentMaxRounds = 3;
let currentRound = 0;
let messageCount = 0;

// ===== Role Labels =====
const ROLE_LABELS = {
  A: 'Agent A - Analyst',
  B: 'Agent B - Challenger',
  C: 'Agent C - Observer',
  user: 'User',
};

// ===== Session Management =====
function createSession(name = null) {
  const id = crypto.randomUUID();
  sessions.set(id, {
    id,
    name: name || `Session ${sessions.size + 1}`,
    topic: '',
    time_context: '',
    pr_goal: '',
    messages: [],
  });
  return id;
}

function refreshSessionOptions() {
  sessionSelect.innerHTML = '';
  sessions.forEach((session) => {
    const opt = document.createElement('option');
    opt.value = session.id;
    opt.textContent = `${session.name} (${session.id.slice(0, 8)})`;
    sessionSelect.appendChild(opt);
  });
  if (activeSessionId) sessionSelect.value = activeSessionId;
}

function switchSession(id) {
  activeSessionId = id;
  const session = sessions.get(id);
  if (!session) return;
  document.getElementById('topic').value = session.topic || '';
  document.getElementById('timeContext').value = session.time_context || '';
  document.getElementById('prGoal').value = session.pr_goal || '';
  renderMessages(session.messages || []);
  if (!isRunning) setStatus('idle', 'Ready');
}

// ===== Tab Navigation =====
tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.remove('active'));
    pages.forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.target).classList.add('active');
  });
});

// ===== Config Extraction =====
function cfg(prefix) {
  return {
    model_name: document.getElementById(`${prefix}_model`).value,
    base_url: document.getElementById(`${prefix}_base`).value,
    api_key: document.getElementById(`${prefix}_key`).value,
    temperature: Number(document.getElementById(`${prefix}_temp`).value),
    max_tokens: Number(document.getElementById(`${prefix}_max`).value),
    capability_prompt: document.getElementById(`${prefix}_capability`).value,
  };
}

// ===== HTML Escaping =====
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ===== Inline Markdown =====
function inlineMarkdown(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>'
    );
}

// ===== Markdown to HTML =====
function markdownToHtml(rawText) {
  const safe = escapeHtml(String(rawText || '')).replace(/\r\n/g, '\n');
  const lines = safe.split('\n');
  let html = '';
  let inList = false;
  let inCodeBlock = false;
  let codeContent = '';

  const closeList = () => {
    if (inList) {
      html += '</ul>';
      inList = false;
    }
  };

  lines.forEach((line) => {
    // Handle code blocks (``` fenced)
    if (line.trimStart().startsWith('```')) {
      if (inCodeBlock) {
        html += `<pre><code>${codeContent}</code></pre>`;
        codeContent = '';
        inCodeBlock = false;
      } else {
        closeList();
        inCodeBlock = true;
      }
      return;
    }
    if (inCodeBlock) {
      codeContent += (codeContent ? '\n' : '') + line;
      return;
    }

    // Empty lines
    if (!line.trim()) {
      closeList();
      return;
    }

    // Headers (#### → h5, ### → h4, ## → h3, # → h2)
    if (line.startsWith('#### ')) {
      closeList();
      html += `<h5>${inlineMarkdown(line.slice(5))}</h5>`;
      return;
    }
    if (line.startsWith('### ')) {
      closeList();
      html += `<h4>${inlineMarkdown(line.slice(4))}</h4>`;
      return;
    }
    if (line.startsWith('## ')) {
      closeList();
      html += `<h3>${inlineMarkdown(line.slice(3))}</h3>`;
      return;
    }
    if (line.startsWith('# ')) {
      closeList();
      html += `<h2>${inlineMarkdown(line.slice(2))}</h2>`;
      return;
    }

    // Blockquote
    if (line.startsWith('&gt; ')) {
      closeList();
      html += `<blockquote>${inlineMarkdown(line.slice(5))}</blockquote>`;
      return;
    }

    // Numbered list
    if (/^\d+\.\s+/.test(line)) {
      if (!inList) {
        html += '<ul>';
        inList = true;
      }
      html += `<li>${inlineMarkdown(line.replace(/^\d+\.\s+/, ''))}</li>`;
      return;
    }

    // Bullet list
    if (/^[-*]\s+/.test(line)) {
      if (!inList) {
        html += '<ul>';
        inList = true;
      }
      html += `<li>${inlineMarkdown(line.replace(/^[-*]\s+/, ''))}</li>`;
      return;
    }

    closeList();
    html += `<p>${inlineMarkdown(line)}</p>`;
  });

  // Close any open blocks
  if (inCodeBlock && codeContent) {
    html += `<pre><code>${codeContent}</code></pre>`;
  }
  closeList();
  return html;
}

// ===== Format Timestamp =====
function formatTime(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

// ===== Render Messages =====
function renderMessages(messages) {
  if (!messages || messages.length === 0) {
    messagesArea.innerHTML = `
      <div class="msg-empty">
        <div class="msg-empty-icon">&#9672;</div>
        <div class="msg-empty-text">No messages yet. Configure your topic and click "Start Analysis" to begin.</div>
      </div>`;
    return;
  }

  messagesArea.innerHTML = '';
  messages.forEach((m) => {
    const card = document.createElement('div');
    card.className = `msg ${m.role}`;

    // Header
    const header = document.createElement('div');
    header.className = 'msg-header';

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.textContent = m.role === 'user' ? 'U' : m.role;

    const roleSpan = document.createElement('span');
    roleSpan.className = 'msg-role';
    roleSpan.textContent = ROLE_LABELS[m.role] || m.role;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'msg-time';
    timeSpan.textContent = formatTime(m.timestamp);

    header.appendChild(avatar);
    header.appendChild(roleSpan);
    header.appendChild(timeSpan);
    card.appendChild(header);

    // Content
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'markdown-body';
    bodyDiv.innerHTML = markdownToHtml(content);
    card.appendChild(bodyDiv);

    // Structured JSON
    if (m.structured && Object.keys(m.structured).length > 0) {
      const d = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = 'View Structured JSON';
      d.appendChild(summary);
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify(m.structured, null, 2);
      d.appendChild(pre);
      card.appendChild(d);
    }

    // Search Directives
    if (m.search_directives?.length) {
      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      meta.innerHTML =
        '<div class="msg-meta-title">Search Directives</div>' +
        '<div class="msg-meta-list">' +
        m.search_directives
          .map(
            (d) =>
              `&#8226; ${escapeHtml(d.query)}${d.domains?.length ? ' <span class="msg-meta-tag">' + d.domains.map(escapeHtml).join(', ') + '</span>' : ''}`
          )
          .join('<br/>') +
        '</div>';
      card.appendChild(meta);
    } else if (m.search_queries?.length) {
      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      meta.innerHTML =
        '<div class="msg-meta-title">Search Queries</div>' +
        '<div class="msg-meta-list">' +
        m.search_queries.map((x) => `&#8226; ${escapeHtml(x)}`).join('<br/>') +
        '</div>';
      card.appendChild(meta);
    }

    // Citation Sources
    if (m.citation_sources?.length) {
      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      meta.innerHTML =
        '<div class="msg-meta-title">Citations</div>' +
        '<div class="msg-meta-list">' +
        m.citation_sources
          .map(
            (r, idx) =>
              `[R${idx + 1}] <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.title || r.url)}</a>`
          )
          .join('<br/>') +
        '</div>';
      card.appendChild(meta);
    }

    // Retrievals
    if (m.retrievals?.length) {
      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      meta.innerHTML =
        '<div class="msg-meta-title">Retrieved Sources</div>' +
        '<div class="msg-meta-list">' +
        m.retrievals
          .map(
            (r) =>
              `&#8226; <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.title || r.url)}</a>`
          )
          .join('<br/>') +
        '</div>';
      card.appendChild(meta);
    }

    messagesArea.appendChild(card);
  });

  // Auto-scroll to bottom
  scrollToBottom();
}

// ===== Auto-scroll =====
function scrollToBottom() {
  requestAnimationFrame(() => {
    messagesArea.scrollTop = messagesArea.scrollHeight;
  });
}

// ===== Status Management =====
function setStatus(state, text) {
  statusDot.className = 'status-dot';
  if (state === 'running') statusDot.classList.add('running');
  else if (state === 'done') statusDot.classList.add('done');
  else if (state === 'error') statusDot.classList.add('error');
  runStatus.textContent = text;
}

// ===== Typing Indicator =====
function showTyping(role) {
  const label = ROLE_LABELS[role] || role;
  typingLabel.textContent = `${label} is thinking...`;
  typingIndicator.classList.add('active');
  scrollToBottom();
}

function hideTyping() {
  typingIndicator.classList.remove('active');
}

// ===== Progress =====
function updateProgress(round, maxRounds, phase) {
  // Each round has 2 phases: Agent A, Agent B.  +1 final for Agent C
  const totalSteps = maxRounds * 2 + 1;
  let currentStep = (round - 1) * 2 + (phase === 'B' ? 2 : phase === 'A' ? 1 : 0);
  if (phase === 'C') currentStep = totalSteps;

  const pct = Math.min(Math.round((currentStep / totalSteps) * 100), 100);
  progressFill.style.width = pct + '%';
  progressPct.textContent = pct + '%';

  if (phase === 'C') {
    progressLabel.textContent = 'Final Synthesis';
  } else {
    progressLabel.textContent = `Round ${round} / ${maxRounds}`;
  }
}

// ===== UI Lock =====
function setRunning(running) {
  isRunning = running;
  startBtn.disabled = running;
  clearSessionBtn.disabled = running;
  document.getElementById('topic').disabled = running;
  document.getElementById('timeContext').disabled = running;
  document.getElementById('prGoal').disabled = running;
  document.getElementById('maxRounds').disabled = running;
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
    hideTyping();
  }
}

// ===== SSE Processing (Bug-fixed) =====
function processSSEChunk(rawChunk, targetSessionId) {
  // Normalize line endings
  const normalized = rawChunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Extract all data: lines
  const dataLines = normalized
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trimStart());

  if (!dataLines.length) return;

  // BUG FIX: Try parsing each data line individually first,
  // falling back to joining them (for multi-line JSON payloads).
  let event = null;
  const joined = dataLines.join('\n');
  try {
    event = JSON.parse(joined);
  } catch {
    // If joined parse fails, try each line individually
    for (const line of dataLines) {
      try {
        event = JSON.parse(line);
        break;
      } catch {
        // continue to next line
      }
    }
  }

  if (!event) return;

  const sid = event.session_id || targetSessionId;
  const session = sessions.get(sid);
  if (!session) return;

  switch (event.type) {
    case 'session_started':
      if (event.message) {
        session.messages = [event.message];
        messageCount = 0;
        currentRound = 0;
      }
      break;

    case 'message':
      if (event.message) {
        session.messages.push(event.message);
        hideTyping();
        messageCount++;

        // Track progress: messages come in A, B pairs per round, then C
        const role = event.message.role;
        if (role === 'A') {
          currentRound = Math.ceil(messageCount / 2);
          updateProgress(currentRound, currentMaxRounds, 'A');
          // Show typing for next agent (B)
          showTyping('B');
        } else if (role === 'B') {
          updateProgress(currentRound, currentMaxRounds, 'B');
          // Check if more rounds, show typing for A
          if (currentRound < currentMaxRounds) {
            showTyping('A');
          } else {
            showTyping('C');
          }
        } else if (role === 'C') {
          updateProgress(currentRound, currentMaxRounds, 'C');
          hideTyping();
        }
      }
      break;

    case 'stopped':
      hideTyping();
      showTyping('C');
      break;

    case 'done':
      if (event.messages) {
        session.messages = event.messages;
      }
      hideTyping();
      updateProgress(currentMaxRounds, currentMaxRounds, 'C');
      break;

    default:
      break;
  }

  // Render if this is the active session
  if (sid === activeSessionId) {
    renderMessages(session.messages);
  }
}

// ===== Streaming Fetch (Bug-fixed) =====
async function startStream(payload, targetSessionId) {
  abortController = new AbortController();

  const res = await fetch('/api/run/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(payload),
    cache: 'no-store',
    signal: abortController.signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => 'Unknown error');
    throw new Error(`HTTP ${res.status}: ${errText}`);
  }

  if (!res.body) {
    throw new Error('Response body is not readable');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      // BUG FIX: Use stream: true to handle multi-byte UTF-8 chars split across chunks
      buffer += decoder.decode(value, { stream: true });

      // Normalize all line endings to \n
      buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

      // SSE events are separated by double newlines
      let sep = buffer.indexOf('\n\n');
      while (sep !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        if (raw.trim()) {
          processSSEChunk(raw, targetSessionId);
        }

        sep = buffer.indexOf('\n\n');
      }
    }

    // BUG FIX: Flush remaining decoder bytes
    const remaining = decoder.decode();
    if (remaining) {
      buffer += remaining;
    }

    // Process any remaining buffered data
    if (buffer.trim()) {
      processSSEChunk(buffer, targetSessionId);
    }
  } finally {
    reader.releaseLock();
  }
}

// ===== Stop Button =====
stopBtn.addEventListener('click', () => {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
});

// ===== Start Button =====
startBtn.addEventListener('click', async () => {
  if (isRunning) return;
  if (!activeSessionId) {
    activeSessionId = createSession();
    refreshSessionOptions();
  }

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

  currentMaxRounds = Number(document.getElementById('maxRounds').value) || 3;
  currentRound = 0;
  messageCount = 0;

  const payload = {
    session_id: sid,
    topic,
    time_context: timeContext,
    pr_goal: prGoal,
    max_rounds: currentMaxRounds,
    agentA_config: cfg('a'),
    agentB_config: cfg('b'),
    agentC_config: cfg('c'),
    tavily_api_key: document.getElementById('tavilyKey').value,
    search_topk: Number(document.getElementById('searchTopk').value),
    search_domains: document
      .getElementById('searchDomains')
      .value.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };

  try {
    setRunning(true);
    session.messages = [];
    renderMessages([]);
    showTyping('A');
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
    // Keep progress visible after completion
    progressWrap.classList.add('active');
  }
});

// ===== New Session =====
newSessionBtn.addEventListener('click', () => {
  if (isRunning) return;
  const id = createSession();
  refreshSessionOptions();
  switchSession(id);
});

// ===== Clear Session =====
clearSessionBtn.addEventListener('click', () => {
  if (isRunning || !activeSessionId) return;
  const session = sessions.get(activeSessionId);
  if (!session) return;
  session.topic = '';
  session.time_context = '';
  session.pr_goal = '';
  session.messages = [];
  document.getElementById('topic').value = '';
  document.getElementById('timeContext').value = '';
  document.getElementById('prGoal').value = '';
  renderMessages([]);
  progressWrap.classList.remove('active');
  setStatus('idle', 'Session cleared');
});

// ===== Session Select =====
sessionSelect.addEventListener('change', (e) => {
  if (isRunning) return;
  switchSession(e.target.value);
});

// ===== Initialize =====
const initId = createSession();
refreshSessionOptions();
switchSession(initId);
