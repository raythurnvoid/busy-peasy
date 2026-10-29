<script lang="ts">
  import type { Provider } from '../../../shared/api'

  // Asked before guests of a meeting the user organizes get email, like Google. Outlook always emails the guests,
  // so there the only choice is to go on or not.
  let {
    provider,
    kind = 'move',
    onanswer
  }: {
    provider: Provider
    // move: new times from a drag. invite / update / cancel: a save in the edit dialog. delete: the event goes.
    kind?: 'move' | 'invite' | 'update' | 'cancel' | 'delete'
    // true: send. false: do not send (Google only). null: back, nothing changes.
    onanswer: (notify: boolean | null) => void
  } = $props()

  // Google's titles; ours for Outlook (Outlook web's words not checked).
  const TEXTS = {
    move: ['Would you like to send update emails to existing Google Calendar guests?', 'Guests will get an update', 'Outlook emails the new time to all guests.'],
    invite: ['Would you like to send invitation emails to Google Calendar guests?', 'Guests will get an invitation', 'Outlook emails an invitation to new guests.'],
    update: ['Would you like to send update emails to existing Google Calendar guests?', 'Guests will get an update', 'Outlook emails the changes to all guests.'],
    cancel: [
      'Would you like to send cancellation emails to removed Google Calendar guests?',
      'Removed guests will get a cancellation',
      'Outlook emails a cancellation to removed guests.'
    ],
    delete: ['Would you like to send cancellation emails to Google Calendar guests?', 'Guests will get a cancellation', 'Outlook emails a cancellation to all guests.']
  }
  const [google, title, text] = $derived(TEXTS[kind])

  let dialog: HTMLDialogElement | undefined = $state()
  let send: HTMLButtonElement | undefined = $state()

  $effect(() => {
    dialog?.showModal()
    // Focus on Send, like Google.
    send?.focus()
  })

  // close() gives focus back to where it was (the Save or Delete button).
  function answer(notify: boolean | null): void {
    dialog?.close()
    onanswer(notify)
  }
</script>

<!-- Keys stay in this question: the popover or the edit dialog behind it must not act on Esc, Tab or Ctrl+S. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<dialog
  bind:this={dialog}
  aria-labelledby="send-updates-title"
  onkeydown={(e) => e.stopPropagation()}
  oncancel={(e) => {
    // Esc is Cancel (Back to editing).
    e.preventDefault()
    answer(null)
  }}
>
  {#if provider === 'google'}
    <h2 id="send-updates-title">{google}</h2>
  {:else}
    <h2 id="send-updates-title">{title}</h2>
    <p>{text}</p>
  {/if}
  <div class="buttons">
    <button type="button" class="pill-btn" onclick={() => answer(null)}>
      {kind === 'move' || kind === 'delete' ? 'Cancel' : 'Back to editing'}
    </button>
    {#if provider === 'google'}
      <button type="button" class="pill-btn" onclick={() => answer(false)}>Do not send</button>
    {/if}
    <button bind:this={send} type="button" class="filled-btn" onclick={() => answer(true)}
      >Send</button
    >
  </div>
</dialog>

<style>
  dialog {
    width: min(28rem, calc(100vw - 2rem));
    padding: 1.5rem;
    border: 0;
    border-radius: 1.75rem;
    background: var(--surface-container);
    color: var(--on-surface);
  }

  dialog::backdrop {
    background: rgb(0 0 0 / 32%);
  }

  h2 {
    margin: 0 0 1rem;
    font-size: 1.125rem;
    font-weight: 400;
  }

  p {
    margin: 0 0 1rem;
    color: var(--on-surface-variant);
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
