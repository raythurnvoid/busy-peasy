import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { Account } from '../shared/api'
import { createTray } from './tray'

const tray = vi.hoisted(() => ({ setToolTip: vi.fn(), setContextMenu: vi.fn(), on: vi.fn() }))
vi.mock('electron', () => ({
  app: { isPackaged: false, getLoginItemSettings: () => ({ openAtLogin: false }) },
  // The menu is its template, so the test can read it.
  Menu: { buildFromTemplate: (template: unknown) => template },
  nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
  Tray: vi.fn(function () {
    return tray
  })
}))
vi.mock('../../resources/icon.png?asset', () => ({ default: '' }))

const lastMenu = (): MenuItemConstructorOptions[] => tray.setContextMenu.mock.lastCall![0]
const actions = (): Parameters<typeof createTray>[0] => ({
  open: vi.fn(),
  signIn: vi.fn(),
  syncNow: vi.fn(),
  update: vi.fn(),
  agentAccess: () => 'off',
  setAgentAccess: vi.fn(),
  agents: () => [],
  setAgentLevel: vi.fn(),
  removeAgent: vi.fn(),
  quit: vi.fn()
})
const agentMenu = (): MenuItemConstructorOptions[] =>
  lastMenu().find((item) => item.label === 'Agent access')!.submenu as MenuItemConstructorOptions[]

describe('createTray', () => {
  it('offers a sign-in for each signed-out account and says so in the tooltip', () => {
    const signIn = vi.fn()
    const { showSignedOut } = createTray({ ...actions(), signIn })
    expect(lastMenu()[0].label).toBe('Open Busy Peasy')

    showSignedOut([{ id: 2, email: 'me@work.com' } as Account])
    expect(lastMenu()[0].label).toBe('Sign in to me@work.com')
    expect(lastMenu()[1].type).toBe('separator')
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Busy Peasy — sign-in needed')
    lastMenu()[0].click!({} as never, undefined, {} as never)
    expect(signIn).toHaveBeenCalledWith(2)

    // The same list again (every sync): the menu the user may have open stays.
    const builds = tray.setContextMenu.mock.calls.length
    showSignedOut([{ id: 2, email: 'me@work.com' } as Account])
    expect(tray.setContextMenu.mock.calls.length).toBe(builds)

    showSignedOut([])
    expect(lastMenu()[0].label).toBe('Open Busy Peasy')
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Busy Peasy')
  })

  it('offers a restart for a downloaded update, above the sign-ins', () => {
    const update = vi.fn()
    const { showSignedOut, showUpdate } = createTray({ ...actions(), update })
    showSignedOut([{ id: 2, email: 'me@work.com' } as Account])
    showUpdate('0.2.0')
    expect(lastMenu().map((item) => item.label ?? item.type).slice(0, 4)).toEqual([
      'Restart to update to 0.2.0',
      'separator',
      'Sign in to me@work.com',
      'separator'
    ])
    lastMenu()[0].click!({} as never, undefined, {} as never)
    expect(update).toHaveBeenCalled()
  })

  it('shows the saved agent access and saves a new pick', () => {
    const setAgentAccess = vi.fn()
    createTray({ ...actions(), agentAccess: () => 'read', setAgentAccess })
    const submenu = agentMenu()
    expect(submenu.slice(0, 3).map((item) => [item.label, item.checked])).toEqual([
      ['Off', false],
      ['Read only', true],
      ['Full access', false]
    ])
    submenu[2].click!({} as never, undefined, {} as never)
    expect(setAgentAccess).toHaveBeenCalledWith('full')
  })

  it('lists the agents with their levels under the tray level, and changes or removes one', () => {
    const setAgentLevel = vi.fn()
    const removeAgent = vi.fn()
    let agents = [
      { id: 'a1', name: 'Claude Code', level: 'pending' as const },
      { id: 'b2', name: 'Codex', level: 'read' as const }
    ]
    const { showAgents } = createTray({ ...actions(), agents: () => agents, setAgentLevel, removeAgent })
    expect(agentMenu().slice(3).map((item) => item.label ?? item.type)).toEqual([
      'separator',
      'Claude Code: Waiting',
      'Codex: Read only'
    ])
    const waiting = agentMenu()[4].submenu as MenuItemConstructorOptions[]
    expect(waiting.map((item) => item.label ?? item.type)).toEqual(['Off', 'Read only', 'Full access', 'separator', 'Remove'])
    expect(waiting.some((item) => item.checked)).toBe(false)
    const codex = agentMenu()[5].submenu as MenuItemConstructorOptions[]
    expect(codex.map((item) => item.checked ?? false)).toEqual([false, true, false, false, false])
    waiting[1].click!({} as never, undefined, {} as never)
    expect(setAgentLevel).toHaveBeenCalledWith('a1', 'read')
    codex[4].click!({} as never, undefined, {} as never)
    expect(removeAgent).toHaveBeenCalledWith('b2')

    agents = []
    showAgents()
    expect(agentMenu().slice(3)).toEqual([{ type: 'separator' }, { label: 'No agents yet', enabled: false }])
  })
})
