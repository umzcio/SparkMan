import { useEffect, useState } from 'react'
import type { AgentApi } from './agent-api'
import type { EventEnvelope } from './protocol'
import { initialView, reduceEvent, type SessionView } from './reduce-events'

export type SessionLoad =
  | { status: 'empty' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; view: SessionView; connection: 'live' | 'reconnecting' | 'closed' }

/** Load a session's persisted events, then follow its live SSE stream. */
export function useAgentSession(api: AgentApi, id: string | null): { load: SessionLoad; reconnect: () => void } {
  const [load, setLoad] = useState<SessionLoad>({ status: id ? 'loading' : 'empty' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!id) {
      setLoad({ status: 'empty' })
      return
    }
    let cancelled = false
    let source: EventSource | null = null
    setLoad({ status: 'loading' })
    api
      .getSession(id)
      .then((detail) => {
        if (cancelled) return
        const view = detail.events.reduce(reduceEvent, initialView(detail.session))
        setLoad({ status: 'ready', view, connection: 'live' })
        const es = new EventSource(api.streamUrl(id, view.lastSeq))
        source = es
        const setConnection = (connection: 'live' | 'reconnecting' | 'closed') =>
          setLoad((prev) => (prev.status === 'ready' && prev.connection !== connection ? { ...prev, connection } : prev))
        es.onopen = () => setConnection('live')
        // EventSource retries on its own; CLOSED means it gave up (e.g. 403/404) and needs a manual retry
        es.onerror = () => setConnection(es.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting')
        es.onmessage = (m) => {
          const env = JSON.parse(m.data as string) as EventEnvelope
          setLoad((prev) => (prev.status === 'ready' ? { ...prev, view: reduceEvent(prev.view, env), connection: 'live' } : prev))
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoad({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      cancelled = true
      source?.close()
    }
  }, [api, id, attempt])

  return { load, reconnect: () => setAttempt((a) => a + 1) }
}
