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
    case 'click': return `Clicking ${args.ref ?? args.selector ?? `at ${args.x}, ${args.y}`}${on}`;
    case 'type_text': return `Typing${on}`;
    case 'press_key': return `Pressing ${args.key}${on}`;
    case 'scroll': return `Scrolling ${page}`;
    case 'navigate': return `Opening ${URL.parse(args.url)?.host ?? args.url}`;
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
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable', { maxTotalBufferSize: 20000000, maxResourceBufferSize: 5000000 });
  return true;
}

async function cdp(tabId, method, params = {}) {
  await attach(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}
chrome.debugger.onDetach.addListener(({ tabId }) => {
  attached.delete(tabId);
  networks.delete(tabId);
});

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
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

// One answer covers each kind of action on a site, so a run of clicks asks once.
async function approveAction(tab, host, key, question, detail) {
  const { allowAllSites, alwaysAllowedTools } = await settings();
  if (allowAllSites || alwaysAllowedTools.includes(`${host} ${key}`)) return;
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

async function screenshot(tabId) {
  const { cssVisualViewport: view } = await cdp(tabId, 'Page.getLayoutMetrics');
  // The capture comes at the display's pixel ratio; undoing it puts the image in CSS pixels, so a
  // point in it is a point click takes.
  const ratio = await evaluate(tabId, 'devicePixelRatio');
  const { data } = await cdp(tabId, 'Page.captureScreenshot', {
    format: 'jpeg',
    quality: 80,
    clip: { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight, scale: 1 / ratio },
  });
  return { image: { data, mimeType: 'image/jpeg' }, width: Math.round(view.clientWidth), height: Math.round(view.clientHeight) };
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

async function clickAt(tabId, x, y) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await input(tabId, 'Input.dispatchMouseEvent', {
      type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1,
    });
  }
}

async function center(tabId, selector) {
  const point = await evaluate(tabId, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const box = element.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);
  if (!point) throw new Error(`Nothing on the page matches ${selector}`);
  return point;
}

// A ref is the element's backend node id, which the renderer keeps for as long as the element
// lives, so refs need no state here and survive this worker being stopped.
async function refPoint(tabId, ref) {
  const backendNodeId = Number(/^e(\d+)$/.exec(ref ?? '')?.[1]);
  if (!backendNodeId) throw new Error(`${ref} is not a ref; read_page with format "tree" lists them`);
  const gone = new Error(`${ref} is no longer on the page; read the tree again`);
  const { object } = await cdp(tabId, 'DOM.resolveNode', { backendNodeId }).catch(() => { throw gone; });
  const { result } = await cdp(tabId, 'Runtime.callFunctionOn', {
    objectId: object.objectId,
    returnByValue: true,
    functionDeclaration: `function () {
      if (!this.isConnected) return false;
      (this.nodeType === 1 ? this : this.parentElement).scrollIntoView({ block: 'center', inline: 'center' });
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

const TREE_LIMIT = 30000;
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

function formatTree(nodes, interactive) {
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
      if (size + line.length > TREE_LIMIT) {
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
  walk(nodes.find((node) => !node.parentId), 0, '');
  return { tree: lines.join('\n'), cut };
}

async function pageTree(tabId, interactive) {
  const { nodes } = await cdp(tabId, 'Accessibility.getFullAXTree');
  // Reading the tree may leave accessibility on, which makes every later change to the page cost more.
  cdp(tabId, 'Accessibility.disable').catch(() => {});
  const { tree, cut } = formatTree(nodes, interactive);
  return {
    tree,
    ...(cut && { note: `The tree was cut at ${TREE_LIMIT.toLocaleString('en')} characters.${interactive ? '' : ' interactive: true lists only what can be clicked or typed into.'}` }),
  };
}

const KEY_CODES = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39,
  ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32,
};
const MODIFIERS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

async function pressKey(tabId, key, modifiers = []) {
  const bits = modifiers.reduce((sum, name) => sum | (MODIFIERS[name] ?? 0), 0);
  const single = [...key].length === 1;
  // With Control or Meta held, a letter is a shortcut rather than text.
  const text = key === 'Enter' ? '\r' : single && !(bits & (MODIFIERS.Control | MODIFIERS.Meta)) ? key : undefined;
  const event = { key, windowsVirtualKeyCode: KEY_CODES[key] ?? (single ? key.toUpperCase().charCodeAt(0) : 0), modifiers: bits };
  await input(tabId, 'Input.dispatchKeyEvent', { ...event, type: text ? 'keyDown' : 'rawKeyDown', ...(text && { text }) });
  await input(tabId, 'Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
}

async function loadNewDocument(tabId, method, params) {
  const before = await evaluate(tabId, 'performance.timeOrigin').catch(() => 0);
  await cdp(tabId, method, params);
  // A new document has a new time origin; until then readyState still describes the old one.
  for (let i = 0; i < 60; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const now = await evaluate(tabId, '[performance.timeOrigin, document.readyState]').catch(() => null);
    if (now && now[0] !== before && now[1] === 'complete') break;
  }
}

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
  async read_page({ tabId, format = 'text', interactive = false }) {
    const { tab, host } = await targetTab(tabId, 'read_page');
    if (format !== 'tree') return { host, ...(await inPage(tab.id, readPage, [50000])) };
    return { host, title: tab.title, url: tab.url, ...(await pageTree(tab.id, interactive)) };
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
  async screenshot({ tabId }) {
    const { tab, host } = await targetTab(tabId, 'screenshot');
    return { host, ...(await screenshot(tab.id)) };
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
  async click({ tabId, x, y, selector, ref }) {
    const { tab, host } = await targetTab(tabId, 'click');
    await inFront(tab.id, 'click');
    const target = ref ?? selector;
    await approveAction(tab, host, 'control', `Let your agent use ${host}?`, target ? `Click ${target}` : `Click at ${x}, ${y}`);
    const point = ref ? await refPoint(tab.id, ref) : selector ? await center(tab.id, selector) : { x, y };
    await clickAt(tab.id, point.x, point.y);
    return { host, clicked: point };
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
  async press_key({ tabId, key, modifiers }) {
    const { tab, host } = await targetTab(tabId, 'press_key');
    await inFront(tab.id, 'press_key');
    await approveAction(tab, host, 'control', `Let your agent use ${host}?`, `Press ${[...(modifiers ?? []), key].join('+')}`);
    await pressKey(tab.id, key, modifiers);
    return { host, pressed: key };
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
    await approveAction(tab, host, 'control', `Let your agent use ${host}?`, `Open ${url}`);
    return { host, ...(await navigate(tab.id, url)) };
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
