<script lang="ts">
  // "?" or Ctrl+/: the keys this app has, in Google's groups, words and order.
  let { onclose }: { onclose: () => void } = $props()

  // Each row: the action, then its keys. "Ctrl Z" is drawn as two keys.
  const GROUPS = [
    {
      name: 'Navigation',
      rows: [
        ['Previous period', 'P', 'K'],
        ['Next period', 'N', 'J'],
        ['Today', 'T'],
        ['Go to date', 'G']
      ]
    },
    {
      name: 'Views',
      rows: [
        ['Day', '1', 'D'],
        ['Week', '2', 'W'],
        ['Month', '3', 'M'],
        ['Schedule', '5', 'A']
      ]
    },
    {
      name: 'Actions',
      rows: [
        ['Create event', 'C'],
        ['Edit event', 'E'],
        ['Delete event', 'Backspace', 'Delete'],
        ['Undo last action (if possible)', 'Ctrl Z', 'Z'],
        ['Back to calendar view', 'Esc'],
        ['Save event', 'Ctrl S']
      ]
    },
    {
      name: 'Application',
      rows: [
        ['Search', '/'],
        ['Refresh', 'R'],
        ['Settings', 'S'],
        ['Open shortcut help', 'Ctrl /', '?']
      ]
    }
  ]

  let dialog: HTMLDialogElement | undefined = $state()

  $effect(() => {
    dialog?.showModal()
  })
</script>

<!-- Esc and Close close it while it is still in the page, so focus goes back to where it was. -->
<dialog bind:this={dialog} aria-labelledby="help-title" {onclose}>
  <div class="head">
    <h2 id="help-title">Keyboard shortcuts</h2>
    <!-- svelte-ignore a11y_autofocus -->
    <button class="icon-btn" aria-label="Close" autofocus onclick={() => dialog?.close()}>
      <svg viewBox="0 0 24 24"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4l5.6 5.6L5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z" /></svg>
    </button>
  </div>
  {#each GROUPS as group (group.name)}
    <h3>{group.name}</h3>
    <table>
      <tbody>
        {#each group.rows as [action, ...keys] (action)}
          <tr>
            <th scope="row">{action}</th>
            <td>
              {#each keys as key, i (key)}
                <!-- kbd has a margin on its left only, so 'or' needs a space before it. -->
                {#if i}&nbsp;or{/if}
                {#each key.split(' ') as cap (cap)}<kbd>{cap}</kbd>{/each}
              {/each}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/each}
</dialog>

<style>
  dialog {
    width: min(37.5rem, calc(100vw - 2rem));
    max-height: calc(100vh - 2rem);
    padding: 1rem 1.5rem 1.5rem;
    border: 0;
    border-radius: 1.75rem;
    background: var(--surface-container);
    color: var(--on-surface);
  }

  dialog::backdrop {
    background: rgb(0 0 0 / 32%);
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  h2 {
    margin: 0;
    font-size: 1.375rem;
    font-weight: 400;
  }

  h3 {
    margin: 1.25rem 0 0.5rem;
    font-size: 0.875rem;
    font-weight: 500;
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  th {
    padding: 0.25rem 0;
    font-weight: 400;
    text-align: left;
  }

  td {
    text-align: right;
    color: var(--on-surface-variant);
  }

  kbd {
    display: inline-block;
    min-width: 1.25rem;
    margin-left: 0.25rem;
    padding: 0 0.25rem;
    border: 1px solid var(--outline);
    border-radius: 0.25rem;
    font-family: inherit;
    text-align: center;
    color: var(--on-surface);
  }

  @media (forced-colors: active) {
    dialog,
    kbd {
      border: 1px solid CanvasText;
    }
  }
</style>
