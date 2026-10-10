// Minimal stand-in for `react`, enough to drive the plugin outside the app.
// State and refs persist across renders, exactly like the real library: without
// that, `useRef` is rebuilt on every render and the draft looks duplicated.
let hooks = []
let cursor = 0

export const beginRender = () => {
  cursor = 0
}

/** Drop every hook: what a close/reopen of the pane does to the component. */
export const unmount = () => {
  hooks = []
  cursor = 0
}

export const useState = initial => {
  const key = cursor++

  if (!(key in hooks)) {
    hooks[key] = typeof initial === 'function' ? initial() : initial
  }

  return [hooks[key], next => { hooks[key] = typeof next === 'function' ? next(hooks[key]) : next }]
}

export const useMemo = factory => {
  cursor++

  return factory()
}

export const useCallback = fn => {
  cursor++

  return fn
}

export const useEffect = effect => {
  cursor++

  if (typeof effect === 'function') {
    effect()
  }
}

export const useRef = initial => {
  const key = cursor++

  if (!(key in hooks)) {
    hooks[key] = { current: initial }
  }

  return hooks[key]
}
