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
// Base64 characters per piece; a multiple of 4, so each piece decodes on its own.
const FILE_CHUNK = 512 * 1024;

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
      title: request.question ?? (request.kind === 'site' ? `Let your agent use ${request.host}?` : `Allow ${request.tool}?`),
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
      openChat();
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

// A relay that keeps the chat in a Slack thread follows the thread of the conversation shown here.
async function openChat() {
  await chatLoaded;
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'chat-open', conversation: chat.conversation }));
  }
}

async function sendChat(text, files = []) {
  await chatLoaded;
  const id = crypto.randomUUID();
  chat.messages.push({
    id, role: 'user', text, at: Date.now(), pending: true, files: files.map(({ name, type, thumb }) => ({ name, type, url: thumb })),
  });
  if (socket?.readyState === WebSocket.OPEN && status === 'connected') {
    const refs = files.map(({ name, type, size, data }) => {
      const upload = crypto.randomUUID();
      // Files go in pieces, so no single WebSocket message gets large on its way through the tunnel.
      for (let i = 0; i < data.length; i += FILE_CHUNK) {
        socket.send(JSON.stringify({ type: 'chat-file', upload, data: data.slice(i, i + FILE_CHUNK) }));
      }
      return { upload, name, type, size };
    });
    socket.send(JSON.stringify({ type: 'chat', conversation: chat.conversation, id, text, files: refs }));
  } else {
    chat.messages.push({ id: crypto.randomUUID(), role: 'error', text: 'Shy is not connected to its relay.', at: Date.now() });
  }
  await saveChat();
}

async function chatFromRelay({ type, conversation, id, messageId, text, emoji, remove, messages }) {
  await chatLoaded;
  // A reply to a conversation the user has since cleared has nowhere to go.
  if (conversation !== chat.conversation) return;
  const message = chat.messages.find((m) => m.id === (type === 'chat-sent' ? id : messageId));
  if (type === 'chat-sent' && message) {
    // The thread names the message by its Slack timestamp from now on; without one, the next
    // look at the thread brings the message back.
    if (messageId) message.id = messageId;
    delete message.pending;
  } else if (type === 'chat-thread') {
    // The thread is the record; only what it cannot know yet stays. A message still unconfirmed
    // after a minute never reached it, and an error already says so.
    const unsent = (m) => m.pending && Date.now() - m.at < 60000;
    chat.messages = [...messages, ...chat.messages.filter((m) => unsent(m) || m.role === 'error')];
  } else if (type === 'chat-reply') {
    if (message) message.text = text;
    else chat.messages.push({ id: messageId, role: 'agent', text, at: Date.now() });
  } else if (type === 'chat-delete') {
    chat.messages = chat.messages.filter((m) => m.id !== messageId);
  } else if (type === 'chat-reaction' && message) {
    // An agent swaps status reactions by adding the new one before removing the old one.
    if (!remove) message.reaction = emoji;
    else if (message.reaction === emoji) message.reaction = null;
  } else if (type === 'chat-error') {
    chat.messages.push({ id: crypto.randomUUID(), role: 'error', text, at: Date.now() });
  }
  await saveChat();
}

async function note(text) {
  await chatLoaded;
  chat.messages.push({ id: crypto.randomUUID(), role: 'error', text, at: Date.now() });
  await saveChat();
}

async function newChat() {
  await chatLoaded;
  chat = { conversation: crypto.randomUUID(), messages: [] };
  await saveChat();
  openChat();
}

// A few words for the panel on what the agent is doing.
async function describe(tool, args) {
  let host = '';
  try {
    const tab = args.tabId === undefined
      ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
      : await chrome.tabs.get(args.tabId);
    host = new URL(tab.url).host;
  } catch {}
  const on = host ? ` on ${host}` : '';
  const page = host || 'the page';
  switch (tool) {
    case 'list_tabs': return args.query ? `Looking for "${args.query}" in your tabs` : 'Looking at your tabs';
    case 'open_tab': return `Opening ${URL.parse(args.url)?.host ?? args.url} in a new tab`;
    case 'close_tab': return `Closing a tab${on}`;
    case 'read_page': return `Reading ${page}`;
    case 'screenshot': return `Taking a screenshot of ${page}`;
    case 'click': {
      const verb = args.button === 'right' ? 'Right-clicking' : args.clickCount === 2 ? 'Double-clicking' : args.clickCount === 3 ? 'Triple-clicking' : 'Clicking';
      return `${verb} ${args.ref ?? args.selector ?? `at ${args.x}, ${args.y}`}${on}`;
    }
    case 'hover': return `Pointing at ${args.ref ?? args.selector ?? `${args.x}, ${args.y}`}${on}`;
    case 'set_value': return `Setting ${args.ref ?? args.selector}${on}`;
    case 'resize_window': return `Resizing the window to ${args.width} by ${args.height}`;
    case 'type_text': return `Typing${on}`;
    case 'press_key': return `Pressing ${args.key}${on}`;
    case 'scroll': return `Scrolling ${page}`;
    case 'drag': return `Dragging${on}`;
    case 'upload_file': return `Uploading ${args.files?.length ?? 0} file${args.files?.length === 1 ? '' : 's'}${on}`;
    case 'console_messages': return `${args.reload ? 'Reloading and reading' : 'Reading'} the console${on}`;
    case 'navigate': return args.url === 'back' || args.url === 'forward' ? `Going ${args.url}${on}` : `Opening ${URL.parse(args.url)?.host ?? args.url}`;
    case 'run_script': return `Running a script${on}`;
    case 'network_requests': return `${args.reload ? 'Reloading and reading' : 'Reading'} the network log${on}`;
    case 'network_request': return `Reading a request${on}`;
    case 'list_webmcp_tools': return `Looking at the page's tools${on}`;
    case 'call_webmcp_tool': return `Using ${args.name}${on}`;
    default: return tool;
  }
}

async function runTool(tool, args) {
  // ok stays null while the call runs, so the panel can show it as it happens.
  const entry = { at: Date.now(), tool, ok: null, detail: await describe(tool, args) };
  log.unshift(entry);
  log.length = Math.min(log.length, LOG_SIZE);
  notifyPanel();
  try {
    if (!Object.hasOwn(TOOLS, tool)) throw new Error(`Talk to Shy has no tool named ${tool}`);
    const content = await TOOLS[tool](args);
    entry.ok = true;
    entry.host = content?.host;
    return content;
  } catch (error) {
    entry.ok = false;
    entry.error = error.message;
    throw error;
  } finally {
    entry.endedAt = Date.now();
    notifyPanel();
  }
}

const BATCH_LIMIT = 50;
const WAIT_LIMIT_MS = 10000;
// Tools that take no tabId, or (close_tab) must never get one the agent did not name.
const NO_DEFAULT_TAB = new Set(['list_tabs', 'open_tab', 'close_tab']);

// One relay round trip for the whole run; later actions usually depend on earlier ones, so the
// first failure skips the rest.
async function runBatch({ tabId, actions }) {
  if (!Array.isArray(actions) || !actions.length) throw new Error('batch needs a list of actions');
  if (actions.length > BATCH_LIMIT) throw new Error(`batch takes at most ${BATCH_LIMIT} actions`);
  // Fixed at the start, so the user switching tabs mid-run does not move the rest elsewhere.
  const defaultTab = tabId ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
  const results = [];
  let failed = false;
  for (const { tool, args = {} } of actions) {
    if (failed) {
      results.push({ tool, skipped: true });
      continue;
    }
    try {
      if (tool === 'batch') throw new Error('A batch cannot hold another batch');
      if (tool === 'wait') {
        const ms = Math.min(Math.max(Number(args.ms) || 0, 0), WAIT_LIMIT_MS);
        await new Promise((resolve) => setTimeout(resolve, ms));
        results.push({ tool, ok: true, content: { waited: ms } });
        continue;
      }
      const withTab = NO_DEFAULT_TAB.has(tool) || args.tabId !== undefined ? args : { ...args, tabId: defaultTab };
      results.push({ tool, ok: true, content: await runTool(tool, withTab) });
    } catch (error) {
      failed = true;
      results.push({ tool, ok: false, error: error.message });
    }
  }
  return { results };
}

async function handleCall(ws, { id, tool, args }) {
  try {
    const content = tool === 'batch' ? await runBatch(args ?? {}) : await runTool(tool, args ?? {});
    ws.send(JSON.stringify({ type: 'result', id, ok: true, content }));
  } catch (error) {
    ws.send(JSON.stringify({ type: 'result', id, ok: false, error: error.message }));
  }
}

// The built-in panel can see incognito windows, which the user keeps private from it.
const INCOGNITO = 'Talk to Shy does not use incognito windows';

// A site the user has not allowed yet waits for them, and "always" adds it to the allowed sites.
async function targetTab(tabId, tool) {
  const tab = tabId === undefined
    ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
    : await chrome.tabs.get(tabId);
  if (!tab?.url) throw new Error('There is no tab to use');
  if (tab.incognito) throw new Error(INCOGNITO);
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

// Screenshots, scripts and input go through the DevTools protocol, so scripts run despite a
// page's CSP and clicks and keys arrive as real input.
const attached = new Set();
// Requests are recorded from the first attach, so a failure the page hit before the agent asked
// about it is still there to read.
const NETWORK_LIMIT = 500;
const networks = new Map();
const CONSOLE_LIMIT = 500;
const consoles = new Map();

// Resolves true when this call started the recording.
async function attach(tabId) {
  if (attached.has(tabId)) return false;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (error) {
    if (!/already attached/i.test(error.message)) throw error;
  }
  attached.add(tabId);
  networks.set(tabId, { since: Date.now(), requests: new Map() });
  consoles.set(tabId, { since: Date.now(), messages: [] });
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable', { maxTotalBufferSize: 20000000, maxResourceBufferSize: 5000000 });
  // Both send what the page logged before they were enabled, as DevTools shows it when opened late.
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
  await chrome.debugger.sendCommand({ tabId }, 'Log.enable');
  return true;
}

async function cdp(tabId, method, params = {}) {
  await attach(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}
chrome.debugger.onDetach.addListener(({ tabId }) => {
  attached.delete(tabId);
  networks.delete(tabId);
  consoles.delete(tabId);
});

const CONSOLE_LEVELS = { error: 'error', assert: 'error', warning: 'warning', debug: 'debug' };
const where = (url, line) => (url ? `${clip(url, 200)}${Number.isInteger(line) ? `:${line + 1}` : ''}` : undefined);

function previewText(p) {
  if (p.entries) return p.description;
  const items = p.properties.map((x) =>
    `${p.subtype === 'array' ? '' : `${x.name}: `}${x.type === 'string' ? JSON.stringify(x.value) : x.value ?? x.type}`);
  const list = `${items.join(', ')}${p.overflow ? ', …' : ''}`;
  if (p.subtype === 'array') return `[${list}]`;
  return `${p.description === 'Object' ? '' : `${p.description} `}{${list}}`;
}

function remoteText(o) {
  if (o.type === 'string') return o.value;
  if (o.type === 'undefined') return 'undefined';
  if (o.unserializableValue) return o.unserializableValue;
  if ('value' in o) return JSON.stringify(o.value);
  if (o.preview && o.subtype !== 'error') return previewText(o.preview);
  return o.description ?? o.type;
}

function consoleText(args = []) {
  const parts = args.map(remoteText);
  // %c styles the text after it; its CSS argument is not part of the message.
  if (args[0]?.type === 'string' && args[0].value.includes('%c')) {
    parts.splice(1, args[0].value.split('%c').length - 1);
    parts[0] = parts[0].replaceAll('%c', '');
  }
  return clip(parts.join(' '), 2000);
}

const releasing = new Set();

function recordConsole(tabId, method, params) {
  const log = consoles.get(tabId);
  if (!log) return;
  let message;
  if (method === 'Runtime.consoleAPICalled') {
    const frame = params.stackTrace?.callFrames?.[0];
    message = { level: CONSOLE_LEVELS[params.type] ?? 'info', text: consoleText(params.args), at: params.timestamp, source: where(frame?.url, frame?.lineNumber) };
  } else if (method === 'Runtime.exceptionThrown') {
    const d = params.exceptionDetails;
    message = { level: 'error', text: clip(`${d.text} ${d.exception?.description ?? ''}`.trim(), 2000), at: params.timestamp, source: where(d.url, d.lineNumber) };
  } else {
    const e = params.entry;
    message = { level: e.level === 'verbose' ? 'debug' : e.level, text: clip(e.text, 2000), at: e.timestamp, source: where(e.url, e.lineNumber) ?? e.source };
  }
  log.messages.push(message);
  if (log.messages.length > CONSOLE_LIMIT) log.messages.shift();
  // The session keeps every logged object alive until its group is released, and only the text is kept here.
  if (!releasing.has(tabId) && (params.args ?? [params.exceptionDetails?.exception]).some((a) => a?.objectId)) {
    releasing.add(tabId);
    setTimeout(() => {
      releasing.delete(tabId);
      if (attached.has(tabId)) chrome.debugger.sendCommand({ tabId }, 'Runtime.releaseObjectGroup', { objectGroup: 'console' }).catch(() => {});
    }, 1000);
  }
}

const CONSOLE_EVENTS = new Set(['Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded']);

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  if (CONSOLE_EVENTS.has(method)) {
    recordConsole(tabId, method, params);
    return;
  }
  const log = networks.get(tabId);
  if (!log) return;
  const entry = log.requests.get(params.requestId);
  if (method === 'Network.requestWillBeSent') {
    if (entry && params.redirectResponse) {
      entry.redirects.push(`${params.redirectResponse.status} ${entry.url}`);
      Object.assign(entry, { url: params.request.url, requestHeaders: params.request.headers });
      return;
    }
    const { url, method: verb, headers, postData } = params.request;
    log.requests.set(params.requestId, {
      id: params.requestId, method: verb, url, type: params.type, start: params.timestamp, requestHeaders: headers, postData, redirects: [],
    });
    if (log.requests.size > NETWORK_LIMIT) log.requests.delete(log.requests.keys().next().value);
  } else if (!entry) {
    return;
  } else if (method === 'Network.responseReceived') {
    const { status, statusText, mimeType, headers, fromDiskCache, fromServiceWorker, fromPrefetchCache } = params.response;
    Object.assign(entry, { status, statusText, mimeType, responseHeaders: headers, type: params.type, fromCache: fromDiskCache || fromServiceWorker || fromPrefetchCache });
  } else if (method === 'Network.loadingFinished') {
    Object.assign(entry, { end: params.timestamp, bytes: params.encodedDataLength });
  } else if (method === 'Network.loadingFailed') {
    Object.assign(entry, { end: params.timestamp, failed: params.canceled ? 'canceled' : params.errorText, blocked: params.blockedReason ?? params.corsErrorStatus?.corsError });
  }
});

const clip = (text, size) => (text.length > size ? `${text.slice(0, size)}…` : text);

function requestSummary(r) {
  return {
    id: r.id, method: r.method, url: clip(r.url, 300), type: r.type, status: r.status ?? null,
    ...(r.failed && { failed: r.failed }), ...(r.blocked && { blocked: r.blocked }),
    ms: r.end ? Math.round((r.end - r.start) * 1000) : null, bytes: r.bytes ?? null,
    ...(r.fromCache && { fromCache: true }), ...(r.redirects.length && { redirects: r.redirects }),
  };
}

// Credentials stay out of what the agent reads, since it may repeat it in a chat.
const SECRET_HEADERS = /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;
const redact = (headers = {}) => Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, SECRET_HEADERS.test(k) ? '[redacted]' : v]));

// One answer covers each kind of action on a site, so a run of clicks asks once. evenIfAllowed asks
// despite "any site", for actions that reach beyond the page.
async function approveAction(tab, host, key, question, detail, evenIfAllowed = false) {
  const { allowAllSites, alwaysAllowedTools } = await settings();
  if ((allowAllSites && !evenIfAllowed) || alwaysAllowedTools.includes(`${host} ${key}`)) return;
  const choice = await requestApproval({
    kind: 'action', tool: key, question, host, title: tab.title, windowId: tab.windowId, input: detail,
  });
  if (choice === 'deny') throw new Error(`The user did not allow that on ${host}`);
  if (choice === 'always') await addSetting('alwaysAllowedTools', `${host} ${key}`);
}

async function evaluate(tabId, expression) {
  const { result, exceptionDetails } = await cdp(tabId, 'Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true, replMode: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

async function screenshot(tabId, { region, scale } = {}) {
  const { cssVisualViewport: view } = await cdp(tabId, 'Page.getLayoutMetrics');
  const area = region ?? { x: 0, y: 0, width: view.clientWidth, height: view.clientHeight };
  const inView = area.width > 0 && area.height > 0 && area.x >= 0 && area.y >= 0 &&
    area.x + area.width <= view.clientWidth + 1 && area.y + area.height <= view.clientHeight + 1;
  if (!inView) throw new Error(`region has to lie within the view, which is ${Math.round(view.clientWidth)} by ${Math.round(view.clientHeight)}`);
  // A region is asked for to see it closer, so it comes at twice its size unless scale says otherwise.
  const size = Math.min(Math.max(Number(scale) || (region ? 2 : 1), 0.1), 4);
  // The capture comes at the display's pixel ratio; undoing it puts the image in CSS pixels, so a
  // point in it is a point click takes.
  const ratio = await evaluate(tabId, 'devicePixelRatio');
  const { data } = await cdp(tabId, 'Page.captureScreenshot', {
    format: 'jpeg',
    quality: 80,
    clip: { x: view.pageX + area.x, y: view.pageY + area.y, width: area.width, height: area.height, scale: size / ratio },
  });
  return {
    image: { data, mimeType: 'image/jpeg' },
    width: Math.round(area.width * size),
    height: Math.round(area.height * size),
    ...(size !== 1 && { scale: size }),
    ...(region && { region }),
  };
}

// A background tab gets no input: clicks and keys never reach the page, and a wheel event is
// never acknowledged, which stalls every later command on that tab.
async function inFront(tabId, tool) {
  if ((await evaluate(tabId, 'document.visibilityState')) === 'hidden') {
    throw new Error(`${tool} needs the tab in front: input to a background tab never reaches the page. Open it with open_tab and active: true, or ask the user to switch to it.`);
  }
}

const INPUT_TIMEOUT_MS = 10000;

// The tab can still go to the background mid-call; detaching drops the stalled command so the
// next call attaches afresh instead of queueing behind it.
async function input(tabId, method, params) {
  let timer;
  const stalled = new Promise((_, reject) => {
    timer = setTimeout(() => {
      chrome.debugger.detach({ tabId }).catch(() => {});
      reject(new Error('The page did not take the input; the tab may have gone to the background'));
    }, INPUT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([cdp(tabId, method, params), stalled]);
  } finally {
    clearTimeout(timer);
  }
}

const BUTTONS = { left: 1, right: 2, middle: 4 };

// A double click is a second press counting 2, as the page tells it from two single clicks.
async function clickAt(tabId, x, y, { button = 'left', count = 1, modifiers = 0 } = {}) {
  await input(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
  for (let clickCount = 1; clickCount <= count; clickCount++) {
    await input(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: BUTTONS[button], clickCount, modifiers });
    await input(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount, modifiers });
  }
}

// Shy's own context menu is native: input from here can neither reach nor close it, and it would
// stay open on the user's screen. The page's own menu still opens. Resolves whether the page had one.
async function withoutBrowserMenu(tabId, click) {
  const key = JSON.stringify(`__talkToShyMenu${crypto.randomUUID().slice(0, 8)}`);
  await evaluate(tabId, `(() => {
    const seen = window[${key}] = { page: null };
    seen.listener = (e) => { seen.page = e.defaultPrevented; e.preventDefault(); };
    addEventListener('contextmenu', seen.listener);
  })()`);
  let page = null;
  try {
    await click();
  } finally {
    page = await evaluate(tabId, `(() => {
      const seen = window[${key}];
      removeEventListener('contextmenu', seen.listener);
      delete window[${key}];
      return seen.page;
    })()`).catch(() => null);
  }
  return page;
}

async function center(tabId, selector, block = 'center') {
  const point = await evaluate(tabId, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({ block: ${JSON.stringify(block)}, inline: ${JSON.stringify(block)} });
    const box = element.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);
  if (!point) throw new Error(`Nothing on the page matches ${selector}`);
  return point;
}

// A ref is the element's backend node id, which the renderer keeps for as long as the element
// lives, so refs need no state here and survive this worker being stopped.
async function refPoint(tabId, ref, block = 'center') {
  const backendNodeId = refNode(ref);
  const gone = new Error(`${ref} is no longer on the page; read the tree again`);
  const { object } = await cdp(tabId, 'DOM.resolveNode', { backendNodeId }).catch(() => { throw gone; });
  const { result } = await cdp(tabId, 'Runtime.callFunctionOn', {
    objectId: object.objectId,
    returnByValue: true,
    arguments: [{ value: block }],
    functionDeclaration: `function (block) {
      if (!this.isConnected) return false;
      (this.nodeType === 1 ? this : this.parentElement).scrollIntoView({ block, inline: block });
      return true;
    }`,
  });
  cdp(tabId, 'Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
  if (!result.value) throw gone;
  // Content quads are in the top page's viewport even for an element inside a frame, as input wants.
  const { quads } = await cdp(tabId, 'DOM.getContentQuads', { backendNodeId }).catch(() => ({ quads: [] }));
  if (!quads.length) throw new Error(`${ref} takes up no space on the page, so there is nowhere to point at`);
  const [q] = quads;
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}

function refNode(ref) {
  const backendNodeId = Number(/^e(\d+)$/.exec(ref ?? '')?.[1]);
  if (!backendNodeId) throw new Error(`${ref} is not a ref; read_page with format "tree" lists them`);
  return backendNodeId;
}

async function pointOf(tabId, { ref, selector, x, y } = {}, block = 'center') {
  if (ref) return refPoint(tabId, ref, block);
  if (selector) return center(tabId, selector, block);
  if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  throw new Error('Name the place with a ref, a selector or x and y');
}

const modifierBits = (modifiers = []) => modifiers.reduce((sum, name) => sum | (MODIFIERS[name] ?? 0), 0);

async function dragBetween(tabId, start, end, steps, modifiers) {
  let dragged = null;
  const intercepted = (source, method, params) => {
    if (source.tabId === tabId && method === 'Input.dragIntercepted') dragged = params.data;
  };
  chrome.debugger.onEvent.addListener(intercepted);
  // An HTML drag would otherwise start macOS's own drag loop, which input from here cannot reach;
  // intercepted, the browser hands its data over to be dropped with drag events.
  await cdp(tabId, 'Input.setInterceptDrags', { enabled: true });
  const mouse = (type, { x, y }, buttons) =>
    input(tabId, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1, modifiers });
  const drag = (type, { x, y }) => input(tabId, 'Input.dispatchDragEvent', { type, x, y, data: dragged, modifiers });
  try {
    await mouse('mouseMoved', start, 0);
    await mouse('mousePressed', start, 1);
    for (let i = 1; i <= steps; i++) {
      const at = { x: start.x + ((end.x - start.x) * i) / steps, y: start.y + ((end.y - start.y) * i) / steps };
      if (dragged) {
        await drag('dragOver', at);
        continue;
      }
      await mouse('mouseMoved', at, 1);
      // A frame apart, as a hand moves, for pages that only look at the mouse once per frame.
      await new Promise((resolve) => setTimeout(resolve, 16));
      if (dragged) await drag('dragEnter', at);
    }
    if (!dragged) {
      await mouse('mouseReleased', end, 0);
      return { from: start, to: end };
    }
    await drag('dragOver', end);
    await drag('drop', end);
    return { from: start, to: end, htmlDrag: true };
  } finally {
    chrome.debugger.onEvent.removeListener(intercepted);
    chrome.debugger.sendCommand({ tabId }, 'Input.setInterceptDrags', { enabled: false }).catch(() => {});
  }
}

const OBJECT_GROUP = 'talk-to-shy';
const UPLOAD_LIMIT = 50 * 1024 * 1024;

async function callOn(tabId, objectId, functionDeclaration, args = [], returnByValue = false) {
  const { result, exceptionDetails } = await cdp(tabId, 'Runtime.callFunctionOn', {
    objectId, functionDeclaration, returnByValue, objectGroup: OBJECT_GROUP, arguments: args.map((value) => ({ value })),
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result;
}

// With no target named, the page's only file input.
async function elementObject(tabId, { ref, selector, x, y }) {
  if (ref) {
    const { object } = await cdp(tabId, 'DOM.resolveNode', { backendNodeId: refNode(ref), objectGroup: OBJECT_GROUP })
      .catch(() => { throw new Error(`${ref} is no longer on the page; read the tree again`); });
    return object.objectId;
  }
  const expression = selector ? `document.querySelector(${JSON.stringify(selector)})`
    : Number.isFinite(x) && Number.isFinite(y) ? `document.elementFromPoint(${x}, ${y})`
      : `(() => { const inputs = document.querySelectorAll('input[type=file]'); return inputs.length === 1 ? inputs[0] : inputs.length; })()`;
  const { result } = await cdp(tabId, 'Runtime.evaluate', { expression, objectGroup: OBJECT_GROUP });
  if (result.objectId) return result.objectId;
  if (result.type === 'number') throw new Error(`The page has ${result.value} file inputs; name one, or the element to drop files on, with a ref, a selector or a point`);
  throw new Error(selector ? `Nothing on the page matches ${selector}` : `Nothing is at ${x}, ${y}`);
}

// Sites hide the input behind a styled button or drop zone, and the tree leaves hidden elements out,
// so the nearest one around the target counts.
const FIND_FILE_INPUT = `function () {
  const isFile = (e) => e instanceof HTMLInputElement && e.type === 'file';
  if (isFile(this)) return this;
  if (isFile(this.control)) return this.control;
  for (let e = this.nodeType === 1 ? this : this.parentElement; e && e !== document.body; e = e.parentElement) {
    const inputs = e.querySelectorAll('input[type=file]');
    if (inputs.length) return inputs.length === 1 ? inputs[0] : null;
  }
  return null;
}`;

const PUT_FILES = `function (files, asDrop) {
  const transfer = new DataTransfer();
  for (const f of files) transfer.items.add(new File([Uint8Array.fromBase64(f.base64)], f.name, { type: f.mimeType }));
  if (!asDrop) {
    this.files = transfer.files;
    this.dispatchEvent(new Event('input', { bubbles: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  const box = this.getBoundingClientRect();
  const init = { bubbles: true, cancelable: true, composed: true, dataTransfer: transfer, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
  this.dispatchEvent(new DragEvent('dragenter', init));
  this.dispatchEvent(new DragEvent('dragover', init));
  const drop = new DragEvent('drop', init);
  this.dispatchEvent(drop);
  // A drop zone cancels the drop, or the browser would open the file instead.
  return drop.defaultPrevented;
}`;

async function fileContents(files) {
  let total = 0;
  const contents = [];
  for (const f of files) {
    let bytes;
    let { name, mimeType } = f;
    if (f.text !== undefined) {
      bytes = new TextEncoder().encode(f.text);
      name ??= 'file.txt';
      mimeType ??= 'text/plain';
    } else if (f.base64 !== undefined) {
      bytes = Uint8Array.fromBase64(f.base64);
    } else if (f.url) {
      // Without the user's cookies, so a URL brings in only what anyone could download.
      const response = await fetch(f.url, { credentials: 'omit' });
      if (!response.ok) throw new Error(`${f.url} answered ${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
      name ??= decodeURIComponent(new URL(response.url).pathname.split('/').pop()) || undefined;
      mimeType ??= response.headers.get('content-type')?.split(';')[0];
    } else {
      throw new Error('Each file needs a path, url, text or base64');
    }
    total += bytes.length;
    if (total > UPLOAD_LIMIT) throw new Error(`Uploads are limited to ${UPLOAD_LIMIT / 1024 / 1024} MB in all`);
    contents.push({ name: name ?? 'file', mimeType: mimeType ?? '', base64: bytes.toBase64() });
  }
  return contents;
}

const TREE_LIMIT = 30000;
const TEXT_LIMIT = 50000;
const READ_LIMIT = 200000;
const ACTIONABLE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
  'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'listbox', 'PopUpButton',
  'ToggleButton', 'DisclosureTriangle', 'MenuListOption', 'ListBoxOption',
]);
// Without a name these only wrap their children, which take their place.
const WRAPPER_ROLES = new Set(['generic', 'none', 'presentation', 'paragraph', 'group', 'LabelText', 'Section', 'Pre', 'Abbr',
  'LayoutTable', 'LayoutTableRow', 'LayoutTableCell']);
const SKIPPED_ROLES = new Set(['InlineTextBox', 'LineBreak']);
// States are worth showing either way (an unchecked box); flags only when set.
const STATES = ['checked', 'pressed', 'expanded'];
const FLAGS = ['selected', 'disabled', 'required', 'focused'];

function formatTree(nodes, interactive, root, limit) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const lines = [];
  let size = 0;
  let cut = false;
  const walk = (node, depth, around) => {
    const role = node?.role?.value ?? '';
    if (cut || !node || SKIPPED_ROLES.has(role)) return;
    const name = String(node.name?.value ?? '').replace(/\s+/g, ' ').trim();
    const props = Object.fromEntries((node.properties ?? []).map((p) => [p.name, p.value?.value]));
    let shown = !node.ignored && role !== 'RootWebArea';
    // Text that only repeats its button's or link's name adds nothing.
    if (shown && role === 'StaticText') shown = !interactive && name !== '' && !around.includes(name);
    else if (shown && interactive) shown = ACTIONABLE_ROLES.has(role) || props.focusable === true || props.editable !== undefined;
    else if (shown) shown = name !== '' || !WRAPPER_ROLES.has(role);
    if (shown) {
      let line = role === 'StaticText' ? `text "${clip(name, 300)}"` : `${role}${name ? ` "${clip(name, 100)}"` : ''}`;
      if (role !== 'StaticText' && node.backendDOMNodeId) line += ` [ref=e${node.backendDOMNodeId}]`;
      const value = node.value?.value;
      if (value !== undefined && value !== '' && String(value) !== name) line += ` value="${clip(String(value), 100)}"`;
      for (const key of STATES) if (props[key] !== undefined) line += ` ${key}=${props[key]}`;
      for (const key of FLAGS) if (props[key] === true) line += ` ${key}`;
      if (props.level !== undefined) line += ` level=${props.level}`;
      if (props.url) line += ` url=${clip(String(props.url), 120)}`;
      line = `${'  '.repeat(depth)}- ${line}`;
      if (size + line.length > limit) {
        cut = true;
        return;
      }
      lines.push(line);
      size += line.length + 1;
    }
    for (const childId of node.childIds ?? []) {
      walk(byId.get(childId), shown ? depth + 1 : depth, shown && name ? name : around);
    }
  };
  walk(root, 0, '');
  return { tree: lines.join('\n'), cut };
}

async function pageTree(tabId, interactive, ref, limit) {
  const { nodes } = await cdp(tabId, 'Accessibility.getFullAXTree');
  // Reading the tree may leave accessibility on, which makes every later change to the page cost more.
  cdp(tabId, 'Accessibility.disable').catch(() => {});
  const root = ref ? nodes.find((node) => node.backendDOMNodeId === refNode(ref)) : nodes.find((node) => !node.parentId);
  if (!root) throw new Error(`${ref} is not in the tree: it is hidden or gone; read the whole tree again`);
  const { tree, cut } = formatTree(nodes, interactive, root, limit);
  const hint = interactive ? ' Pass a larger maxChars, or a ref to read one part.' : ' interactive: true lists only what can be clicked or typed into; a ref reads one part.';
  return { tree, ...(cut && { note: `The tree was cut at ${limit.toLocaleString('en')} characters.${hint}` }) };
}

const KEY_CODES = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39,
  ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32,
};
const MODIFIERS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const MODIFIER_NAMES = { cmd: 'Meta', command: 'Meta', meta: 'Meta', ctrl: 'Control', control: 'Control', alt: 'Alt', option: 'Alt', opt: 'Alt', shift: 'Shift' };
const KEY_NAMES = Object.fromEntries([...Object.keys(KEY_CODES).map((name) => [name.toLowerCase(), name]), ['return', 'Enter'], ['esc', 'Escape'], ['space', ' ']]);
// On a Mac the editing these shortcuts do comes from the window, which input sent here bypasses.
const MAC_COMMANDS = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo', 'shift+z': 'redo' };

// Takes "cmd+shift+z" as well as a key with a list of modifiers.
function parseKey(key, modifiers = []) {
  const combo = /^((?:(?:cmd|command|meta|ctrl|control|alt|option|opt|shift)\+)+)(.+)$/i.exec(key);
  const held = combo ? combo[1].split('+').filter(Boolean).map((name) => MODIFIER_NAMES[name.toLowerCase()]) : [];
  const base = combo ? combo[2] : key;
  return { key: KEY_NAMES[base.toLowerCase()] ?? base, modifiers: [...new Set([...modifiers, ...held])] };
}

function keyCode(key) {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^\d$/.test(key)) return `Digit${key}`;
  if (key === ' ') return 'Space';
  return KEY_CODES[key] ? key : '';
}

async function pressKey(tabId, key, modifiers = []) {
  const bits = modifierBits(modifiers);
  const single = [...key].length === 1;
  // With Control or Meta held, a letter is a shortcut rather than text.
  const text = key === 'Enter' ? '\r' : single && !(bits & (MODIFIERS.Control | MODIFIERS.Meta)) ? key : undefined;
  const command = bits === MODIFIERS.Meta ? MAC_COMMANDS[key.toLowerCase()]
    : bits === (MODIFIERS.Meta | MODIFIERS.Shift) ? MAC_COMMANDS[`shift+${key.toLowerCase()}`] : undefined;
  const event = { key, code: keyCode(key), windowsVirtualKeyCode: KEY_CODES[key] ?? (single ? key.toUpperCase().charCodeAt(0) : 0), modifiers: bits };
  await input(tabId, 'Input.dispatchKeyEvent', { ...event, type: text ? 'keyDown' : 'rawKeyDown', ...(text && { text }), ...(command && { commands: [command] }) });
  await input(tabId, 'Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
}

// A new document has a new time origin; until then readyState still describes the old one. A move
// within one document keeps its time origin, so reaching url counts too.
async function loadNewDocument(tabId, method, params, url) {
  const before = await evaluate(tabId, 'performance.timeOrigin').catch(() => 0);
  await cdp(tabId, method, params);
  for (let i = 0; i < 60; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const now = await evaluate(tabId, '[performance.timeOrigin, document.readyState, location.href]').catch(() => null);
    if (now && (now[0] !== before || now[2] === url) && now[1] === 'complete') break;
  }
}

async function goThroughHistory(tabId, step) {
  const { currentIndex, entries } = await cdp(tabId, 'Page.getNavigationHistory');
  const entry = entries[currentIndex + step];
  if (!entry) throw new Error(`There is no page to go ${step < 0 ? 'back' : 'forward'} to`);
  await loadNewDocument(tabId, 'Page.navigateToHistoryEntry', { entryId: entry.id }, entry.url);
  return evaluate(tabId, '({ url: location.href, title: document.title })');
}

// Through the prototype's setter, which frameworks such as React watch, then the events a person's
// edit fires.
const SET_VALUE = `function (value) {
  let el = this.nodeType === 1 ? this : this.parentElement;
  if (el instanceof HTMLLabelElement && el.control) el = el.control;
  if (el instanceof HTMLOptionElement && el.closest('select')) {
    value = el.value;
    el = el.closest('select');
  }
  if (el.disabled) return { error: 'It is disabled' };
  const fire = () => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  if (el instanceof HTMLSelectElement) {
    const options = [...el.options];
    const wanted = (Array.isArray(value) ? value : [value]).map(String);
    const chosen = wanted.map((w) => options.find((o) => o.value === w) ?? options.find((o) => o.text.trim() === w.trim()));
    const missing = wanted.filter((_, i) => !chosen[i]);
    if (missing.length) return { error: 'No option ' + missing.join(', ') + '; the options are ' + options.map((o) => o.text.trim()).slice(0, 50).join(', ') };
    if (chosen.length > 1 && !el.multiple) return { error: 'This select takes one option' };
    for (const o of options) o.selected = chosen.includes(o);
    fire();
    return { selected: chosen.map((o) => o.text.trim()) };
  }
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    const on = value === true || value === 'true' || value === 'on';
    if (!on && el.type === 'radio') return { error: 'A radio button is unchecked by choosing another one' };
    // click() toggles it and fires click, input and change, as a person's click does.
    if (el.checked !== on) el.click();
    if (el.checked !== on) return { error: 'The page kept it ' + (el.checked ? 'checked' : 'unchecked') };
    return { checked: el.checked };
  }
  if (el instanceof HTMLInputElement && el.type === 'file') return { error: 'Use upload_file for a file input' };
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.focus();
    const kind = el instanceof HTMLInputElement ? HTMLInputElement : HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(kind.prototype, 'value').set.call(el, String(value));
    fire();
    return { value: el.value };
  }
  if (el.isContentEditable) {
    el.focus();
    getSelection().selectAllChildren(el);
    document.execCommand('insertText', false, String(value));
    return { text: el.innerText.slice(0, 200) };
  }
  return { error: el.tagName.toLowerCase() + ' is not a form control; open it with click, then click the option or use press_key' };
}`;

async function navigate(tabId, url) {
  await loadNewDocument(tabId, 'Page.navigate', { url });
  return evaluate(tabId, '({ url: location.href, title: document.title })');
}

const TOOLS = {
  // Every window, so a tab elsewhere can be found; active marks the one a call without tabId uses.
  async list_tabs({ query }) {
    const [tabs, [current]] = await Promise.all([chrome.tabs.query({}), chrome.tabs.query({ active: true, lastFocusedWindow: true })]);
    const needle = query?.toLowerCase();
    return tabs
      .filter((t) => !t.incognito && (!needle || `${t.title} ${t.url}`.toLowerCase().includes(needle)))
      .map(({ id, windowId, title, url }) => ({ id, windowId, title, url, active: id === current?.id }));
  },
  async read_page({ tabId, format = 'text', interactive = false, ref, maxChars }) {
    const { tab, host } = await targetTab(tabId, 'read_page');
    const limit = Math.min(Math.max(Math.round(maxChars) || 0, 0), READ_LIMIT) || undefined;
    if (format === 'tree') return { host, title: tab.title, url: tab.url, ...(await pageTree(tab.id, interactive, ref, limit ?? TREE_LIMIT)) };
    if (!ref) return { host, ...(await inPage(tab.id, readPage, [limit ?? TEXT_LIMIT])) };
    try {
      const element = await elementObject(tab.id, { ref });
      const read = 'function (limit) { return (this.innerText ?? this.textContent).slice(0, limit); }';
      return { host, title: tab.title, url: tab.url, text: (await callOn(tab.id, element, read, [limit ?? TEXT_LIMIT], true)).value };
    } finally {
      cdp(tab.id, 'Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => {});
    }
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
    const { allowAllSites, alwaysAllowedTools } = await settings();
    if (!tool.annotations?.readOnlyHint && !allowAllSites && !alwaysAllowedTools.includes(key)) {
      const choice = await requestApproval({
        kind: 'tool', tool: name, host, title: tab.title, windowId: tab.windowId, input: JSON.stringify(input ?? {}, null, 2),
      });
      if (choice === 'deny') throw new Error(`The user did not allow ${name} on ${host}`);
      if (choice === 'always') await addSetting('alwaysAllowedTools', key);
    }
    return { host, ...(await inPage(tab.id, runPageTool, [name, input ?? {}])) };
  },
  async screenshot({ tabId, region, scale }) {
    const { tab, host } = await targetTab(tabId, 'screenshot');
    return { host, ...(await screenshot(tab.id, { region, scale })) };
  },
  async run_script({ tabId, code }) {
    const { tab, host } = await targetTab(tabId, 'run_script');
    await approveAction(tab, host, 'run_script', `Let your agent run a script on ${host}?`, code);
    let result;
    try {
      result = await evaluate(tab.id, code);
    } catch (error) {
      // Agents often send a function body, and a REPL evaluation rejects its top-level return.
      if (!/Illegal return statement/.test(error.message)) throw error;
      result = await evaluate(tab.id, `await (async () => {\n${code}\n})()`);
    }
    return { host, result: result ?? null };
  },
  async click({ tabId, x, y, selector, ref, button = 'left', clickCount = 1, modifiers }) {
    if (!Object.hasOwn(BUTTONS, button)) throw new Error('button is left, right or middle');
    const count = Math.min(Math.max(Math.round(clickCount) || 1, 1), 3);
    const { tab, host } = await targetTab(tabId, 'click');
    await inFront(tab.id, 'click');
    const target = ref ?? selector;
    const verb = button === 'right' ? 'Right-click' : ['Click', 'Double-click', 'Triple-click'][count - 1];
    await approveAction(tab, host, 'control', `Let your agent use ${host}?`, target ? `${verb} ${target}` : `${verb} at ${x}, ${y}`);
    const point = await pointOf(tab.id, { ref, selector, x, y });
    const bits = modifierBits(modifiers);
    const press = () => clickAt(tab.id, point.x, point.y, { button, count, modifiers: bits });
    // On a Mac, a click with Control held is a right click.
    if (button !== 'right' && !(bits & MODIFIERS.Control)) {
      await press();
      return { host, clicked: point };
    }
    return { host, clicked: point, pageMenu: await withoutBrowserMenu(tab.id, press) };
  },
  async hover({ tabId, x, y, selector, ref }) {
    const { tab, host } = await targetTab(tabId, 'hover');
    await inFront(tab.id, 'hover');
    await approveAction(tab, host, 'control', `Let your agent use ${host}?`, `Point at ${ref ?? selector ?? `${x}, ${y}`}`);
    const point = await pointOf(tab.id, { ref, selector, x, y });
    await input(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    return { host, hovered: point };
  },
  async set_value({ tabId, ref, selector, value }) {
    if (!ref && !selector) throw new Error('set_value needs a ref or a selector');
    if (value === undefined) throw new Error('set_value needs a value');
    const { tab, host } = await targetTab(tabId, 'set_value');
    await approveAction(tab, host, 'control', `Let your agent use ${host}?`, `Set ${ref ?? selector} to ${JSON.stringify(value)}`);
    try {
      const element = await elementObject(tab.id, { ref, selector });
      const result = (await callOn(tab.id, element, SET_VALUE, [value], true)).value;
      if (result.error) throw new Error(result.error);
      return { host, ...result };
    } finally {
      cdp(tab.id, 'Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => {});
    }
  },
  // The size asked for is the page's; the window adds the toolbar and any side panel around it.
  async resize_window({ tabId, width, height }) {
    const { tab, host } = await targetTab(tabId, 'resize_window');
    if (!(width >= 200 && height >= 200)) throw new Error('width and height have to be at least 200');
    await approveAction(tab, host, 'control', `Let your agent use ${host}?`, `Resize the window so the page is ${width} by ${height}`);
    if ((await chrome.windows.get(tab.windowId)).state !== 'normal') {
      await chrome.windows.update(tab.windowId, { state: 'normal' });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    // A second pass corrects for a toolbar or panel that changed size along with the window.
    for (let i = 0; i < 2; i++) {
      const win = await chrome.windows.get(tab.windowId);
      const [w, h] = await evaluate(tab.id, '[innerWidth, innerHeight]');
      if (w === width && h === height) break;
      await chrome.windows.update(tab.windowId, { width: win.width + Math.round(width - w), height: win.height + Math.round(height - h) });
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const [w, h] = await evaluate(tab.id, '[innerWidth, innerHeight]');
    const win = await chrome.windows.get(tab.windowId);
    return {
      host,
      page: { width: w, height: h },
      window: { width: win.width, height: win.height },
      ...((w !== width || h !== height) && { note: 'The window could not reach that size; the screen or its smallest size limits it' }),
    };
  },
  async drag({ tabId, from, to, steps = 12, modifiers }) {
    const { tab, host } = await targetTab(tabId, 'drag');
    await inFront(tab.id, 'drag');
    const name = (place) => place?.ref ?? place?.selector ?? `${place?.x}, ${place?.y}`;
    await approveAction(tab, host, 'control', `Let your agent use ${host}?`, `Drag from ${name(from)} to ${name(to)}`);
    // Scrolling only when needed keeps the first place in view while the second is found.
    const start = await pointOf(tab.id, from, 'nearest');
    const end = await pointOf(tab.id, to, 'nearest');
    const moves = Math.min(Math.max(Math.round(steps) || 1, 1), 100);
    return { host, ...(await dragBetween(tab.id, start, end, moves, modifierBits(modifiers))) };
  },
  async upload_file({ tabId, ref, selector, x, y, files }) {
    const { tab, host } = await targetTab(tabId, 'upload_file');
    if (!Array.isArray(files) || !files.length) throw new Error('upload_file needs a list of files');
    const paths = files.filter((f) => f.path).map((f) => f.path);
    if (paths.length && paths.length < files.length) throw new Error('Pass either paths or contents (url, text, base64), not both');
    const names = paths.length ? paths : files.map((f) => f.name ?? f.url ?? 'a file');
    // A path can be any file on this Mac, and the page can send it anywhere.
    if (paths.length) {
      await approveAction(tab, host, 'upload_file', `Let your agent upload files from this Mac to ${host}?`, paths.join('\n'), true);
    } else {
      await approveAction(tab, host, 'control', `Let your agent use ${host}?`, `Upload ${names.join(', ')}`);
    }
    const contents = paths.length ? null : await fileContents(files);
    try {
      const target = await elementObject(tab.id, { ref, selector, x, y });
      const fileInput = (await callOn(tab.id, target, FIND_FILE_INPUT)).objectId;
      if (fileInput) {
        if (files.length > 1 && !(await callOn(tab.id, fileInput, 'function () { return this.multiple; }', [], true)).value) {
          throw new Error('This file input takes one file');
        }
        if (paths.length) await cdp(tab.id, 'DOM.setFileInputFiles', { files: paths, objectId: fileInput });
        else await callOn(tab.id, fileInput, PUT_FILES, [contents, false]);
        return { host, uploaded: names, into: 'file input' };
      }
      if (paths.length) throw new Error('A path goes into a file input, and there is none here; to drop a file on this element, pass its content (url or base64) instead');
      if (!(await callOn(tab.id, target, PUT_FILES, [contents, true], true)).value) {
        throw new Error('Nothing took the drop: name a file input, or an element that takes dropped files');
      }
      return { host, uploaded: names, into: 'drop' };
    } finally {
      cdp(tab.id, 'Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => {});
    }
  },
  async type_text({ tabId, text, selector, ref }) {
    const { tab, host } = await targetTab(tabId, 'type_text');
    await inFront(tab.id, 'type_text');
    const target = ref ?? selector;
    await approveAction(tab, host, 'control', `Let your agent use ${host}?`, `Type "${text}"${target ? ` into ${target}` : ''}`);
    if (target) {
      const point = ref ? await refPoint(tab.id, ref) : await center(tab.id, selector);
      await clickAt(tab.id, point.x, point.y);
    }
    await input(tab.id, 'Input.insertText', { text });
    return { host, typed: text.length };
  },
  async press_key({ tabId, key, modifiers, repeat = 1 }) {
    const parsed = parseKey(String(key ?? ''), modifiers);
    if (!parsed.key) throw new Error('press_key needs a key');
    const times = Math.min(Math.max(Math.round(repeat) || 1, 1), 100);
    const { tab, host } = await targetTab(tabId, 'press_key');
    await inFront(tab.id, 'press_key');
    const name = [...parsed.modifiers, parsed.key === ' ' ? 'Space' : parsed.key].join('+');
    await approveAction(tab, host, 'control', `Let your agent use ${host}?`, `Press ${name}${times > 1 ? ` ${times} times` : ''}`);
    for (let i = 0; i < times; i++) await pressKey(tab.id, parsed.key, parsed.modifiers);
    return { host, pressed: name, ...(times > 1 && { times }) };
  },
  async scroll({ tabId, x, y, ref, deltaX = 0, deltaY = 0 }) {
    const { tab, host } = await targetTab(tabId, 'scroll');
    await inFront(tab.id, 'scroll');
    await approveAction(tab, host, 'control', `Let your agent use ${host}?`, `Scroll by ${deltaX}, ${deltaY}${ref ? ` over ${ref}` : ''}`);
    const middle = await evaluate(tab.id, '({ x: innerWidth / 2, y: innerHeight / 2 })');
    const at = ref ? await refPoint(tab.id, ref) : { x: x ?? middle.x, y: y ?? middle.y };
    await input(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX, deltaY });
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { host, scroll: await evaluate(tab.id, '({ x: scrollX, y: scrollY })') };
  },
  async navigate({ tabId, url }) {
    const { tab, host } = await targetTab(tabId, 'navigate');
    const step = { back: -1, forward: 1 }[url];
    await approveAction(tab, host, 'control', `Let your agent use ${host}?`, step ? `Go ${url}` : `Open ${url}`);
    return { host, ...(await (step ? goThroughHistory(tab.id, step) : navigate(tab.id, url))) };
  },
  // In the background by default, so the agent works without taking over the page the user is on.
  async open_tab({ url, active = false }) {
    const target = URL.parse(url);
    if (target?.protocol !== 'https:' && target?.protocol !== 'http:') throw new Error('Talk to Shy can only open web pages');
    const host = target.hostname;
    const focused = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    const window = focused.incognito
      ? (await chrome.windows.getAll({ windowTypes: ['normal'] })).find((w) => !w.incognito)
      : focused;
    if (!window) throw new Error('Open a regular Shy window first; Talk to Shy does not use incognito windows');
    await approveAction({ title: url, windowId: window.id }, host, 'control', `Let your agent use ${host}?`, `Open ${url} in a new tab`);
    const created = await chrome.tabs.create({ url, active, windowId: window.id });
    for (let i = 0; i < 60 && (await chrome.tabs.get(created.id)).status !== 'complete'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const { id, windowId, title, url: loaded } = await chrome.tabs.get(created.id);
    return { host, id, windowId, title, url: loaded };
  },
  async close_tab({ tabId }) {
    if (tabId === undefined) throw new Error('close_tab needs a tabId from list_tabs');
    const tab = await chrome.tabs.get(tabId);
    if (tab.incognito) throw new Error(INCOGNITO);
    const host = URL.parse(tab.url)?.hostname ?? '';
    await approveAction(tab, host, 'control', `Let your agent use ${host}?`, `Close "${tab.title}"`);
    await chrome.tabs.remove(tabId);
    return { host, closed: tabId, title: tab.title };
  },
  async network_requests({ tabId, reload, failedOnly, filter, limit = 100 }) {
    const { tab, host } = await targetTab(tabId, 'network_requests');
    let started = await attach(tab.id);
    if (reload) {
      await approveAction(tab, host, 'control', `Let your agent use ${host}?`, 'Reload the page');
      networks.set(tab.id, { since: Date.now(), requests: new Map() });
      await loadNewDocument(tab.id, 'Page.reload', { ignoreCache: true });
      // Requests the page starts once loaded would otherwise be missing.
      await new Promise((resolve) => setTimeout(resolve, 500));
      started = false;
    }
    const log = networks.get(tab.id);
    let list = [...log.requests.values()];
    if (failedOnly) list = list.filter((r) => r.failed || r.blocked || r.status >= 400);
    if (filter) list = list.filter((r) => r.url.includes(filter));
    return {
      host,
      recordingSince: new Date(log.since).toISOString(),
      ...(started && { note: 'Recording started just now, so earlier requests were not seen. Pass reload: true to record the page loading.' }),
      total: log.requests.size,
      requests: list.slice(-limit).map(requestSummary),
    };
  },
  async console_messages({ tabId, reload, errorsOnly, pattern, limit = 100 }) {
    const { tab, host } = await targetTab(tabId, 'console_messages');
    await attach(tab.id);
    if (reload) {
      await approveAction(tab, host, 'control', `Let your agent use ${host}?`, 'Reload the page');
      consoles.set(tab.id, { since: Date.now(), messages: [] });
      await loadNewDocument(tab.id, 'Page.reload', { ignoreCache: true });
      // Messages the page logs once loaded would otherwise be missing.
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const log = consoles.get(tab.id);
    let list = log.messages;
    if (errorsOnly) list = list.filter((m) => m.level === 'error');
    if (pattern) {
      const match = new RegExp(pattern, 'i');
      list = list.filter((m) => match.test(m.text) || match.test(m.source ?? ''));
    }
    return {
      host,
      recordingSince: new Date(log.since).toISOString(),
      total: log.messages.length,
      messages: list.slice(-limit).map(({ at, ...m }) => ({ time: new Date(at).toISOString(), ...m })),
    };
  },
  async network_request({ tabId, requestId, body }) {
    const { tab, host } = await targetTab(tabId, 'network_request');
    const r = networks.get(tab.id)?.requests.get(requestId);
    if (!r) throw new Error(`This tab has no recorded request ${requestId}; list them with network_requests`);
    const detail = {
      host, ...requestSummary(r), statusText: r.statusText, mimeType: r.mimeType,
      requestHeaders: redact(r.requestHeaders), ...(r.postData && { postData: clip(r.postData, 4000) }),
      responseHeaders: redact(r.responseHeaders),
    };
    if (body) {
      try {
        const { body: data, base64Encoded } = await cdp(tab.id, 'Network.getResponseBody', { requestId });
        detail.body = base64Encoded ? `(binary, about ${Math.round((data.length * 3) / 4)} bytes)` : clip(data, 20000);
      } catch (error) {
        // The browser drops bodies after a while or a navigation.
        detail.body = null;
        detail.bodyError = error.message;
      }
    }
    return detail;
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
  else if (message.type === 'chat-send') sendChat(message.text, message.files);
  else if (message.type === 'chat-note') note(message.text);
  else if (message.type === 'chat-new') newChat();
});
// A service worker stopped while the relay was down has nothing left to wake it.
chrome.alarms.create('reconnect', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => connect());
connect();
