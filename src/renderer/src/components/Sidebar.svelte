<script lang="ts">
  import type { Account, Calendar } from '../../../shared/api'
  import { labelsHint } from '../../../shared/events'
  import { formats } from '../lib/settings.svelte'
  import { runAction as run, signIn, signInOutlook } from '../lib/sign-in.svelte'
  import MiniMonth from './MiniMonth.svelte'

  let {
    accounts,
    calendars,
    anchor,
    weekStart,
    onpick,
    oncreate
  }: {
    accounts: Account[]
    calendars: Calendar[]
    anchor: Date
    weekStart: number
    onpick: (day: Date) => void
    oncreate: () => void
  } = $props()

  const PROVIDER_NAMES = { outlook: 'Microsoft 365', google: 'Google' }
  // Same limit as STALE_AFTER in src/main/db/reminders.ts.
  const STALE = 15 * 60_000

  // Accounts re-render after every sync attempt (at least every 2 min), so Date.now() here stays fresh enough.
  const stale = (account: Account): boolean =>
    account.status !== 'needs-sign-in' && account.lastSyncAt !== null && Date.now() - account.lastSyncAt > STALE

  function statusText(account: Account): string {
    if (account.status === 'syncing') return 'Syncing…'
    if (account.status === 'needs-sign-in') return 'Sign-in needed'
    if (account.status === 'error') return 'Sync failed'
    if (!account.lastSyncAt) return ''
    return (stale(account) ? 'Not synced since ' : 'Synced ') + formats.time.format(account.lastSyncAt)
  }
</script>

<aside class="side">
  <!-- The view's one primary button, in the Palazzo deep orange. -->
  <button class="filled-btn create" title="Create event (c)" onclick={oncreate}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z" /></svg>
    Create
  </button>
  <MiniMonth selected={anchor} {weekStart} {onpick} />

  {#each accounts as account (account.id)}
    <section class="account" aria-label="{PROVIDER_NAMES[account.provider]} account {account.email}">
      <div class="account-head">
        <div class="email" title={account.email}>{account.email}</div>
        <div class="status" class:warn={account.status === 'needs-sign-in' || account.status === 'error' || stale(account)} title={account.lastError ?? ''}>
          {PROVIDER_NAMES[account.provider]} · {statusText(account)}
        </div>
        {#if account.status === 'needs-sign-in'}
          <button
            class="pill-btn small"
            disabled={signIn.busy || signIn.outlookOpen}
            onclick={() => (account.provider === 'outlook' ? signInOutlook(account.id) : run(window.api.addGoogleAccount))}>Sign in</button
          >
        {:else if account.status === 'error'}
          <button class="pill-btn small" disabled={signIn.busy} onclick={() => run(window.api.syncNow)}>Retry</button>
        {:else if calendars.some((c) => c.accountId === account.id && labelsHint(c, account))}
          <!-- A sign-in from before the labels scope: the 11 classic colors only. Not a warning. -->
          <div class="status">Sign in again to see all event colors.</div>
          <button class="pill-btn small" disabled={signIn.busy} onclick={() => run(window.api.addGoogleAccount)}>Sign in</button>
        {/if}
      </div>
      {#each calendars.filter((c) => c.accountId === account.id) as calendar (calendar.id)}
        <label class="calendar">
          <input
            type="checkbox"
            checked={calendar.visible}
            style:--c={calendar.color}
            onchange={(e) => window.api.setCalendarVisible(calendar.id, e.currentTarget.checked)}
          />
          <span>{calendar.name}</span>
        </label>
      {/each}
      <button class="link-btn" disabled={signIn.busy} onclick={() => {
          if (confirm(`Remove ${account.email}? Its calendars and reminders leave this app until you add it again.`)) {
            void run(() => window.api.removeAccount(account.id))
          }
        }}>Remove account</button
      >
    </section>
  {:else}
    <p class="hint">Connect your calendars</p>
  {/each}

  {#if signIn.outlookOpen}
    <p class="hint" role="status">Finish signing in in the Microsoft window. If it shows an error, start over.</p>
    <button class="pill-btn add" onclick={() => signInOutlook()}>Start over</button>
  {:else}
    <button class="pill-btn add" disabled={signIn.busy} onclick={() => signInOutlook()}>Add Microsoft 365 account</button>
  {/if}
  <button class="pill-btn add" disabled={signIn.busy} onclick={() => run(window.api.addGoogleAccount)}>Add Google account</button>
  {#if signIn.error}<p class="error" role="alert">{signIn.error}</p>{/if}
</aside>

<style>
  .side {
    padding: 0.5rem 1rem;
    overflow-y: auto;
  }

  .create {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    height: 3.5rem;
    margin-bottom: 1rem;
    padding: 0 1.5rem 0 1rem;
    font-size: 12.5px;
  }

  .create svg {
    width: 1.5rem;
    height: 1.5rem;
    fill: currentColor;
  }

  .account {
    margin-bottom: 1rem;
  }

  .account-head {
    margin-bottom: 0.25rem;
  }

  .email {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status {
    font-size: 0.8125rem;
    color: var(--on-surface-variant);
  }

  .status.warn {
    color: var(--error);
  }

  .calendar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    height: 2rem;
    cursor: pointer;
  }

  .calendar span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .calendar input {
    width: 1.125rem;
    height: 1.125rem;
    margin: 0 0 0 0.25rem;
    accent-color: var(--c);
  }

  .hint {
    color: var(--on-surface-variant);
  }

  /* Long Cinzel caps labels ("Add Microsoft 365 account"): smaller and tighter, so they fit the sidebar. */
  .add {
    display: block;
    width: 100%;
    margin-top: 0.5rem;
    padding: 0 0.5rem;
    font-size: 10.5px;
    letter-spacing: 0.05em;
  }

  .small {
    height: 2rem;
    margin-top: 0.25rem;
    padding: 0 0.75rem;
    font-size: 10.5px;
  }

  .link-btn {
    padding: 0;
    border: 0;
    background: none;
    color: var(--on-surface-variant);
    font-size: 0.8125rem;
    text-decoration: underline;
    cursor: pointer;
  }

  .error {
    color: var(--error);
  }
</style>
