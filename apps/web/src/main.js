// Bootstrap lives in .js on purpose: it is the only place that touches the DOM
// directly (mount target), and keeping it out of a .ts file means the root
// (non-DOM) TypeScript program in the monorepo does not type-check browser
// globals it has no lib for. App.svelte and everything below is real source.
import { mount } from 'svelte'
import App from './App.svelte'
import './app.css'

const target = document.getElementById('app')
export const app = mount(App, { target })
