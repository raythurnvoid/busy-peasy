<script lang="ts">
  import {
    APPROVAL_ARM_MS,
    approvalText,
    mayAnswer,
    type ApprovalAnswer,
    type ApprovalRequest
  } from '../../../shared/approval'

  // Asks the user to allow a new agent (main/ipc.ts askApproval). Agents must not answer it: main refuses their page
  // input while it is open (main/agent.ts), the buttons take only the user's own click or key (a key once the window
  // has had the focus for APPROVAL_ARM_MS, see mayAnswer), and main checks the answer again (main/ipc.ts).
  let { request, onanswer }: { request: ApprovalRequest; onanswer: (answer: ApprovalAnswer) => void } = $props()

  const text = $derived(approvalText(request))

  let dialog: HTMLDialogElement | undefined = $state()
  let notNow: HTMLButtonElement | undefined = $state()
  // When the window got the focus. null: it has none, so no key answers (a mouse click still does).
  let armedSince: number | null = null
  // Only for the look and for snapshot: the buttons are aria-disabled until then.
  let armed = $state(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  // Set when App.svelte closes the prompt.
  let closing = false

  // Starts the arm time again: now if the window has the focus, else when it gets it.
  function rearm(focused = document.hasFocus()): void {
    clearTimeout(timer)
    armed = false
    armedSince = focused ? Date.now() : null
    if (focused) timer = setTimeout(() => (armed = true), APPROVAL_ARM_MS)
  }

  $effect(() => {
    dialog?.showModal()
    // Not now first: Enter or Space from someone typing elsewhere gives nothing.
    notNow?.focus()
    rearm()
    const focus = (): void => rearm(true)
    const blur = (): void => rearm(false)
    window.addEventListener('focus', focus)
    window.addEventListener('blur', blur)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('focus', focus)
      window.removeEventListener('blur', blur)
      // Gives the focus back to where it was.
      closing = true
      dialog?.close()
    }
  })

  // App.svelte closes the prompt; main checks the answer again.
  function answer(e: Event, value: ApprovalAnswer): void {
    if (mayAnswer(e, armedSince, Date.now())) onanswer(value)
  }
</script>

<!-- Keys stay in this prompt: the page behind it must not act on Esc, Tab or Ctrl keys. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<dialog
  class="pz-panel"
  bind:this={dialog}
  role="alertdialog"
  aria-labelledby="agent-approval-title"
  aria-describedby="agent-approval-text"
  onkeydown={(e) => {
    e.stopPropagation()
    // A key from a script, or any key but the ones that answer (Tab too): the arm starts again. Someone typing
    // elsewhere, then Tab and Space, gives nothing; the user pauses 1 s first.
    if (!e.isTrusted || !['Enter', ' ', 'Escape'].includes(e.key)) rearm()
  }}
  onclose={() => {
    // Chromium can close a modal dialog on Esc without a cancel it lets us stop. Main still waits: show it again.
    if (closing) return
    dialog?.showModal()
    notNow?.focus()
    rearm()
  }}
  oncancel={(e) => {
    // Esc is Not now. Never the default close: the prompt closes only with an answer main takes.
    e.preventDefault()
    answer(e, null)
  }}
>
  <h2 id="agent-approval-title">{text.title}</h2>
  <div id="agent-approval-text">
    {#each text.lines as line (line)}
      <p>{line}</p>
    {/each}
  </div>
  <div class="buttons">
    <button type="button" class="pill-btn" aria-disabled={!armed} onclick={(e) => answer(e, 'off')}>Deny</button>
    <button bind:this={notNow} type="button" class="filled-btn" aria-disabled={!armed} onclick={(e) => answer(e, null)}
      >Not now</button
    >
    <button type="button" class="pill-btn" aria-disabled={!armed} onclick={(e) => answer(e, 'read')}
      >Allow read only</button
    >
    <button type="button" class="pill-btn" aria-disabled={!armed} onclick={(e) => answer(e, 'full')}
      >Allow full access</button
    >
  </div>
</dialog>

<style>
  dialog {
    width: min(40rem, calc(100vw - 2rem));
    padding: 1.5rem;
    color: var(--on-surface);
    box-shadow: var(--shadow-float);
  }

  dialog::backdrop {
    background: rgb(30 20 10 / 40%);
  }

  /* A whole question, so the reading face, not Cinzel caps. */
  h2 {
    margin: 0 0 1rem;
    font-family: var(--font);
    font-size-adjust: inherit;
    font-size: 1.125rem;
    font-weight: 500;
    letter-spacing: normal;
  }

  p {
    margin: 0 0 1rem;
    color: var(--on-surface-variant);
  }

  .buttons {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  /* Until keys answer: the buttons look off (no hover, app.css) but keep the focus. */
  button[aria-disabled='true'] {
    opacity: 0.6;
    cursor: default;
  }

  @media (forced-colors: active) {
    dialog {
      border: 1px solid CanvasText;
    }
  }
</style>
