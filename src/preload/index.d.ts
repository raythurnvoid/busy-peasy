import type { Api, CalendarEvent, DataChanged } from '../shared/api'
import type { AgentAccess, ApprovalRequest } from '../shared/approval'

declare global {
  interface Window {
    api: Api & {
      onDataChanged(callback: (change: DataChanged) => void): () => void
      onSignIn(callback: (accountId: number) => void): () => void
      onShowEvent(callback: (event: CalendarEvent) => void): () => void
      onUpdateReady(callback: (version: string) => void): () => void
      onAgentCommand(callback: (name: string, args: Record<string, unknown>) => Promise<unknown>): () => void
      onAgentApproval(callback: (request: ApprovalRequest | null) => void): () => void
      answerAgentApproval(id: string, answer: AgentAccess): void
    }
  }
}
