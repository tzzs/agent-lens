<script lang="ts">
  // Where the spec references (§x.y) and basis notes live now: an info glyph with
  // a hover/focus tooltip, so the numbers' provenance stays one keystroke away
  // without cluttering headings.
  import Tooltip from './Tooltip.svelte'
  import Icon from './Icon.svelte'
  let { text }: { text: string } = $props()
</script>

<Tooltip {text}>
  <button type="button" class="inline-grid cursor-help place-items-center rounded-full text-ink-3 hover:text-ink-2" aria-label={text}>
    <Icon name="info" size={13} />
  </button>
</Tooltip>
