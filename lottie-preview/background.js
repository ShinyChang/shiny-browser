const VIEWER = chrome.runtime.getURL('viewer.html');

// Static rulesets are read from disk, and a component extension served from
// resources.pak has none, so the .lottie redirect is registered at runtime.
async function registerRedirect() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: { type: 'redirect', redirect: { regexSubstitution: `${VIEWER}#src=\\0` } },
      condition: { regexFilter: '^https?://[^?#]*\\.lottie(\\?[^#]*)?$', resourceTypes: ['main_frame'] },
    }],
  });
}

chrome.runtime.onInstalled.addListener(registerRedirect);
chrome.runtime.onStartup.addListener(registerRedirect);

// declarativeNetRequest never sees file: URLs, so a local .lottie opened in the
// browser arrives here as a download.
chrome.downloads.onCreated.addListener((item) => {
  const url = item.finalUrl || item.url;
  if (!url.startsWith('file:') || !/\.lottie$/i.test(new URL(url).pathname)) return;
  chrome.downloads.cancel(item.id, () => chrome.downloads.erase({ id: item.id }));
  chrome.tabs.create({ url: `${VIEWER}#src=${url}` });
});
