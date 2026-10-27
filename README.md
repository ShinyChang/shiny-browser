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

## Build

Shiny is Chromium stable at the version in [CHROMIUM_VERSION](CHROMIUM_VERSION) plus the commits
in [patches/](patches), one per feature, compiled with [args.gn](args.gn). On a Mac with Xcode
and 45 GB free:

    git clone https://github.com/ShinyChang/shiny-browser
    shiny-browser/scripts/build.sh ~/shiny-chromium

The script fetches Chromium without its history, applies the patches and builds
`~/shiny-chromium/src/out/Release/Shiny.app`. On an M1 Max with `JOBS=8` the fetch took 12
minutes and the compile 2 hours 40 minutes. Running it again resumes an interrupted fetch or
build.

The build is ad-hoc signed, so macOS may ask again for keychain access or camera and microphone
permission after an update. `scripts/sign.sh Shiny.app IDENTITY` signs it with your own
code-signing identity instead.

## Updates

A daily GitHub Actions job compares Chrome stable for Mac with `CHROMIUM_VERSION` and opens a
`chrome-update` issue when a newer version ships. Shiny is then rebuilt on that version in a new
work directory, and `scripts/export-patches.sh` writes the rebased commits back to `patches/`,
`lottie-preview/` and `CHROMIUM_VERSION`. The issue is closed with that commit.

`scripts/publish-update.sh Shiny.app UPDATES_DIR` turns a build into a
[Sparkle](https://sparkle-project.org) update: it adds Sparkle, signs the app and writes the
archive and `appcast.xml` for any web server to serve. A copy installed from such an archive
checks the feed every four hours and offers to install newer builds. A build that was not
published this way never checks for updates.

Pages in the screenshots: [Wikipedia](https://en.wikipedia.org/wiki/Chromium_(web_browser))
(CC BY-SA 4.0) and [MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
(CC BY-SA 2.5).

Unofficial; not affiliated with Google or the Chromium project.
