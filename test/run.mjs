// Headless harness: runs `plugin.js` outside Hermes Desktop with stub modules
// for `@hermes/plugin-sdk`, `react` and `react/jsx-runtime`.
//
//   node test/run.mjs
//
// Every check pins either a behaviour that broke once or a contract the README
// states. Nothing is installed and nothing is built: the plugin is loaded
// through a temporary copy whose imports point at `test/stubs/`.
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const dir = mkdtempSync(join(tmpdir(), 'inline-comments-'))
const outside = mkdtempSync(join(tmpdir(), 'inline-comments-outside-'))

const rewritten = readFileSync(join(root, 'plugin.js'), 'utf8')
  .replace("from '@hermes/plugin-sdk'", "from './plugin-sdk.mjs'")
  .replace("from 'react/jsx-runtime'", "from './jsx-runtime.mjs'")
  .replace("from 'react'", "from './react.mjs'")

writeFileSync(join(dir, 'plugin.mjs'), rewritten)
for (const stub of ['jsx-runtime.mjs', 'plugin-sdk.mjs', 'react.mjs']) {
  copyFileSync(join(here, 'stubs', stub), join(dir, stub))
}

const read = path => readFileSync(path, 'utf8')
const tick = () => new Promise(resolve => setTimeout(resolve, 25))

// ------------------------------------------------------------------ fixtures

const fixture = (name, text, target = dir) => {
  const path = join(target, name)

  writeFileSync(path, text)

  return path
}

// Column on the right = the line number in the file.
const markdown = fixture(
  'doc.md',
  [
    '# Title', // 1
    '', // 2
    'A paragraph', // 3
    'on two lines.', // 4
    '', // 5
    '- first item', // 6
    '  second line of the item', // 7
    '- second item', // 8
    '', // 9
    '```js', // 10
    'const a = 1', // 11
    '```', // 12
    '', // 13
    '| a | b |', // 14
    '| --- | --- |', // 15
    '| 1 | 2 |', // 16
    '' // 17
  ].join('\n')
)
const crlf = fixture('crlf.md', '# Title\r\n\r\n- a\r\n- b\r\n')
const bom = fixture('bom.md', '\uFEFF# BOM title\n')
const unclosed = fixture('unclosed.md', '```\ncode one\ncode two')
const plain = fixture('plain.txt', `${Array.from({ length: 41 }, (_, index) => `line ${index + 1}`).join('\n')}\n`)
const hostile = fixture(
  'hostile.md',
  'x\n\n![a" onerror="alert(1)](https://x/y.png)\n\n[x](javascript:1)\n\n[y](http://a/**b**)\n'
)
const outer = fixture('outer.md', '# Outside\n\ntext\n', outside)

// ------------------------------------------------------------------ helpers

const checks = []
const check = (name, run) => checks.push({ name, run })

const assert = (condition, detail) => {
  if (!condition) {
    throw new Error(detail || 'assertion failed')
  }
}

const assertEqual = (got, want, label = 'value') => {
  assert(got === want, `${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

const helpers = await import(`${pathToFileURL(join(dir, 'plugin.mjs')).href}?helpers=1`)

/** A fresh plugin instance (a cache-busting import resets the module state)
 *  with the pane mounted, plus helpers to drive it. */
let version = 0
const boot = async store => {
  const sdk = await import(pathToFileURL(join(dir, 'plugin-sdk.mjs')).href)
  const react = await import(pathToFileURL(join(dir, 'react.mjs')).href)
  const plugin = await import(`${pathToFileURL(join(dir, 'plugin.mjs')).href}?v=${version++}`)

  sdk.reset()
  sdk.setCwd(dir)
  globalThis.window = { hermesDesktop: { readPluginSource: async path => ({ path, text: read(path) }) } }

  const storage = store || {}
  const contributions = []
  plugin.default.register({
    os: { pickOpenPath: async () => null },
    register: contribution => {
      contributions.push(contribution)

      return () => undefined
    },
    storage: {
      get: (key, fallback) => (key in storage ? storage[key] : fallback),
      remove: key => {
        delete storage[key]
      },
      set: (key, value) => {
        storage[key] = value
      }
    }
  })

  const tree = { current: null }
  const nodes = () => {
    const out = []
    const walk = node => {
      if (!node || typeof node !== 'object') {
        return
      }
      if (Array.isArray(node)) {
        node.forEach(walk)

        return
      }
      out.push(node)
      walk(node.props && node.props.children)
    }

    walk(tree.current)

    return out
  }
  const within = (parent, node) => {
    let found = false
    const walk = current => {
      if (found || !current || typeof current !== 'object') {
        return
      }
      if (current === node) {
        found = true

        return
      }
      if (Array.isArray(current)) {
        current.forEach(walk)

        return
      }
      walk(current.props && current.props.children)
    }

    walk(parent)

    return found
  }
  const render = () => {
    react.beginRender()

    const element = sdk.opened.opts.render()

    tree.current = element.type(element.props)
  }
  const update = () => {
    react.beginRender()

    const element = sdk.opened.opts.render()

    tree.current = element.type(element.props)
  }
  const byText = text => nodes().find(node => node.props && node.props.children === text)
  const byClass = name =>
    nodes().filter(
      node => node.props && typeof node.props.className === 'string' && node.props.className.includes(name)
    )
  const status = () => byClass('mdann-status').map(node => `${node.props['data-tone']}: ${node.props.children}`)

  const pane = {
    byClass,
    byText,
    contributions,
    remount: () => {
      react.unmount()
      render()
    },
    sdk,
    status,
    store: storage,
    update,
    open: async path => {
      assert(sdk.opened.opts, 'the pane is not mounted')
      update()
      const input = nodes().find(node => node.type === 'input')

      assert(input, 'the path input is missing')
      input.props.onChange({ target: { value: path } })
      update()
      const button = byText('Open')

      assert(button, 'the Open button is missing (the pane may still be busy)')
      button.props.onClick()
      await tick()
      update()
    },
    comment: async (label, note) => {
      const block = byClass('mdann-blk').find(candidate =>
        nodes().some(node => node.props && node.props.children === label && within(candidate, node))
      )

      assert(block, `no block labelled ${label}`)
      block.props.onClick({ currentTarget: { textContent: 'clicked' }, target: { closest: () => null } })
      update()
      const textarea = byClass('mdann-note')[0]

      assert(textarea, 'the note field is missing')
      textarea.props.onChange({ target: { value: note } })
      update()
      const save = byText('Save comment (\u2318\u21b5)')

      assert(save, 'the save button is missing')
      save.props.onClick()
      await tick()
      update()
    }
  }

  const statusBar = contributions.find(contribution => contribution.area === 'statusBar.right')

  statusBar.data.onSelect()
  render()

  return pane
}

// ------------------------------------------------------------------ checks

check('markdown: every block carries its source line range', () => {
  const ranges = helpers.mdBlocks(read(markdown)).map(block => `${block.start}-${block.end}`)

  for (const expected of ['1-1', '3-4', '6-8', '10-12', '14-16']) {
    assert(ranges.includes(expected), `range ${expected} missing, got ${ranges.join(' ')}`)
  }
  // The list is ONE block; inside it every item keeps its own anchor, and the
  // anchor starts on the first line of that item (6-7 and 8).
  const list = helpers.mdBlocks(read(markdown)).find(block => block.start === 6)

  assert(
    list.html.includes('<li data-md-line="6" data-md-end="7"') && list.html.includes('<li data-md-line="8"'),
    `item anchors, got ${list.html}`
  )
})

check('markdown: CRLF and a BOM do not break the block detection', () => {
  const crlfHtml = helpers.mdBlocks(read(crlf)).map(block => block.html).join('')

  assertEqual(crlfHtml.includes('<ul><li'), true, 'CRLF list recognised')
  assertEqual(crlfHtml.includes('<h1'), true, 'CRLF heading recognised')
  assertEqual(helpers.mdBlocks(read(bom))[0].html.includes('<h1'), true, 'BOM heading recognised')
})

check('markdown: an unterminated fence stops at the last line', () => {
  assertEqual(helpers.mdBlocks(read(unclosed))[0].end, 3, 'clamped end')
})

check('plain text: 40-line blocks, one anchor per line, empty file is empty', () => {
  const blocks = helpers.textBlocks(read(plain))

  assertEqual(blocks.length, 2, 'block count')
  assertEqual(`${blocks[0].start}-${blocks[0].end}`, '1-40', 'first block')
  assertEqual(`${blocks[1].start}-${blocks[1].end}`, '41-41', 'second block')
  assertEqual((blocks[0].html.match(/data-md-line=/g) || []).length, 41, 'line anchors')
  assertEqual(helpers.textBlocks('').length, 0, 'empty file')
})

check('a document cannot inject markup through a link or an image', () => {
  const html = helpers.mdBlocks(read(hostile)).map(block => block.html).join('\n')

  assert(!html.includes('onerror="alert'), 'the event handler attribute must not survive')
  assert(html.includes('&quot;'), 'the quote inside the alt text must be escaped')
  assert(!html.includes('<a href="javascript:'), 'a javascript: link must stay literal text')
  assert(html.includes('href="http://a/**b**"'), 'emphasis must not be expanded inside an attribute')
})

check('the draft shows the workspace-relative path, and the absolute one outside', async () => {
  const pane = await boot()

  await pane.open(markdown)
  await pane.comment('L1', 'inside')
  assert(pane.sdk.draft.text.startsWith('doc.md:'), `relative header, got ${pane.sdk.draft.text}`)
  assert(!pane.sdk.draft.text.includes(dir), 'the absolute prefix must not appear')

  await pane.open(outer)
  await pane.comment('L1', 'outside')
  assert(pane.sdk.draft.text.includes(`${outer}:`), `absolute header, got ${pane.sdk.draft.text}`)
})

check('a note with a newline stays one line of the draft', async () => {
  const pane = await boot()

  await pane.open(markdown)
  await pane.comment('L1', 'first line\n- L9: injected')
  assertEqual(pane.sdk.draft.text.split('\n').length, 2, 'draft line count')
})

check('the second comment replaces the block, it does not append it', async () => {
  const pane = await boot()

  await pane.open(markdown)
  await pane.comment('L1', 'one')
  await pane.comment('L3-4', 'two')

  assertEqual(pane.sdk.draft.text, 'doc.md:\n- L1: one\n- L3-4: two', 'draft content')
})

check('a close/reopen of the pane does not duplicate the block', async () => {
  const pane = await boot()

  await pane.open(markdown)
  await pane.comment('L1', 'one')
  pane.remount()
  await new Promise(resolve => setTimeout(resolve, 40))
  pane.update()
  await pane.open(markdown)
  await pane.comment('L1', 'two')

  assertEqual(pane.sdk.draft.text, 'doc.md:\n- L1: one\n- L1: two', 'draft content after a remount')
})

check('after a send the list restarts, the sent comments do not come back', async () => {
  const pane = await boot()

  await pane.open(markdown)
  await pane.comment('L1', 'sent already')
  pane.byText('Send draft now').props.onClick()
  await tick()
  pane.update()
  assertEqual(pane.sdk.draft.text, '', 'draft emptied by the send')

  await pane.open(markdown)
  await pane.comment('L1', 'new one')
  assertEqual(pane.sdk.draft.text, 'doc.md:\n- L1: new one', 'draft after the send')
})

check('a comment list written by an older version does not break the pane', async () => {
  const store = { items: [{ line: 3, note: 'legacy entry' }, { end: 2, line: 2, note: 'valid', path: 'a.md' }] }
  const pane = await boot(store)

  pane.remount()

  assertEqual(pane.byClass('mdann-item').length, 1, 'only the valid entry renders')
})

check('a block edited by hand is reported, not silently duplicated', async () => {
  const pane = await boot()

  await pane.open(markdown)
  await pane.comment('L1', 'one')
  pane.sdk.draft.text = pane.sdk.draft.text.replace('- L1: one', '- L1: hand edited')
  await pane.open(markdown)
  await pane.comment('L1', 'two')

  assert(
    pane.status().some(line => line.includes('changed by hand')),
    `expected the warning, got ${JSON.stringify(pane.status())}`
  )
})

check('the status bar and the palette carry English labels, and the icon toggles', async () => {
  const pane = await boot()
  const statusBar = pane.contributions.find(contribution => contribution.area === 'statusBar.right')
  const palette = pane.contributions.find(contribution => contribution.area === 'palette')

  assert(statusBar, 'no status bar contribution')
  assert(palette, 'no palette contribution')
  assertEqual(statusBar.data.title, 'Annotate a text file (show/hide the pane)', 'status bar title')
  assertEqual(statusBar.data.toggleLabel, 'Inline comments', 'toggle label')
  assertEqual(palette.data.label, 'Annotate a text file (show/hide the pane)', 'palette label')
  assertEqual(pane.sdk.opened.opts.title, 'annotate', 'pane title')
})

// ------------------------------------------------------------------ runner

let failed = 0

for (const { name, run } of checks) {
  try {
    await run()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}\n     ${error.message}`)
  }
}

console.log(`\n${checks.length - failed}/${checks.length} checks passed`)

if (failed) {
  process.exitCode = 1
}
