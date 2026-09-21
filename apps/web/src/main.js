// Bootstrap lives in .js on purpose: it is the only place that touches the DOM
// directly (mount target), and keeping it out of a .ts file means the root
// (non-DOM) TypeScript program in the monorepo does not type-check browser
// globals it has no lib for. App.svelte and everything below is real source.
//
// Fonts are imported here (not via CSS @import) so Vite fingerprints the woff2
// files into dist/assets and the loopback server serves them — no font CDN.
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import { mount } from 'svelte'
import App from './App.svelte'
import './app.css'

const target = document.getElementById('app')
export const app = mount(App, { target })
