import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

// vitePreprocess lets components use `<script lang="ts">`. Svelte 5 runes are on
// by default. No kit, no routing plugin — the router is hand-rolled (hash based)
// so no extra dependency is introduced.
export default {
  preprocess: vitePreprocess(),
}
