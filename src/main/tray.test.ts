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
  quit: vi.fn()
})

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
    const submenu = lastMenu().find((item) => item.label === 'Agent access')!.submenu as MenuItemConstructorOptions[]
    expect(submenu.map((item) => [item.label, item.checked])).toEqual([
      ['Off', false],
      ['Read only', true],
      ['Full access', false]
    ])
    submenu[2].click!({} as never, undefined, {} as never)
    expect(setAgentAccess).toHaveBeenCalledWith('full')
  })
})
