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

function approvalCard({ id, kind, tool, host, title, input: toolInput }) {
  const card = document.createElement('article');
  card.className = 'card approval';
  const what = document.createElement('p');
  what.className = 'what';
  what.textContent = kind === 'site' ? `Let your agent use ${host}?` : `Run ${tool} on ${host}?`;
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

function messageItem({ role, text, reaction }) {
  const item = document.createElement('li');
  item.className = `message ${role}`;
  if (role === 'agent') item.append(markdown(text));
  else item.append(inline(text));
  if (reaction) {
    const badge = document.createElement('span');
    badge.className = 'reaction';
    badge.textContent = reaction;
    item.append(badge);
  }
  return item;
}

function renderMessages(messages, connected) {
  const nearBottom = messagesEl.parentElement.scrollHeight - messagesEl.parentElement.scrollTop
    - messagesEl.parentElement.clientHeight < 80;
  const items = messages.map(messageItem);
  // Until the first words of a reply arrive, the user's message is all there is to look at.
  if (connected && messages.at(-1)?.role === 'user') {
    const waiting = document.createElement('li');
    waiting.className = 'message waiting';
    waiting.textContent = 'Shy is thinking…';
    items.push(waiting);
  }
  messagesEl.replaceChildren(...items);
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
    meta.textContent = [time, entry.host, entry.error].filter(Boolean).join(' · ');
    item.append(head, meta);
    return item;
  }));
}

function render({ status, configured, log, messages = [], approvals = [] }) {
  statusEl.textContent = status;
  statusEl.dataset.state = status.split(':')[0];
  $('setup').hidden = configured;
  $('approvals').replaceChildren(...approvals.map(approvalCard));
  renderMessages(messages, status === 'connected');
  renderLog(log);
  $('send').disabled = status !== 'connected';
}

function send() {
  const text = input.value.trim();
  if (!text || $('send').disabled) return;
  chrome.runtime.sendMessage({ type: 'chat-send', text });
  input.value = '';
  resize();
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
