/**
 * hermes-inline-comments — annotate a text file (Markdown or plain text) line by
 * line inside the app;
 * the comments stack themselves into the draft of the active session, grouped
 * by file.
 *
 * Why it exists: the native comment mode only works on a webview
 * (`annotateGuest()` in apps/desktop/src/app/chat/right-rail/preview-pane.tsx
 * requires `webview.executeJavaScript`), and a `.md` is rendered by the React
 * component `MarkdownPreview` — never a webview — so it cannot be annotated.
 * This plugin renders the document itself, in a pane: Markdown through the
 * Markdown renderer, any other text file through a plain-text renderer where
 * every LINE carries its own anchor.
 *
 * Flow: open the pane with the pencil icon in the status bar (or ⌘K → "Annotate
 * a text file (show/hide the pane)", or by dragging a file from the tree),
 * then click a block → write the note → Save. Each comment goes INTO the draft
 * of the active session at once, in this format:
 *
 *     /path/to/file.md:
 *     - L109-112: what to change
 *     - L18: what to change
 *
 *     /path/to/other.md:
 *     - L41: what to change
 *
 * and stays there: you press Enter when you are done. The write goes through
 * `host.composer.setDraft` and is idempotent — it rewrites the block this
 * plugin wrote and leaves the text you typed around it untouched.
 *
 * Known limits, by design:
 *  - no screenshot per pin (the SDK exposes no renderer capture); a comment
 *    carries path, line range and note instead;
 *  - the read uses `window.hermesDesktop.readPluginSource` (full read, 16 MiB
 *    cap) when the shell offers it, and falls back to the preview read
 *    `readFileText` (512 KiB, truncating) — both are outside the curated
 *    `ctx.os` door, so this is the one unofficial reach-in;
 *  - binary extensions are refused before the read;
 *  - the file tree's context menu is hardcoded in the app (no contribution
 *    area), so opening "from the tree" is a DRAG onto the pane, not a menu row.
 */

import { atom, host, icons, PALETTE_AREA, PANES_AREA, STATUSBAR_AREAS, useValue } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const PANE_ID = 'hermes-inline-comments:pane'
const WORKSPACE_ID = 'hermes-inline-comments-annotate'
const STORE_ITEMS = 'items'
const STORE_BLOCKS = 'blocks'

/** Blocks of the draft this plugin wrote, kept so a later write can remove
 *  them. Persisted, not a ref: the pane can be closed and reopened (or the app
 *  reloaded) between two comments, and the old block must still be found. */
const MAX_WRITTEN_BLOCKS = 8

/** Open/closed: the pane is created on demand with `host.openWorkspace`, which
 *  returns its closer — that is what makes the toggle real (the SDK has no
 *  "hide pane" verb, only reveal/undismiss). */
const $paneOpen = atom(false)

// ---------------------------------------------------------------- markdown

const FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/
const HEAD_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const QUOTE_RE = /^\s*>\s?(.*)$/
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/
const TASK_RE = /^\[([ xX])\]\s+(.*)$/

/** Escape for BOTH text and attribute position. A document is not trusted
 *  input: without the quote escapes a link label can close an attribute and
 *  add an event handler of its own. */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;')
}

/** An href/src reaches the page only in these forms: http(s), mailto, an
 *  anchor, or a path. Every other scheme (`javascript:`, `data:`, `vbscript:`
 *  and the rest) is refused, and the link stays literal text. */
function safeUrl(raw) {
  const value = String(raw ?? '').replace(/[\u0000-\u0020]+/g, '')

  if (!value) {
    return null
  }
  if (/^(?:https?:|mailto:|#|\/|\.{1,2}\/)/i.test(value)) {
    return value
  }

  return /^[a-z][a-z0-9+.-]*:/i.test(value) ? null : value
}

/** Inline minimale: code, immagini, link, grassetto, corsivo, barrato. */
function inlineMd(text) {
  const stash = []
  const keep = fragment => {
    stash.push(fragment)

    return `\u0000${stash.length - 1}\u0000`
  }

  let out = String(text).replace(/`([^`]+)`/g, (m, code) => keep(`<code>${esc(code)}</code>`))
  out = esc(out)
  // Links and images go through `keep` too: the emphasis passes below must
  // never rewrite an attribute value (a `**` inside a URL would inject markup).
  out = out.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (m, alt, src) => {
      const url = safeUrl(src)

      return url ? keep(`<img src="${url}" alt="${alt}">`) : m
    }
  )
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (m, label, href) => {
      const url = safeUrl(href)

      return url ? keep(`<a href="${url}">${label}</a>`) : m
    }
  )
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, '<em>$1</em>')
  out = out.replace(/~~(.+?)~~/g, '<del>$1</del>')

  return out.replace(/\u0000(\d+)\u0000/g, (m, i) => stash[Number(i)] ?? '')
}

/** Join a paragraph BEFORE the inline pass: emphasis routinely spans a
 *  soft-wrapped line, and converting line by line leaves literal asterisks.
 *  Two trailing spaces are a hard break (\u0001 -> <br>). */
function paraHtml(lines) {
  let buf = ''

  lines.forEach((line, i) => {
    const hard = line.endsWith('  ')

    buf += hard ? line.slice(0, -2) : line
    if (i < lines.length - 1) {
      buf += hard ? '\u0001' : ' '
    }
  })

  return inlineMd(buf).replace(/\u0001/g, '<br>')
}

function renderList(items) {
  const parts = []
  const stack = []
  let liOpen = false

  for (const [indent, marker, text, lineno, endLine] of items) {
    const tag = /^\d/.test(marker) ? 'ol' : 'ul'

    while (stack.length && indent < stack[stack.length - 1][0]) {
      if (liOpen) {
        parts.push('</li>')
        liOpen = false
      }
      parts.push(`</${stack.pop()[1]}>`)
    }

    if (!stack.length || indent > stack[stack.length - 1][0]) {
      stack.push([indent, tag])
      parts.push(`<${tag}>`)
    } else {
      if (liOpen) {
        parts.push('</li>')
        liOpen = false
      }
      if (tag !== stack[stack.length - 1][1]) {
        parts.push(`</${stack.pop()[1]}>`)
        stack.push([indent, tag])
        parts.push(`<${tag}>`)
      }
    }

    const flat = text
      .split('\n')
      .map(part => part.trim())
      .join(' ')
    const task = TASK_RE.exec(flat)
    const inner = task
      ? `<input type="checkbox" disabled${task[1].toLowerCase() === 'x' ? ' checked' : ''}> ${inlineMd(task[2])}`
      : inlineMd(flat)

    parts.push(`<li data-md-line="${lineno}" data-md-end="${endLine ?? lineno}">${inner}`)
    liOpen = true
  }

  while (stack.length) {
    if (liOpen) {
      parts.push('</li>')
      liOpen = false
    }
    parts.push(`</${stack.pop()[1]}>`)
  }

  return parts.join('')
}

function renderTable(rows) {
  const head = []
  const body = []

  rows.forEach(([lineno, row], idx) => {
    if (idx === 1 && TABLE_SEP_RE.test(row)) {
      return
    }

    const cells = row
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map(cell => cell.trim())

    if (idx === 0) {
      head.push(`<tr>${cells.map(cell => `<th>${inlineMd(cell)}</th>`).join('')}</tr>`)

      return
    }

    body.push(
      `<tr data-md-line="${lineno}" data-md-end="${lineno}">${cells
        .map(cell => `<td>${inlineMd(cell)}</td>`)
        .join('')}</tr>`
    )
  })

  const thead = head.length
    ? `<thead><tr data-md-line="${rows[0][0]}">${head[0].replace(/^<tr>/, '').replace(/<\/tr>$/, '')}</tr></thead>`
    : ''

  return `<table data-md-line="${rows[0][0]}" data-md-end="${rows[rows.length - 1][0]}">${thead}<tbody>${body.join(
    ''
  )}</tbody></table>`
}

/**
 * Markdown source -> blocks that carry their own source line. Every leaf
 * element gets `data-md-line` and `data-md-end` (the line or line range in the
 * .md on disk), so a comment always points back to the file the user edits.
 */
export function mdBlocks(source) {
  // One normalisation, at the door: a BOM hides the first heading, and a `\r`
  // left by a CRLF file makes the fence/list/quote regexes miss (in JS `.`
  // never matches `\r`).
  let lines = String(source ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
  const blocks = []

  // YAML frontmatter: one block, lines 1..n.
  if (lines[0] !== undefined && lines[0].trim() === '---') {
    for (let j = 1; j < Math.min(lines.length, 40); j += 1) {
      if (lines[j].trim() === '---') {
        blocks.push({
          start: 1,
          end: j + 1,
          html: `<pre data-md-line="1" class="mdann-front">${esc(lines.slice(0, j + 1).join('\n'))}</pre>`
        })
        lines = lines.map((line, idx) => (idx <= j ? '' : line))
        break
      }
    }
  }

  let i = 0
  const n = lines.length

  while (i < n) {
    const raw = lines[i]

    if (!raw.trim()) {
      i += 1
      continue
    }

    const start = i + 1
    const fence = FENCE_RE.exec(raw)

    if (fence) {
      const closer = new RegExp(
        `^\\s*${fence[2][0] === '`' ? '`' : '~'}{${fence[2].length},}\\s*$`
      )
      const body = []

      i += 1
      while (i < n && !closer.test(lines[i])) {
        body.push(lines[i])
        i += 1
      }
      i += 1

      // An unterminated fence leaves `i` past the last line: clamp it, or the
      // block claims a line range the file does not have.
      const end = Math.min(i, n)

      blocks.push({
        start,
        end,
        html: `<pre data-md-line="${start}" data-md-end="${end}"><code>${esc(body.join('\n'))}</code></pre>`
      })
      continue
    }

    if (HR_RE.test(raw)) {
      i += 1
      blocks.push({ start, end: start, html: '<hr>' })
      continue
    }

    const head = HEAD_RE.exec(raw)

    if (head) {
      const level = head[1].length

      i += 1
      blocks.push({
        start,
        end: start,
        html: `<h${level} data-md-line="${start}" data-md-end="${start}">${inlineMd(head[2])}</h${level}>`
      })
      continue
    }

    if (QUOTE_RE.test(raw)) {
      const body = []

      while (i < n && lines[i].trim() && QUOTE_RE.test(lines[i])) {
        body.push(QUOTE_RE.exec(lines[i])[1])
        i += 1
      }

      const chunks = body.join('\n').split('\n\n').filter(chunk => chunk.trim())
      const inner = (chunks.length ? chunks : [''])
        .map(
          chunk =>
            `<p>${inlineMd(
              chunk
                .split('\n')
                .map(part => part.trim())
                .join(' ')
            )}</p>`
        )
        .join('')

      blocks.push({
        start,
        end: i,
        html: `<blockquote data-md-line="${start}" data-md-end="${i}">${inner}</blockquote>`
      })
      continue
    }

    if (raw.includes('|') && i + 1 < n && TABLE_SEP_RE.test(lines[i + 1])) {
      const rows = []

      while (i < n && lines[i].trim() && lines[i].includes('|')) {
        rows.push([i + 1, lines[i]])
        i += 1
      }
      blocks.push({ start, end: i, html: renderTable(rows) })
      continue
    }

    if (LIST_RE.test(raw)) {
      const items = []

      while (i < n) {
        const line = lines[i]

        if (!line.trim()) {
          break
        }

        const m = LIST_RE.exec(line)

        if (m) {
          // [indent, marker, testo, primaRiga, ultimaRiga]
          items.push([m[1].length, m[2], m[3], i + 1, i + 1])
          i += 1
          while (
            i < n &&
            lines[i].trim() &&
            !LIST_RE.test(lines[i]) &&
            /^\s{2,}\S/.test(lines[i])
          ) {
            items[items.length - 1][2] += `\n${lines[i].trim()}`
            items[items.length - 1][4] = i + 1
            i += 1
          }
          continue
        }

        if (/^\s{2,}\S/.test(line)) {
          i += 1
          continue
        }
        break
      }

      blocks.push({ start, end: i, html: renderList(items) })
      continue
    }

    const body = [raw.replace(/\s+$/, '')]

    i += 1
    while (
      i < n &&
      lines[i].trim() &&
      !HEAD_RE.test(lines[i]) &&
      !FENCE_RE.test(lines[i]) &&
      !HR_RE.test(lines[i]) &&
      !LIST_RE.test(lines[i]) &&
      !QUOTE_RE.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < n && TABLE_SEP_RE.test(lines[i + 1]))
    ) {
      body.push(lines[i].replace(/\s+$/, ''))
      i += 1
    }

    blocks.push({ start, end: i, html: `<p data-md-line="${start}" data-md-end="${i}">${paraHtml(body)}</p>` })
  }

  return blocks
}

/** Plain-text source -> blocks. Blank lines end a block; a block never holds
 *  more than TEXT_BLOCK_MAX_LINES lines. Every LINE is its own anchor, so a
 *  click reports the exact line even inside a large block. */
const TEXT_BLOCK_MAX_LINES = 40

export function textBlocks(source) {
  const lines = String(source ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
  const blocks = []
  let start = 0

  const flush = end => {
    if (end <= start) {
      return
    }

    const html = lines
      .slice(start, end)
      .map(
        (line, index) =>
          `<span class="mdann-tl" data-md-line="${start + index + 1}" data-md-end="${
            start + index + 1
          }">${esc(line)}</span>`
      )
      .join('<br>')

    blocks.push({
      start: start + 1,
      end,
      html: `<div data-md-line="${start + 1}" data-md-end="${end}">${html}</div>`
    })
  }

  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim()) {
      flush(i)
      start = i + 1
      continue
    }
    if (i - start + 1 > TEXT_BLOCK_MAX_LINES) {
      flush(i)
      start = i
    }
  }
  flush(lines.length)

  return blocks
}

// ------------------------------------------------------------------- io

function bridge() {
  return typeof window !== 'undefined' ? window.hermesDesktop : undefined
}

function expandHome(path, cwd) {
  if (!path.startsWith('~/')) {
    return path
  }

  // No HOME in the bridge: derive it from the workspace cwd.
  const m = /^(\/(?:Users|home)\/[^/]+)\//.exec(cwd || '')

  return m ? `${m[1]}${path.slice(1)}` : path
}

function absolutize(raw, cwd) {
  let value = String(raw ?? '').trim()

  if (value.startsWith('file://')) {
    value = decodeURIComponent(value.slice(7))
  }
  if (value.startsWith('~/')) {
    value = expandHome(value, cwd)
  }
  if (value && !value.startsWith('/')) {
    value = `${String(cwd || '').replace(/\/+$/, '')}/${value}`
  }

  // Cosmetic: keep `/a/./b` and `//a` out of the pane's error lines.
  return value.replace(/\/\.\//g, '/').replace(/\/{2,}/g, '/')
}

const BINARY_EXT = new Set([
  '7z', 'avif', 'bin', 'bmp', 'bz2', 'db', 'dmg', 'doc', 'docx', 'exe', 'gif', 'gz', 'icns',
  'ico', 'jar', 'jpeg', 'jpg', 'key', 'mov', 'mp3', 'mp4', 'numbers', 'odp', 'ods', 'odt', 'otf',
  'pages', 'pdf', 'png', 'ppt', 'pptx', 'sqlite', 'tar', 'tiff', 'ttf', 'wav', 'webp', 'woff',
  'woff2', 'xls', 'xlsx', 'zip'
])
const MARKDOWN_EXT = new Set(['markdown', 'md', 'mdx'])
const MONO_EXT = new Set([
  'c', 'cfg', 'conf', 'cpp', 'cs', 'css', 'env', 'go', 'h', 'hpp', 'html', 'ini', 'java', 'js',
  'json', 'jsx', 'log', 'lua', 'php', 'pl', 'py', 'rb', 'rs', 'sh', 'sql', 'swift', 'toml', 'ts',
  'tsx', 'txt', 'xml', 'yaml', 'yml', 'zsh'
])

/** Full read when the shell offers it (`readPluginSource`, 16 MiB, no
 *  truncation), else the preview read (`readFileText`, 512 KiB, truncating).
 *  Binary extensions are refused before the read; Markdown goes through the
 *  Markdown renderer, every other text file through the plain-text one. */
async function readDocument(path, cwd) {
  const api = bridge()

  if (!api) {
    return { error: 'the app bridge is not available', ok: false }
  }

  const target = absolutize(path, cwd)
  const ext = (target.split('.').pop() || '').toLowerCase()

  if (BINARY_EXT.has(ext)) {
    return { error: `not a text file (.${ext})`, ok: false, path: target }
  }

  const full = typeof api.readPluginSource === 'function'
  const read = full ? api.readPluginSource.bind(api) : api.readFileText

  if (typeof read !== 'function') {
    return { error: 'the app bridge is not available', ok: false, path: target }
  }

  try {
    const res = await read(target)

    if (!res || typeof res.text !== 'string') {
      return { error: res && res.error ? String(res.error) : 'read failed', ok: false, path: target }
    }

    return {
      mono: MONO_EXT.has(ext),
      ok: true,
      path: res.path || target,
      mode: MARKDOWN_EXT.has(ext) ? 'markdown' : 'text',
      text: res.text,
      truncated: Boolean(res.truncated)
    }
  } catch (err) {
    const message = String((err && err.message) || err)

    return {
      error: /EFBIG|too large|exceeds/i.test(message) ? 'file larger than the 16 MiB read limit' : message,
      ok: false,
      path: target
    }
  }
}

function targetSnippet(el, fallbackNode) {
  const node = el || fallbackNode
  const text = (node && node.textContent ? node.textContent : '').replace(/\s+/g, ' ').trim()

  return text.length > 110 ? `${text.slice(0, 110)}…` : text
}

/** Riga compatta: `L109` o `L109-112`. */
function lineLabel(item) {
  const line = Number(item && item.line)
  const end = Number(item && item.end)
  const first = Number.isFinite(line) ? line : 0

  return Number.isFinite(end) && end !== first ? `L${first}-${end}` : `L${first}`
}

/** A stored comment is only usable when it carries all four fields: a list
 *  written by an older version must not reach the render (it used to throw). */
function isStoredItem(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.path === 'string' && value.path !== '' && typeof value.note === 'string' && Number.isFinite(Number(value.line))
}

function readStoredItems(ctx) {
  const raw = ctx.storage.get(STORE_ITEMS, [])

  if (!Array.isArray(raw)) {
    return []
  }

  return raw.filter(isStoredItem).map(item => ({
    end: Number.isFinite(Number(item.end)) ? Number(item.end) : undefined,
    line: Number(item.line),
    note: item.note,
    path: item.path,
    target: typeof item.target === 'string' ? item.target : ''
  }))
}

function readStoredBlocks(ctx) {
  const raw = ctx.storage.get(STORE_BLOCKS, [])

  return Array.isArray(raw) ? raw.filter(entry => typeof entry === 'string' && entry.trim()).slice(0, MAX_WRITTEN_BLOCKS) : []
}

/** Remove every block this plugin wrote from the draft. All of them, not just
 *  the last one: a leftover from an earlier write would otherwise stay in the
 *  draft and the next write would duplicate it. */
function stripBlocks(text, blocks) {
  let out = String(text ?? '')

  for (const block of blocks || []) {
    if (!block) {
      continue
    }
    while (out.includes(block)) {
      out = out.replace(block, '')
    }
  }

  return out
}

/** The path as it goes into the draft: relative to the workspace root when the
 *  file is inside it, absolute otherwise. The app's `host.state.cwd` is the
 *  workspace root, and the session runs in that same directory, so a relative
 *  path resolves for the session. A file outside the workspace has no readable
 *  relative form and keeps the absolute path. */
function displayPath(path, cwd) {
  const value = String(path ?? '')
  const root = String(cwd || '').replace(/\/+$/, '')

  return root && value.startsWith(`${root}/`) ? value.slice(root.length + 1) : value
}

/** One draft line must stay one line. A filename can hold a newline on macOS,
 *  and a pasted note can too: either would inject extra comment lines into what
 *  the session receives. Control characters become single spaces. */
function oneLine(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
}

/** The comments as they go into the composer: one block per file, path first,
 *  one line per comment, in the order you wrote them. The grouping key is the
 *  absolute path; only the header line shows the display path. */
function formatBlock(items, cwd) {
  const order = []
  const byPath = new Map()

  for (const item of items) {
    if (!byPath.has(item.path)) {
      byPath.set(item.path, [])
      order.push(item.path)
    }
    byPath.get(item.path).push(item)
  }

  return order
    .map(path =>
      [
        `${oneLine(displayPath(path, cwd))}:`,
        ...byPath.get(path).map(item => `- ${lineLabel(item)}: ${oneLine(item.note)}`)
      ].join('\n')
    )
    .join('\n\n')
}

/** The comments grouped by file, each with its global index (so it can be
 *  removed). */
function groupItems(items) {
  const order = []
  const byPath = new Map()

  items.forEach((item, index) => {
    if (!byPath.has(item.path)) {
      byPath.set(item.path, [])
      order.push(item.path)
    }
    byPath.get(item.path).push({ index, item })
  })

  return order.map(path => [path, byPath.get(path)])
}

/** Read the draft of the composer the user is typing in (`null` = that one).
 *  `null` also means "no answer": no mounted surface replied. */
async function readDraft() {
  const composer = host && host.composer

  if (!composer || typeof composer.getDraft !== 'function') {
    return null
  }

  const text = await composer.getDraft(null)

  return typeof text === 'string' ? text : null
}

/** Keep the active session's draft in sync with the comments. It rewrites only
 *  the blocks this plugin wrote (idempotent, and it leaves whatever the user
 *  typed around it alone) and fails closed: no mounted surface -> `ok: false`,
 *  never a half write. `cwd` is the workspace root and decides the path form in
 *  the draft (relative inside the workspace, absolute outside).
 *
 *  `blocks` is every block previously written, most recent first. The three
 *  flags let the caller tell three different situations apart:
 *   - `found`  how many of those blocks were still in the draft;
 *   - `stale`  the draft holds text that is not ours, and none of our blocks:
 *              the user edited the block by hand;
 *   - `sent`   the draft is empty while we had written blocks: the user pressed
 *              Enter, so the batch went out. */
async function syncDraft(items, blocks, cwd) {
  const composer = host && host.composer
  const known = (blocks || []).filter(Boolean)

  if (!composer || typeof composer.getDraft !== 'function' || typeof composer.setDraft !== 'function') {
    return { block: known[0] || '', found: 0, ok: false, sent: false, stale: false }
  }

  const current = (await composer.getDraft(null)) ?? ''
  const found = known.filter(block => current.includes(block)).length
  const base = stripBlocks(current, known).trim()
  const block = items.length ? formatBlock(items, cwd) : ''
  const text = [base, block].filter(Boolean).join('\n\n')
  const sent = items.length > 0 && known.length > 0 && current.trim() === ''
  const stale = items.length > 0 && known.length > 0 && found === 0 && current.trim() !== ''

  // No write when the draft already holds exactly this text: one less repaint.
  const ok = text === current ? true : await composer.setDraft(null, text)

  return { block, found, ok: Boolean(ok), sent, stale }
}

/** Explicit send (the button): submit the current draft as a turn. */
async function submitDraft() {
  const composer = host && host.composer

  if (!composer || typeof composer.submit !== 'function') {
    return false
  }

  const text = typeof composer.getDraft === 'function' ? (await composer.getDraft(null)) ?? '' : ''

  return Boolean(text.trim()) && Boolean(composer.submit(null, text))
}

// ------------------------------------------------------------------- UI

const CSS = `
.mdann-root { display:flex; flex-direction:column; height:100%; font-size:12.5px; line-height:1.5; }
.mdann-bar { display:flex; gap:6px; align-items:center; padding:8px 10px; border-bottom:1px solid var(--ui-stroke-secondary, rgba(127,127,127,.28)); }
.mdann-bar input { flex:1; min-width:0; background:transparent; border:1px solid var(--ui-stroke-secondary, rgba(127,127,127,.28));
  border-radius:6px; padding:4px 8px; font-size:12px; color:var(--ui-text-primary, inherit); }
.mdann-btn { border:1px solid var(--ui-stroke-secondary, rgba(127,127,127,.28)); background:transparent; border-radius:6px;
  padding:3px 8px; font-size:11.5px; color:var(--ui-text-secondary, inherit); cursor:pointer; white-space:nowrap; }
.mdann-btn:hover { border-color:var(--ui-accent, currentColor); color:var(--ui-text-primary, inherit); }
.mdann-btn[data-on="true"] { border-color:var(--ui-accent, currentColor); color:var(--ui-accent, currentColor); }
.mdann-btn:disabled { opacity:.45; cursor:default; }
.mdann-status { padding:6px 10px; font-size:11px; color:var(--ui-text-tertiary, inherit); border-bottom:1px solid var(--ui-stroke-secondary, rgba(127,127,127,.2)); }
.mdann-status[data-tone="error"] { color:#e5484d; }
.mdann-body { flex:1; overflow:auto; padding:6px 0 40px; }
.mdann-blk { position:relative; padding:2px 10px 2px 42px; border-radius:6px; }
.mdann-blk:hover { background:rgba(120,150,255,.10); outline:1px solid rgba(120,150,255,.35); cursor:crosshair; }
.mdann-blk[data-pinned="true"] { background:rgba(120,150,255,.14); }
.mdann-blk[data-editing="true"] { outline:1px solid var(--ui-accent, rgba(120,150,255,.7)); }
.mdann-gutter { position:absolute; left:8px; top:4px; font-size:10px; font-variant-numeric:tabular-nums;
  color:var(--ui-text-quaternary, #8a8f98); user-select:none; }
.mdann-pin { position:absolute; left:2px; top:2px; width:15px; height:15px; border-radius:50%;
  background:var(--ui-accent, #3b82f6); color:#fff; font-size:9.5px; line-height:15px; text-align:center; font-weight:600; }
.mdann-blk p { margin:.35em 0; } .mdann-blk ul,.mdann-blk ol { margin:.35em 0; padding-left:1.3em; }
.mdann-blk li { margin:.1em 0; }
.mdann-blk h1 { font-size:1.35em; margin:.7em 0 .3em; } .mdann-blk h2 { font-size:1.15em; margin:.7em 0 .3em; }
.mdann-blk h3,.mdann-blk h4,.mdann-blk h5,.mdann-blk h6 { font-size:1.02em; margin:.6em 0 .3em; }
.mdann-blk code { font-family:ui-monospace,Menlo,monospace; font-size:11.5px; background:rgba(127,127,127,.16);
  padding:1px 3px; border-radius:3px; }
.mdann-blk pre { background:rgba(127,127,127,.10); border-radius:6px; padding:6px 8px; overflow-x:auto; }
.mdann-blk pre code { background:none; padding:0; }
.mdann-blk blockquote { margin:.4em 0; padding-left:.7em; border-left:2px solid var(--ui-stroke-secondary, #555); }
.mdann-blk table { border-collapse:collapse; font-size:11.5px; }
.mdann-blk th,.mdann-blk td { border:1px solid var(--ui-stroke-secondary, rgba(127,127,127,.3)); padding:2px 5px; }
.mdann-blk hr { border:none; border-top:1px solid var(--ui-stroke-secondary, rgba(127,127,127,.4)); margin:.8em 0; }
.mdann-foot { border-top:1px solid var(--ui-stroke-secondary, rgba(127,127,127,.28)); padding:8px 10px; display:flex; flex-direction:column; gap:6px; }
.mdann-note { width:100%; box-sizing:border-box; min-height:46px; resize:vertical; background:transparent; font-size:12px;
  border:1px solid var(--ui-stroke-secondary, rgba(127,127,127,.28)); border-radius:6px; padding:5px 7px; color:var(--ui-text-primary, inherit); }
.mdann-row { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
.mdann-list { max-height:120px; overflow:auto; font-size:11.5px; }
.mdann-item { display:flex; gap:6px; align-items:baseline; padding:2px 0; }
.mdann-item b { color:var(--ui-accent, inherit); }
.mdann-path { font-size:10.5px; color:var(--ui-text-quaternary, #8a8f98); margin:5px 0 2px; word-break:break-all;
  font-family:ui-monospace,Menlo,monospace; }
.mdann-hint { font-size:11px; color:var(--ui-text-tertiary, inherit); }
.mdann-drop { outline:1px dashed var(--ui-accent, #3b82f6); outline-offset:-4px; }
.mdann-textmode { white-space: pre-wrap; }
.mdann-mono { font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; line-height: 1.45; }
.mdann-tl:hover { outline: 1px solid rgba(120,150,255,.35); border-radius: 3px; }
.mdann-target { color:var(--ui-text-quaternary, #8a8f98); font-size:10.5px; }
`

/** Status-bar icon: a pencil, tinted in the accent colour while the pane is
 *  open. It is passed as the `icon` of a `StatusbarItem` (a `data` contribution),
 *  so the app owns the button chrome, the tooltip and the right-click show/hide
 *  entry — no custom markup in the bar. */
function StatusbarIcon() {
  const open = useValue($paneOpen)
  const Pencil = icons.Pencil

  // `size` is an SVG attribute, not a Tailwind class: the app's CSS build never
  // scans plugin files, so a utility class written here would not exist.
  return jsx(Pencil, {
    size: 14,
    style: open ? { color: 'var(--ui-accent)' } : undefined
  })
}

function MdAnnotatorPane({ ctx }) {
  const cwd = useValue(host.state.cwd)
  const [pathInput, setPathInput] = useState(() => ctx.storage.get('lastPath', ''))
  const [doc, setDoc] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [draft, setDraft] = useState(null)
  const [note, setNote] = useState('')
  // Comments accumulate across files: every entry knows which path it belongs
  // to, and nothing is lost when you open another document.
  // Comments survive closing the pane: they live in ctx.storage.
  const [items, setItems] = useState(() => readStoredItems(ctx))
  const [dragging, setDragging] = useState(false)
  // Every block this plugin wrote, most recent first (see syncDraft).
  const writtenRef = useRef(readStoredBlocks(ctx))
  const aliveRef = useRef(true)
  const restoredRef = useRef(false)

  useEffect(
    () => () => {
      aliveRef.current = false
    },
    []
  )

  const blocks = useMemo(
    () => (doc ? (doc.mode === 'text' ? textBlocks(doc.text) : mdBlocks(doc.text)) : []),
    [doc]
  )

  const open = useCallback(
    async raw => {
      const wanted = raw !== undefined ? raw : pathInput

      if (!String(wanted ?? '').trim()) {
        setError('Enter a text file path (absolute, or relative to the workspace).')

        return
      }

      setBusy(true)
      setError('')
      setNotice('')

      const res = await readDocument(wanted, cwd)

      if (!aliveRef.current) {
        return
      }

      setBusy(false)

      if (!res.ok) {
        setError(`Cannot read ${res.path || wanted}: ${res.error}`)

        return
      }

      setDoc(res)
      setDraft(null)
      setPathInput(res.path)
      ctx.storage.set('lastPath', res.path)
      if (res.truncated) {
        setNotice('File truncated at 512 KiB: the rest of the file is not shown.')
      }
    },
    [cwd, pathInput, ctx]
  )

  const pick = useCallback(async () => {
    const chosen = ctx.os && ctx.os.pickOpenPath ? await ctx.os.pickOpenPath({
      filters: [
        { extensions: ['md', 'markdown', 'txt'], name: 'Text and Markdown' },
        { extensions: ['*'], name: 'All files' }
      ],
      defaultPath: cwd || undefined,
      title: 'Choose a text file to annotate'
    }) : null

    if (chosen) {
      await open(chosen)
    }
  }, [ctx, cwd, open])

  /** The document died with the previous pane instance, the path did not: open
   *  the last file again, so reopening the pane costs one click less. */
  useEffect(() => {
    if (restoredRef.current || doc) {
      return
    }
    restoredRef.current = true
    const last = ctx.storage.get('lastPath', '')

    if (last) {
      void open(last)
    }
  }, [ctx, doc, open])

  /** Every change to the comments rewrites the draft of the active session. */
  const pushDraft = useCallback(async (next, options = {}) => {
    const res = await syncDraft(next, writtenRef.current, cwd)

    if (!aliveRef.current) {
      return res.ok
    }

    ctx.storage.set(STORE_ITEMS, next)
    if (res.block) {
      writtenRef.current = [
        res.block,
        ...writtenRef.current.filter(entry => entry !== res.block)
      ].slice(0, MAX_WRITTEN_BLOCKS)
    }
    ctx.storage.set(STORE_BLOCKS, writtenRef.current)

    if (!res.ok) {
      setError('No active session, or the draft is not editable now. The comments stay in this list.')

      return res.ok
    }

    setError('')
    const files = new Set(next.map(entry => entry.path)).size

    setNotice(
      next.length
        ? `draft updated: ${next.length} comment${next.length === 1 ? '' : 's'} in ${files} file${
            files === 1 ? '' : 's'
          }`
        : 'draft restored: no comments.'
    )
    if (options.sent || res.sent) {
      setNotice('the previous batch was sent: the list starts from this comment.')
    }
    if (res.stale) {
      setError('the comment block in the draft was changed by hand: press Clear comments before you continue, or the comments appear twice.')
    }

    return res.ok
  }, [cwd])

  const savePin = useCallback(async () => {
    if (!draft || !doc || !note.trim()) {
      return
    }

    // The batch in the draft went out (the user pressed Enter): the draft is
    // empty while we had written blocks, so this comment starts a fresh list.
    // Without this the already-sent comments would come back into the draft.
    let base = items
    let sent = false
    const current = items.length > 0 && writtenRef.current.length > 0 ? await readDraft() : null

    if (typeof current === 'string' && current.trim() === '') {
      base = []
      sent = true
      writtenRef.current = []
      ctx.storage.set(STORE_BLOCKS, [])
    }

    const next = [
      ...base,
      { end: draft.end, line: draft.line, note: note.trim(), path: doc.path, target: draft.target }
    ]

    setItems(next)
    setNote('')
    setDraft(null)
    void pushDraft(next, { sent })
  }, [ctx, doc, draft, items, note, pushDraft])

  const removeItem = useCallback(
    index => {
      const next = items.filter((_, i) => i !== index)

      setItems(next)
      void pushDraft(next)
    },
    [items, pushDraft]
  )

  const clearItems = useCallback(() => {
    setItems([])
    void pushDraft([])
  }, [pushDraft])

  const sendNow = useCallback(async () => {
    if (await submitDraft()) {
      // The batch left with the turn: keep the list, and the next comment puts
      // the already-sent comments back into the draft.
      setItems([])
      ctx.storage.set(STORE_ITEMS, [])
      writtenRef.current = []
      ctx.storage.set(STORE_BLOCKS, [])
      setError('')
      setNotice('draft sent: the comment list is empty.')
    } else {
      setError('Send failed: no session is ready to receive the draft.')
    }
  }, [ctx])

  /** Drag from the sidebar tree: the payload is
   *  `application/x-hermes-paths` = [{isDirectory, path}], with `text/plain` as
   *  the fallback (see app/right-sidebar/files/tree.tsx). */
  const onDropFiles = useCallback(
    async event => {
      event.preventDefault()

      const dt = event.dataTransfer
      let path = ''

      try {
        const raw = dt.getData('application/x-hermes-paths')

        if (raw) {
          const parsed = JSON.parse(raw)

          path = (Array.isArray(parsed) ? parsed[0] : parsed)?.path ?? ''
        }
      } catch {
        path = ''
      }

      if (!path) {
        path = dt.getData('text/plain') || ''
      }
      if (!path) {
        setError('No path in the drop.')

        return
      }
      const ext = (path.split('.').pop() || '').toLowerCase()

      if (BINARY_EXT.has(ext)) {
        setError(`Not a text file: ${path}`)

        return
      }

      await open(path)
    },
    [open]
  )

  const onBlockClick = useCallback(
    (event, block) => {
      const holder = event.target && event.target.closest ? event.target.closest('[data-md-line]') : null
      const line = holder ? Number(holder.getAttribute('data-md-line')) : block.start
      const end = holder && holder.getAttribute('data-md-end') ? Number(holder.getAttribute('data-md-end')) : block.end

      setDraft({ end: end || block.end, line: line || block.start, target: targetSnippet(holder, event.currentTarget) })
      setNote('')
    },
    []
  )

  const fileItems = useMemo(() => items.filter(item => item.path === doc?.path), [items, doc])
  /** A pin belongs to the block that CONTAINS the commented line, not only to
   *  the block that starts on it: a comment on line 4 of a block 3-4 shows its
   *  pin too. `pinFor(block)` returns the 1-based comment number or 0. */
  const pinFor = useCallback(
    block => {
      const index = fileItems.findIndex(item => {
        const first = Number(item.line) || 0
        const last = Number.isFinite(Number(item.end)) ? Number(item.end) : first

        return first <= block.end && last >= block.start
      })

      return index < 0 ? 0 : index + 1
    },
    [fileItems]
  )

  return jsxs('div', {
    className: dragging ? 'mdann-root mdann-drop' : 'mdann-root',
    onDragLeave: () => setDragging(false),
    onDragOver: event => {
      event.preventDefault()
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy'
      }
      setDragging(true)
    },
    onDrop: event => {
      setDragging(false)
      void onDropFiles(event)
    },
    children: [
      jsx('style', { dangerouslySetInnerHTML: { __html: CSS } }),
      jsxs('div', {
        className: 'mdann-bar',
        children: [
          jsx('input', {
            'aria-label': 'Percorso del file Markdown',
            onChange: event => setPathInput(event.target.value),
            onKeyDown: event => {
              if (event.key === 'Enter') {
                void open()
              }
            },
            placeholder: cwd ? `${cwd}/TODO.md` : '/path/to/file',
            spellCheck: false,
            value: pathInput
          }),
          jsx('button', {
            className: 'mdann-btn',
            disabled: busy,
            onClick: () => void pick(),
            type: 'button',
            children: 'Open…'
          }),
          jsx('button', {
            className: 'mdann-btn',
            disabled: busy,
            onClick: () => void open(),
            type: 'button',
            children: busy ? '…' : 'Open'
          })
        ]
      }),
      error || notice
        ? jsx('div', {
            className: 'mdann-status',
            'data-tone': error ? 'error' : 'info',
            children: error || notice
          })
        : null,
      jsx('div', {
        className: 'mdann-body',
        children: doc
          ? blocks.map(block =>
              jsxs(
                'div',
                {
                  className: 'mdann-blk',
                  'data-editing': draft && draft.line >= block.start && draft.line <= block.end ? 'true' : 'false',
                  'data-pinned': pinFor(block) ? 'true' : 'false',
                  onClick: event => onBlockClick(event, block),
                  children: [
                    jsx('span', {
                      className: 'mdann-gutter',
                      children: block.end && block.end !== block.start ? `L${block.start}-${block.end}` : `L${block.start}`
                    }),
                    pinFor(block)
                      ? jsx('span', { className: 'mdann-pin', children: String(pinFor(block)) })
                      : null,
                    jsx('div', {
                      className:
                        doc?.mode === 'text'
                          ? `mdann-blk-body mdann-textmode${doc.mono ? ' mdann-mono' : ''}`
                          : 'mdann-blk-body',
                      dangerouslySetInnerHTML: { __html: block.html }
                    })
                  ]
                },
                `${block.start}-${block.end}`
              )
            )
          : jsx('div', {
              className: 'mdann-hint',
              style: { padding: '10px' },
              children: 'No file open. Drag a text file here from the sidebar tree, or use “Open…”'
            })
      }),
      jsxs('div', {
        className: 'mdann-foot',
        children: [
          draft
            ? jsxs('div', {
                children: [
                  jsxs('div', {
                    className: 'mdann-status',
                    style: { padding: '0 0 4px' },
                    children: [
                      `line ${draft.line}${draft.end && draft.end !== draft.line ? `-${draft.end}` : ''} — `,
                      jsx('span', { style: { color: 'var(--ui-text-quaternary)' }, children: draft.target })
                    ]
                  }),
                  jsx('textarea', {
                    autoFocus: true,
                    className: 'mdann-note',
                    onChange: event => setNote(event.target.value),
                    onKeyDown: event => {
                      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                        savePin()
                      }
                      if (event.key === 'Escape') {
                        setDraft(null)
                        setNote('')
                      }
                    },
                    placeholder: 'What should change on this line? (the intent, not the description)',
                    value: note
                  }),
                  jsxs('div', {
                    className: 'mdann-row',
                    style: { marginTop: 4 },
                    children: [
                      jsx('button', {
                        className: 'mdann-btn',
                        disabled: !note.trim(),
                        onClick: savePin,
                        type: 'button',
                        children: 'Save comment (⌘↵)'
                      }),
                      jsx('button', {
                        className: 'mdann-btn',
                        onClick: () => {
                          setDraft(null)
                          setNote('')
                        },
                        type: 'button',
                        children: 'Cancel'
                      })
                    ]
                  })
                ]
              })
            : null,
          jsxs('div', {
            className: 'mdann-row',
            children: [
              jsx('button', {
                className: 'mdann-btn',
                disabled: !items.length,
                onClick: () => void sendNow(),
                type: 'button',
                children: 'Send draft now'
              }),
              jsx('button', {
                className: 'mdann-btn',
                disabled: !items.length,
                onClick: clearItems,
                type: 'button',
                children: 'Clear comments'
              })
            ]
          }),
          items.length
            ? jsx('div', {
                className: 'mdann-list',
                children: groupItems(items).map(([path, list]) =>
                  jsxs(
                    'div',
                    {
                      children: [
                        jsx('div', { className: 'mdann-path', children: displayPath(path, cwd) }),
                        ...list.map(({ index, item }) =>
                          jsxs(
                            'div',
                            {
                              className: 'mdann-item',
                              children: [
                                jsx('b', { children: lineLabel(item) }),
                                jsx('span', { children: oneLine(item.note) }),
                                item.target
                                  ? jsx('i', {
                                      className: 'mdann-target',
                                      children: item.target
                                    })
                                  : null,
                                jsx('button', {
                                  className: 'mdann-btn',
                                  onClick: () => removeItem(index),
                                  style: { marginLeft: 'auto' },
                                  type: 'button',
                                  children: '×'
                                })
                              ]
                            },
                            `item-${index}`
                          )
                        )
                      ]
                    },
                    `grp-${path}`
                  )
                )
              })
            : jsx('div', {
                className: 'mdann-hint',
                children: 'No comments yet. Click a block above, write the note and save: it goes into the session draft.'
              })
        ]
      })
    ]
  })
}

export default {
  id: 'hermes-inline-comments',
  name: 'Inline comments',
  description: 'Annotate text and Markdown files line by line, and stack the comments into the draft of the active session.',
  defaultEnabled: true,
  register(ctx) {
    let closePane = null

    /** Create the pane on demand: openWorkspace returns its closer, so the
     *  status-bar icon is a real toggle. On a build without openWorkspace it
     *  falls back to the registered pane + revealPane (reveal only). */
    const openPane = () => {
      if (typeof host.openWorkspace !== 'function') {
        host.revealPane(PANE_ID)

        return
      }

      closePane = host.openWorkspace(WORKSPACE_ID, {
        dock: { pane: 'workspace', pos: 'right' },
        minWidth: '22rem',
        onClose: () => {
          closePane = null
          $paneOpen.set(false)
        },
        render: () => jsx(MdAnnotatorPane, { ctx }),
        title: 'annotate'
      })

      $paneOpen.set(true)
    }

    const togglePane = () => {
      if (closePane) {
        const close = closePane

        closePane = null
        $paneOpen.set(false)
        close()

        return
      }

      openPane()
    }

    ctx.register({
      id: 'toggle',
      area: STATUSBAR_AREAS.right,
      order: 140,
      data: {
        id: 'hermes-inline-comments.toggle',
        icon: jsx(StatusbarIcon, {}),
        onSelect: togglePane,
        title: 'Annotate a text file (show/hide the pane)',
        toggleLabel: 'Inline comments'
      }
    })

    ctx.register({
      id: 'open',
      area: PALETTE_AREA,
      data: {
        id: 'hermes-inline-comments.open',
        keywords: ['annotate', 'comments', 'inline', 'markdown', 'md', 'pencil', 'pane'],
        label: 'Annotate a text file (show/hide the pane)',
        run: togglePane
      }
    })

    if (typeof host.openWorkspace !== 'function') {
      ctx.register({
        id: 'pane',
        area: PANES_AREA,
        title: 'annotate',
        data: { placement: 'right', width: '360px' },
        render: () => jsx(MdAnnotatorPane, { ctx })
      })
    }
  }
}
