import { app, Menu, nativeImage, Tray } from 'electron'
import icon from '../../resources/icon.png?asset'
import type { Account } from '../shared/api'

// Passed by the login item, so a start with Windows goes straight to the tray.
export const HIDDEN_ARG = '--hidden'

// Kept at module level: a Tray with no reference is garbage collected and vanishes.
let tray: Tray | null = null

// Returns a function that shows the accounts that need a sign-in: a menu item for each, and a note in the tooltip.
export function createTray(actions: {
  open(): void
  signIn(accountId: number): void
  syncNow(): void
  quit(): void
}): (signedOut: Account[]) => void {
  tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }))
  tray.setToolTip('Busy Peasy')
  let signedOut: Account[] = []
  const menu = (): Menu =>
    Menu.buildFromTemplate([
      ...signedOut.map((account) => ({ label: `Sign in to ${account.email}`, click: () => actions.signIn(account.id) })),
      ...(signedOut.length ? [{ type: 'separator' as const }] : []),
      { label: 'Open Busy Peasy', click: actions.open },
      { label: 'Sync now', click: actions.syncNow },
      { type: 'separator' },
      {
        label: 'Start at login',
        type: 'checkbox',
        // A dev build would register electron.exe itself, so only the installed app offers this.
        enabled: app.isPackaged,
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked, args: [HIDDEN_ARG] })
          tray?.setContextMenu(menu())
        }
      },
      { type: 'separator' },
      { label: 'Quit', click: actions.quit }
    ])
  tray.setContextMenu(menu())
  tray.on('click', actions.open)
  return (accounts) => {
    // Only on a change, so a menu the user has open is not replaced at every sync.
    if (accounts.map((a) => a.id).join() === signedOut.map((a) => a.id).join()) return
    signedOut = accounts
    tray?.setToolTip(accounts.length ? 'Busy Peasy — sign-in needed' : 'Busy Peasy')
    tray?.setContextMenu(menu())
  }
}

// Turns start at login on the first time the installed app runs. The tray menu can turn it off.
export function enableStartAtLoginOnce(firstRun: boolean): void {
  if (app.isPackaged && firstRun) app.setLoginItemSettings({ openAtLogin: true, args: [HIDDEN_ARG] })
}
