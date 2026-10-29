import type { CalendarEvent } from '../../../shared/api'
import { addDays, atMinute, fromDateKey, startOfDay } from './time'

// A timed event's box inside one day column. Times are wall-clock minutes from local midnight,
// so DST days still show 00:00-24:00.
export interface TimedBox {
  event: CalendarEvent
  top: number
  bottom: number
  col: number
  cols: number
  // How many columns the box covers, from col to the right.
  span: number
}

// A bar in the all-day row. Days are indexes into the shown days; endDay is inclusive.
export interface AllDayBar {
  event: CalendarEvent
  startDay: number
  endDay: number
  row: number
  startsBefore: boolean
  endsAfter: boolean
}

// All-day events, and timed events of 24 h or more, go in the all-day row like in Google Calendar.
// 24 h by the clock, so over a DST night 13:30 to 12:30 next day stays in the grid, like Google.
export function inAllDayRow(event: CalendarEvent): boolean {
  const s = new Date(event.start)
  return event.allDay || event.end >= atMinute(addDays(s, 1), s.getHours() * 60 + s.getMinutes()).getTime()
}

// days: the shown days in order. Hidden days (weekends) may be missing, so a bar goes from the first to the last
// shown day it covers.
export function layoutAllDay(events: CalendarEvent[], days: Date[]): { bars: AllDayBar[]; rows: number } {
  const bars: AllDayBar[] = []
  for (const event of events) {
    if (!inAllDayRow(event)) continue
    const start = event.allDay ? fromDateKey(event.startDate!) : startOfDay(new Date(event.start))
    // End dates are exclusive, so the last day is the day before.
    const last = event.allDay ? addDays(fromDateKey(event.endDate!), -1) : startOfDay(new Date(event.end - 1))
    const end = last < start ? start : last
    const startDay = days.findIndex((d) => d >= start)
    const endDay = days.findLastIndex((d) => d <= end)
    if (startDay === -1 || endDay < startDay) continue
    bars.push({ event, startDay, endDay, row: 0, startsBefore: start < days[0], endsAfter: end > days[days.length - 1] })
  }
  // Longer bars first, then greedy rows.
  bars.sort((a, b) => a.startDay - b.startDay || b.endDay - a.endDay)
  const rowEnds: number[] = []
  for (const bar of bars) {
    let row = rowEnds.findIndex((end) => end < bar.startDay)
    if (row === -1) row = rowEnds.length
    rowEnds[row] = bar.endDay
    bar.row = row
  }
  return { bars, rows: rowEnds.length }
}

// With more than maxRows rows, the all-day row shows maxRows - 1 rows of bars and then "N more" per day, like Google.
// Per shown day: how many bars that "N more" stands for (0: none hidden).
export function allDayMore(bars: AllDayBar[], dayCount: number, maxRows: number): number[] {
  const rows = Math.max(0, ...bars.map((b) => b.row + 1))
  return Array.from({ length: dayCount }, (_, d) =>
    rows > maxRows ? bars.filter((b) => b.row >= maxRows - 1 && b.startDay <= d && b.endDay >= d).length : 0
  )
}

// The Schedule and search lists: events by local day, all-day ones first (not timed ones of 24 h or more, like
// Google), then by start. An event over several days
// shows once, on its first day. from (Schedule): the first day; it always shows, and events that started before it
// show on it.
export function scheduleDays(events: CalendarEvent[], from: Date | null): { day: Date; events: CalendarEvent[] }[] {
  const groups = new Map<number, CalendarEvent[]>()
  if (from) groups.set(from.getTime(), [])
  for (const event of events) {
    // The read has some slack for all-day events, so drop those that ended before the first day.
    const end = event.allDay ? fromDateKey(event.endDate!) : new Date(event.end)
    if (from && end <= from) continue
    const start = event.allDay ? fromDateKey(event.startDate!) : startOfDay(new Date(event.start))
    const key = (from && start < from ? from : start).getTime()
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(event)
  }
  return [...groups]
    .sort(([a], [b]) => a - b)
    .map(([key, list]) => ({
      day: new Date(key),
      events: list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start)
    }))
}

// Wall-clock minutes of t inside the day that starts at dayStart, clamped to 0..1440.
function minutesInDay(t: number, dayStart: Date, nextDay: Date): number {
  if (t <= dayStart.getTime()) return 0
  if (t >= nextDay.getTime()) return 1440
  const d = new Date(t)
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60
}

// minMinutes: the shortest box, so tiny events still have room for one line of text.
export function layoutDay(events: CalendarEvent[], day: Date, minMinutes: number): TimedBox[] {
  const next = addDays(day, 1)
  const boxes: TimedBox[] = []
  for (const event of events) {
    if (inAllDayRow(event) || event.end <= day.getTime() || event.start >= next.getTime()) continue
    const top = minutesInDay(event.start, day, next)
    const bottom = Math.max(minutesInDay(event.end, day, next), Math.min(1440, top + minMinutes))
    boxes.push({ event, top, bottom, col: 0, cols: 1, span: 1 })
  }
  boxes.sort((a, b) => a.top - b.top || b.bottom - a.bottom)

  // Clusters of boxes that overlap each other, directly or through other boxes.
  let cluster: TimedBox[] = []
  let clusterEnd = -1
  const flush = (): void => {
    const colEnds: number[] = []
    for (const box of cluster) {
      let col = colEnds.findIndex((end) => end <= box.top)
      if (col === -1) col = colEnds.length
      colEnds[col] = box.bottom
      box.col = col
    }
    for (const box of cluster) {
      box.cols = colEnds.length
      // Grow to the right while no box in the next column overlaps this one.
      while (
        box.col + box.span < box.cols &&
        !cluster.some((o) => o.col === box.col + box.span && o.top < box.bottom && o.bottom > box.top)
      ) {
        box.span++
      }
    }
  }
  for (const box of boxes) {
    if (box.top >= clusterEnd && cluster.length) {
      flush()
      cluster = []
    }
    cluster.push(box)
    clusterEnd = Math.max(clusterEnd, box.bottom)
  }
  if (cluster.length) flush()
  return boxes
}
