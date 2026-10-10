// Minimal stand-in for `react/jsx-runtime`: the plugin calls `jsx`/`jsxs`
// directly, so elements can be plain objects and no DOM is needed.
export const jsx = (type, props, key) => ({ key, props: props || {}, type })
export const jsxs = jsx
export const Fragment = 'Fragment'
