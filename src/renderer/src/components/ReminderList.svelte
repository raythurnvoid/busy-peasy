<script lang="ts">
  import type { EventReminder } from '../../../shared/api'
  import { MAX_REMINDER_MINUTES, MIN_ALL_DAY_MINUTES, allDayParts } from '../../../shared/reminders'
  import { formats } from '../lib/settings.svelte'
  import { REMINDER_UNITS, allDayReminderText, reminderUnit } from '../lib/time'

  // Edits a list of reminders, like Google Calendar's notifications: [type] [number] [unit] before.
  // All-day events, like Google: [type] [number] [days|weeks] before at [time].
  let { reminders = $bindable(), label, allDay = false }: { reminders: EventReminder[]; label: string; allDay?: boolean } = $props()

  const units = $derived(allDay ? REMINDER_UNITS.filter((u) => u.minutes >= 1440) : REMINDER_UNITS)
  const pad = (n: number): string => String(n).padStart(2, '0')

  // Each row keeps its unit, so "2 hours" stays "2 hours" while the user types. time: HH:MM, all-day only.
  function rowOf(r: EventReminder): { amount: number; unit: number; time: string; alarm: boolean } {
    if (!allDay) return { amount: r.minutes / reminderUnit(r.minutes), unit: reminderUnit(r.minutes), time: '', alarm: r.alarm }
    const { days, time } = allDayParts(r.minutes)
    const unit = days > 0 && days % 7 === 0 ? 10_080 : 1440
    return { amount: (days * 1440) / unit, unit, time: `${pad(Math.floor(time / 60))}:${pad(time % 60)}`, alarm: r.alarm }
  }

  function minutesOf(r: ReturnType<typeof rowOf>): number {
    const before = Math.round((r.amount || 0) * r.unit)
    if (!allDay) return Math.min(MAX_REMINDER_MINUTES, Math.max(0, before))
    const [h, m] = r.time.split(':').map(Number)
    return Math.min(MAX_REMINDER_MINUTES, Math.max(MIN_ALL_DAY_MINUTES, before - (h * 60 + m || 0)))
  }

  // Every 15 minutes, plus a time set another way (e.g. 09:38). A list, not a time field: the native field ignores the
  // app's 12/24 h setting.
  const QUARTERS = Array.from({ length: 96 }, (_, i) => `${pad(Math.floor(i / 4))}:${pad((i % 4) * 15)}`)
  const timesFor = (time: string): string[] => (QUARTERS.includes(time) ? QUARTERS : [...QUARTERS, time].sort())
  function timeLabel(time: string): string {
    const [h, m] = time.split(':').map(Number)
    return formats.time.format(new Date(2000, 0, 1, h, m))
  }

  // svelte-ignore state_referenced_locally
  let rows = $state(reminders.map(rowOf))

  $effect(() => {
    reminders = rows.map((r) => ({ minutes: minutesOf(r), alarm: r.alarm }))
  })
</script>

<div class="reminders" role="group" aria-label={label}>
  {#each rows as row, i (row)}
    <!-- All-day rows are named by their text, like Google's list. -->
    <div class="reminder" role={allDay ? 'group' : undefined} aria-label={allDay ? allDayReminderText(minutesOf(row), formats.time) : undefined}>
      <select aria-label="Reminder {i + 1} type" bind:value={row.alarm}>
        <option value={false}>Notification</option>
        <option value={true}>Alarm</option>
      </select>
      <input
        type="number"
        aria-label={allDay ? `Reminder ${i + 1} days or weeks before` : `Reminder ${i + 1} time`}
        min="0"
        max={Math.floor(MAX_REMINDER_MINUTES / row.unit)}
        step="1"
        required
        bind:value={row.amount}
      />
      <select aria-label="Reminder {i + 1} unit" bind:value={row.unit}>
        {#each units as unit (unit.minutes)}
          <option value={unit.minutes}>{unit.label}</option>
        {/each}
      </select>
      {#if allDay}
        <span>before at</span>
        <select aria-label="Reminder {i + 1} time of day" bind:value={row.time}>
          {#each timesFor(row.time) as time (time)}
            <option value={time}>{timeLabel(time)}</option>
          {/each}
        </select>
      {:else}
        <span>before</span>
      {/if}
      <button type="button" class="icon-btn" aria-label="Remove reminder {i + 1}" title="Remove" onclick={() => rows.splice(i, 1)}>
        <svg viewBox="0 0 24 24"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z" /></svg>
      </button>
    </div>
  {/each}
  {#if rows.some((r) => r.alarm)}
    <p class="note">An alarm shows on every screen and rings until you join, snooze or dismiss it.</p>
  {/if}
  {#if allDay && rows.some((r) => !r.amount)}
    <p class="note">On the same day: only this app reminds you. Google and Outlook cannot store it.</p>
  {/if}
  <!-- All-day: "The day before at 09:00", like Google's "Add notification". -->
  <button
    type="button"
    class="pill-btn"
    onclick={() => rows.push(allDay ? { amount: 1, unit: 1440, time: '09:00', alarm: false } : { amount: 10, unit: 1, time: '', alarm: false })}
  >
    Add reminder
  </button>
</div>

<style>
  .reminders {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
  }

  .reminder {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  select,
  input {
    height: 2.25rem;
    padding: 0 0.5rem;
    border: 1px solid var(--outline);
    border-radius: 0.25rem;
    background: var(--surface);
    color: inherit;
    font: inherit;
  }

  input {
    width: 4.5rem;
  }

  .note {
    margin: 0;
    color: var(--on-surface-variant);
    font-size: 0.8125rem;
  }
</style>
