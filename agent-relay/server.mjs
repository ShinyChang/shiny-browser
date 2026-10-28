// Shy's Talk to Shy extension can only open connections, so agents reach it
// through this relay: MCP over HTTP for agents, a WebSocket for the extension.
// The panel's chat goes to a Slack thread when SLACK_CHANNEL is set and a Slack user token is
// in SLACK_TOKEN_FILE; otherwise an OpenAB agent can connect to /gateway to chat.
//
//   PORT=8796 TOKEN_FILE=~/.config/shy/token node server.mjs
//   SLACK_CHANNEL=C0123 SLACK_AGENT=U0456 SLACK_AGENT_NAME=fugu node server.mjs
//
// Agents send the token as a bearer token, OpenAB as ?token=, and the extension in its first message.
// Publish /extension (through a Cloudflare Tunnel, say); keep /gateway local, and /mcp too unless
// something like Cloudflare Access guards it.
import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { slackChat } from './slack.mjs';

const PORT = Number(process.env.PORT ?? 8796);
// cloudflared and OrbStack containers (through host.docker.internal) both reach loopback.
const HOST = process.env.HOST ?? '127.0.0.1';
const TOKEN = readFileSync(process.env.TOKEN_FILE ?? `${process.env.HOME}/.config/shy/token`, 'utf8').trim();
// Long enough for the user to answer an approval in Shy, which gives up after 150 seconds.
const CALL_TIMEOUT_MS = 180000;
const PROTOCOL_VERSION = '2025-06-18';
// Two pings at the extension's 20-second interval, so a live browser is never taken for a dead one.
const STALE_MS = 45000;
// The platform name the agent's [gateway] config uses; it keys the agent's sessions.
const PLATFORM = process.env.GATEWAY_PLATFORM ?? 'shy';
// Replies that arrive while Shy is away wait here for it to come back.
const OUTBOX_SIZE = 100;

const tabId = { type: 'integer', description: 'A tab id from list_tabs. Leave it out to use the tab the user is looking at.' };
const TOOLS = [
  {
    name: 'list_tabs',
    description: "Lists the tabs in every Shy window (incognito excluded) with their ids, window ids, titles and URLs, marking as active the one the user is looking at.",
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Keeps only tabs whose title or URL contains this, ignoring case.' } } },
  },
  {
    name: 'read_page',
    description: 'Returns the title, URL and visible text of a tab. On a site the user has not allowed yet, it waits until they allow it in Shy.',
    inputSchema: { type: 'object', properties: { tabId } },
  },
  {
    name: 'list_webmcp_tools',
    description: 'Lists the WebMCP tools a page offers, with their input schemas and whether they only read.',
    inputSchema: { type: 'object', properties: { tabId } },
  },
  {
    name: 'call_webmcp_tool',
    description: 'Runs one of the WebMCP tools a page offers and returns its output. If the user turned off "Use and drive any site without asking" in Shy, a tool that changes the page waits until they allow it, and fails if they decline or do not answer within about two minutes.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        name: { type: 'string', description: 'The tool name from list_webmcp_tools.' },
        input: { type: 'object', description: "The tool's input, matching its input schema." },
      },
      required: ['name'],
    },
  },
  {
    name: 'screenshot',
    description: 'Returns an image of what a tab shows right now (its visible area, in CSS pixels, so a point in the image is a point click takes).',
    inputSchema: { type: 'object', properties: { tabId } },
  },
  {
    name: 'run_script',
    description: "Runs JavaScript in the page and returns its result: the value of the last expression, awaited if it is a promise, so return plain data. Top-level await works. A function body with a top-level return also works. It is not limited by the page's CSP.",
    inputSchema: {
      type: 'object',
      properties: { tabId, code: { type: 'string', description: 'The JavaScript to run.' } },
      required: ['code'],
    },
  },
  {
    name: 'click',
    description: 'Clicks with real mouse events, at a point (CSS pixels, as in screenshot) or at the middle of the first element a CSS selector matches, scrolled into view. Prefer a selector: it survives scrolling and layout changes.',
    inputSchema: {
      type: 'object',
      properties: { tabId, x: { type: 'number' }, y: { type: 'number' }, selector: { type: 'string', description: 'Clicks this element instead of a point.' } },
    },
  },
  {
    name: 'type_text',
    description: 'Types text, as if pasted from a keyboard, into the focused element, or into the element a CSS selector matches after clicking it.',
    inputSchema: {
      type: 'object',
      properties: { tabId, text: { type: 'string' }, selector: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'press_key',
    description: 'Presses one key, such as Enter, Escape, Tab, Backspace, ArrowDown or a character, with optional modifiers.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        key: { type: 'string' },
        modifiers: { type: 'array', items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] } },
      },
      required: ['key'],
    },
  },
  {
    name: 'scroll',
    description: 'Scrolls with the mouse wheel at a point (the middle of the view if left out) and returns the new scroll position.',
    inputSchema: {
      type: 'object',
      properties: { tabId, x: { type: 'number' }, y: { type: 'number' }, deltaX: { type: 'number' }, deltaY: { type: 'number' } },
    },
  },
  {
    name: 'navigate',
    description: 'Opens a URL in the tab and waits for the page to load.',
    inputSchema: { type: 'object', properties: { tabId, url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'open_tab',
    description: "Opens a URL in a new tab in the user's window, in the background unless active is true, waits for it to load and returns its tab id.",
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, active: { type: 'boolean', description: 'Shows the new tab to the user.' } }, required: ['url'] },
  },
  {
    name: 'close_tab',
    description: 'Closes a tab.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'integer', description: 'A tab id from list_tabs or open_tab.' } }, required: ['tabId'] },
  },
  {
    name: 'network_requests',
    description: "Lists a tab's network requests as the browser's debugger records them, oldest first: method, URL, type, status, time in ms, size, and for a request that never got a response why it failed (DNS, connection, CORS, blocked, canceled). Recording starts the first time any tool that drives or captures the tab (screenshot, run_script, click, ...) or this one touches it; reload: true clears the list and reloads the page to record its whole load.",
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        reload: { type: 'boolean', description: 'Clear the list and reload the page first.' },
        failedOnly: { type: 'boolean', description: 'Only requests that failed or got a 4xx or 5xx status.' },
        filter: { type: 'string', description: 'Only URLs containing this text.' },
        limit: { type: 'integer', description: 'How many of the newest to return. Defaults to 100.' },
      },
    },
  },
  {
    name: 'network_request',
    description: 'Returns one request from network_requests in full: request and response headers (cookies, authorization and API keys are hidden), posted data, and with body: true the response body (text up to 20,000 characters, while the browser still keeps it).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        requestId: { type: 'string', description: 'The id from network_requests.' },
        body: { type: 'boolean', description: 'Also return the response body.' },
      },
      required: ['requestId'],
    },
  },
];

function isToken(value) {
  const given = Buffer.from(String(value ?? ''));
  const expected = Buffer.from(TOKEN);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

let extension = null;
let gateway = null;
let nextCallId = 1;
const pending = new Map();
const outbox = [];

function toExtension(message) {
  if (extension) return extension.send(JSON.stringify(message));
  outbox.push(message);
  outbox.splice(0, outbox.length - OUTBOX_SIZE);
}

const CONFIG_DIR = `${process.env.HOME}/.config/shy`;
const slack = process.env.SLACK_CHANNEL && process.env.SLACK_AGENT
  ? slackChat({
    tokenFile: process.env.SLACK_TOKEN_FILE ?? `${CONFIG_DIR}/slack-user-token`,
    threadsFile: process.env.SLACK_THREADS_FILE ?? `${CONFIG_DIR}/slack-threads.json`,
    channel: process.env.SLACK_CHANNEL,
    agent: process.env.SLACK_AGENT,
    agentName: process.env.SLACK_AGENT_NAME,
    send: toExtension,
  })
  : null;

// Pieces of files the extension is sending, by upload id, until the chat message that uses them.
const uploads = new Map();

async function chat(message) {
  const files = (message.files ?? []).map(({ upload, name, type }) => {
    const data = Buffer.from((uploads.get(upload) ?? []).join(''), 'base64');
    uploads.delete(upload);
    return { name, type, data };
  });
  if (slack && (await slack.enabled())) return slack.chat({ ...message, files });
  if (files.length) {
    toExtension({ type: 'chat-error', conversation: message.conversation, text: 'Files can only be sent when the chat goes through Slack.' });
  }
  if (message.text) chatToGateway(message);
}

// A message the user typed in the panel, as an OpenAB gateway event.
function chatToGateway({ conversation, id, text }) {
  if (!gateway) {
    return toExtension({ type: 'chat-error', conversation, text: 'Your agent is not connected to Shy yet.' });
  }
  const channel = `shy-${conversation}`;
  gateway.send(JSON.stringify({
    schema: 'openab.gateway.event.v1',
    event_id: `evt_${randomUUID()}`,
    timestamp: new Date().toISOString(),
    platform: PLATFORM,
    event_type: 'message',
    // A private channel needs no @mention, and one channel per conversation gives it its own session.
    channel: { id: channel, type: 'private', thread_id: channel },
    sender: { id: 'shy-user', name: 'shy', display_name: process.env.SHY_USER_NAME ?? 'Shy user', is_bot: false },
    content: { type: 'text', text },
    mentions: [],
    message_id: id,
  }));
}

function respondToGateway(requestId, fields = {}) {
  if (!requestId) return;
  gateway?.send(JSON.stringify({
    schema: 'openab.gateway.response.v1',
    request_id: requestId,
    success: true,
    thread_id: null,
    message_id: null,
    error: null,
    ...fields,
  }));
}

function replyFromGateway(reply) {
  if (reply.schema !== 'openab.gateway.reply.v1') return;
  const conversation = reply.channel?.id?.replace(/^shy-/, '');
  const text = reply.content?.text ?? '';
  switch (reply.command ?? 'send') {
    case 'send': {
      // Streaming edits name the message by this id, so the agent needs it back.
      const messageId = `gw_${randomUUID()}`;
      respondToGateway(reply.request_id, { message_id: messageId });
      return toExtension({ type: 'chat-reply', conversation, messageId, text });
    }
    case 'edit_message':
      respondToGateway(reply.request_id);
      return toExtension({ type: 'chat-reply', conversation, messageId: reply.reply_to, text });
    case 'delete_message':
      return toExtension({ type: 'chat-delete', conversation, messageId: reply.reply_to });
    case 'add_reaction':
    case 'remove_reaction':
      return toExtension({
        type: 'chat-reaction', conversation, messageId: reply.reply_to, emoji: text, remove: reply.command === 'remove_reaction',
      });
    case 'create_topic':
      return respondToGateway(reply.request_id, { thread_id: reply.channel?.id });
    default:
      return respondToGateway(reply.request_id);
  }
}

function callExtension(tool, args) {
  if (!extension) {
    return Promise.reject(new Error('Shy is not connected. Open Shy and check its Talk to Shy panel.'));
  }
  const id = nextCallId++;
  extension.send(JSON.stringify({ type: 'call', id, tool, args }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Shy did not answer ${tool} within ${CALL_TIMEOUT_MS / 1000} seconds`));
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
  });
}

async function handleRpc({ id, method, params }) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'shy', version: '0.1.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      const { name, arguments: args } = params ?? {};
      if (!TOOLS.some((tool) => tool.name === name)) throw Object.assign(new Error(`Unknown tool ${name}`), { code: -32602 });
      try {
        const content = await callExtension(name, args ?? {});
        // A screenshot goes back as an image the agent can look at.
        if (content?.image) {
          const { image, ...rest } = content;
          return { content: [{ type: 'image', data: image.data, mimeType: image.mimeType }, { type: 'text', text: JSON.stringify(rest) }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(content, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: error.message }], isError: true };
      }
    }
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

function send(res, status, body) {
  res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, extension: Boolean(extension), gateway: Boolean(gateway), slack: Boolean(slack?.status()) });
  }
  if (req.url !== '/mcp') return send(res, 404, { error: 'not found' });
  if (!isToken(req.headers.authorization?.replace(/^Bearer /, ''))) return send(res, 401, { error: 'unauthorized' });
  // Responses come back on the POST itself, so there is no event stream to open.
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

  let message;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (message.id === undefined) return send(res, 202);
  try {
    send(res, 200, { jsonrpc: '2.0', id: message.id, result: await handleRpc(message) });
  } catch (error) {
    send(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: error.code ?? -32603, message: error.message } });
  }
});

const sockets = new WebSocketServer({ noServer: true });
const gateways = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://relay');
  if (url.pathname === '/extension') {
    return sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit('connection', ws));
  }
  if (url.pathname === '/gateway' && isToken(url.searchParams.get('token'))) {
    return gateways.handleUpgrade(req, socket, head, (ws) => gateways.emit('connection', ws));
  }
  socket.destroy();
});

gateways.on('connection', (ws) => {
  gateway?.close();
  gateway = ws;
  console.log(`${new Date().toISOString()} agent gateway connected`);
  ws.on('message', (data) => {
    try {
      replyFromGateway(JSON.parse(data.toString('utf8')));
    } catch (error) {
      console.log(`${new Date().toISOString()} bad gateway message: ${error.message}`);
    }
  });
  ws.on('close', () => {
    if (gateway !== ws) return;
    gateway = null;
    console.log(`${new Date().toISOString()} agent gateway disconnected`);
  });
});

sockets.on('connection', (ws) => {
  let authenticated = false;
  const helloTimer = setTimeout(() => ws.close(), 5000);
  ws.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (!authenticated) {
      clearTimeout(helloTimer);
      if (message.type !== 'hello' || !isToken(message.token)) {
        ws.send(JSON.stringify({ type: 'rejected', reason: 'wrong token' }));
        return ws.close();
      }
      // One browser at a time. The same browser reconnecting replaces its old socket, but another
      // one waits for this one to go quiet; otherwise the two would keep displacing each other.
      if (extension && extension.instance !== message.instance && Date.now() - extension.lastSeen < STALE_MS) {
        ws.send(JSON.stringify({ type: 'rejected', reason: 'another browser is connected' }));
        return ws.close();
      }
      authenticated = true;
      ws.instance = message.instance;
      ws.lastSeen = Date.now();
      extension?.close();
      extension = ws;
      ws.send(JSON.stringify({ type: 'welcome' }));
      for (const queued of outbox.splice(0)) ws.send(JSON.stringify(queued));
      console.log(`${new Date().toISOString()} Shy connected`);
      return;
    }
    ws.lastSeen = Date.now();
    if (message.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    } else if (message.type === 'result') {
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.ok) call.resolve(message.content);
      else call.reject(new Error(message.error));
    } else if (message.type === 'chat') {
      chat(message);
    } else if (message.type === 'chat-open') {
      slack?.open(message.conversation);
    } else if (message.type === 'chat-file') {
      if (!uploads.has(message.upload)) uploads.set(message.upload, []);
      uploads.get(message.upload).push(message.data);
    }
  });
  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (extension === ws) {
      extension = null;
      uploads.clear();
      slack?.close();
      console.log(`${new Date().toISOString()} Shy disconnected`);
    }
  });
});

server.listen(PORT, HOST, () => console.log(`shy relay on ${HOST}:${PORT}`));
