import { tick } from 'svelte'

// Agent commands that use the screen like a screen reader user: list the controls by role and name, click one, fill one.
// Refs are positions in the last snapshot, so they are valid until the next snapshot or action.

export interface Control {
  ref: number
  role: string
  name: string
  // The nearest named group around it, which a screen reader also says: "Every meeting" for its "Add reminder".
  group?: string
  value?: string
  checked?: boolean
  pressed?: boolean
  selected?: boolean
  expanded?: boolean
  disabled?: true
}

const CONTROLS = [
  'button',
  'a[href]',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="gridcell"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="combobox"]'
].join(', ')
const MAX_NAME = 200

let last: HTMLElement[] = []

const clean = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME)

// A <label> around its field: without the field, so a select's options are not in the name.
function labelText(label: HTMLLabelElement): string {
  const copy = label.cloneNode(true) as HTMLElement
  for (const field of copy.querySelectorAll('select, textarea, input')) field.remove()
  return copy.textContent ?? ''
}

// The accessible name, in the browser's order: aria-labelledby, aria-label, a <label>, the text, then title or
// placeholder.
function nameOf(el: HTMLElement): string {
  const by = el.getAttribute('aria-labelledby')
  if (by) return clean(by.split(' ').map((id) => document.getElementById(id)?.textContent).join(' '))
  const label = el.getAttribute('aria-label')
  if (label) return clean(label)
  const labels = (el as HTMLInputElement).labels
  if (labels?.length) return clean([...labels].map(labelText).join(' '))
  const own = el instanceof HTMLInputElement || el instanceof HTMLSelectElement ? '' : clean(el.textContent)
  return own || clean(el.title || el.getAttribute('placeholder'))
}

function roleOf(el: HTMLElement): string {
  const role = el.getAttribute('role')
  if (role) return role
  if (el instanceof HTMLButtonElement) return 'button'
  if (el instanceof HTMLAnchorElement) return 'link'
  if (el instanceof HTMLSelectElement) return 'combobox'
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox' || el.type === 'radio') return el.type
    return el.type === 'button' || el.type === 'submit' ? 'button' : 'textbox'
  }
  return 'textbox'
}

// A group without a legend or label has no name, so the next one up counts.
function groupOf(el: HTMLElement): string | undefined {
  for (let group = el.parentElement?.closest('[role="group"], fieldset'); group; group = group.parentElement?.closest('[role="group"], fieldset')) {
    const legend = group instanceof HTMLFieldSetElement ? group.querySelector(':scope > legend') : null
    const name = legend ? clean(legend.textContent) : group.getAttribute('aria-label') && nameOf(group as HTMLElement)
    if (name) return name
  }
  return undefined
}

// A boolean ARIA state, or undefined when it is not set.
function state(el: HTMLElement, name: string): boolean | undefined {
  const value = el.getAttribute(name)
  return value === null ? undefined : value === 'true'
}

// Only what the user can reach: inside the top modal dialog if one is open, shown, and not hidden from screen readers.
function controls(): HTMLElement[] {
  const root = [...document.querySelectorAll<HTMLDialogElement>('dialog:modal')].at(-1) ?? document.body
  return [...root.querySelectorAll<HTMLElement>(CONTROLS)].filter(
    (el) => el.checkVisibility({ visibilityProperty: true }) && !el.closest('[aria-hidden="true"], [inert]')
  )
}

// The name of the top dialog or popover. null: none.
export function openDialog(): string | null {
  const dialog = [...document.querySelectorAll<HTMLElement>('dialog:modal, [role="dialog"]')].at(-1)
  return dialog ? nameOf(dialog) || 'Dialog' : null
}

// messages: what screen readers announce now, like "Event saved" or an error under a form.
export function snapshot(): { dialog: string | null; messages: string[]; focused: number | null; controls: Control[] } {
  last = controls()
  const focused = last.indexOf(document.activeElement as HTMLElement)
  return {
    dialog: openDialog(),
    messages: [...document.querySelectorAll('[role="alert"], [role="status"]')].map((el) => clean(el.textContent)).filter((text) => text),
    focused: focused === -1 ? null : focused,
    controls: last.map((el, ref) => {
      const control: Control = { ref, role: roleOf(el), name: nameOf(el), group: groupOf(el) }
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) control.checked = el.checked
      else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) control.value = el.value
      else if (el instanceof HTMLSelectElement) control.value = el.selectedOptions[0]?.text ?? ''
      control.checked ??= state(el, 'aria-checked')
      control.pressed = state(el, 'aria-pressed')
      control.selected = state(el, 'aria-selected')
      control.expanded = state(el, 'aria-expanded')
      if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') control.disabled = true
      return control
    })
  }
}

// By ref from the last snapshot, or by name (any case) and maybe role among the controls on screen now.
function find(target: { ref?: unknown; name?: unknown; role?: unknown }): HTMLElement {
  if (target.ref !== undefined) {
    const el = last[target.ref as number]
    if (!el?.isConnected) throw new Error('This ref is gone. Take a new snapshot.')
    return el
  }
  if (typeof target.name !== 'string') throw new Error('Give a ref or a name.')
  const name = target.name.toLowerCase()
  const found = controls().filter((el) => nameOf(el).toLowerCase() === name && (!target.role || roleOf(el) === target.role))
  if (found.length === 0) throw new Error(`No control is named "${target.name}". Take a snapshot to see the names.`)
  if (found.length > 1) throw new Error(`${found.length} controls are named "${target.name}". Use a ref from a snapshot.`)
  return found[0]
}

// Waits for Svelte to draw the change, then lists the controls again.
async function after(): Promise<ReturnType<typeof snapshot>> {
  await tick()
  return snapshot()
}

export async function click(target: { ref?: unknown; name?: unknown; role?: unknown }): Promise<ReturnType<typeof snapshot>> {
  const el = find(target)
  if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') throw new Error('This control is disabled.')
  el.focus()
  el.click()
  return after()
}

// Sets the value the way typing does, so Svelte's bind:value and change handlers see it.
export async function fill(target: { ref?: unknown; name?: unknown; value?: unknown }): Promise<ReturnType<typeof snapshot>> {
  const el = find(target)
  if (typeof target.value !== 'string') throw new Error('Give a value.')
  const value = target.value
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    if (el.checked !== (value === 'true')) el.click()
    return after()
  }
  if (el instanceof HTMLSelectElement) {
    const option = [...el.options].find((o) => o.value === value || clean(o.text).toLowerCase() === value.toLowerCase())
    if (!option) throw new Error(`No option "${value}". Options: ${[...el.options].map((o) => clean(o.text)).join(', ')}`)
    el.value = option.value
  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.value = value
  } else {
    throw new Error('This control is not a field.')
  }
  el.focus()
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return after()
}
