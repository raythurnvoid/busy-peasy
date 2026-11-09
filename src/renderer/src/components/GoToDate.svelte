<script lang="ts">
  import { formats } from '../lib/settings.svelte'
  import { parseDate } from '../lib/time'

  // "g": shows another date in the same view, like Google's "Go to date". Typed in the order of the app's language,
  // like every other date (20/10/2026 in en-GB). A date field would follow the Windows region format instead.
  let { initial, ongo, onclose }: { initial: Date; ongo: (day: Date) => void; onclose: () => void } = $props()

  // svelte-ignore state_referenced_locally
  let value = $state(formats.numericDate.format(initial))
  let dialog: HTMLDialogElement | undefined = $state()

  $effect(() => {
    // Focus goes to the date field, the first control. Its text is selected, so typing replaces it, like Google.
    dialog?.showModal()
    dialog?.querySelector('input')?.select()
  })
</script>

<!-- Esc, Cancel and Go close it while it is still in the page, so focus goes back to where it was. -->
<dialog class="pz-panel" bind:this={dialog} aria-labelledby="go-to-title" {onclose}>
  <form
    onsubmit={(e) => {
      e.preventDefault()
      dialog?.close()
      ongo(parseDate(value, formats.numericDate)!)
    }}
  >
    <h2 id="go-to-title">Go to date</h2>
    <!-- Not a date: the browser blocks Go and shows the message. -->
    <input
      aria-label="Date"
      required
      bind:value
      oninput={(e) =>
        e.currentTarget.setCustomValidity(
          parseDate(e.currentTarget.value, formats.numericDate) ? '' : `Enter a date like ${formats.numericDate.format(initial)}.`
        )}
    />
    <div class="buttons">
      <button type="button" class="pill-btn" onclick={() => dialog?.close()}>Cancel</button>
      <button class="filled-btn">Go</button>
    </div>
  </form>
</dialog>

<style>
  dialog {
    width: min(20rem, calc(100vw - 2rem));
    padding: 1.5rem;
    color: var(--on-surface);
    box-shadow: var(--shadow-float);
  }

  dialog::backdrop {
    background: rgb(30 20 10 / 40%);
  }

  h2 {
    margin: 0 0 1rem;
    font-size: 1.125rem;
    font-weight: 400;
  }

  input {
    width: 100%;
    height: 2.5rem;
    margin-bottom: 1.5rem;
    padding: 0 0.75rem;
    border: 1px solid var(--outline);
    border-radius: var(--radius);
    background: transparent;
    color: inherit;
    font: inherit;
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
