const tabs = document.querySelectorAll('.tab');
const pages = document.querySelectorAll('.page');
const startBtn = document.getElementById('startBtn');
const newSessionBtn = document.getElementById('newSessionBtn');
const clearSessionBtn = document.getElementById('clearSessionBtn');
const sessionSelect = document.getElementById('sessionSelect');
const runStatus = document.getElementById('runStatus');

const sessions = new Map();
let activeSessionId = null;
let isRunning = false;

function createSession(name = null) {
  const id = crypto.randomUUID();
  sessions.set(id, { id, name: name || `会话 ${sessions.size + 1}`, topic: '', time_context: '', pr_goal: '', messages: [] });
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
  document.getElementById('topic').value = session.topic || '';
  document.getElementById('timeContext').value = session.time_context || '';
  document.getElementById('prGoal').value = session.pr_goal || '';
  renderMessages(session.messages || []);
  runStatus.textContent = isRunning ? '运行中...' : '已切换会话';
}

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.remove('active'));
    pages.forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.target).classList.add('active');
  });
});

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

function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function inlineMarkdown(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
}

function markdownToHtml(rawText) {
  const safe = escapeHtml(String(rawText || '')).replaceAll('\r\n', '\n');
  const lines = safe.split('\n');
  let html = '';
  let inList = false;

  const closeList = () => {
    if (inList) {
      html += '</ul>';
      inList = false;
    }
  };

  lines.forEach((line) => {
    if (!line.trim()) {
      closeList();
      html += '<br/>';
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

  closeList();
  return html;
}

function renderMessages(messages) {
  const el = document.getElementById('messages');
  el.innerHTML = '';
  messages.forEach((m) => {
    const card = document.createElement('div');
    card.className = `msg ${m.role}`;
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    card.innerHTML = `<strong>${m.role}</strong><div class="markdown-body">${markdownToHtml(content)}</div>`;

    if (m.structured && Object.keys(m.structured).length > 0) {
      const d = document.createElement('details');
      d.innerHTML = `<summary>structured JSON（可解析时显示）</summary><pre>${JSON.stringify(m.structured, null, 2)}</pre>`;
      card.appendChild(d);
    }

    if (m.search_directives?.length) {
      const q = document.createElement('div');
      q.className = 'retrieval';
      q.innerHTML = '<strong>检索词与站点范围</strong><br/>' + m.search_directives
        .map(d => `• ${d.query}${d.domains?.length ? ` <span class="muted">[sites: ${d.domains.join(', ')}]</span>` : ''}`)
        .join('<br/>');
      card.appendChild(q);
    } else if (m.search_queries?.length) {
      const q = document.createElement('div');
      q.className = 'retrieval';
      q.innerHTML = '<strong>检索词</strong><br/>' + m.search_queries.map(x => `• ${x}`).join('<br/>');
      card.appendChild(q);
    }
    if (m.citation_sources?.length) {
      const cite = document.createElement('div');
      cite.className = 'retrieval';
      cite.innerHTML = '<strong>引用目录</strong><br/>' + m.citation_sources.map((r, idx) => `[R${idx + 1}] <a href="${r.url}" target="_blank">${r.title || r.url}</a>`).join('<br/>');
      card.appendChild(cite);
    }
    if (m.retrievals?.length) {
      const list = document.createElement('div');
      list.className = 'retrieval';
      list.innerHTML = '<strong>检索来源</strong><br/>' + m.retrievals.map(r => `• <a href="${r.url}" target="_blank">${r.title || r.url}</a>`).join('<br/>');
      card.appendChild(list);
    }
    el.appendChild(card);
  });
}

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
  runStatus.textContent = running ? '运行中...（禁止重复提交）' : '运行结束';
}

function processSSEChunk(rawChunk, targetSessionId) {
  const normalized = rawChunk.replaceAll('\r', '');
  const dataLines = normalized
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trimStart());

  if (!dataLines.length) return;

  let event;
  try {
    event = JSON.parse(dataLines.join('\n'));
  } catch {
    return;
  }

  const sid = event.session_id || targetSessionId;
  const session = sessions.get(sid);
  if (!session) return;

  if (event.type === 'session_started' && event.message) {
    session.messages = [event.message];
  } else if (event.type === 'message' && event.message) {
    session.messages.push(event.message);
  } else if (event.type === 'done' && event.messages) {
    session.messages = event.messages;
  }

  if (sid === activeSessionId) {
    renderMessages(session.messages);
  }
}

async function startStream(payload, targetSessionId) {
  const res = await fetch('/api/run/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(payload),
    cache: 'no-store',
  });
  if (!res.ok || !res.body) throw new Error(await res.text());

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replaceAll('\r\n', '\n');

    let sep = buffer.indexOf('\n\n');
    while (sep !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      processSSEChunk(raw, targetSessionId);
      sep = buffer.indexOf('\n\n');
    }
  }

  if (buffer.trim()) {
    processSSEChunk(buffer, targetSessionId);
  }
}

startBtn.addEventListener('click', async () => {
  if (isRunning) return;
  if (!activeSessionId) activeSessionId = createSession();

  const topic = document.getElementById('topic').value.trim();
  const timeContext = document.getElementById('timeContext').value.trim();
  const prGoal = document.getElementById('prGoal').value.trim();
  if (!topic) return alert('请输入热点事件主题');
  if (!timeContext) return alert('请输入时间背景');
  if (!prGoal) return alert('请输入PR目标');

  const sid = activeSessionId;
  const session = sessions.get(sid);
  session.topic = topic;
  session.time_context = timeContext;
  session.pr_goal = prGoal;
  session.name = topic.slice(0, 20) || session.name;
  refreshSessionOptions();

  const payload = {
    session_id: sid,
    topic,
    time_context: timeContext,
    pr_goal: prGoal,
    max_rounds: Number(document.getElementById('maxRounds').value),
    agentA_config: cfg('a'),
    agentB_config: cfg('b'),
    agentC_config: cfg('c'),
    tavily_api_key: document.getElementById('tavilyKey').value,
    search_topk: Number(document.getElementById('searchTopk').value),
    search_domains: document.getElementById('searchDomains').value.split(',').map(s => s.trim()).filter(Boolean),
  };

  try {
    setRunning(true);
    session.messages = [];
    renderMessages([]);
    await startStream(payload, sid);
  } catch (err) {
    runStatus.textContent = '运行失败';
    alert(`请求失败: ${err}`);
  } finally {
    setRunning(false);
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
  session.topic = '';
  session.time_context = '';
  session.pr_goal = '';
  session.messages = [];
  document.getElementById('topic').value = '';
  document.getElementById('timeContext').value = '';
  document.getElementById('prGoal').value = '';
  renderMessages([]);
  runStatus.textContent = '已清理当前会话并重置状态';
});

sessionSelect.addEventListener('change', (e) => {
  if (isRunning) return;
  switchSession(e.target.value);
});

const initId = createSession();
refreshSessionOptions();
switchSession(initId);
