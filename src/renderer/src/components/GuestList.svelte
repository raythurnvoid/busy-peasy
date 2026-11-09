<script lang="ts" module>
  // One guest in the edit dialog. email: the provider's address, maybe not an email for an Outlook guest.
  export interface GuestRow {
    email: string
    name?: string
    optional: boolean
  }
</script>

<script lang="ts">
  import { tick } from 'svelte'
  import type { Guest } from '../../../shared/api'
  import { MAX_GUESTS, parseGuests, pickedSuggestion } from '../../../shared/events'

  // The guest field and the guest list of the edit dialog, like Google's: type or paste addresses, pick a suggestion,
  // mark a guest optional, remove one.
  let {
    guests = $bindable(),
    host,
    own,
    accountId,
    onchange
  }: {
    // Without the organizer, in the order shown.
    guests: GuestRow[]
    // The organizer, shown at the top.
    host: { email: string; name?: string }
    // Never guests, lower case: the organizer and the user.
    own: string[]
    // Whose people to suggest.
    accountId: number
    // After guests were added or removed. message: Google's live text. first: the list had no guest before.
    onchange: (message: string, first: boolean) => void
  } = $props()

  let text = $state('')
  let invalid = $state(false)
  let field: HTMLInputElement | undefined = $state()
  let list: HTMLUListElement | undefined = $state()
  // People seen in the account's events, read when the field first gets focus. Local, so it works offline.
  let people = $state<{ accountId: number; list: Pick<Guest, 'email' | 'name'>[] } | null>(null)
  let listOpen = $state(false)
  let active = $state(0)
  // The user moved in the list with the arrow keys.
  let moved = $state(false)

  const matches = $derived.by(() => {
    const typed = text.trim().toLowerCase()
    if (!listOpen || !typed || people?.accountId !== accountId) return []
    const taken = [...own, ...guests.map((g) => g.email.toLowerCase())]
    return people.list
      .filter((p) => !taken.includes(p.email) && (p.email.includes(typed) || !!p.name?.toLowerCase().includes(typed)))
      .slice(0, 5)
  })
  // The row Enter takes, or -1: then Enter adds the typed text.
  const picked = $derived(pickedSuggestion(text, matches.length, Math.min(active, matches.length - 1), moved))

  async function loadPeople(): Promise<void> {
    const id = accountId
    if (people?.accountId === id) return
    people = { accountId: id, list: await window.api.listPeople(id).catch(() => []) }
  }

  // Adds every address in the text (a pasted list too). What is not an address stays in the field, like Google.
  function add(value: string): void {
    const { emails, invalid: bad } = parseGuests(value)
    const first = guests.length === 0
    const added: string[] = []
    const over: string[] = []
    for (const email of emails) {
      const key = email.toLowerCase()
      // Already there, or the organizer or the user: nothing to add.
      if (own.includes(key) || guests.some((g) => g.email.toLowerCase() === key)) continue
      if (guests.length >= MAX_GUESTS) {
        over.push(email)
        continue
      }
      guests.push({ email, name: people?.list.find((p) => p.email === key)?.name, optional: false })
      added.push(email)
    }
    text = [...bad, ...over].join(', ')
    invalid = bad.length > 0
    listOpen = false
    if (added.length === 0) onchange(bad.length > 0 ? 'No guests added to the event.' : '', false)
    else onchange(added.length === 1 ? `${added[0]} added to the event.` : `${added.length} guests added to the event.`, first)
  }

  function onkey(e: KeyboardEvent): void {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && matches.length > 0) {
      e.preventDefault()
      // With no row active (an address typed in full), the first key only marks the first row.
      if (picked >= 0) active = (picked + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length
      moved = true
    } else if (e.key === 'Enter') {
      // Enter adds guests here, like Google; it never saves the event.
      e.preventDefault()
      add(picked >= 0 ? matches[picked].email : text)
    } else if (e.key === 'Escape' && matches.length > 0) {
      // Closes only the list. The next Esc is the dialog's.
      e.preventDefault()
      e.stopPropagation()
      listOpen = false
    }
  }

  function remove(i: number): void {
    const [guest] = guests.splice(i, 1)
    onchange(`${guest.email} removed from event.`, false)
    // The next row's Remove, else the one above, else the field. Same column, so one key never removes two.
    void tick().then(() => {
      const buttons = list?.querySelectorAll<HTMLButtonElement>('.remove')
      ;(buttons?.[i] ?? buttons?.[i - 1] ?? field)?.focus()
    })
  }
</script>

{#snippet avatar(person: { email: string; name?: string })}
  <span class="avatar" aria-hidden="true">{(person.name || person.email || '?').charAt(0).toUpperCase()}</span>
{/snippet}

<section class="guests" aria-labelledby="guests-title">
  <h3 id="guests-title">Guests</h3>
  <div class="combo">
    <input
      bind:this={field}
      bind:value={text}
      role="combobox"
      aria-label="Guests"
      placeholder="Add guests"
      autocomplete="off"
      aria-autocomplete="list"
      aria-expanded={matches.length > 0}
      aria-controls="guest-suggestions"
      aria-activedescendant={picked >= 0 ? `guest-suggestion-${picked}` : undefined}
      aria-invalid={invalid}
      aria-describedby={invalid ? 'guest-invalid' : undefined}
      disabled={guests.length >= MAX_GUESTS}
      onfocus={loadPeople}
      oninput={() => {
        listOpen = true
        active = 0
        moved = false
        invalid = false
      }}
      onblur={() => (listOpen = false)}
      onkeydown={onkey}
      onpaste={(e) => {
        // A text field drops the line breaks of a pasted list, so a list is read here.
        const pasted = e.clipboardData?.getData('text') ?? ''
        if (!/[,;\n]/.test(pasted)) return
        e.preventDefault()
        add(`${text},${pasted}`)
      }}
    />
    {#if matches.length > 0}
      <ul id="guest-suggestions" class="suggestions" role="listbox" aria-label="Suggestions">
        {#each matches as person, i (person.email)}
          <!-- The keys work in the field (aria-activedescendant); a click keeps focus there. -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <li
            id="guest-suggestion-{i}"
            role="option"
            aria-selected={i === picked}
            onpointerdown={(e) => e.preventDefault()}
            onclick={() => add(person.email)}
          >
            {@render avatar(person)}
            <span class="who">
              <!-- Outlook often stores the address as the name: show it once. -->
              {#if person.name && person.name.toLowerCase() !== person.email}<span>{person.name}</span>{/if}
              <span class="sub">{person.email}</span>
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
  {#if invalid}<p id="guest-invalid" class="field-error" role="alert">Invalid email address.</p>{/if}
  {#if guests.length >= MAX_GUESTS}<p class="note">You can add up to {MAX_GUESTS} guests.</p>{/if}
  {#if guests.length > 0}
    <ul class="guest-list" aria-label="Guests" bind:this={list}>
      <li class="guest">
        {@render avatar(host)}
        <span class="who"><span>{host.name ?? host.email}</span><span class="sub">Organizer</span></span>
      </li>
      {#each guests as guest, i (i)}
        {@const label = `Mark ${guest.email} as ${guest.optional ? 'required' : 'optional'}`}
        <li class="guest">
          {@render avatar(guest)}
          <span class="who">
            <span>{guest.name || guest.email}</span>
            {#if guest.optional}<span class="sub">Optional</span>{/if}
          </span>
          <button
            type="button"
            class="icon-btn row-btn"
            class:shown={guest.optional}
            aria-label={label}
            title={label}
            onclick={() => (guests[i].optional = !guest.optional)}
          >
            {#if guest.optional}
              <svg viewBox="0 0 24 24"><path d="M12 6a2 2 0 1 1 0 4 2 2 0 0 1 0-4m0 9c2.7 0 5.8 1.3 6 2v1H6v-1c.2-.7 3.3-2 6-2m0-11a4 4 0 1 0 0 8 4 4 0 0 0 0-8m0 9c-2.7 0-8 1.3-8 4v3h16v-3c0-2.7-5.3-4-8-4" /></svg>
            {:else}
              <svg viewBox="0 0 24 24"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8m0 2c-2.7 0-8 1.3-8 4v2h16v-2c0-2.7-5.3-4-8-4" /></svg>
            {/if}
          </button>
          <button
            type="button"
            class="icon-btn row-btn remove"
            aria-label="Remove {guest.email} from guest list"
            title="Remove {guest.email} from guest list"
            onclick={() => remove(i)}
          >
            <svg viewBox="0 0 24 24"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4l5.6 5.6L5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z" /></svg>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  h3 {
    margin: 0 0 0.25rem;
    color: var(--on-surface-variant);
    font-size: inherit;
    font-weight: 400;
  }

  .guests {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .combo {
    position: relative;
    display: flex;
    flex-direction: column;
  }

  input {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--outline);
    border-radius: var(--radius);
    background: var(--surface);
    color: inherit;
    font: inherit;
  }

  input[aria-invalid='true'] {
    border-color: var(--error);
    box-shadow: inset 0 -2px 0 var(--error);
  }

  .suggestions,
  .guest-list {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .suggestions {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    z-index: 1;
    padding: 0.5rem 0;
    border-radius: var(--radius);
    border: 1px solid var(--line);
    background: var(--surface);
    box-shadow: var(--shadow-float);
  }

  .suggestions li,
  .guest {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-height: 2.5rem;
  }

  .suggestions li {
    padding: 0.25rem 1rem;
    cursor: pointer;
  }

  .suggestions li[aria-selected='true'] {
    background: var(--hover);
  }

  .avatar {
    flex: none;
    display: grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 50%;
    background: var(--surface-highest);
    font-weight: 500;
  }

  .who {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .sub {
    color: var(--on-surface-variant);
    font-size: 0.75rem;
  }

  .note {
    margin: 0;
    color: var(--on-surface-variant);
  }

  .field-error {
    margin: 0;
    color: var(--error);
    font-size: 0.75rem;
  }

  /* Like Google: the row buttons show on hover or keyboard focus; an optional guest's icon always shows. */
  .row-btn {
    width: 2rem;
    height: 2rem;
    opacity: 0;
  }

  .row-btn svg {
    width: 1.25rem;
    height: 1.25rem;
  }

  .guest:hover .row-btn,
  .guest:focus-within .row-btn,
  .row-btn.shown {
    opacity: 1;
  }

  /* Touch screens have no hover. */
  @media (hover: none) {
    .row-btn {
      opacity: 1;
    }
  }

  @media (forced-colors: active) {
    .suggestions {
      border: 1px solid CanvasText;
    }

    /* The background is dropped in forced colors, so the row Enter takes needs the system mark, like EventPopover. */
    .suggestions li[aria-selected='true'] {
      background: Highlight;
      color: HighlightText;
      forced-color-adjust: none;
    }
  }
</style>
