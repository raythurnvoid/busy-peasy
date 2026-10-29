// Pointer drags on the calendar grids (WeekView, MonthView). No Svelte here: each view keeps its own preview.
//
// A view calls drag() from a pointerdown. A press that moves less than DRAG_PX stays a plain click. After that,
// onmove(x, y) runs on every move (the first call starts the drag), onend() on release, and oncancel() on Esc, a lost
// pointer or a window blur. The click that follows a drag never reaches the page.

// Like Google: 3 px is still a click, 4 px is a drag.
const DRAG_PX = 4

interface DragHandlers {
  onmove: (x: number, y: number) => void
  onend: () => void
  oncancel: () => void
}

// root: a stable element of the view (a sync reload does not re-create it), which holds the pointer capture.
// cursor: shown everywhere while the drag runs, like Google.
// No handlers: something that cannot move (an invite, a view-only event). A press that moves then does nothing, and
// its click is eaten, like Google.
export function drag(
  down: PointerEvent,
  root: HTMLElement,
  cursor?: 'move' | 'ns-resize',
  handlers?: DragHandlers
): void {
  if (down.button !== 0 || !down.isPrimary) return
  let dragging = false

  function move(e: PointerEvent): void {
    if (e.pointerId !== down.pointerId) return
    if (!dragging) {
      // Released outside the window before the drag started.
      if (!(e.buttons & 1)) return cancel()
      if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < DRAG_PX) return
      dragging = true
      // Capture only now, so a plain click still reaches the chip under the pointer.
      root.setPointerCapture(e.pointerId)
      root.addEventListener('lostpointercapture', cancel)
      window.addEventListener('blur', cancel)
      if (cursor) document.body.dataset.drag = cursor
    }
    handlers?.onmove(e.clientX, e.clientY)
  }

  function up(e: PointerEvent): void {
    if (e.pointerId !== down.pointerId) return
    const ended = dragging
    stop()
    if (!ended) return
    eatClick()
    handlers?.onend()
  }

  // Keys belong to the press, from the start: Esc cancels it, other keys do nothing (no view switch with "w" while
  // the button is down, which would leave this drag on a view that is gone).
  function key(e: KeyboardEvent): void {
    e.preventDefault()
    e.stopPropagation()
    if (e.key !== 'Escape') return
    stop()
    // The button is still down; its release must not click.
    eatClick()
    handlers?.oncancel()
  }

  function cancel(): void {
    stop()
    handlers?.oncancel()
  }

  function lost(e: PointerEvent): void {
    if (e.pointerId === down.pointerId) cancel()
  }

  function stop(): void {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', lost)
    window.removeEventListener('keydown', key, true)
    root.removeEventListener('lostpointercapture', cancel)
    window.removeEventListener('blur', cancel)
    if (root.hasPointerCapture(down.pointerId)) root.releasePointerCapture(down.pointerId)
    delete document.body.dataset.drag
  }

  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', lost)
  window.addEventListener('keydown', key, true)
}

// The click after a drag would open the popover or start a new event, so eat that one click. The next press takes
// the trap away, in case no click comes (released outside the window).
function eatClick(): void {
  const eat = (e: MouseEvent): void => {
    // A keyboard click (Enter or Space on a button) has no pointer: let it through.
    if (e.detail === 0) return
    e.stopPropagation()
    e.preventDefault()
    clear()
  }
  const clear = (): void => {
    window.removeEventListener('click', eat, true)
    window.removeEventListener('pointerdown', clear, true)
  }
  window.addEventListener('click', eat, true)
  window.addEventListener('pointerdown', clear, true)
}
