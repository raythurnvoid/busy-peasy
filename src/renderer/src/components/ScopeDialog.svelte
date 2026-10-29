<script lang="ts">
  import type { Scope } from '../../../shared/api'

  // Google's question before a change to one event of the user's own repeating event. The first choice is checked.
  let {
    kind,
    choices,
    guests = false,
    onanswer
  }: {
    kind: 'edit' | 'delete'
    // Two or more, in Google's order. One choice needs no question.
    choices: Scope[]
    // The series has guests: a split also invites them again.
    guests?: boolean
    // null: Cancel, nothing changes.
    onanswer: (scope: Scope | null) => void
  } = $props()

  const LABELS: Record<Scope, string> = {
    event: 'This event',
    following: 'This and following events',
    series: 'All events'
  }

  // svelte-ignore state_referenced_locally
  let picked = $state(choices[0])
  let dialog: HTMLDialogElement | undefined = $state()

  // Differs from Google (plan D-2): a split ends the series and makes a new one, so say it cannot be undone.
  const note = $derived(
    kind === 'delete'
      ? "This can't be undone."
      : `Ends this series and starts a new one. This can't be undone.${guests ? ' Guests get an update and a new invitation.' : ''}`
  )

  $effect(() => {
    dialog?.showModal()
    // The checked choice, so the arrow keys move between them at once.
    dialog?.querySelector<HTMLInputElement>('input:checked')?.focus()
  })

  // close() gives focus back to where it was (Save, Delete or the dragged event).
  function answer(scope: Scope | null): void {
    dialog?.close()
    onanswer(scope)
  }
</script>

<!-- Keys stay in this question: the popover or the edit dialog behind it must not act on Esc, Tab or Ctrl+S. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<dialog
  bind:this={dialog}
  aria-labelledby="scope-title"
  onkeydown={(e) => e.stopPropagation()}
  oncancel={(e) => {
    // Esc is Cancel.
    e.preventDefault()
    answer(null)
  }}
>
  <form
    method="dialog"
    onsubmit={(e) => {
      e.preventDefault()
      answer(picked)
    }}
  >
    <h2 id="scope-title">{kind === 'edit' ? 'Edit recurring event' : 'Delete recurring event'}</h2>
    <!-- Named by the title, so a screen reader says "Edit recurring event, grouping". -->
    <fieldset aria-labelledby="scope-title">
      {#each choices as scope (scope)}
        <label class="choice">
          <input
            type="radio"
            name="scope"
            value={scope}
            aria-describedby={scope === 'following' ? 'scope-note' : undefined}
            bind:group={picked}
          />
          {LABELS[scope]}
        </label>
        {#if scope === 'following'}<p id="scope-note" class="note">{note}</p>{/if}
      {/each}
    </fieldset>
    <div class="buttons">
      <button type="button" class="pill-btn" onclick={() => answer(null)}>Cancel</button>
      <button type="submit" class="filled-btn">OK</button>
    </div>
  </form>
</dialog>

<style>
  dialog {
    width: min(24rem, calc(100vw - 2rem));
    padding: 1.5rem;
    border: 0;
    border-radius: 1.75rem;
    background: var(--surface-container);
    color: var(--on-surface);
    accent-color: var(--primary);
  }

  dialog::backdrop {
    background: rgb(0 0 0 / 32%);
  }

  h2 {
    margin: 0 0 1rem;
    font-size: 1.375rem;
    font-weight: 400;
  }

  fieldset {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin: 0 0 1.5rem;
    padding: 0;
    border: 0;
  }

  .choice {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .note {
    margin: -0.5rem 0 0 2rem;
    color: var(--on-surface-variant);
    font-size: 0.875rem;
  }

  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  @media (forced-colors: active) {
    dialog {
      border: 1px solid CanvasText;
    }
  }
</style>
