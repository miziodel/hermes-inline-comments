// Stand-in for `@hermes/plugin-sdk`: the parts the plugin imports, plus the
// instrumentation the tests read (`draft`, `calls`, `opened`) and the control
// the tests need (`setCwd`).
export const PALETTE_AREA = 'palette'
export const PANES_AREA = 'panes'
export const STATUSBAR_AREAS = { left: 'statusBar.left', right: 'statusBar.right' }
export const icons = { Pencil: 'Pencil' }

export const atom = value => ({
  get: () => value,
  listen: () => () => undefined,
  set: next => {
    value = next
  }
})

export const useValue = value => value.get()

/** What the tests inspect. */
export const draft = { text: '' }
export const calls = []
export const opened = { closed: false, opts: null }
export const state = { cwd: '' }

export const setCwd = next => {
  state.cwd = next
}

export const reset = () => {
  draft.text = ''
  calls.length = 0
  opened.closed = false
  opened.opts = null
}

export const host = {
  state: { cwd: { get: () => state.cwd } },
  notify: message => calls.push(['notify', message]),
  revealPane: id => calls.push(['revealPane', id]),
  openWorkspace: (id, opts) => {
    opened.opts = opts
    opened.closed = false
    calls.push(['openWorkspace', id])

    return () => {
      opened.closed = true
      opened.opts = null

      if (opts.onClose) {
        opts.onClose()
      }
    }
  },
  composer: {
    getDraft: async () => draft.text,
    setDraft: async (sessionId, text) => {
      // The real write is refused when the composer is not mounted.
      if (typeof text !== 'string') {
        return false
      }
      draft.text = text

      return true
    },
    submit: (sessionId, text) => {
      calls.push(['submit', text])
      draft.text = ''

      return true
    },
    insertText: async () => true,
    focus: () => undefined
  }
}
