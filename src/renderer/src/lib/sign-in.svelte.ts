// Sign-in state shared by the sidebar and the "sign in again" banner.
export const signIn = $state({ outlookOpen: false, busy: false, error: '' })

// Electron prefixes errors from main with "Error invoking remote method 'api': Error: ".
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message.replace(/^Error invoking remote method 'api': (\w*Error: )?/, '') : String(e)
}

export async function runAction(action: () => Promise<void>): Promise<void> {
  signIn.error = ''
  signIn.busy = true
  try {
    await action()
  } catch (e) {
    signIn.error = errorMessage(e)
  } finally {
    signIn.busy = false
  }
}

// The account the open Microsoft window signs in (undefined: a new account).
let openFor: number | undefined

// Not tied to `busy`: a second click must stay possible, it restarts the Microsoft window.
// With an account id it signs that account in again; without, it adds a new account.
// While the window is open, any click restarts that same sign-in, whichever button it came from.
export async function signInOutlook(accountId?: number): Promise<void> {
  if (signIn.outlookOpen) return void window.api.addOutlookAccount(openFor).catch(() => {})
  openFor = accountId
  signIn.error = ''
  signIn.outlookOpen = true
  try {
    await window.api.addOutlookAccount(accountId)
  } catch (e) {
    signIn.error = errorMessage(e)
  } finally {
    signIn.outlookOpen = false
  }
}
