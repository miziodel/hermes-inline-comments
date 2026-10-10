# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-10

First release. **Alpha**: the plugin is under heavy testing, and the behaviour
can still change. The right home for this function is the core of Hermes Desktop
(see the README).

### Added

- A pane that renders a text file and anchors every block to its source line:
  Markdown through a small Markdown renderer, every other text file through a
  plain-text renderer with one anchor per line.
- Comments that stack into the draft of the active session, grouped by file, in
  the format `<path>:` and `- Lx-y: note`.
- The pencil icon in the status bar, which shows and hides the pane. The same
  command is in the palette.
- A comment list that survives the closure of the pane and the reload of the app,
  and that reopens the last file on its own.
- A headless test harness (`node test/run.mjs`) with 13 checks and no dependency.

### Changed

- The draft shows a path relative to the workspace root for a file inside the
  workspace, and the absolute path for a file outside it.
- After a send, the comment list restarts, and the pane says so.
- The plugin name and every label are in English.

### Fixed

- **Draft**: a close and reopen of the pane duplicated the comment block. The
  plugin now keeps the blocks it wrote in its storage, and it removes all of them
  before it writes the new one.
- **Draft**: after a send, the already-sent comments came back at the next
  comment. The list now restarts when the draft is empty.
- **Draft**: a block edited by hand was duplicated in silence. The pane now
  reports it.
- **Rendering**: a CRLF file lost its lists, fences and quotes. A BOM hid the
  first heading. The renderer normalises both at the door.
- **Rendering**: an unterminated code fence claimed a line range past the end of
  the file.
- **State**: a comment list written by an older version crashed the pane. The
  list is validated at load.
- **State**: a note with a newline added a comment line to the draft. Control
  characters become spaces.
- **UI**: a comment on an inner line of a multi-line block showed no pin.
- **UI**: the block label showed only the first line.

### Security

- The renderer escaped `&`, `<` and `>` only. A Markdown file with a crafted link
  or image could close an attribute and inject an event handler into the app
  renderer. The escape now covers `"`, `'` and the backtick, `href` and `src`
  accept http(s), mailto, an anchor or a path only, and emphasis can no longer
  expand inside an attribute.

[0.1.0]: https://github.com/miziodel/hermes-inline-comments/releases/tag/v0.1.0
