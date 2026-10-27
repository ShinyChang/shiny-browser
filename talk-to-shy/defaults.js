export const DEFAULTS = {
  relayUrl: 'wss://shy.shinychang.net/extension',
  token: '',
  // When off, a site outside allowedHosts, and each kind of action on a site, wait for the user to allow them.
  allowAllSites: true,
  allowedHosts: ['creator.lottiefiles.com'],
  // "host tool" pairs the user chose to always allow without asking.
  alwaysAllowedTools: [],
};
