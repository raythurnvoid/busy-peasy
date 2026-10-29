<script lang="ts">
  import type { Snippet } from 'svelte'

  // A card next to what was clicked. A click outside or Esc closes it, like Google Calendar.
  // The backdrop takes that outside click, so it does not also start a new event in the grid.
  let {
    anchor,
    label,
    width = '28rem',
    onclose,
    children
  }: {
    anchor: { left: number; top: number; right: number; bottom: number }
    label: string
    width?: string
    onclose: () => void
    children: Snippet
  } = $props()

  const GAP = 8
  let card: HTMLDivElement | undefined = $state()
  let cardWidth = $state(0)
  let cardHeight = $state(0)
  let viewWidth = $state(window.innerWidth)
  let viewHeight = $state(window.innerHeight)

  // Right of the anchor if it fits, else left of it, else as far right as the window allows.
  const left = $derived.by(() => {
    if (anchor.right + GAP + cardWidth <= viewWidth - GAP) return anchor.right + GAP
    if (anchor.left - GAP - cardWidth >= GAP) return anchor.left - GAP - cardWidth
    return Math.max(GAP, viewWidth - cardWidth - GAP)
  })
  const top = $derived(Math.max(GAP, Math.min(anchor.top, viewHeight - cardHeight - GAP)))

  $effect(() => {
    const previous = document.activeElement as HTMLElement | null
    // Focus the first control, so Enter and Tab work at once.
    focusEdge(false)
    return () => previous?.focus?.()
  })

  // Tab and Shift+Tab stay in the card, like Google Calendar. Guards at both ends move focus to the other end.
  // The browser handles all other stops.
  function focusEdge(last: boolean): void {
    // The guards are the first and last tab stops in the card.
    const stops = [...card!.querySelectorAll<HTMLElement>('*')]
      .filter((el) => el.tabIndex >= 0)
      .slice(1, -1)
    if (last) stops.reverse()
    // The first one that really takes focus (not disabled or hidden).
    for (const el of stops) {
      el.focus()
      if (document.activeElement === el) return
    }
    card!.focus()
  }
</script>

<svelte:window
  bind:innerWidth={viewWidth}
  bind:innerHeight={viewHeight}
  onkeydown={(e) => {
    // Focus is on the card itself (a click on its text), or fell out of it (its control went away): Tab goes to the
    // first or last control, not to the page behind.
    const active = document.activeElement
    if (e.key === 'Tab' && (active === card || !card?.contains(active))) {
      e.preventDefault()
      focusEdge(e.shiftKey)
    }
    if (e.key !== 'Escape') return
    e.stopPropagation()
    onclose()
  }}
/>

<div class="backdrop" onpointerdown={onclose} aria-hidden="true"></div>
<div
  class="card"
  role="dialog"
  aria-modal="true"
  aria-label={label}
  tabindex="-1"
  bind:this={card}
  bind:clientWidth={cardWidth}
  bind:clientHeight={cardHeight}
  style:width
  style:left="{left}px"
  style:top="{top}px"
>
  <!-- Focus guards: they pass focus on at once, so they are never a real stop. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <span tabindex="0" onfocus={() => focusEdge(true)}></span>
  {@render children()}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <span tabindex="0" onfocus={() => focusEdge(false)}></span>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 10;
  }

  .card {
    position: fixed;
    z-index: 11;
    max-width: calc(100vw - 1rem);
    max-height: calc(100vh - 1rem);
    overflow-y: auto;
    padding: 0.5rem 0.5rem 1rem;
    border-radius: 1.75rem;
    background: var(--surface-container);
    color: var(--on-surface);
    box-shadow:
      0 1px 8px rgb(0 0 0 / 20%),
      0 3px 4px rgb(0 0 0 / 14%),
      0 3px 3px -2px rgb(0 0 0 / 12%);
  }

  .card:focus {
    outline: none;
  }

  @media (forced-colors: active) {
    .card {
      border: 1px solid CanvasText;
    }
  }
</style>
