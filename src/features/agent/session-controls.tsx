import { useQuery } from '@tanstack/react-query'
import { Brain } from 'lucide-react'
import type { ContextUsage, ModelOption } from '@/agent/protocol'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { formatCompact } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useProvider } from './providers'

export function ModelPicker({ model, models, disabled, onChange }: { model: string | null; models: ModelOption[]; disabled?: boolean; onChange: (model: string) => void }) {
  const current = models.find((m) => m.value === model)
  return (
    <Select value={current?.value ?? ''} onValueChange={onChange} disabled={disabled || models.length === 0}>
      <SelectTrigger size="sm" className="max-w-52 font-mono text-xs" aria-label="Model">
        <SelectValue placeholder={model ?? 'model'}>{current?.displayName ?? model ?? 'model'}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {models.map((m) => (
          <SelectItem key={m.value} value={m.value}>
            <span className="flex flex-col">
              <span>{m.displayName}</span>
              <span className="text-xs text-muted-foreground">{m.description}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function ThinkingToggle({ enabled, disabled, onChange }: { enabled: boolean; disabled?: boolean; onChange: (enabled: boolean) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <Switch id="show-thinking" size="sm" checked={enabled} disabled={disabled} onCheckedChange={onChange} aria-label="Show thinking" />
      <Label htmlFor="show-thinking" className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
        <Brain className="size-3.5" />
        Thinking
      </Label>
    </div>
  )
}

/** Tailwind-ish swatches for the CLI's context category colour names. */
const SWATCH: Record<string, string> = {
  promptBorder: 'bg-muted-foreground',
  inactive: 'bg-muted-foreground/50',
  claude: 'bg-claude',
  permission: 'bg-level-info',
  warning: 'bg-level-warn',
  error: 'bg-level-error',
  success: 'bg-brand',
}
const swatch = (color: string, i: number) => SWATCH[color] ?? ['bg-level-info', 'bg-brand', 'bg-claude', 'bg-level-warn', 'bg-chart-5'][i % 5]

function Ring({ pct }: { pct: number }) {
  const r = 6
  const c = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden>
      <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2.5" className="stroke-muted" />
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.min(pct, 100) / 100)}
        className={cn('transition-[stroke-dashoffset] duration-500 ease-(--ease-out-strong)', pct > 85 ? 'stroke-level-error' : pct > 65 ? 'stroke-level-warn' : 'stroke-claude')}
      />
    </svg>
  )
}

function ContextBreakdown({ usage }: { usage: ContextUsage }) {
  return (
    <div className="space-y-3 text-sm" data-testid="context-breakdown">
      <div className="flex items-baseline justify-between">
        <span className="font-medium">Context window</span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {formatCompact(usage.totalTokens)} / {formatCompact(usage.maxTokens)}
        </span>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-muted">
        {usage.categories.map((c, i) => (
          <span key={c.name} className={cn('h-full', swatch(c.color, i))} style={{ width: `${(c.tokens / usage.maxTokens) * 100}%` }} />
        ))}
      </div>
      <ul className="space-y-1">
        {usage.categories.map((c, i) => (
          <li key={c.name} className="flex items-center gap-2 text-xs">
            <span className={cn('size-2 rounded-sm', swatch(c.color, i))} />
            <span className="flex-1">{c.name}</span>
            <span className="font-mono tabular-nums text-muted-foreground">{formatCompact(c.tokens)}</span>
          </li>
        ))}
      </ul>
      {usage.memoryFiles.length > 0 && (
        <div className="space-y-1 border-t pt-2">
          <div className="text-xs font-medium text-muted-foreground">Memory files</div>
          {usage.memoryFiles.map((f) => (
            <div key={f.path} className="flex gap-2 font-mono text-xs">
              <span className="min-w-0 flex-1 truncate">{f.path}</span>
              <span className="tabular-nums text-muted-foreground">{formatCompact(f.tokens)}</span>
            </div>
          ))}
        </div>
      )}
      {usage.categories.length === 0 && <p className="text-xs text-muted-foreground">No usage reported yet — send a message first.</p>}
    </div>
  )
}

export function ContextMeter({ sessionId, turns }: { sessionId: string; turns: number }) {
  const { api, id } = useProvider()
  const ctx = useQuery({ queryKey: [id, sessionId, 'context', turns], queryFn: () => api.context(sessionId), retry: false, staleTime: 60_000 })
  const pct = ctx.data?.percentage ?? 0
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 font-mono text-xs tabular-nums text-muted-foreground" aria-label="Context usage" data-testid="context-meter">
          <Ring pct={pct} />
          {ctx.data ? `${Math.round(pct)}%` : '–'}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        {ctx.data ? <ContextBreakdown usage={ctx.data} /> : ctx.isError ? <p className="text-sm text-muted-foreground">{ctx.error.message}</p> : <Skeleton className="h-32" />}
      </PopoverContent>
    </Popover>
  )
}
