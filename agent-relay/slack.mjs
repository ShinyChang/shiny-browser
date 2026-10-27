// Talk to Shy chat through a Slack thread, so a conversation also lives in Slack and replies
// typed there show up in the panel. The panel's messages are posted as the user, with a user
// token, so Slack shows them under the user's name.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const API = process.env.SLACK_API ?? 'https://slack.com/api';
// conversations.replies allows about 50 calls a minute, so poll quickly only while a reply may
// still be coming.
const FAST_MS = 2000;
const SLOW_MS = 15000;
const FAST_FOR_MS = 120000;

const EMOJI = {
  eyes: '👀', white_check_mark: '✅', heavy_check_mark: '✔️', x: '❌', warning: '⚠️', '+1': '👍',
  thumbsup: '👍', hourglass_flowing_sand: '⏳', thinking_face: '🤔', tada: '🎉', fire: '🔥', heart: '❤️',
  rocket: '🚀', wave: '👋', pray: '🙏', ok_hand: '👌', point_left: '👈', saluting_face: '🫡',
  new_moon: '🌑', ok: '🆗', zap: '⚡', scream: '😱', 'male-technologist': '👨‍💻', technologist: '🧑‍💻',
  yawning_face: '🥱', fearful: '😨', no_entry_sign: '🚫', blush: '😊', sunglasses: '😎', nerd_face: '🤓', smirk: '😏',
  v: '✌️', muscle: '💪', mechanical_arm: '🦾', wrench: '🔧',
};

function loadJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

// Slack mrkdwn to the panel's small markdown, leaving code alone.
function fromSlack(text, names) {
  return text.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, index) => {
    const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    if (index % 2) return unescape(part);
    return unescape(part
      .replace(/<@(\w+)>/g, (_, id) => `@${names[id] ?? id}`)
      .replace(/<#\w+\|([^>]+)>/g, '#$1')
      .replace(/<!(here|channel|everyone)>/g, '@$1')
      .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '[$2]($1)')
      .replace(/<(https?:[^>]+)>/g, '$1')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1**$2**'));
  }).join('');
}

function inlineBlock(el, names) {
  switch (el.type) {
    case 'text': {
      if (el.style?.code) return `\`${el.text}\``;
      return el.style?.bold && el.text.trim() ? el.text.replace(/^(\s*)(.*?)(\s*)$/s, '$1**$2**$3') : el.text;
    }
    case 'link': return el.text ? `[${el.text}](${el.url})` : el.url;
    case 'emoji': return el.unicode ? String.fromCodePoint(...el.unicode.split('-').map((h) => parseInt(h, 16))) : EMOJI[el.name] ?? `:${el.name}:`;
    case 'user': return `@${names[el.user_id] ?? el.user_id}`;
    case 'channel': return `#${el.channel_id}`;
    case 'broadcast': return `@${el.range}`;
    default: return el.text ?? '';
  }
}

// Agents post their full reply as rich_text blocks and only a cut-down summary as text.
function fromBlocks(blocks, names) {
  const out = [];
  const line = (s) => { if (out.length && !out.at(-1).endsWith('\n')) out.push('\n'); out.push(s); };
  const inline = (els = []) => els.map((el) => inlineBlock(el, names)).join('');
  for (const block of blocks) {
    if (block.type === 'rich_text') {
      for (const part of block.elements ?? []) {
        if (part.type === 'rich_text_section') out.push(inline(part.elements));
        else if (part.type === 'rich_text_list') {
          part.elements.forEach((item, i) => line(`${'  '.repeat(part.indent ?? 0)}${part.style === 'ordered' ? `${(part.offset ?? 0) + i + 1}.` : '•'} ${inline(item.elements)}\n`));
        } else if (part.type === 'rich_text_quote') line(`${inline(part.elements).split('\n').map((l) => `> ${l}`).join('\n')}\n`);
        else if (part.type === 'rich_text_preformatted') line(`\`\`\`\n${inline(part.elements).replace(/\n$/, '')}\n\`\`\`\n`);
      }
    } else if (block.type === 'table') {
      // The panel has no tables, so each row becomes a line of cells.
      const cell = (c) => (c.type === 'raw_text' ? c.text : fromBlocks([c], names)).replace(/\s*\n\s*/g, ' ');
      block.rows.forEach((row, i) => line(`${row.map((c) => (i === 0 && cell(c) ? `**${cell(c)}**` : cell(c))).join(' | ')}\n`));
    } else if (block.type === 'markdown') {
      line(`${block.text}\n`);
    } else if (block.type === 'divider') {
      line('---\n');
    } else if (block.type === 'image') {
      line(`[${block.alt_text || 'image'}](${block.image_url})\n`);
    } else if (block.type === 'section' || block.type === 'header') {
      if (block.text?.text) line(`${block.type === 'header' ? `**${block.text.text}**` : fromSlack(block.text.text, names)}\n`);
    } else if (block.type === 'context') {
      line(`${block.elements.map((el) => (el.type === 'mrkdwn' ? fromSlack(el.text, names) : el.text ?? '')).join(' ')}\n`);
    }
  }
  return out.join('').replace(/\n+$/, '');
}

export function slackChat({ tokenFile, channel, agent, agentName = 'agent', threadsFile, send }) {
  const threads = loadJson(threadsFile);
  let token = null;
  let verified = false;
  let open = null;
  let timer = null;
  let fastUntil = 0;
  let last = '';
  // A poll that started before a post would show the thread without the posted message.
  let generation = 0;

  async function api(method, params) {
    const res = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: new URLSearchParams(params),
    });
    const body = await res.json();
    if (!body.ok) throw new Error(`Slack ${method} failed: ${body.error}`);
    return body;
  }

  // Slack's file URLs need the token, so images reach the panel as small data URLs.
  const thumbs = new Map();
  function fileView(f) {
    const view = { name: f.name ?? f.title ?? 'file', type: f.mimetype, link: f.permalink };
    // Thumbnails appear a little after an upload; until then the file shows by name.
    const source = f.mimetype?.startsWith('image/') && (f.thumb_360 ?? f.thumb_480);
    if (!source) return view;
    if (!thumbs.has(f.id)) {
      thumbs.set(f.id, fetch(source, { headers: { authorization: `Bearer ${token}` } })
        .then(async (res) => {
          const type = res.headers.get('content-type') ?? '';
          // Slack answers a token that cannot read files with a sign-in page.
          if (!res.ok || !type.startsWith('image/')) return null;
          return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
        })
        .catch(() => null));
      if (thumbs.size > 200) thumbs.delete(thumbs.keys().next().value);
    }
    return thumbs.get(f.id).then((url) => ({ ...view, url }));
  }

  async function postFiles(files, text, threadTs) {
    const uploaded = [];
    for (const file of files) {
      const { upload_url: url, file_id: id } = await api('files.getUploadURLExternal', { filename: file.name, length: file.data.length });
      const res = await fetch(url, { method: 'POST', body: file.data });
      if (!res.ok) throw new Error(`Slack did not take ${file.name}: HTTP ${res.status}`);
      uploaded.push({ id, title: file.name });
    }
    await api('files.completeUploadExternal', {
      files: JSON.stringify(uploaded),
      channel_id: channel,
      ...(text && { initial_comment: text }),
      ...(threadTs && { thread_ts: threadTs }),
    });
    // Slack shares the files in the background, and only then does their message have a timestamp.
    for (let i = 0; i < 20; i++) {
      const { file } = await api('files.info', { file: uploaded[0].id });
      const share = (file.shares?.private?.[channel] ?? file.shares?.public?.[channel])?.[0];
      if (share) return share.ts;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return null;
  }

  // The token can be added while the relay runs.
  async function ready() {
    if (!token) {
      if (!existsSync(tokenFile)) return false;
      token = readFileSync(tokenFile, 'utf8').trim();
    }
    if (!verified) {
      await api('auth.test', {});
      verified = true;
    }
    return true;
  }

  async function poll() {
    timer = null;
    const ts = threads[open];
    if (!ts) return;
    const conversation = open;
    const started = generation;
    try {
      const messages = [];
      let cursor;
      do {
        const page = await api('conversations.replies', { channel, ts, limit: 200, ...(cursor && { cursor }) });
        messages.push(...page.messages);
        cursor = page.response_metadata?.next_cursor;
      } while (cursor);
      if (started !== generation || conversation !== open) return;
      const names = { [agent]: agentName };
      const snapshot = await Promise.all(messages.map(async (m) => {
        const reaction = m.reactions?.at(-1)?.name;
        return {
          id: m.ts,
          // The person posts through this token, an earlier one or by hand in Slack, so only the agent's own posts are its side.
          role: m.user === agent ? 'agent' : 'user',
          text: (m.blocks?.length ? fromBlocks(m.blocks, names) : fromSlack(m.text ?? '', names)).replace(new RegExp(`^@${agentName}\\s*`), ''),
          reaction: reaction ? EMOJI[reaction] ?? `:${reaction}:` : null,
          files: await Promise.all((m.files ?? []).map(fileView)),
        };
      }));
      if (started !== generation || conversation !== open) return;
      const key = JSON.stringify(snapshot);
      if (key !== last) {
        last = key;
        send({ type: 'chat-thread', conversation, messages: snapshot });
        // A changed thread is often a reply still streaming in.
        fastUntil = Math.max(fastUntil, Date.now() + 30000);
      }
    } catch (error) {
      console.log(`${new Date().toISOString()} ${error.message}`);
    } finally {
      if (conversation === open && !timer) schedule();
    }
  }

  function schedule(delay = Date.now() < fastUntil ? FAST_MS : SLOW_MS) {
    clearTimeout(timer);
    timer = setTimeout(poll, delay);
  }

  return {
    async enabled() {
      try {
        return await ready();
      } catch (error) {
        console.log(`${new Date().toISOString()} ${error.message}`);
        return false;
      }
    },

    // The panel shows one conversation at a time; only its thread is followed.
    async open(conversation) {
      if (!(await this.enabled())) return;
      if (conversation !== open) last = '';
      open = conversation;
      schedule(0);
    },

    close() {
      clearTimeout(timer);
      timer = null;
      open = null;
    },

    async chat({ conversation, id, text, files = [] }) {
      try {
        if (!(await ready())) throw new Error('Talk to Shy has no Slack token yet.');
        const ts = threads[conversation];
        generation++;
        // An API post carries the app's bot_id, even with a user token, so the agent treats it as another bot's and answers only when mentioned.
        const body = `<@${agent}> ${text}`.trim();
        const posted = files.length
          ? await postFiles(files, body, ts)
          : (await api('chat.postMessage', { channel, text: body, ...(ts && { thread_ts: ts }) })).ts;
        if (!ts) {
          if (!posted) throw new Error('Slack took the files but did not say where it posted them.');
          threads[conversation] = posted;
          writeFileSync(threadsFile, JSON.stringify(threads));
        }
        send({ type: 'chat-sent', conversation, id, messageId: posted });
        open = conversation;
        fastUntil = Date.now() + FAST_FOR_MS;
        schedule(500);
      } catch (error) {
        send({ type: 'chat-error', conversation, text: error.message });
      }
    },

    status() {
      return Boolean(token);
    },
  };
}
