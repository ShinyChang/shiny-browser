import { DEFAULTS } from './defaults.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const messagesEl = $('messages');
const input = $('input');
const form = $('settings');

// Escapes everything, then turns code, bold and links back into elements.
function inline(text) {
  const block = document.createElement('div');
  block.className = 'text';
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))|(https?:\/\/[^\s)]+)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    block.append(text.slice(last, match.index));
    const [token] = match;
    if (match[1] || match[2]) {
      const el = document.createElement(match[1] ? 'code' : 'strong');
      el.textContent = match[1] ? token.slice(1, -1) : token.slice(2, -2);
      block.append(el);
    } else {
      const split = token.indexOf('](');
      const link = document.createElement('a');
      link.href = match[3] ? token.slice(split + 2, -1) : token;
      link.textContent = match[3] ? token.slice(1, split) : token;
      link.target = '_blank';
      link.rel = 'noreferrer';
      block.append(link);
    }
    last = match.index + token.length;
  }
  block.append(text.slice(last));
  return block;
}

function markdown(text) {
  const fragment = document.createDocumentFragment();
  const parts = text.split(/```[\w-]*\n?([\s\S]*?)(?:```|$)/);
  parts.forEach((part, index) => {
    if (index % 2) {
      const pre = document.createElement('pre');
      pre.textContent = part;
      fragment.append(pre);
    } else if (part.trim()) {
      fragment.append(inline(part.replace(/^\n+|\n+$/g, '')));
    }
  });
  return fragment;
}

function approvalCard({ id, kind, tool, host, title, question, input: toolInput }) {
  const card = document.createElement('article');
  card.className = 'card approval';
  const what = document.createElement('p');
  what.className = 'what';
  what.textContent = question ?? (kind === 'site' ? `Let your agent use ${host}?` : `Run ${tool} on ${host}?`);
  const where = document.createElement('p');
  where.className = 'meta';
  where.textContent = kind === 'site' ? `It wants to run ${tool} on "${title}".` : title;
  card.append(what, where);
  if (toolInput) {
    const code = document.createElement('pre');
    code.textContent = toolInput.length > 4000 ? `${toolInput.slice(0, 4000)}\n…` : toolInput;
    card.append(code);
  }
  const buttons = document.createElement('div');
  buttons.className = 'buttons';
  const choices = kind === 'site'
    ? [['Allow once', 'once'], ['Always allow', 'always'], ['Decline', 'deny']]
    : [['Allow', 'once'], ['Always allow here', 'always'], ['Decline', 'deny']];
  for (const [label, choice] of choices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (choice === 'once') button.className = 'primary';
    button.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'decide', id, choice }));
    buttons.append(button);
  }
  card.append(buttons);
  return card;
}

function filesView(files) {
  const view = document.createElement('div');
  view.className = 'files';
  for (const { name, url, link } of files) {
    let el;
    if (url) {
      el = document.createElement('img');
      el.src = url;
      el.alt = name;
    } else {
      el = document.createElement('span');
      el.textContent = `📎 ${name}`;
    }
    if (link) {
      const a = document.createElement('a');
      a.href = link;
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.append(el);
      el = a;
    }
    view.append(el);
  }
  return view;
}

// OpenAB shows how a turn is going as one reaction on the user's message, swapped as it goes.
const WORKING = {
  '👀': 'Starting…', '🤔': 'Thinking…', '🔥': 'Using a tool…', '👨‍💻': 'Running code…', '🧑‍💻': 'Running code…',
  '⚡': 'Searching the web…', '🥱': 'Still working…', '😨': 'Taking a long time…',
};
// OpenAB starts a reply with its tool calls, "🔧 `title`..." while one runs, and counts once there are many.
const TOOL_LINE = /^(?:(?:🔧|✅|❌) `(.*)`(\.\.\.)?|(?:🔧|✅|❌) \d+(?: · (?:🔧|✅|❌) \d+)* tool\(s\)(?: completed)?|🔧 \d+ more(?: running)?)$/u;
// A call that ends quickly would otherwise never be seen.
const RECENT_CALL_MS = 3000;
const openTools = new Set();

function splitTools(text) {
  const lines = text.split('\n');
  let count = 0;
  while (count < lines.length && TOOL_LINE.test(lines[count])) count++;
  return { tools: lines.slice(0, count), body: lines.slice(count).join('\n').trim() };
}

const toolTitle = (title) => title.replace(/^~\/\.local\/bin\//, '');

function toolsView(id, lines) {
  const details = document.createElement('details');
  details.className = 'tool-calls';
  // The list is redrawn on every update, which would close it under the user's eyes.
  details.open = openTools.has(id);
  details.addEventListener('toggle', () => (details.open ? openTools.add(id) : openTools.delete(id)));
  const count = lines.reduce((n, line) => n + (line.includes('`') ? 1 : line.match(/\d+/g).reduce((a, d) => a + Number(d), 0)), 0);
  const summary = document.createElement('summary');
  summary.textContent = `${count} ${count === 1 ? 'tool' : 'tools'}`;
  const list = document.createElement('ul');
  list.append(...lines.map((line) => {
    const item = document.createElement('li');
    item.textContent = line.replace(/`/g, '').replace(' ~/.local/bin/', ' ');
    return item;
  }));
  details.append(summary, list);
  return details;
}

// What the agent is doing now, or null once its turn is over.
function workingOn(messages, call) {
  if (call && (call.ok === null || Date.now() - call.endedAt < RECENT_CALL_MS)) return call.detail ?? call.tool;
  const userAt = messages.findLastIndex((m) => m.role === 'user');
  if (userAt < 0) return null;
  const { reaction } = messages[userAt];
  const last = messages.at(-1);
  const running = last.role === 'agent'
    ? splitTools(last.text).tools.map((line) => line.match(TOOL_LINE)).findLast((m) => m[2])
    : null;
  // Without status reactions, the turn lasts until a reply arrives and no tool is still running.
  const working = reaction ? Object.hasOwn(WORKING, reaction) : last === messages[userAt] || Boolean(running);
  if (!working) return null;
  if (running) return `Running ${toolTitle(running[1])}`;
  return WORKING[reaction] ?? 'Thinking…';
}

function messageItem({ id, role, text, reaction, files }, inProgress) {
  const item = document.createElement('li');
  item.className = `message ${role}`;
  if (role === 'agent') {
    const { tools, body } = splitTools(text);
    // Until there are words, the status line says what is happening.
    if (!body && inProgress) return null;
    item.append(markdown(body));
    if (tools.length) item.append(toolsView(id, tools));
  } else if (text) item.append(inline(text));
  if (files?.length) item.append(filesView(files));
  if (reaction) {
    const badge = document.createElement('span');
    badge.className = 'reaction';
    badge.textContent = reaction;
    item.append(badge);
  }
  return item;
}

let lastState = null;
let workingTimer = null;

function renderMessages(messages, connected, call) {
  const nearBottom = messagesEl.parentElement.scrollHeight - messagesEl.parentElement.scrollTop
    - messagesEl.parentElement.clientHeight < 80;
  const working = connected ? workingOn(messages, call) : null;
  messagesEl.replaceChildren(...messages.map((m, i) => messageItem(m, working && i === messages.length - 1)).filter(Boolean));
  // One element for the whole turn, so its animation does not restart on every update.
  const workingEl = $('working');
  workingEl.hidden = !working;
  workingEl.textContent = working ?? '';
  workingEl.title = working ?? '';
  clearTimeout(workingTimer);
  if (call?.endedAt && Date.now() - call.endedAt < RECENT_CALL_MS) {
    workingTimer = setTimeout(() => render(lastState), RECENT_CALL_MS - (Date.now() - call.endedAt));
  }
  $('chat-empty').hidden = messages.length > 0;
  if (nearBottom) messagesEl.parentElement.scrollTop = messagesEl.parentElement.scrollHeight;
}

function renderLog(log) {
  $('log-empty').hidden = log.length > 0;
  $('log').replaceChildren(...log.map((entry) => {
    const item = document.createElement('li');
    item.dataset.ok = entry.ok;
    const time = new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const head = document.createElement('div');
    head.className = 'call';
    head.textContent = entry.tool;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = [time, entry.detail ?? entry.host, entry.error].filter(Boolean).join(' · ');
    item.append(head, meta);
    return item;
  }));
}

function render(state) {
  const { status, configured, log, messages = [], approvals = [] } = state;
  lastState = state;
  statusEl.textContent = status;
  statusEl.dataset.state = status.split(':')[0];
  $('setup').hidden = configured;
  $('approvals').replaceChildren(...approvals.map(approvalCard));
  renderMessages(messages, status === 'connected', log[0]);
  renderLog(log);
  $('send').disabled = status !== 'connected';
}

// Slack takes files of up to a gigabyte, but each one crosses the extension's messaging as base64.
const MAX_FILE = 20 * 1024 * 1024;
const MAX_TOTAL = 50 * 1024 * 1024;
let attachments = [];

async function thumbnail(file) {
  if (!file.type.startsWith('image/')) return null;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 240 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.8);
  } catch {
    return null;
  }
}

function renderAttachments() {
  $('attachments').replaceChildren(...attachments.map((attachment) => {
    const item = document.createElement('li');
    item.className = 'attachment';
    item.title = attachment.file.name;
    if (attachment.thumb) {
      const img = document.createElement('img');
      img.src = attachment.thumb;
      img.alt = '';
      item.append(img);
    }
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = attachment.file.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${attachment.file.name}`);
    remove.addEventListener('click', () => {
      attachments = attachments.filter((a) => a !== attachment);
      renderAttachments();
    });
    item.append(name, remove);
    return item;
  }));
}

async function addFiles(files) {
  for (const file of files) {
    const total = attachments.reduce((sum, a) => sum + a.file.size, 0) + file.size;
    if (file.size > MAX_FILE || total > MAX_TOTAL) {
      chrome.runtime.sendMessage({ type: 'chat-note', text: `${file.name} is too large to send from here; Talk to Shy takes files up to 20 MB, 50 MB in all.` });
      continue;
    }
    attachments.push({ file, thumb: await thumbnail(file) });
  }
  renderAttachments();
  input.focus();
}

function base64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function send() {
  const text = input.value.trim();
  if ((!text && !attachments.length) || $('send').disabled) return;
  const sending = attachments;
  attachments = [];
  input.value = '';
  renderAttachments();
  resize();
  const files = await Promise.all(sending.map(async ({ file, thumb }) => ({
    name: file.name, type: file.type, size: file.size, thumb, data: await base64(file),
  })));
  chrome.runtime.sendMessage({ type: 'chat-send', text, files });
}

function resize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

$('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  send();
});
input.addEventListener('keydown', (event) => {
  // Enter also confirms a candidate in Chinese and Japanese input methods; only a bare Enter sends.
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    send();
  }
});
input.addEventListener('input', resize);
input.addEventListener('paste', (event) => {
  const files = [...event.clipboardData.files];
  if (!files.length) return;
  event.preventDefault();
  addFiles(files);
});
$('attach').addEventListener('click', () => $('files').click());
$('files').addEventListener('change', () => {
  addFiles([...$('files').files]);
  $('files').value = '';
});
// Files dropped anywhere on the panel are attached; the box shows where they go.
const dragsFiles = (event) => event.dataTransfer?.types.includes('Files');
document.addEventListener('dragover', (event) => {
  if (!dragsFiles(event)) return;
  event.preventDefault();
  $('box').classList.add('dropping');
});
document.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget) $('box').classList.remove('dropping');
});
document.addEventListener('drop', (event) => {
  $('box').classList.remove('dropping');
  if (!dragsFiles(event)) return;
  event.preventDefault();
  addFiles([...event.dataTransfer.files]);
});
$('new-chat').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'chat-new' }));
$('more').addEventListener('click', () => {
  const open = $('more-view').hidden;
  $('more-view').hidden = !open;
  $('chat-view').hidden = open;
  $('composer').hidden = open;
  $('more').textContent = open ? 'Back to chat' : 'More';
  $('more').setAttribute('aria-expanded', String(open));
});
$('setup').addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = $('setup-token').value.trim();
  if (token) await chrome.storage.local.set({ token });
  $('setup-token').value = '';
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'state') render(message);
});
chrome.runtime.sendMessage({ type: 'get-state' }).then(render);

async function loadSettings() {
  const stored = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  $('relay-url').value = stored.relayUrl;
  $('token').value = stored.token;
  $('allow-all-sites').checked = stored.allowAllSites;
  $('allowed-hosts').disabled = stored.allowAllSites;
  $('allowed-hosts').value = stored.allowedHosts.join('\n');
  $('always-tools').value = stored.alwaysAllowedTools.join('\n');
}
await loadSettings();
// The setup card and "Always allow" in a card change settings while the form is showing them,
// and saving a stale form would undo them.
chrome.storage.onChanged.addListener((changes) => {
  if (Object.keys(DEFAULTS).some((key) => key in changes)) loadSettings();
});
$('allow-all-sites').addEventListener('change', (event) => {
  $('allowed-hosts').disabled = event.target.checked;
});

const lines = (value) => value.split('\n').map((line) => line.trim()).filter(Boolean);
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  await chrome.storage.local.set({
    relayUrl: $('relay-url').value.trim(),
    token: $('token').value.trim(),
    allowAllSites: $('allow-all-sites').checked,
    allowedHosts: lines($('allowed-hosts').value),
    alwaysAllowedTools: lines($('always-tools').value),
  });
  $('saved').hidden = false;
  setTimeout(() => { $('saved').hidden = true; }, 1500);
});
input.focus();
