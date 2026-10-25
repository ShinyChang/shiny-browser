// Chromium shows JSON documents as text in a <pre>; swap Lottie JSON for the player.
(() => {
  if (!/^(application|text)\/(json|plain|x-json)$/.test(document.contentType)) return;
  const pre = document.body?.querySelector(':scope > pre');
  if (!pre || document.body.children.length > 3) return;
  const text = pre.textContent;
  if (!text || text.length > 64 * 1024 * 1024 || text.trimStart()[0] !== '{') return;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return;
  }
  const isLottie = typeof data.v === 'string' && typeof data.fr === 'number' &&
    typeof data.ip === 'number' && typeof data.op === 'number' && Array.isArray(data.layers);
  if (!isLottie) return;

  const origin = new URL(chrome.runtime.getURL('')).origin;
  const frame = document.createElement('iframe');
  frame.src = chrome.runtime.getURL('viewer.html#embedded');
  frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483646';
  frame.addEventListener('load', () =>
    frame.contentWindow.postMessage({ type: 'lottie-preview:json', text, url: location.href }, origin));

  const back = document.createElement('button');
  back.textContent = 'Show preview';
  back.hidden = true;
  back.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;font:13px system-ui;' +
    'padding:6px 12px;border-radius:8px;border:1px solid #8884;background:Canvas;color:CanvasText;cursor:pointer';
  back.addEventListener('click', () => {
    frame.hidden = false;
    back.hidden = true;
  });

  window.addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow || event.data?.type !== 'lottie-preview:raw') return;
    frame.hidden = true;
    back.hidden = false;
  });
  document.documentElement.append(frame, back);
})();
