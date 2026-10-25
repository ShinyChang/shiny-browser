# shiny-browser

Shiny is a personal browser built from Chromium stable for macOS: one toolbar, no tab strip,
everything a keystroke away.

![Shiny showing a Wikipedia article: one toolbar, no tab strip](docs/screenshots/browse.webp)

## Features

### Go to Anything (Cmd+T)

Open tabs, history and recently closed tabs in one fuzzy-matched list. Anything else opens as a
URL or a search.

![Go to Anything matching "chrom" against open tabs and history](docs/screenshots/go-to-anything.webp)

### Command palette (Shift+Cmd+P)

Browser commands by name, each with its shortcut.

![Command palette filtered to the split commands](docs/screenshots/command-palette.webp)

### Ctrl+Tab in most-recently-used order

Tap Ctrl+Tab to flip between the last two tabs; hold Ctrl and keep pressing Tab to go further back.

![Ctrl+Tab list of tabs in most-recently-used order](docs/screenshots/ctrl-tab.webp)

### Split view with Ghostty's keys

| Keys | Action |
| --- | --- |
| Cmd+D / Shift+Cmd+D | Split right / split down |
| Cmd+Opt+arrows | Select the pane in that direction; with none, Left and Right switch to the previous or next tab |
| Cmd+Ctrl+arrows, Cmd+Ctrl+= | Move the divider, even it out |
| Cmd+W | Close the active pane |

Panes are drawn edge to edge, with no frame or gap between them. Cmd+T opens tabs, URLs and
history in the active pane.

![Wikipedia and MDN side by side in a split with no visible seam](docs/screenshots/split-view.webp)

### Lottie preview

Lottie JSON and .lottie files open in a built-in player: play and pause, frame-by-frame
scrubbing, speed, loop, backgrounds, and the themes and animations inside a .lottie. Its source
is in [lottie-preview/](lottie-preview), built on
[dotlottie-web](https://github.com/LottieFiles/dotlottie-web).

![The built-in Lottie player paused on a frame of a .lottie file](docs/screenshots/lottie-preview.webp)

### Also

- The last session reopens on launch.
- Background tabs left idle for 12 hours close themselves; pinned tabs stay.
- H.264 and AAC playback.

## Updates

A daily GitHub Actions job compares Chrome stable for Mac with `CHROMIUM_VERSION` and opens a
`chrome-update` issue when a newer version ships. The issue is closed once Shiny has been rebuilt
on that version. The Chromium patches themselves are not published here.

Pages in the screenshots: [Wikipedia](https://en.wikipedia.org/wiki/Chromium_(web_browser))
(CC BY-SA 4.0) and [MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
(CC BY-SA 2.5).

Unofficial; not affiliated with Google or the Chromium project.
