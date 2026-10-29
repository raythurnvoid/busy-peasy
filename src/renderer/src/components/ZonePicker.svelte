<script lang="ts">
  import { tick } from 'svelte'
  import { searchZones, zoneLabel, zoneList } from '../lib/time'

  // A time zone field like Google's: type a city, zone or country, or browse the whole list.
  let {
    id,
    label,
    value = $bindable(),
    at,
    city = true,
    disabled = false
  }: {
    // Makes the list and option ids unique on the page.
    id: string
    label: string
    // IANA id.
    value: string
    // The moment whose offsets the labels show.
    at: number
    // false: the field shows the picked zone without a city (an Outlook zone, see zoneLabel).
    city?: boolean
    disabled?: boolean
  } = $props()

  let field: HTMLInputElement | undefined = $state()
  let text = $state('')
  let focused = $state(false)
  let open = $state(false)
  // The user typed since the field got focus. Before that the whole list shows.
  let typed = $state(false)
  let active = $state(0)

  // Built only when the list opens, then again only for another moment.
  const all = $derived(zoneList(at))
  const matches = $derived.by(() => {
    if (!open) return []
    return typed ? searchZones(all, text) : all
  })
  const shown = $derived(focused ? text : zoneLabel(value, at, city))

  // The parent sets the first focus.
  export function focus(): void {
    field?.focus()
  }

  function openList(): void {
    if (open) return
    open = true
    // The picked zone, so the list starts there.
    active = Math.max(0, matches.findIndex((z) => z.zone === value))
  }

  function pick(zone: string): void {
    value = zone
    text = zoneLabel(zone, at, city)
    typed = false
    open = false
    // Like Google: typing again replaces the picked name.
    void tick().then(() => field?.select())
  }

  function onkey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) return openList()
      if (matches.length > 0) active = (active + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length
    } else if (e.key === 'Enter') {
      // Enter picks here; it never saves.
      e.preventDefault()
      if (matches[active]) pick(matches[active].zone)
    } else if (e.key === 'Escape' && open) {
      // Closes only the list. The next Esc is the dialog's.
      e.preventDefault()
      e.stopPropagation()
      open = false
    }
  }

  // Keep the active row in view while the keys move it.
  $effect(() => {
    if (!open) return
    const row = active
    void tick().then(() => document.getElementById(`${id}-option-${row}`)?.scrollIntoView({ block: 'nearest' }))
  })
</script>

<div class="combo">
  <input
    bind:this={field}
    value={shown}
    role="combobox"
    aria-label={label}
    placeholder="Search for a city or country"
    autocomplete="off"
    aria-autocomplete="list"
    aria-expanded={open}
    aria-controls={open ? `${id}-list` : undefined}
    aria-activedescendant={open && matches[active] ? `${id}-option-${active}` : undefined}
    {disabled}
    onfocus={(e) => {
      focused = true
      typed = false
      text = zoneLabel(value, at, city)
      e.currentTarget.select()
    }}
    onclick={openList}
    oninput={(e) => {
      text = e.currentTarget.value
      typed = true
      open = true
      active = 0
    }}
    onblur={() => {
      // Unfinished text keeps the last picked zone, like Google.
      focused = false
      open = false
    }}
    onkeydown={onkey}
  />
  {#if open}
    <ul id="{id}-list" class="options" role="listbox" aria-label={label}>
      {#each matches as option, i (option.zone)}
        <!-- The keys work in the field (aria-activedescendant); a click keeps focus there. -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          id="{id}-option-{i}"
          role="option"
          aria-label={option.country ? `${option.label}, ${option.country}` : option.label}
          aria-selected={i === active}
          onpointerdown={(e) => e.preventDefault()}
          onclick={() => pick(option.zone)}
        >
          <span>{option.label}</span>
          {#if option.country}<span class="sub">{option.country}</span>{/if}
        </li>
      {:else}
        <li role="option" aria-selected="false" aria-disabled="true" class="none">No matches found</li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .combo {
    position: relative;
    display: flex;
    flex-direction: column;
  }

  input {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--outline);
    border-radius: 0.25rem;
    background: var(--surface);
    color: inherit;
    font: inherit;
  }

  input:disabled {
    opacity: 0.38;
  }

  .options {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    z-index: 1;
    /* Small windows: the list hangs below the dialog, so it must stay on screen. */
    max-height: min(16rem, 40vh);
    margin: 0;
    padding: 0.5rem 0;
    overflow-y: auto;
    border-radius: 0.25rem;
    background: var(--surface);
    box-shadow: 0 2px 6px rgb(0 0 0 / 30%);
    list-style: none;
  }

  li {
    display: flex;
    flex-direction: column;
    padding: 0.375rem 1rem;
    cursor: pointer;
  }

  li[aria-selected='true'] {
    background: var(--hover);
  }

  .none {
    color: var(--on-surface-variant);
    cursor: default;
  }

  .sub {
    color: var(--on-surface-variant);
    font-size: 0.75rem;
  }

  @media (forced-colors: active) {
    .options {
      border: 1px solid CanvasText;
    }

    /* The background is dropped in forced colors, so the active row needs the system mark, like GuestList. */
    li[aria-selected='true'] {
      background: Highlight;
      color: HighlightText;
      forced-color-adjust: none;
    }
  }
</style>
