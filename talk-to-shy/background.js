import { DEFAULTS } from './defaults.js';

// Chrome keeps a service worker alive while its WebSocket carries a message at
// least every 30 seconds.
const KEEPALIVE_MS = 20000;
const LOG_SIZE = 50;
const CHAT_SIZE = 200;
// Shorter than the relay's call timeout, so the agent hears "declined" rather than a timeout.
const APPROVAL_TIMEOUT_MS = 150000;
// A relay or tunnel restart drops the socket; retry within seconds rather than at the next alarm.
const RETRY_MS = [1000, 2000, 5000, 10000, 20000];

let socket = null;
let keepalive = null;
let retries = 0;
let status = 'disconnected';
let configured = false;
const log = [];
const approvals = new Map();
let nextApprovalId = 1;
let chat = { conversation: crypto.randomUUID(), messages: [] };
const chatLoaded = chrome.storage.local.get(['conversation', 'messages']).then((stored) => {
  if (stored.conversation) chat = { conversation: stored.conversation, messages: stored.messages ?? [] };
});

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
}

async function addSetting(key, value) {
  const list = (await settings())[key];
  if (!list.includes(value)) await chrome.storage.local.set({ [key]: [...list, value] });
}

// Lets the relay tell this browser reconnecting apart from another browser or profile.
async function instanceId() {
  const { instance } = await chrome.storage.local.get('instance');
  if (instance) return instance;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ instance: id });
  return id;
}

function state() {
  return {
    status,
    configured,
    log,
    messages: chat.messages,
    approvals: [...approvals.values()].map(({ resolve, timer, ...request }) => request),
  };
}

function notifyPanel() {
  chrome.runtime.sendMessage({ type: 'state', ...state() }).catch(() => {});
  // The panel cannot open itself, so a waiting request also shows on the toolbar button.
  chrome.action.setBadgeText({ text: approvals.size ? String(approvals.size) : '' });
}

// Resolves with "once", "always" or "deny".
function requestApproval(request) {
  const id = nextApprovalId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => decide(id, 'deny'), APPROVAL_TIMEOUT_MS);
    approvals.set(id, { id, at: Date.now(), ...request, resolve, timer });
    notifyPanel();
    // The panel may be closed, and Shy has no tab strip to badge.
    chrome.notifications.create(`approval-${id}`, {
      type: 'basic',
      iconUrl: 'icon.png',
      title: request.kind === 'site' ? `Let your agent use ${request.host}?` : `Allow ${request.tool}?`,
      message: request.kind === 'site'
        ? `It wants to run ${request.tool} there. Click to answer in Talk to Shy.`
        : `Your agent wants to run it on ${request.host}. Click to review it in Talk to Shy.`,
      requireInteraction: true,
    });
  });
}

function decide(id, choice) {
  const approval = approvals.get(id);
  if (!approval) return;
  approvals.delete(id);
  chrome.notifications.clear(`approval-${id}`);
  clearTimeout(approval.timer);
  approval.resolve(choice);
  notifyPanel();
}

function setStatus(next) {
  status = next;
  notifyPanel();
}

async function connect() {
  if (socket) return;
  const { relayUrl, token } = await settings();
  const instance = await instanceId();
  // The alarm and a retry can both get here while those reads are pending.
  if (socket) return;
  configured = Boolean(token);
  if (!token) return setStatus('no token');
  const ws = new WebSocket(relayUrl);
  socket = ws;
  setStatus('connecting');
  // The token goes in the first message rather than the URL, which servers and proxies log.
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'hello', token, instance }));
    keepalive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, KEEPALIVE_MS);
  };
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'welcome') {
      retries = 0;
      setStatus('connected');
    } else if (message.type === 'rejected') setStatus(`rejected: ${message.reason}`);
    else if (message.type === 'call') handleCall(ws, message);
    else if (message.type.startsWith('chat-')) chatFromRelay(message);
  };
  ws.onclose = () => {
    clearInterval(keepalive);
    if (socket !== ws) return;
    socket = null;
    // Retrying a wrong token cannot help until the settings change.
    if (status.startsWith('rejected')) return;
    setStatus('disconnected');
    setTimeout(connect, RETRY_MS[Math.min(retries++, RETRY_MS.length - 1)]);
  };
}

function reconnect() {
  socket?.close();
  socket = null;
  connect();
}

async function saveChat() {
  chat.messages.splice(0, chat.messages.length - CHAT_SIZE);
  notifyPanel();
  await chrome.storage.local.set({ conversation: chat.conversation, messages: chat.messages });
}

async function sendChat(text) {
  await chatLoaded;
  const id = crypto.randomUUID();
  chat.messages.push({ id, role: 'user', text, at: Date.now() });
  if (socket?.readyState === WebSocket.OPEN && status === 'connected') {
    socket.send(JSON.stringify({ type: 'chat', conversation: chat.conversation, id, text }));
  } else {
    chat.messages.push({ id: crypto.randomUUID(), role: 'error', text: 'Shy is not connected to its relay.', at: Date.now() });
  }
  await saveChat();
}

async function chatFromRelay({ type, conversation, messageId, text, emoji, remove }) {
  await chatLoaded;
  // A reply to a conversation the user has since cleared has nowhere to go.
  if (conversation !== chat.conversation) return;
  const message = chat.messages.find((m) => m.id === messageId);
  if (type === 'chat-reply') {
    if (message) message.text = text;
    else chat.messages.push({ id: messageId, role: 'agent', text, at: Date.now() });
  } else if (type === 'chat-delete') {
    chat.messages = chat.messages.filter((m) => m.id !== messageId);
  } else if (type === 'chat-reaction' && message) {
    message.reaction = remove ? null : emoji;
  } else if (type === 'chat-error') {
    chat.messages.push({ id: crypto.randomUUID(), role: 'error', text, at: Date.now() });
  }
  await saveChat();
}

async function newChat() {
  await chatLoaded;
  chat = { conversation: crypto.randomUUID(), messages: [] };
  await saveChat();
}

async function handleCall(ws, { id, tool, args }) {
  const entry = { at: Date.now(), tool, ok: false };
  try {
    if (!Object.hasOwn(TOOLS, tool)) throw new Error(`Talk to Shy has no tool named ${tool}`);
    const content = await TOOLS[tool](args ?? {});
    entry.ok = true;
    entry.host = content?.host;
    ws.send(JSON.stringify({ type: 'result', id, ok: true, content }));
  } catch (error) {
    entry.error = error.message;
    ws.send(JSON.stringify({ type: 'result', id, ok: false, error: error.message }));
  }
  log.unshift(entry);
  log.length = Math.min(log.length, LOG_SIZE);
  notifyPanel();
}

// A site the user has not allowed yet waits for them, and "always" adds it to the allowed sites.
async function targetTab(tabId, tool) {
  const tab = tabId === undefined
    ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
    : await chrome.tabs.get(tabId);
  if (!tab?.url) throw new Error('There is no tab to use');
  const url = new URL(tab.url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Talk to Shy can only use web pages');
  const host = url.hostname;
  const { allowAllSites, allowedHosts } = await settings();
  if (!allowAllSites && !allowedHosts.includes(host)) {
    const choice = await requestApproval({ kind: 'site', tool, host, title: tab.title, windowId: tab.windowId });
    if (choice === 'deny') throw new Error(`The user did not let you use ${host}`);
    if (choice === 'always') await addSetting('allowedHosts', host);
  }
  return { tab, host };
}

// Runs in the page's own world, where document.modelContext lives.
async function inPage(tabId, func, args = []) {
  const [frame] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
  if (frame?.result?.error) throw new Error(frame.result.error);
  return frame?.result;
}

function readPage(limit) {
  return { title: document.title, url: location.href, text: document.body.innerText.slice(0, limit) };
}

async function listPageTools() {
  if (!document.modelContext) return { error: 'This page does not offer WebMCP tools' };
  const tools = await document.modelContext.getTools();
  return tools.map(({ name, title, description, inputSchema, annotations }) =>
    ({ name, title, description, inputSchema, annotations }));
}

async function runPageTool(name, input) {
  if (!document.modelContext) return { error: 'This page does not offer WebMCP tools' };
  const tool = (await document.modelContext.getTools()).find((t) => t.name === name);
  if (!tool) return { error: `This page has no WebMCP tool named ${name}` };
  // Chromium 153 wanted the input as a JSON string, 155 and later want an object.
  let output;
  try {
    output = await document.modelContext.executeTool(tool, input);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    output = await document.modelContext.executeTool(tool, JSON.stringify(input));
  }
  return { output };
}

const TOOLS = {
  async list_tabs() {
    const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
    return tabs.map(({ id, title, url, active }) => ({ id, title, url, active }));
  },
  async read_page({ tabId }) {
    const { tab, host } = await targetTab(tabId, 'read_page');
    return { host, ...(await inPage(tab.id, readPage, [50000])) };
  },
  async list_webmcp_tools({ tabId }) {
    const { tab, host } = await targetTab(tabId, 'list_webmcp_tools');
    return { host, tools: await inPage(tab.id, listPageTools) };
  },
  async call_webmcp_tool({ tabId, name, input }) {
    const { tab, host } = await targetTab(tabId, name);
    const tools = await inPage(tab.id, listPageTools);
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`${host} has no WebMCP tool named ${name}`);
    const key = `${host} ${name}`;
    if (!tool.annotations?.readOnlyHint && !(await settings()).alwaysAllowedTools.includes(key)) {
      const choice = await requestApproval({
        kind: 'tool', tool: name, host, title: tab.title, windowId: tab.windowId, input: JSON.stringify(input ?? {}, null, 2),
      });
      if (choice === 'deny') throw new Error(`The user did not allow ${name} on ${host}`);
      if (choice === 'always') await addSetting('alwaysAllowedTools', key);
    }
    return { host, ...(await inPage(tab.id, runPageTool, [name, input ?? {}])) };
  },
};

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
chrome.storage.onChanged.addListener((changes) => {
  if (changes.relayUrl || changes.token) reconnect();
});
chrome.notifications.onClicked.addListener((notificationId) => {
  const approval = approvals.get(Number(notificationId.replace('approval-', '')));
  // A notification click is a user gesture, which sidePanel.open needs; it ends at the first await.
  if (approval) chrome.sidePanel.open({ windowId: approval.windowId });
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'get-state') {
    chatLoaded.then(() => sendResponse(state()));
    return true;
  }
  if (message.type === 'decide') decide(message.id, message.choice);
  else if (message.type === 'chat-send') sendChat(message.text);
  else if (message.type === 'chat-new') newChat();
});
// A service worker stopped while the relay was down has nothing left to wake it.
chrome.alarms.create('reconnect', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => connect());
connect();
