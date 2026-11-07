import { Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { highlightLogQuery, type HighlightKind } from '@/lib/log-query'

const TOKEN_CLASS: Record<HighlightKind, string> = {
  key: 'text-level-info',
  value: 'text-foreground',
  negate: 'text-level-error',
  term: 'text-foreground',
  space: '',
}

export function LogQueryInput({ value, onSubmit, prefix }: { value: string; onSubmit: (q: string) => void; prefix?: string }) {
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => setDraft(value), [value])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      ref.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <form
      role="search"
      className="flex min-w-[18rem] flex-1 items-center rounded-lg border bg-card focus-within:ring-2 focus-within:ring-ring/50"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(draft.trim())
      }}
    >
      <Search className="ml-3 size-4 shrink-0 text-muted-foreground" />
      {prefix && <span className="ml-2 shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{prefix}</span>}
      <div className="relative min-w-0 flex-1">
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre px-3 py-2 font-mono text-sm">
          {highlightLogQuery(draft).map((t, i) => (
            <span key={i} className={TOKEN_CLASS[t.kind]}>
              {t.text}
            </span>
          ))}
        </div>
        <input
          ref={ref}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="Log query"
          placeholder="level:error host:spark-05 -healthcheck"
          spellCheck={false}
          autoComplete="off"
          className="relative w-full bg-transparent px-3 py-2 font-mono text-sm text-transparent caret-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
      <kbd className="mr-2 rounded border px-1.5 font-mono text-xs text-muted-foreground">/</kbd>
    </form>
  )
}
