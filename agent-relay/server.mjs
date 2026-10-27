// Shy's Talk to Shy extension can only open connections, so agents reach it
// through this relay: MCP over HTTP for agents, a WebSocket for the extension.
// An OpenAB agent can also connect to /gateway, so the user can chat with it from the panel.
//
//   PORT=8796 TOKEN_FILE=~/.config/shy/token node server.mjs
//
// Agents send the token as a bearer token, OpenAB as ?token=, and the extension in its first message.
// Publish only /extension (through a Cloudflare Tunnel, say); /mcp and /gateway stay local.
import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';

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
    description: "Lists the tabs in the user's current Shy window with their ids, titles and URLs, marking the one the user is looking at.",
    inputSchema: { type: 'object', properties: {} },
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
    description: 'Runs one of the WebMCP tools a page offers and returns its output. Read-only tools run at once; a tool that changes the page waits until the user allows it in Shy, and fails if they decline or do not answer within about two minutes.',
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
    return send(res, 200, { ok: true, extension: Boolean(extension), gateway: Boolean(gateway) });
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
      chatToGateway(message);
    }
  });
  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (extension === ws) {
      extension = null;
      console.log(`${new Date().toISOString()} Shy disconnected`);
    }
  });
});

server.listen(PORT, HOST, () => console.log(`shy relay on ${HOST}:${PORT}`));
