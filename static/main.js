const tabs = document.querySelectorAll('.tab');
const pages = document.querySelectorAll('.page');

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
    system_prompt: document.getElementById(`${prefix}_prompt`).value,
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

    if (m.structured) {
      const d = document.createElement('details');
      d.innerHTML = `<summary>structured JSON</summary><pre>${JSON.stringify(m.structured, null, 2)}</pre>`;
      card.appendChild(d);
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

document.getElementById('startBtn').addEventListener('click', async () => {
  const payload = {
    topic: document.getElementById('topic').value,
    max_rounds: Number(document.getElementById('maxRounds').value),
    agentA_config: cfg('a'),
    agentB_config: cfg('b'),
    tavily_api_key: document.getElementById('tavilyKey').value,
    search_topk: Number(document.getElementById('searchTopk').value),
  };

  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    alert(`请求失败: ${text}`);
    return;
  }
  const data = await res.json();
  renderMessages(data.messages || []);
});
