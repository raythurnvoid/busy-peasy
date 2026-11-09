import type { Api, CalendarEvent, DataChanged } from '../shared/api'

declare global {
  interface Window {
    api: Api & {
      onDataChanged(callback: (change: DataChanged) => void): () => void
      onSignIn(callback: (accountId: number) => void): () => void
      onShowEvent(callback: (event: CalendarEvent) => void): () => void
      onAgentCommand(callback: (name: string, args: Record<string, unknown>) => Promise<unknown>): () => void
    }
  }
}
