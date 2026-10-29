<script lang="ts">
  import type { Account, Calendar, CalendarEvent } from '../../../shared/api'
  import { isInvite, labelsHint } from '../../../shared/events'
  import { textOn } from '../lib/color'
  import Popover from './Popover.svelte'

  // Google's right-click menu on an event: Delete, a line, the calendar's colors and Default. A real menu: only the
  // current item is a tab stop, and the arrow keys move between the items.
  let {
    event,
    calendar,
    account,
    anchor,
    onclose,
    ondelete,
    onpick,
    onsignin
  }: {
    event: CalendarEvent
    calendar: Calendar
    account: Account | undefined
    anchor: DOMRect
    onclose: () => void
    ondelete: () => void
    // A key of calendar.colors, or null for Default.
    onpick: (key: string | null) => void
    onsignin: () => void
  } = $props()

  const invite = $derived(isInvite(event))
  // Short forms of the popover's words: Outlook declines an invite, Google only takes it off.
  const deleteLabel = $derived(event.cancelled || (invite && account?.provider === 'google') ? 'Remove' : invite ? 'Decline and remove' : 'Delete')
  // Outside the main calendar, removing an invite would act in the owner's name, like in the popover.
  const canDelete = $derived(!invite || calendar.isPrimary)
  // A canceled event can only be removed, like Google.
  const colors = $derived(event.cancelled ? [] : calendar.colors)
  const hint = $derived(!event.cancelled && labelsHint(calendar, account))
  const CHECK = 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z'

  // The item that is the tab stop. It starts on the checked color, so Shift+F10 then Enter never deletes.
  // Popover focuses the first tab stop, which is this one.
  // svelte-ignore state_referenced_locally
  let active = $state(colors.some((c) => c.key === event.colorKey) ? `color:${event.colorKey}` : colors.length > 0 ? 'default' : canDelete ? 'delete' : 'signin')
  const tab = (item: string): number => (active === item ? 0 : -1)
  let menu: HTMLDivElement | undefined = $state()

  // Left/Up: previous, Right/Down: next, like Google, with no wrap. Home and End: the first and last item. Tab closes the
  // menu, like a native one, and focus goes back to the event.
  function move(e: KeyboardEvent): void {
    if (e.key === 'Tab') {
      e.preventDefault()
      return onclose()
    }
    const items = [...menu!.querySelectorAll<HTMLElement>('[data-item]')]
    const i = items.indexOf(document.activeElement as HTMLElement)
    const to = ({ ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 } as Record<string, number>)[e.key]
    if (to === undefined) return
    e.preventDefault()
    items[Math.max(0, Math.min(items.length - 1, to))].focus()
  }
</script>

<!-- The card is named by the event, the menu by what it is, so a screen reader does not say one name twice. -->
<Popover {anchor} label={event.title || '(No title)'} width="20rem" {onclose}>
  <div
    class="menu"
    role="menu"
    aria-label="Event options"
    tabindex="-1"
    bind:this={menu}
    onkeydown={move}
    onfocusin={(e) => (active = (e.target as HTMLElement).dataset.item ?? active)}
  >
    {#if canDelete}
      <button type="button" class="item" role="menuitem" data-item="delete" tabindex={tab('delete')} onclick={ondelete}>{deleteLabel}</button>
    {/if}
    {#if colors.length > 0}
      {#if canDelete}<div class="line" role="separator"></div>{/if}
      <div class="swatches">
        {#each colors as color (color.key)}
          <button
            type="button"
            class="swatch"
            role="menuitemradio"
            aria-checked={event.colorKey === color.key}
            aria-label={color.name}
            title={color.name}
            data-item="color:{color.key}"
            tabindex={tab(`color:${color.key}`)}
            style:--c={color.color}
            onclick={() => onpick(color.key)}
          >
            <!-- textOn: a white check is not seen on Banana. -->
            {#if event.colorKey === color.key}<svg viewBox="0 0 24 24" aria-hidden="true" style:fill={textOn(color.color)}><path d={CHECK} /></svg>{/if}
          </button>
        {/each}
      </div>
      <!-- Outlook has no Default: it takes off the categories that have a color, and keeps the others. -->
      <button
        type="button"
        class="item"
        role="menuitemradio"
        aria-checked={event.colorKey === null}
        title={account?.provider === 'outlook' ? 'Remove color categories' : undefined}
        data-item="default"
        tabindex={tab('default')}
        onclick={() => onpick(null)}
      >
        <span class="ring" style:--c={calendar.color}>
          {#if event.colorKey === null}<svg viewBox="0 0 24 24" aria-hidden="true"><path d={CHECK} /></svg>{/if}
        </span>
        Default
      </button>
    {/if}
    {#if hint}
      <button type="button" class="item" role="menuitem" data-item="signin" tabindex={tab('signin')} onclick={onsignin}>
        Sign in again to see all event colors
      </button>
    {/if}
  </div>
</Popover>

<style>
  .menu {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    outline: none;
  }

  .item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-height: 2.5rem;
    padding: 0 1rem;
    border: 0;
    border-radius: 1.25rem;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .item:hover,
  .item:focus-visible {
    background: color-mix(in srgb, var(--on-surface) 8%, transparent);
  }

  .line {
    height: 1px;
    margin: 0.25rem 0;
    background: var(--outline);
  }

  /* 9 per row, like Google's right-click menu. */
  .swatches {
    display: grid;
    grid-template-columns: repeat(9, 1.75rem);
    gap: 0.25rem;
    padding: 0.25rem 0.5rem;
  }

  .swatch {
    display: grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: var(--c);
    cursor: pointer;
  }

  .swatch:focus-visible {
    outline: 2px solid var(--on-surface);
    outline-offset: 2px;
  }

  .swatch svg {
    width: 1.125rem;
    height: 1.125rem;
  }

  .ring {
    display: grid;
    place-items: center;
    width: 1.25rem;
    height: 1.25rem;
    border: 2px solid var(--c);
    border-radius: 50%;
  }

  .ring svg {
    width: 0.875rem;
    height: 0.875rem;
    fill: var(--on-surface);
  }

  @media (forced-colors: active) {
    .swatch {
      border: 1px solid CanvasText;
      forced-color-adjust: none;
    }

    .swatch[aria-checked='true'] {
      outline: 2px solid Highlight;
      outline-offset: 2px;
    }
  }
</style>
