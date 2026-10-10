# hermes-inline-comments

Write comments on the lines of a text file, inside Hermes Desktop. Markdown gets
the Markdown renderer. Any other text file (code, logs, configuration, plain
text) gets a plain-text renderer. The plugin puts each comment into the composer
of the active session. The comments stay in the draft until you press Enter.

Not affiliated with Nous Research. Hermes Desktop is a Nous Research product.
This plugin is unofficial and nobody maintains it but its author.

Example draft:

```
TODO.md:
- L109-112: split this paragraph in two parts
- L18: add the source of this number

DESIGN.md:
- L41-43: rewire this before you add more content

/Users/you/.hermes/config.yaml:
- L12: this key needs a comment
```

A file inside the workspace appears with a path relative to the workspace root. A
file outside the workspace keeps the absolute path. The session runs in the
workspace root, so both forms resolve.

## Why this is a plugin

Hermes Desktop has a comment mode. That mode is for the in-app browser only. It
needs a webview, and it puts its controls into the shown page.

A `.md` file is not a web page. The app renders it with the React component
`MarkdownPreview`. That component is not a webview. Therefore the preview pane
shows no Annotate button for a `.md` file. The app makes this test
(`apps/desktop/src/app/chat/right-rail/preview-pane.tsx`):

```ts
const isWebPreview =
  target.kind !== 'artifact' &&
  (target.kind === 'url' || (target.previewKind === 'html' && renderMode !== 'source'))
```

A plugin cannot add the Annotate button to that pane. The preview browser bar is
not a contribution area. A plugin can render the document itself, and it can
annotate its own page. This plugin does that.

## Requirements

Hermes Desktop on macOS, Linux or Windows. The plugin targets the build
`v0.21.5+9145.g0240fa4`. It needs no build step and no dependency.

## Install

**From the app.** Do these steps:

1. Open **Capabilities → Plugins**.
2. Click **Install from Git**.
3. Enter `miziodel/hermes-inline-comments`.
4. Enable the new row.

The deep link opens the same dialog with the repository filled in:

```html
<a href="hermes://plugin/install?repo=miziodel/hermes-inline-comments&enable=1">Install in Hermes</a>
```

The dialog never installs on its own: you confirm the install. The `enable`
parameter applies to the agent half of a plugin, which this repository has none.

**By hand.** The desktop app loads `~/.hermes/desktop-plugins/<folder>/plugin.js`.
The plugin declares `id: 'hermes-inline-comments'`. Name the folder the same, and
a clone is sufficient:

```bash
git clone https://github.com/miziodel/hermes-inline-comments.git \
  ~/.hermes/desktop-plugins/hermes-inline-comments
```

A different folder name also works. The loader obeys the declared `id`. The folder
name only labels a load error, and the row in **Capabilities → Plugins** shows the
declared `name` (`Inline comments`). `git pull` in that folder is the update.

Then do: **⌘K → Reload desktop plugins**.

**Removal.** Open **Capabilities → Plugins** and click the trash button. The app
asks for a confirmation. After it, the app deletes the folder from
`desktop-plugins/` and unloads the plugin at once. A gateway restart is not
necessary.

**Two points about this repository.** The repository holds no `plugin.yaml`, no
`plugin.yml` and no `plugin.json`. Therefore it is a desktop-only plugin. Those
files describe the agent half, and this plugin has none.

- `hermes plugins doctor` **rejects** this repository: it finds no manifest.
- `hermes plugins install` **accepts** it, copies it into the agent plugin folder
  and prints only a warning. That copy does nothing.

Only the **Install from Git** dialog or the manual copy above gives a working
plugin. The install dialog looks for the desktop half at `<repo>/plugin.js` first
and at `<repo>/desktop/plugin.js` second (`desktop-plugin-install.ts`,
`findDesktopEntry`). This repository keeps the file at its root for that reason.

## Use

1. **Open the pane.** Click the pencil icon in the status bar (right side). The
   icon takes the accent colour while the pane is open. Click it again to hide
   the pane. The same command is in ⌘K: *Annotate a text file (show/hide the
   pane)*.
2. **Open a file.** The pane reopens the last file by itself. To change it, drag
   a file from the sidebar tree onto the pane, click **Open…**, or type a path in
   the path field. The plugin accepts Markdown, code, logs and plain text, and it
   refuses binary extensions before the read. A leading `~/` expands when the
   workspace is below your home directory.
3. **Write a comment.** Click a block of the document. You can also click one
   list item or one table row. Write the note. Click **Save comment (⌘↵)**.
4. **Check the range.** A comment gives the line or the line range of the file on
   disk. The plugin writes `data-md-line` and `data-md-end` on every rendered
   block, and on every line of a plain-text file. It reads these attributes when
   you click.
5. **Remove a comment.** Click `×` on the comment row. Click **Clear comments**
   to remove the complete block from the draft.
6. **Send the comments.** Press Enter in the composer. Or click **Send draft now**
   in the pane. The comment list then starts empty, because the batch has left.

The plugin rewrites the draft after each change. The write is idempotent: the
plugin removes every block that it wrote before, and it writes the new one. Your
own text around the block never changes. Comments from different files stay in one
stack, and they survive the closure of the pane.

Two behaviours are worth knowing:

- **After a send, the list restarts.** The plugin writes the remaining comments
  into an empty draft and says so.
- **A comment block that you edit by hand is reported.** The plugin cannot tell
  your text from its own, so it warns instead of guessing. Press **Clear comments**
  before you continue.

## Limits

- **The line reference can move.** A comment stores the path, the line range and
  your note. It does not store the text of the line in the draft. Edit the file
  above a comment and the range points elsewhere. This is an accepted compromise:
  the draft stays short and readable, which matters because the session receives
  it at every turn. The pane shows the captured text of the line next to the note,
  so you can check a comment before you send it. An automatic staleness check is
  not implemented.
- **No screenshot.** The plugin SDK gives no capture function for the app window.
  The comment mode of the in-app browser keeps that function for web pages.
- **No menu entry in the file tree.** The context menu of the file tree is
  hardcoded in the app, and it has no contribution area. Use the drag gesture.
- **16 MiB maximum.** The plugin reads the file with
  `window.hermesDesktop.readPluginSource`: a full read, no truncation, and a
  16 MiB cap. On a shell without that function the plugin falls back to the
  preview read `readFileText`, which truncates at 512 KiB. The pane shows a
  message in both cases.
- **Two windows share one comment list.** The list lives in the plugin storage of
  the app, which both windows read. The window that writes last wins. Work in one
  window at a time.
- **One point outside the SDK.** The plugin reads the file with
  `window.hermesDesktop.readPluginSource` (or `readFileText` on an older shell).
  These functions are IPC bridges of the app, not part of the curated `ctx.os`
  door. An app update can change or remove them without notice, and then the pane
  stops reading files. There is no support guarantee.

## Security

Install this plugin only if you accept what it does:

- **A desktop plugin runs with full app authority.** The loader of Hermes Desktop
  states this in its own source
  (`apps/desktop/src/contrib/runtime-loader.ts`: "this is NOT a capability
  boundary"). A plugin is third-party code in the renderer of the app.
- **The read is not sandboxed.** The plugin reads any regular file that your user
  account can read. The app refuses a fixed list of sensitive paths (SSH keys,
  credential stores, `.env`-like files) and rejects a read above the cap. It does
  not restrict a plugin to the workspace.
- **Your data leaves the machine.** The paths, the line ranges and your notes go
  into the draft, and the session sends them to the configured model provider.

## Development

The app loads `plugin.js` uncompiled. Do not build. Use only these imports:
`@hermes/plugin-sdk`, `react` and `react/jsx-runtime`.

Edit the file and save it. Then run **⌘K → Reload desktop plugins**.

- A failure of a pane appears in `$HERMES_HOME/logs/desktop.log` as
  `[error-boundary:contrib:hermes-inline-comments:<id>]`. Use that line for the
  diagnosis. A save does not always cause a render: if the pane is not shown, the
  log stays empty. Do not accept an empty log as a proof.
- **Run the test harness.** It loads the plugin outside the app, with stub modules
  for `@hermes/plugin-sdk`, `react` and `react/jsx-runtime`, and it needs no
  dependency and no install:

  ```bash
  node test/run.mjs
  ```

  The harness walks the returned `{type, props}` tree, calls the handlers, types
  into the inputs and compares the result with the value that reached
  `host.composer`. It finds import errors, property errors and handler errors in
  seconds. It also pins the behaviours that broke during development: the
  escaping of a hostile document, the block detection on a CRLF file, the
  idempotent draft, and the restart of the list after a send. Add a check for
  every defect you fix.

## Compatibility

This plugin targets Hermes Agent `v0.21.5+9145.g0240fa4`. It uses this SDK
surface: `PANES_AREA`, `STATUSBAR_AREAS`, `PALETTE_AREA`, `icons`,
`host.openWorkspace`, `host.revealPane`,
`host.composer.{getDraft,setDraft,submit}`, `ctx.storage` and
`ctx.os.pickOpenPath`. The file read uses `window.hermesDesktop.readPluginSource`
when present, with `readFileText` as the fallback.

On a build without `host.openWorkspace` the plugin falls back to a registered
pane and `revealPane`. That fallback can show the pane, but it cannot hide it.

## Contributing

Open an issue or a pull request on the repository.

## License

MIT. See [LICENSE](LICENSE).
