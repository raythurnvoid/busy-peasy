<script lang="ts">
  import { pcZone } from '../lib/time'
  import ZonePicker from './ZonePicker.svelte'

  // Google's "Event time zone" dialog. The edit dialog keeps the wall times, so the moment moves, like Google.
  let {
    startZone,
    endZone,
    at,
    endAt,
    city,
    onanswer
  }: {
    startZone: string
    endZone: string
    // The event's start and end, for the offsets in the labels.
    at: number
    endAt: number
    // false: an Outlook event (see zoneLabel).
    city: boolean
    // The zones the user chose. null: Cancel, nothing changes.
    onanswer: (zones: { start: string; end: string } | null) => void
  } = $props()

  // svelte-ignore state_referenced_locally
  let start = $state(startZone)
  // svelte-ignore state_referenced_locally
  let end = $state(endZone)
  // svelte-ignore state_referenced_locally
  let separate = $state(startZone !== endZone)

  let dialog: HTMLDialogElement | undefined = $state()
  let startField: ZonePicker | undefined = $state()

  $effect(() => {
    dialog?.showModal()
    // The start zone, not OK like Google: the user came to change it, so this saves two Tabs.
    startField?.focus()
  })

  // close() gives focus back to the "Time zone" button.
  function answer(zones: { start: string; end: string } | null): void {
    dialog?.close()
    onanswer(zones)
  }
</script>

<!-- Keys stay in this dialog: the edit dialog behind it must not act on Esc, Tab or Ctrl+S. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<dialog
  bind:this={dialog}
  aria-labelledby="zone-dialog-title"
  onkeydown={(e) => e.stopPropagation()}
  oncancel={(e) => {
    // Esc is Cancel. An open list closes first (ZonePicker).
    e.preventDefault()
    answer(null)
  }}
>
  <h2 id="zone-dialog-title">Event time zone</h2>
  <label class="check">
    <!-- The first time, the end starts from the start zone it followed; later it keeps the end the user had. -->
    <input
      type="checkbox"
      bind:checked={separate}
      onchange={() => separate && startZone === endZone && end === endZone && (end = start)}
    />
    Use separate start and end time zones
  </label>
  <div class="fields">
    <!-- Visible labels, like Google's, so two equal boxes say which is which. -->
    <div class="field">
      <span>Event start time zone</span>
      <ZonePicker bind:this={startField} id="zone-start" label="Event start time zone" bind:value={start} {at} {city} />
    </div>
    <!-- Off: the end follows the start. -->
    <div class="field">
      <span>Event end time zone</span>
      {#if separate}
        <ZonePicker id="zone-end" label="Event end time zone" bind:value={end} at={endAt} {city} />
      {:else}
        <ZonePicker id="zone-end" label="Event end time zone" value={start} at={endAt} {city} disabled />
      {/if}
    </div>
    <button
      type="button"
      class="icon-btn"
      aria-label="Swap time zones"
      title="Swap time zones"
      disabled={!separate}
      onclick={() => ([start, end] = [end, start])}
    >
      <svg viewBox="0 0 24 24"><path d="M6.99 11 3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z" /></svg>
    </button>
  </div>
  <div class="buttons">
    <!-- Applies at once, like Google. Ours is this PC's zone, the app's main zone. -->
    <button type="button" class="pill-btn current" onclick={() => answer({ start: pcZone(), end: pcZone() })}>Use current time zone</button>
    <button type="button" class="pill-btn" onclick={() => answer(null)}>Cancel</button>
    <button type="button" class="filled-btn" onclick={() => answer({ start, end: separate ? end : start })}>OK</button>
  </div>
</dialog>

<style>
  dialog {
    width: min(32rem, calc(100vw - 2rem));
    padding: 1.5rem;
    border: 0;
    border-radius: 1.75rem;
    background: var(--surface-container);
    color: var(--on-surface);
    accent-color: var(--primary);
    /* The zone list hangs below the dialog, like Google's, instead of scrolling it and covering OK. */
    overflow: visible;
  }

  dialog::backdrop {
    background: rgb(0 0 0 / 32%);
  }

  h2 {
    margin: 0 0 1rem;
    font-size: 1.375rem;
    font-weight: 400;
  }

  .check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .fields {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.75rem 0.5rem;
    margin: 1rem 0 1.5rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .field span {
    color: var(--on-surface-variant);
    font-size: 0.75rem;
  }

  /* The swap button sits beside both fields. */
  .fields .icon-btn {
    grid-column: 2;
    grid-row: 1 / 3;
    align-self: center;
  }

  .icon-btn:disabled {
    opacity: 0.38;
    cursor: default;
  }

  .buttons {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  .current {
    margin-right: auto;
  }

  @media (forced-colors: active) {
    dialog {
      border: 1px solid CanvasText;
    }
  }
</style>
