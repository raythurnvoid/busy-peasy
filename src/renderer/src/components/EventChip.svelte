<script lang="ts">
  import type { CalendarEvent } from '../../../shared/api'
  import { needsRsvp } from '../../../shared/events'
  import { textOn } from '../lib/color'
  import { fromDateKey } from '../lib/time'

  let {
    event,
    color,
    now,
    compact = false,
    timeLabel,
    name,
    onopen,
    onmenu
  }: {
    event: CalendarEvent
    // The calendar's color. The event's own color, if it has one, fills the chip.
    color: string
    now: number
    compact?: boolean
    // Empty: no time, like Google's all-day bars in Week.
    timeLabel: string
    // The name for screen readers (eventName). Left out on the drag copy.
    name?: string
    onopen?: (anchor: HTMLElement) => void
    // Right-click, Shift+F10 or the context-menu key: the color menu.
    onmenu?: (anchor: HTMLElement, e: MouseEvent) => void
  } = $props()

  const title = $derived(event.title || '(No title)')
  const fill = $derived(event.color ?? color)
  const on = $derived(textOn(fill))
</script>

<!-- Needs an answer: outlined. Tentative: striped. Declined: outlined and struck. Past: a light tint, like Google's
     "Reduce brightness of past events". -->
<!-- Canceled by the organizer: grey and struck, whatever the answer was. -->
<button
  type="button"
  class="chip"
  class:needs-rsvp={needsRsvp(event)}
  class:tentative={!event.cancelled && event.response === 'tentative'}
  class:declined={!event.cancelled && event.response === 'declined'}
  class:cancelled={event.cancelled}
  class:strip={event.color !== null}
  class:past={(event.allDay ? fromDateKey(event.endDate!).getTime() : event.end) <= now}
  class:compact
  style:--c={fill}
  style:--on-c={on}
  style:--away={on === '#ffffff' ? '#000000' : '#ffffff'}
  style:--cal={color}
  aria-label={name}
  data-id={event.id}
  onclick={(e) => {
    // The grid behind would start a new event.
    e.stopPropagation()
    onopen?.(e.currentTarget)
  }}
  oncontextmenu={(e) => {
    e.preventDefault()
    e.stopPropagation()
    onmenu?.(e.currentTarget, e)
  }}
>
  {#if compact}
    <span class="title">{title}</span>{#if timeLabel}<span class="time">, {timeLabel}</span>{/if}
  {:else}
    <span class="title line">{title}</span>
    <span class="time line">{timeLabel}</span>
  {/if}
</button>

<style>
  .chip {
    display: block;
    width: 100%;
    height: 100%;
    padding: 0.25rem 0.5rem;
    border: 0;
    border-radius: 0.375rem;
    background: var(--c);
    color: var(--on-c);
    font-size: 0.75rem;
    line-height: 0.9375rem;
    text-align: left;
    overflow: hidden;
    box-shadow: 0 0 0 1px var(--surface);
    cursor: pointer;
  }

  .compact {
    padding-top: 0;
    padding-bottom: 0;
    white-space: nowrap;
    text-overflow: ellipsis;
    line-height: 1.125rem;
  }

  .title {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .line {
    display: block;
  }

  /* Text in the chip color is too dark on a dark surface (and yellow too light on white), so mix it half toward the
     text color. */
  .needs-rsvp,
  .declined {
    background: var(--surface);
    color: color-mix(in srgb, var(--c) 50%, var(--on-surface));
    box-shadow: inset 0 0 0 1px var(--c);
  }

  /* The second stripe goes away from the text color (darker under white text), so the text keeps its contrast. */
  .tentative {
    background: repeating-linear-gradient(-45deg, var(--c) 0 6px, color-mix(in srgb, var(--c) 75%, var(--away)) 6px 12px);
  }

  .declined .title,
  .cancelled .title {
    text-decoration: line-through;
  }

  /* An event color fills the chip; a strip keeps the calendar's color, like Google. */
  .strip {
    border-left: 4px solid var(--cal);
  }

  /* Past: the color mixed 30% into the surface with normal text, like Google. No opacity: it made text too faint. */
  .past {
    --tint: color-mix(in srgb, var(--c) 30%, var(--surface));
    background: var(--tint);
    color: var(--on-surface);
  }

  .past.needs-rsvp,
  .past.declined {
    background: var(--surface);
    color: color-mix(in srgb, var(--c) 30%, var(--on-surface-variant));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c) 50%, var(--surface));
  }

  .past.tentative {
    background: repeating-linear-gradient(-45deg, var(--tint) 0 6px, color-mix(in srgb, var(--tint) 75%, var(--surface)) 6px 12px);
  }

  /* After .strip and .past, so its border wins and a canceled past event stays grey. */
  .cancelled {
    border: 1px solid var(--outline);
    background: var(--surface);
    color: var(--on-surface-variant);
  }

  /* Fills and stripes are gone in forced colors, so the border style tells the answer. */
  @media (forced-colors: active) {
    .chip {
      border: 1px solid CanvasText;
    }

    .needs-rsvp {
      border-style: dashed;
    }

    .tentative {
      border-style: dotted;
    }
  }
</style>
