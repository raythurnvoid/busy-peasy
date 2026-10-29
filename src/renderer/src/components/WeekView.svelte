<script lang="ts">
  import { tick } from 'svelte'
  import type { Calendar, CalendarEvent, Times } from '../../../shared/api'
  import { eventName } from '../../../shared/events'
  import { drag } from '../lib/drag'
  import { allDayMore, inAllDayRow, layoutAllDay, layoutDay } from '../lib/layout'
  import { formats, prefs, spokenTime } from '../lib/settings.svelte'
  import {
    addDays,
    allDayTimes,
    atMinute,
    createRange,
    dateKey,
    daysBetween,
    fromDateKey,
    isSameDay,
    moveDates,
    moveTimes,
    pcZone,
    resizeEnd,
    snapDelta,
    timeZoneLabel,
    zoneHourLabels,
    zoneLabel
  } from '../lib/time'
  import EventChip from './EventChip.svelte'

  let {
    days,
    events,
    calendars,
    secondary,
    canDrag,
    newEvent,
    onopen,
    onmenu,
    oncreate,
    onmove,
    onday
  }: {
    // The days to show: one for the day view, up to 7 for the week (fewer without weekends).
    days: Date[]
    events: CalendarEvent[]
    calendars: Calendar[]
    // The second zone of the gutter, from the settings. null: off.
    secondary: { zone: string; label: string } | null
    // false: the event cannot be moved or resized (an invite, a view-only calendar, ...).
    canDrag: (event: CalendarEvent) => boolean
    // The placeholder of a new event with these times, shown while a drag creates one.
    newEvent: (times: Times) => CalendarEvent
    onopen: (event: CalendarEvent, anchor: HTMLElement) => void
    // Right-click or Shift+F10: the color menu.
    onmenu: (event: CalendarEvent, anchor: HTMLElement, e: MouseEvent) => void
    // A click or a drag on empty space: a timed slot, or days in the all-day row. end: where the drag stopped.
    oncreate: (start: Date, allDay: boolean, point: { x: number; y: number }, end?: Date) => void
    // A drag moved or resized the event to these times (maybe the same ones).
    onmove: (event: CalendarEvent, times: Times) => void
    // A day header was clicked: Google opens that day in the Day view.
    onday: (day: Date) => void
  } = $props()

  // Boxes shorter than this show title and time on one line.
  const COMPACT_PX = 34
  // The all-day row shows at most this many rows; more fold into "N more", like Google.
  const MAX_ROWS = 3
  // While dragging near the top or bottom edge, the grid scrolls this much per frame.
  const EDGE_PX = 24
  const SCROLL_PX = 20
  // The id of the moving copy, so it does not clash with the original in keyed lists.
  const COPY = -2

  let now = $state(new Date())
  let root: HTMLDivElement | undefined = $state()
  let body: HTMLDivElement | undefined = $state()
  let scroller: HTMLDivElement | undefined = $state()
  let scrollerHeight = $state(0)
  let toggle: HTMLButtonElement | undefined = $state()
  let allDayOpen = $state(false)
  // The one day cell with tabindex 0 (roving tabindex), so Tab enters the grid once. day -1: today, or the first day.
  let focus: { day: number; row: 'all' | 'time' } = $state({ day: -1, row: 'time' })
  // The drag in progress. event: the one moved or resized; null while creating. times: what it would get.
  let preview: { event: CalendarEvent | null; times: Times } | null = $state(null)
  // Runs the preview again with the last pointer, after the grid scrolled.
  let follow: (() => void) | null = null
  let pointer = { x: 0, y: 0 }
  let frame = 0

  // Taller hours on taller windows, like Google Calendar: 48 to 80 px, in steps of 12.
  const hourPx = $derived(Math.min(80, Math.max(48, Math.floor(scrollerHeight / 12.5 / 12) * 12)))
  const nowTop = $derived(((now.getHours() * 60 + now.getMinutes()) / 60) * hourPx)
  // 20 px is the smallest box: one line of text.
  const minMinutes = $derived((20 / hourPx) * 60)
  const columns = $derived(days.map((day) => layoutDay(events, day, minMinutes)))
  const allDay = $derived(layoutAllDay(events, days))
  const more = $derived(allDayMore(allDay.bars, days.length, MAX_ROWS))
  const folded = $derived(allDay.rows > MAX_ROWS && !allDayOpen)
  const focusDay = $derived(
    focus.day >= 0 && focus.day < days.length ? focus.day : Math.max(0, days.findIndex((d) => isSameDay(d, now)))
  )
  // The copy that follows the pointer: full column width in the grid, or a bar in the all-day row.
  const copy = $derived.by(() => preview && { ...(preview.event ?? newEvent(preview.times)), ...preview.times, id: COPY })
  const copyBoxes = $derived(copy && !inAllDayRow(copy) ? days.map((day) => layoutDay([copy], day, minMinutes)[0]) : [])
  const copyBar = $derived(copy && inAllDayRow(copy) ? layoutAllDay([copy], days).bars[0] : undefined)

  const byId = $derived(new Map(calendars.map((c) => [c.id, c])))
  const color = (event: CalendarEvent): string => byId.get(event.calendarId)?.color ?? '#039be5'
  const name = (event: CalendarEvent, day: Date): string => eventName(event, byId.get(event.calendarId), spokenTime(event), formats.date.format(day))

  // The day every gutter offset is for: today when shown, else the first day, at noon. Google uses today's offset
  // always; this one is right for the week shown. A week with a DST change can be right for part of it only.
  const refDay = $derived(atMinute(days.find((d) => isSameDay(d, now)) ?? days[0], 720))
  const secondaryLabels = $derived(secondary ? zoneHourLabels(refDay, secondary.zone, prefs.settings.hour12) : [])

  // New events start on the half hour that was clicked.
  function createAt(day: Date, e: MouseEvent): void {
    const minutes = Math.floor((e.offsetY / hourPx) * 2) * 30
    oncreate(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes), false, { x: e.clientX, y: e.clientY })
  }

  // The shown day under x (the nearest one outside the grid) and the wall-clock minutes at y, 0 to 1440.
  // Read fresh each time: the grid scrolls during a drag.
  function pointAt(x: number, y: number): { day: number; minutes: number } {
    const cols = [...body!.querySelectorAll('.col')]
    const day = cols.findIndex((c) => x < c.getBoundingClientRect().right)
    const minutes = ((y - body!.getBoundingClientRect().top) / hourPx) * 60
    return { day: day === -1 ? cols.length - 1 : day, minutes: Math.min(1440, Math.max(0, minutes)) }
  }

  // A press on an event (move or resize) or on empty space (event null: create). allDayRow: the press is in the
  // all-day row, where only whole days count.
  function startDrag(e: PointerEvent, event: CalendarEvent | null, kind: 'move' | 'resize', allDayRow: boolean): void {
    const press = pointAt(e.clientX, e.clientY)
    const update = (): void => {
      const at = pointAt(pointer.x, pointer.y)
      const shift = daysBetween(days[press.day], days[at.day])
      let times: Times
      if (event && kind === 'resize') {
        times = { start: event.start, end: resizeEnd(event.start, days[press.day], at.minutes), allDay: false, startDate: null, endDate: null }
      } else if (event) {
        times = event.allDay ? moveDates(event, shift) : moveTimes(event, shift, allDayRow ? 0 : snapDelta(at.minutes - press.minutes))
      } else if (allDayRow) {
        const [first, last] = [days[Math.min(press.day, at.day)], days[Math.max(press.day, at.day)]]
        times = allDayTimes(dateKey(first), dateKey(addDays(last, 1)))
      } else {
        const { start, end } = createRange(days[press.day], press.minutes, at.minutes)
        times = { start: start.getTime(), end: end.getTime(), allDay: false, startDate: null, endDate: null }
      }
      preview = { event, times }
    }
    drag(e, root!, kind === 'resize' ? 'ns-resize' : 'move', {
      onmove: (x, y) => {
        pointer = { x, y }
        follow = update
        update()
        if (!allDayRow) autoScroll()
      },
      onend: () => {
        const done = preview
        stopDrag()
        if (!done) return
        const { times } = done
        if (event) return onmove(event, times)
        const [start, end] = times.allDay ? [fromDateKey(times.startDate!), fromDateKey(times.endDate!)] : [new Date(times.start), new Date(times.end)]
        oncreate(start, times.allDay, pointer, end)
      },
      oncancel: stopDrag
    })
  }

  function stopDrag(): void {
    preview = null
    follow = null
    cancelAnimationFrame(frame)
  }

  // Near the top or bottom edge the grid scrolls, like Google. Its scroll event moves the copy along.
  function autoScroll(): void {
    cancelAnimationFrame(frame)
    const r = scroller!.getBoundingClientRect()
    const step = pointer.y < r.top + EDGE_PX ? -SCROLL_PX : pointer.y > r.bottom - EDGE_PX ? SCROLL_PX : 0
    if (!step || !follow) return
    scroller!.scrollTop += step
    frame = requestAnimationFrame(autoScroll)
  }

  // Arrows move between day cells, Enter or Space opens quick create there, like Google.
  function cellKey(e: KeyboardEvent, day: number, row: 'all' | 'time'): void {
    if (e.target !== e.currentTarget) return
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      // A time cell is the whole day: Google opens 12:00 pm there.
      if (row === 'all') oncreate(days[day], true, { x: r.left + r.width / 2, y: r.bottom })
      else oncreate(atMinute(days[day], 720), false, { x: r.left + r.width / 2, y: r.top + 12 * hourPx })
      return
    }
    const last = days.length - 1
    let next: typeof focus | null = null
    if (e.key === 'ArrowLeft') next = { day: Math.max(0, day - 1), row }
    else if (e.key === 'ArrowRight') next = { day: Math.min(last, day + 1), row }
    else if (e.key === 'Home') next = { day: 0, row }
    else if (e.key === 'End') next = { day: last, row }
    else if (e.key === 'ArrowUp' && row === 'time') next = { day, row: 'all' }
    else if (e.key === 'ArrowDown' && row === 'all') next = { day, row: 'time' }
    if (!next) return
    e.preventDefault()
    focus = next
    // preventScroll: a time cell is the whole day, so focus() would scroll the grid to midnight.
    void tick().then(() => root?.querySelector<HTMLElement>('[role="gridcell"][tabindex="0"]')?.focus({ preventScroll: true }))
  }

  // "N more" opens the whole all-day section, and focus goes to its toggle, so keyboard users keep their place.
  function showAllDay(): void {
    allDayOpen = true
    void tick().then(() => toggle?.focus())
  }

  $effect(() => {
    const timer = setInterval(() => (now = new Date()), 30_000)
    return () => clearInterval(timer)
  })

  // The current time about a third from the top. Also for Today, like Google.
  export function scrollToNow(): void {
    now = new Date()
    scroller!.scrollTop = Math.max(0, nowTop - scrollerHeight / 3)
  }

  // On first layout.
  let scrolled = false
  $effect(() => {
    if (scrolled || !scroller || scrollerHeight === 0) return
    scrolled = true
    scrollToNow()
  })
</script>

<div
  class="week"
  role="grid"
  aria-label={days.length === 1 ? 'Day' : 'Week'}
  style:--days={days.length}
  style:--gutter={secondary ? '8.5rem' : undefined}
  bind:this={root}
>
  <div class="head" role="row">
    <div class="gutter"></div>
    {#each days as day (day.getTime())}
      {@const today = isSameDay(day, now)}
      <div class="day-head" class:today role="columnheader">
        <!-- Opens the Day view, like Google. Also in the Day view: there it keeps focus after a week header opened it. -->
        <button
          class="day-link"
          aria-label="{formats.weekdayLong.format(day)}, {formats.dayMonth.format(day)}{today ? ', today' : ''}"
          aria-current={today ? 'date' : undefined}
          onclick={() => onday(day)}
        >
          <span class="weekday">{formats.weekday.format(day)}</span>
          <span class="date">{day.getDate()}</span>
        </button>
      </div>
    {/each}
  </div>

  <div class="all-day" role="row" style:--rows={folded ? MAX_ROWS : Math.max(1, allDay.rows)}>
    <div class="gutter tz">
      <!-- Left of the main zone, like Google. -->
      <span class="tz-labels" class:two={secondary}>
        {#if secondary}
          <!-- The title also holds the whole label, which the narrow column may cut. -->
          <span title={`${secondary.label ? `${secondary.label}: ` : ''}${zoneLabel(secondary.zone, refDay.getTime())}`}>{secondary.label || timeZoneLabel(refDay, secondary.zone)}</span>
        {/if}
        <span title={zoneLabel(pcZone(), refDay.getTime())}>{timeZoneLabel(refDay)}</span>
      </span>
      {#if allDay.rows > MAX_ROWS}
        <button
          bind:this={toggle}
          class="icon-btn fold"
          aria-expanded={allDayOpen}
          aria-label="{allDayOpen ? 'Collapse' : 'Expand'} all-day section"
          onclick={() => (allDayOpen = !allDayOpen)}
        >
          <svg viewBox="0 0 24 24">
            <path d={allDayOpen ? 'M7.4 15.4 12 10.8l4.6 4.6L18 14l-6-6-6 6z' : 'M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z'} />
          </svg>
        </button>
      {/if}
    </div>
    {#each days as day, i (day.getTime())}
      {@const count = allDay.bars.filter((b) => b.startDay <= i && b.endDay >= i).length}
      <div
        class="all-day-cell"
        style:grid-column={i + 2}
        role="gridcell"
        tabindex={focus.row === 'all' && focusDay === i ? 0 : -1}
        aria-label="{count} all-day {count === 1 ? 'event' : 'events'}, {formats.weekdayLong.format(day)}, {formats.dayMonth.format(day)}"
        onfocus={() => (focus = { day: i, row: 'all' })}
        onkeydown={(e) => cellKey(e, i, 'all')}
        onpointerdown={(e) => startDrag(e, null, 'move', true)}
        onclick={(e) => oncreate(day, true, { x: e.clientX, y: e.clientY })}
      ></div>
    {/each}
    {#each folded ? allDay.bars.filter((b) => b.row < MAX_ROWS - 1) : allDay.bars as bar (bar.event.id)}
      <!-- The chip inside is the button; the wrapper only starts a drag. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="bar"
        class:starts-before={bar.startsBefore}
        class:ends-after={bar.endsAfter}
        class:dragging={bar.event.id === preview?.event?.id}
        style:grid-column="{bar.startDay + 2} / {bar.endDay + 3}"
        style:grid-row={bar.row + 1}
        onpointerdown={(e) => (canDrag(bar.event) ? startDrag(e, bar.event, 'move', true) : drag(e, root!))}
      >
        <EventChip
          event={bar.event}
          color={color(bar.event)}
          now={now.getTime()}
          compact
          timeLabel={bar.event.allDay ? '' : formats.time.format(bar.event.start)}
          name={name(bar.event, days[bar.startDay])}
          onopen={(anchor) => onopen(bar.event, anchor)}
          onmenu={(anchor, e) => onmenu(bar.event, anchor, e)}
        />
      </div>
    {/each}
    {#if folded}
      {#each more as count, i (i)}
        {#if count}
          <button class="more" style:grid-column={i + 2} style:grid-row={MAX_ROWS} aria-label="{count} more events" onclick={showAllDay}>
            {count} more
          </button>
        {/if}
      {/each}
    {/if}
    {#if copyBar}
      <div
        class="bar copy"
        style:grid-column="{copyBar.startDay + 2} / {copyBar.endDay + 3}"
        style:grid-row={(allDay.bars.find((b) => b.event.id === preview?.event?.id)?.row ?? 0) + 1}
      >
        <EventChip
          event={copyBar.event}
          color={color(copyBar.event)}
          now={now.getTime()}
          compact
          timeLabel={copyBar.event.allDay ? '' : formats.time.format(copyBar.event.start)}
        />
      </div>
    {/if}
  </div>

  <div class="scroll" bind:this={scroller} bind:clientHeight={scrollerHeight} onscroll={() => follow?.()}>
    <div class="body" role="row" style:--hour="{hourPx}px" bind:this={body}>
      <div class="gutter hours" aria-hidden="true">
        {#each secondaryLabels as label, h (h)}
          <span class="hour-label second" style:top="{h * hourPx}px">{label}</span>
        {/each}
        {#each formats.hourLabels as label, h (h)}
          <span class="hour-label" style:top="{h * hourPx}px">{label}</span>
        {/each}
      </div>
      {#each days as day, i (day.getTime())}
        <div
          class="col"
          role="gridcell"
          tabindex={focus.row === 'time' && focusDay === i ? 0 : -1}
          aria-label="{columns[i].length} {columns[i].length === 1 ? 'event' : 'events'}, {formats.weekdayLong.format(day)}, {formats.dayMonth.format(day)}"
          onfocus={() => (focus = { day: i, row: 'time' })}
          onkeydown={(e) => cellKey(e, i, 'time')}
          onpointerdown={(e) => e.target === e.currentTarget && startDrag(e, null, 'move', false)}
          onclick={(e) => e.target === e.currentTarget && createAt(day, e)}
        >
          {#each columns[i] as box (box.event.id)}
            {@const height = ((box.bottom - box.top) / 60) * hourPx - 2}
            {@const draggable = canDrag(box.event)}
            <!-- The chip inside is the button; the wrapper only starts a drag. -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="box"
              class:dragging={box.event.id === preview?.event?.id}
              style:top="{(box.top / 60) * hourPx}px"
              style:height="{height}px"
              style:left="calc((100% - 12px) * {box.col / box.cols})"
              style:width="calc((100% - 12px) * {box.span / box.cols})"
              onpointerdown={(e) => (draggable ? startDrag(e, box.event, 'move', false) : drag(e, root!))}
            >
              <EventChip
                event={box.event}
                color={color(box.event)}
                now={now.getTime()}
                compact={height < COMPACT_PX}
                timeLabel={formats.time.formatRange(box.event.start, box.event.end)}
                name={name(box.event, day)}
                onopen={(anchor) => onopen(box.event, anchor)}
                onmenu={(anchor, e) => onmenu(box.event, anchor, e)}
              />
              <!-- Resize: the bottom 8 px of the event's last piece, like Google. A plain click still opens it. -->
              {#if draggable && box.event.end <= addDays(day, 1).getTime()}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <div
                  class="grip"
                  role="presentation"
                  onpointerdown={(e) => {
                    e.stopPropagation()
                    startDrag(e, box.event, 'resize', false)
                  }}
                  onclick={(e) => onopen(box.event, e.currentTarget.parentElement!)}
                  oncontextmenu={(e) => (e.preventDefault(), e.stopPropagation(), onmenu(box.event, e.currentTarget.parentElement!, e))}
                ></div>
              {/if}
            </div>
          {/each}
          {#if copyBoxes[i]}
            {@const piece = copyBoxes[i]}
            {@const height = ((piece.bottom - piece.top) / 60) * hourPx - 2}
            <div class="box copy" style:top="{(piece.top / 60) * hourPx}px" style:height="{height}px">
              <EventChip
                event={piece.event}
                color={color(piece.event)}
                now={now.getTime()}
                compact={height < COMPACT_PX}
                timeLabel={formats.time.formatRange(piece.event.start, piece.event.end)}
              />
            </div>
          {/if}
          {#if isSameDay(day, now)}
            <div class="now" style:top="{nowTop}px"></div>
          {/if}
        </div>
      {/each}
    </div>
  </div>
</div>

<style>
  .week {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    /* Like Google: no text selection when a drag starts. */
    user-select: none;
  }

  .head,
  .all-day,
  .body {
    display: grid;
    grid-template-columns: var(--gutter, 4.5rem) repeat(var(--days), minmax(0, 1fr));
  }

  /* Keep the fixed rows aligned with the scrolling grid below its scrollbar. */
  .head,
  .all-day {
    overflow-y: hidden;
    scrollbar-gutter: stable;
  }

  .day-head {
    display: flex;
    justify-content: center;
    padding-top: 0.75rem;
    height: 5.25rem;
  }

  .day-link {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    height: fit-content;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
  }

  .day-head:not(.today) .day-link:hover .date {
    background: var(--hover);
  }

  .weekday {
    font-size: 0.6875rem;
    font-weight: 500;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--on-surface-variant);
  }

  .date {
    display: grid;
    place-items: center;
    width: 2.875rem;
    height: 2.875rem;
    border-radius: 50%;
    font-size: 1.625rem;
  }

  .today .weekday {
    color: var(--primary);
  }

  .today .date {
    background: var(--primary);
    color: var(--on-primary);
  }

  .all-day {
    grid-template-rows: repeat(var(--rows), 1.5rem);
    padding-bottom: 0.25rem;
    border-bottom: 1px solid var(--grid-line);
  }

  .all-day > .gutter {
    grid-row: 1 / -1;
  }

  .all-day-cell {
    grid-row: 1 / -1;
    border-left: 1px solid var(--grid-line);
  }

  .bar {
    min-width: 0;
    height: 1.375rem;
    padding: 0 0.5rem 0 1px;
  }

  .tz {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    justify-content: flex-end;
    padding: 0 0.5rem 0.25rem 0;
    font-size: 0.625rem;
    color: var(--on-surface-variant);
  }

  /* Two columns that line up with the hour labels below. */
  .tz-labels.two {
    display: flex;
  }

  .tz-labels.two > span {
    width: 4rem;
    overflow: hidden;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Below the zone label, like Google. */
  .fold {
    width: 1.5rem;
    height: 1.5rem;
  }

  .fold svg {
    width: 1.25rem;
    height: 1.25rem;
  }

  .more {
    min-width: 0;
    height: 1.375rem;
    margin-right: 0.5rem;
    padding: 0 0.5rem;
    border: 0;
    border-radius: 0.375rem;
    background: transparent;
    font-size: 0.75rem;
    font-weight: 500;
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }

  .more:hover {
    background: var(--hover);
  }

  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    scrollbar-gutter: stable;
  }

  .body {
    position: relative;
    height: calc(24 * var(--hour));
  }

  .hours {
    position: relative;
  }

  .hour-label {
    position: absolute;
    right: 0.5rem;
    transform: translateY(-50%);
    font-size: 0.6875rem;
    font-weight: 500;
    line-height: 1rem;
    color: var(--on-surface-variant);
  }

  .hour-label.second {
    right: 4.5rem;
  }

  .col {
    position: relative;
    border-left: 1px solid var(--grid-line);
    background-image: linear-gradient(var(--grid-line) 1px, transparent 1px);
    background-size: 100% var(--hour);
  }

  .box {
    position: absolute;
    padding-left: 1px;
  }

  /* While dragging, the original stays in place, faded, like Google. */
  .dragging {
    opacity: 0.5;
  }

  /* The copy that follows the pointer: full column width, above the rest, with a shadow. The radius is the chip's. */
  .copy {
    z-index: 2;
    pointer-events: none;
    border-radius: 0.375rem;
    box-shadow:
      0 6px 10px rgb(0 0 0 / 14%),
      0 1px 18px rgb(0 0 0 / 12%),
      0 3px 5px rgb(0 0 0 / 20%);
  }

  .box.copy {
    left: 0;
    width: calc(100% - 12px);
  }

  .grip {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 8px;
    cursor: ns-resize;
  }

  .now {
    position: absolute;
    left: -1px;
    right: 0;
    height: 2px;
    margin-top: -1px;
    background: var(--now);
    pointer-events: none;
    z-index: 1;
  }

  .now::before {
    content: '';
    position: absolute;
    left: -6px;
    top: -5px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--now);
  }

  @media (forced-colors: active) {
    /* Shadows are gone in forced colors, so the copy gets an outline. */
    .copy {
      outline: 2px dashed CanvasText;
    }

    /* Backgrounds are gone too: the now line and today's date keep a system color. */
    .now,
    .now::before,
    .today .date {
      forced-color-adjust: none;
      background: Highlight;
      color: HighlightText;
    }
  }
</style>
