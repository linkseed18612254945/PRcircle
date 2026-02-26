const tabs = document.querySelectorAll('.tab');
const pages = document.querySelectorAll('.page');
const startBtn = document.getElementById('startBtn');
const newSessionBtn = document.getElementById('newSessionBtn');
const sessionSelect = document.getElementById('sessionSelect');
const runStatus = document.getElementById('runStatus');

const sessions = new Map();
let activeSessionId = null;
let isRunning = false;

function createSession(name = null) {
  const id = crypto.randomUUID();
  sessions.set(id, { id, name: name || `会话 ${sessions.size + 1}`, topic: '', messages: [] });
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

function renderMessages(messages) {
  const el = document.getElementById('messages');
  el.innerHTML = '';
  messages.forEach((m) => {
    const card = document.createElement('div');
    card.className = `msg ${m.role}`;
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    card.innerHTML = `<strong>${m.role}</strong><div>${content.replaceAll('\n', '<br/>')}</div>`;

    if (m.structured && Object.keys(m.structured).length > 0) {
      const d = document.createElement('details');
      d.innerHTML = `<summary>structured JSON（可解析时显示）</summary><pre>${JSON.stringify(m.structured, null, 2)}</pre>`;
      card.appendChild(d);
    }


    if (m.search_queries?.length) {
      const q = document.createElement('div');
      q.className = 'retrieval';
      q.innerHTML = '<strong>检索词</strong><br/>' + m.search_queries.map(x => `• ${x}`).join('<br/>');
      card.appendChild(q);
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
  document.getElementById('topic').disabled = running;
  document.getElementById('maxRounds').disabled = running;
  sessionSelect.disabled = running;
  newSessionBtn.disabled = running;
  runStatus.textContent = running ? '运行中...（禁止重复提交）' : '运行结束';
}

async function startStream(payload, targetSessionId) {
  const res = await fetch('/api/run/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok || !res.body) throw new Error(await res.text());

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep = buffer.indexOf('\n\n');
    while (sep !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      sep = buffer.indexOf('\n\n');

      const dataLines = raw.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
      if (!dataLines.length) continue;

      const event = JSON.parse(dataLines.join('\n'));
      const sid = event.session_id || targetSessionId;
      const session = sessions.get(sid);
      if (!session) continue;

      if (event.type === 'session_started' && event.message) {
        session.messages = [event.message];
      } else if (event.type === 'message' && event.message) {
        session.messages.push(event.message);
      } else if (event.type === 'done' && event.messages) {
        session.messages = event.messages;
      }

      if (sid === activeSessionId) renderMessages(session.messages);
    }
  }
}

startBtn.addEventListener('click', async () => {
  if (isRunning) return;
  if (!activeSessionId) activeSessionId = createSession();

  const topic = document.getElementById('topic').value.trim();
  if (!topic) return alert('请输入 topic');

  const sid = activeSessionId;
  const session = sessions.get(sid);
  session.topic = topic;
  session.name = topic.slice(0, 20) || session.name;
  refreshSessionOptions();

  const payload = {
    session_id: sid,
    topic,
    max_rounds: Number(document.getElementById('maxRounds').value),
    agentA_config: cfg('a'),
    agentB_config: cfg('b'),
    tavily_api_key: document.getElementById('tavilyKey').value,
    search_topk: Number(document.getElementById('searchTopk').value),
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

sessionSelect.addEventListener('change', (e) => {
  if (isRunning) return;
  switchSession(e.target.value);
});

const initId = createSession();
refreshSessionOptions();
switchSession(initId);
