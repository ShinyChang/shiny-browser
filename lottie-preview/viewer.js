import { DotLottie } from './vendor/dotlottie-web.js';

DotLottie.setWasmUrl(new URL('vendor/dotlottie-player.wasm', import.meta.url).href);

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const scrub = $('scrub');
const embedded = location.hash === '#embedded';
const BACKGROUNDS = ['checker', 'light', 'dark'];

let player = null;
let source = null;
let scrubbing = false;
let resumeAfterScrub = false;

function stored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function showMessage(text, isError = false) {
  $('message').textContent = text;
  $('message').classList.toggle('error', isError);
  $('message').hidden = !text;
}

function setControlsEnabled(enabled) {
  for (const id of ['play', 'scrub']) $(id).disabled = !enabled;
}

function fail(text) {
  player?.destroy();
  player = null;
  canvas.hidden = true;
  setControlsEnabled(false);
  showMessage(text, true);
}

function nameFromUrl(url) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : url;
  } catch {
    return url;
  }
}

function isZip(buffer) {
  const head = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
  return head[0] === 0x50 && head[1] === 0x4b;
}

// data is JSON text, or an ArrayBuffer holding either a .lottie zip or JSON bytes.
function open(name, data) {
  if (typeof data !== 'string' && !isZip(data)) data = new TextDecoder().decode(data);
  let json = null;
  if (typeof data === 'string') {
    try {
      json = JSON.parse(data);
    } catch {
      fail(`${name} is neither a .lottie file nor Lottie JSON.`);
      return;
    }
  }
  source = { name, data, json };
  document.title = name;
  $('name').textContent = name;
  $('meta').textContent = '';
  $('save').hidden = embedded;
  $('raw').hidden = !embedded;
  $('animation').hidden = true;
  $('theme').hidden = true;

  player?.destroy();
  showMessage('');
  canvas.hidden = false;
  const instance = new DotLottie({
    canvas,
    data,
    autoplay: true,
    loop: $('loop').getAttribute('aria-pressed') === 'true',
    speed: Number($('speed').value),
    renderConfig: { autoResize: true },
  });
  player = instance;
  player.addEventListener('load', onLoad);
  player.addEventListener('loadError', (event) => {
    if (player === instance) fail(`Could not play ${name}: ${event.error?.message ?? 'not a Lottie animation'}`);
  });
  // The core loads synchronously right after 'ready', but a damaged zip fails without a loadError event.
  player.addEventListener('ready', () => setTimeout(() => {
    if (player === instance && !instance.isLoaded) fail(`Could not play ${name}: the file looks damaged.`);
  }, 100));
  player.addEventListener('frame', onFrame);
  for (const type of ['load', 'play', 'pause', 'stop', 'complete']) player.addEventListener(type, syncPlaying);
}

function fillSelect(select, ids, current, emptyLabel) {
  const options = ids.map((id) => new Option(id, id));
  if (emptyLabel) options.unshift(new Option(emptyLabel, ''));
  select.replaceChildren(...options);
  select.value = current ?? '';
}

function onLoad() {
  const { width, height } = player.animationSize();
  if (width && height) canvas.style.setProperty('--ratio', `${width} / ${height}`);
  const frames = player.totalFrames;
  const seconds = player.duration;
  const parts = [`${width}×${height}`];
  if (seconds) parts.push(`${+(frames / seconds).toFixed(2)} fps`);
  parts.push(`${Math.round(frames)} frames`, `${seconds.toFixed(2)}s`);
  if (Array.isArray(source.json?.layers)) parts.push(`${source.json.layers.length} layers`);
  if (typeof source.json?.v === 'string') parts.push(`v${source.json.v}`);
  $('meta').textContent = parts.join(' · ');

  const manifest = player.manifest;
  const animations = (manifest?.animations ?? []).map((animation) => animation.id);
  fillSelect($('animation'), animations, player.activeAnimationId);
  $('animation').hidden = animations.length < 2;
  const themes = (manifest?.themes ?? []).map((theme) => theme.id);
  fillSelect($('theme'), themes, player.activeThemeId, 'No theme');
  $('theme').hidden = themes.length === 0;

  scrub.max = String(Math.max(0, Math.round(frames) - 1));
  setControlsEnabled(true);
  onFrame();
}

function onFrame() {
  if (!scrubbing) scrub.value = String(player.currentFrame);
  $('frame').textContent = `${Math.round(player.currentFrame)} / ${scrub.max}`;
}

function syncPlaying() {
  const playing = player?.isPlaying ?? false;
  $('play').classList.toggle('playing', playing);
  $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('play').title = `${playing ? 'Pause' : 'Play'} (Space)`;
}

function togglePlay() {
  if (!player) return;
  if (player.isPlaying) player.pause();
  else player.play();
}

function seek(frame) {
  if (!player) return;
  player.pause();
  player.setFrame(Math.min(Math.max(frame, 0), Number(scrub.max)));
  onFrame();
}

function setBackground(name) {
  canvas.dataset.background = name;
  $('background').title = `Background: ${name}`;
}

async function readUrl(url) {
  showMessage('Loading…');
  try {
    let buffer;
    if (url.startsWith('file:')) {
      // fetch() rejects file: URLs; XHR reads them when the extension has file access.
      buffer = await new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open('GET', url);
        request.responseType = 'arraybuffer';
        request.onload = () => (request.response ? resolve(request.response) : reject(new Error('empty response')));
        request.onerror = () => reject(new Error('the browser blocked reading this file'));
        request.send();
      });
    } else {
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      buffer = await response.arrayBuffer();
    }
    open(nameFromUrl(url), buffer);
  } catch (error) {
    fail(`Could not load ${url}: ${error.message}`);
  }
}

async function readFile(file) {
  open(file.name, await file.arrayBuffer());
}

// Keep focus off buttons after a mouse click so Space always means play/pause.
for (const button of document.querySelectorAll('button')) {
  button.addEventListener('mousedown', (event) => event.preventDefault());
}

$('play').addEventListener('click', togglePlay);

scrub.addEventListener('input', () => {
  if (!player) return;
  if (!scrubbing) {
    scrubbing = true;
    resumeAfterScrub = player.isPlaying;
    player.pause();
  }
  player.setFrame(Number(scrub.value));
  $('frame').textContent = `${scrub.value} / ${scrub.max}`;
});

scrub.addEventListener('change', () => {
  scrubbing = false;
  if (resumeAfterScrub) player?.play();
  resumeAfterScrub = false;
});

$('speed').addEventListener('change', () => player?.setSpeed(Number($('speed').value)));

$('loop').addEventListener('click', () => {
  const on = $('loop').getAttribute('aria-pressed') !== 'true';
  $('loop').setAttribute('aria-pressed', String(on));
  player?.setLoop(on);
});

$('background').addEventListener('click', () => {
  const next = BACKGROUNDS[(BACKGROUNDS.indexOf(canvas.dataset.background) + 1) % BACKGROUNDS.length];
  setBackground(next);
  store('background', next);
});

$('animation').addEventListener('change', () => player?.loadAnimation($('animation').value));

$('theme').addEventListener('change', () => {
  const id = $('theme').value;
  if (id) player?.setTheme(id);
  else player?.resetTheme();
});

$('open').addEventListener('click', () => $('file').click());

$('file').addEventListener('change', () => {
  const file = $('file').files[0];
  if (file) readFile(file);
  $('file').value = '';
});

$('save').addEventListener('click', () => {
  if (!source) return;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([source.data]));
  link.download = source.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

// A file: page has the opaque origin "null", which postMessage rejects as a target;
// the message carries no data, so any origin is safe.
$('raw').addEventListener('click', () => window.parent.postMessage({ type: 'lottie-preview:raw' }, '*'));

window.addEventListener('keydown', (event) => {
  if (!player || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target.closest('select')) return;
  const step = event.shiftKey ? 10 : 1;
  switch (event.key) {
    case ' ':
      if (event.target.closest('button')) return;
      togglePlay();
      break;
    case 'ArrowLeft':
      seek(Math.round(player.currentFrame) - step);
      break;
    case 'ArrowRight':
      seek(Math.round(player.currentFrame) + step);
      break;
    case 'Home':
      seek(0);
      break;
    case 'End':
      seek(Number(scrub.max));
      break;
    default:
      return;
  }
  event.preventDefault();
});

document.addEventListener('dragover', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  $('stage').classList.add('dragging');
});

document.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget) $('stage').classList.remove('dragging');
});

document.addEventListener('drop', (event) => {
  event.preventDefault();
  $('stage').classList.remove('dragging');
  const file = event.dataTransfer?.files[0];
  if (file) readFile(file);
});

const savedBackground = stored('background');
setBackground(BACKGROUNDS.includes(savedBackground) ? savedBackground : 'checker');

if (embedded) {
  showMessage('Loading…');
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.data?.type !== 'lottie-preview:json') return;
    open(nameFromUrl(event.data.url), event.data.text);
  });
} else if (location.hash.startsWith('#src=')) {
  // The redirect rule appends the original URL verbatim, so it may contain '&' and '#'.
  readUrl(location.hash.slice('#src='.length));
}
