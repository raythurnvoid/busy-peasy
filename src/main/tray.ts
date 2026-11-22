import { app, Menu, nativeImage, Tray } from 'electron'
import icon from '../../resources/icon.png?asset'
import trayIcon from '../../resources/tray.ico?asset'
import type { Account } from '../shared/api'
import type { AgentAccess } from '../shared/approval'
import { AGENT_ACCESS_LABELS, AGENT_LEVEL_LABELS, type Agent } from './agent'

// Passed by the login item, so a start with Windows goes straight to the tray.
export const HIDDEN_ARG = '--hidden'

// Kept at module level: a Tray with no reference is garbage collected and vanishes.
let tray: Tray | null = null

// showSignedOut shows the accounts that need a sign-in: a menu item for each, and a note in the tooltip.
// showUpdate adds a restart item for a downloaded update. Agent access and each agent's level: only here and in the
// prompt in the window, never from agents (main/agent.ts). showAgents shows a changed agent list.
export function createTray(actions: {
  open(): void
  signIn(accountId: number): void
  syncNow(): void
  update(): void
  agentAccess(): AgentAccess
  setAgentAccess(access: AgentAccess): void
  agents(): Agent[]
  setAgentLevel(id: string, level: AgentAccess): void
  removeAgent(id: string): void
  quit(): void
}): { showSignedOut(signedOut: Account[]): void; showUpdate(version: string): void; showAgents(): void } {
  // Windows: the ICO has the simpler small drawing at 16 to 32 px, and Windows picks the size for the screen scaling.
  tray = new Tray(process.platform === 'win32' ? trayIcon : nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }))
  tray.setToolTip('Busy Peasy')
  let signedOut: Account[] = []
  let update: string | null = null
  const menu = (): Menu =>
    Menu.buildFromTemplate([
      ...(update ? [{ label: `Restart to update to ${update}`, click: actions.update }, { type: 'separator' as const }] : []),
      ...signedOut.map((account) => ({ label: `Sign in to ${account.email}`, click: () => actions.signIn(account.id) })),
      ...(signedOut.length ? [{ type: 'separator' as const }] : []),
      { label: 'Open Busy Peasy', click: actions.open },
      { label: 'Sync now', click: actions.syncNow },
      {
        label: 'Agent access',
        submenu: [
          // The tray access: the upper limit for every agent.
          ...(['off', 'read', 'full'] as const).map((access) => ({
            label: AGENT_ACCESS_LABELS[access],
            type: 'radio' as const,
            checked: actions.agentAccess() === access,
            click: () => actions.setAgentAccess(access)
          })),
          { type: 'separator' as const },
          ...(actions.agents().length === 0 ? [{ label: 'No agents yet', enabled: false }] : []),
          // A Waiting agent has no level checked.
          ...actions.agents().map((agent) => ({
            label: `${agent.name}: ${AGENT_LEVEL_LABELS[agent.level]}`,
            submenu: [
              ...(['off', 'read', 'full'] as const).map((level) => ({
                label: AGENT_ACCESS_LABELS[level],
                type: 'radio' as const,
                checked: agent.level === level,
                click: () => actions.setAgentLevel(agent.id, level)
              })),
              { type: 'separator' as const },
              { label: 'Remove', click: () => actions.removeAgent(agent.id) }
            ]
          }))
        ]
      },
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
  return {
    showSignedOut(accounts) {
      // Only on a change, so a menu the user has open is not replaced at every sync.
      if (accounts.map((a) => a.id).join() === signedOut.map((a) => a.id).join()) return
      signedOut = accounts
      tray?.setToolTip(accounts.length ? 'Busy Peasy — sign-in needed' : 'Busy Peasy')
      tray?.setContextMenu(menu())
    },
    showUpdate(version) {
      update = version
      tray?.setContextMenu(menu())
    },
    showAgents() {
      tray?.setContextMenu(menu())
    }
  }
}

// Turns start at login on the first time the installed app runs. The tray menu can turn it off.
export function enableStartAtLoginOnce(firstRun: boolean): void {
  if (app.isPackaged && firstRun) app.setLoginItemSettings({ openAtLogin: true, args: [HIDDEN_ARG] })
}
