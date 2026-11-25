// The prompt that asks the user to allow a new agent: main/ipc.ts (askApproval) and the page
// (components/AgentApproval.svelte).

// Keys answer only after the window has had the focus this long: keys that were already on their way, or that the
// user was typing elsewhere, must not answer. Main also ignores an answer that comes sooner after it sent the prompt.
export const APPROVAL_ARM_MS = 1000

// The tray's Agent access, and the level the user gives an agent.
export type AgentAccess = 'off' | 'read' | 'full'
// null: the prompt closed without an answer (the user answered in the tray or removed the agent, agent access was
// turned off, or the app quit).
export type ApprovalAnswer = AgentAccess | null

export interface ApprovalRequest {
  id: string
  name: string
  // Another agent has the same name, so this one got " (2)".
  twin: boolean
  trayAccess: AgentAccess
  upgrade?: boolean
}

// What agents get while a prompt is open (main/agent.ts, and App.svelte behind it).
export const ASKING =
  'Busy Peasy is asking the user whether to allow an agent. Until the user answers, agents cannot use click, fill, ' +
  'press or the app commands. Try again later.'

// "Claude Code (2)" -> "Claude Code".
export const baseName = (name: string): string => name.replace(/ \(\d+\)$/, '')

// Only the user's own click or key: an agent's click() is a script event (isTrusted false). A mouse click (detail: the
// click count) answers at once, also the one that brings the window to the front. A key, or a click from a key
// (detail 0), only once the window has had the focus for APPROVAL_ARM_MS. armedSince: when the window got the focus,
// or null while it has none.
export function mayAnswer(e: { isTrusted: boolean; detail?: number }, armedSince: number | null, now: number): boolean {
  if (!e.isTrusted) return false
  if (e.detail) return true
  return armedSince !== null && now - armedSince >= APPROVAL_ARM_MS
}

export function approvalText(request: ApprovalRequest): { title: string; lines: string[] } {
  const lines = [
    'An agent on this computer asks for access to your calendar. With Read only it can read your events and see the ' +
      'app window. With Full access it can also create, change and delete events, answer invites, and use the window ' +
      'like you. Allow it only if you just started this agent.'
  ]
  if (request.twin) {
    lines.push(`Busy Peasy already has an agent named "${baseName(request.name)}". If you did not start a second copy of it, click ${request.upgrade ? 'Keep read only' : 'Deny'}.`)
  }
  if (request.trayAccess === 'read') {
    lines.push('Agent access in the tray is Read only, so every agent can only read until you change it there.')
  }
  const title = request.upgrade
    ? `Give "${request.name}" full access to change your calendar?`
    : `Allow "${request.name}" to use Busy Peasy?`
  return { title, lines }
}

// App.svelte wraps its whole agent command handler in this, so the check comes first: while a prompt is open, only
// snapshot and getState run.
export function refuseWhileAsking<T>(
  asking: () => boolean,
  handler: (name: string, args: Record<string, unknown>) => Promise<T>
): (name: string, args: Record<string, unknown>) => Promise<T> {
  return async (name, args) => {
    if (asking() && name !== 'snapshot' && name !== 'getState') throw new Error(ASKING)
    return handler(name, args)
  }
}
