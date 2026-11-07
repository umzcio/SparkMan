import { siClaude } from 'simple-icons'
import { cn } from '@/lib/utils'

/** Claude's starburst mark (from simple-icons). Brand coral by default; `mono` inherits currentColor. */
export function ClaudeMark({ className, mono = false, label = 'Claude' }: { className?: string; mono?: boolean; label?: string | null }) {
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true }
  return (
    <svg viewBox="0 0 24 24" {...a11y} className={cn('size-5 shrink-0', !mono && 'text-claude', className)} fill="currentColor">
      <path d={siClaude.path} />
    </svg>
  )
}

/** Monochrome rail/menu icon. */
export function ClaudeIcon({ className }: { className?: string }) {
  return <ClaudeMark mono label={null} className={cn('size-4', className)} />
}
