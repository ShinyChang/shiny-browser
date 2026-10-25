# shiny-browser

Shiny is a personal browser built from Chromium stable for macOS: one toolbar, no tab strip,
Cmd+T "Go to Anything", Cmd+Shift+P command palette, Ctrl+Tab in most-recently-used order.

This repository only tracks upstream releases. A daily GitHub Actions job compares Chrome
stable for Mac with `CHROMIUM_VERSION` and opens a `chrome-update` issue when a newer
version ships. The issue is closed once Shiny has been rebuilt on that version.

Unofficial; not affiliated with Google or the Chromium project.
