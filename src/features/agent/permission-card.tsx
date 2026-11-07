import { Check, MessageCircleQuestion, NotebookPen, ShieldAlert, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { PermissionDecisionBody } from '@/agent/protocol'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { cn } from '@/lib/utils'
import { DiffView, fileEdits } from './diff-view'
import { Markdown } from './markdown'
import { useProvider } from './providers'
import { toolSummary } from './tool-card'

export type Decide = (body: PermissionDecisionBody) => void

interface CardProps {
  toolName: string
  input: Record<string, unknown>
  reason?: string
  resolution?: 'allow' | 'deny'
  pending: boolean
  busy: boolean
  onDecide: Decide
}

function Shell({ icon, title, pending, resolution, labels, children, actions }: { icon: ReactNode; title: string; pending: boolean; resolution?: 'allow' | 'deny'; labels?: [string, string]; children: ReactNode; actions: ReactNode }) {
  const [allowLabel, denyLabel] = labels ?? ['Approved', 'Denied']
  return (
    <div className={cn('rounded-lg border px-3 py-2.5 text-sm transition-colors duration-300', pending ? 'attention-pulse border-level-warn/50 bg-level-warn/10' : 'bg-card')} data-testid="permission-card">
      <div className="flex items-center gap-2">
        {icon}
        <span className="font-medium">{title}</span>
        {!pending && (
          <span className={cn('enter-fade ml-auto text-xs', resolution === 'allow' ? 'text-brand' : resolution === 'deny' ? 'text-level-error' : 'text-muted-foreground')}>
            {resolution === 'allow' ? allowLabel : resolution === 'deny' ? denyLabel : 'Expired'}
          </span>
        )}
      </div>
      {children}
      <div className="collapsible" data-open={pending} inert={!pending}>
        <div>
          <div className="flex flex-wrap gap-2 pt-2">{actions}</div>
        </div>
      </div>
    </div>
  )
}

const iconCls = (pending: boolean) => cn('size-4 shrink-0', pending ? 'text-level-warn' : 'text-muted-foreground')

function ToolPermission({ toolName, input, reason, resolution, pending, busy, onDecide }: CardProps) {
  const { name, features } = useProvider()
  const edits = fileEdits(toolName, input)
  return (
    <Shell
      icon={<ShieldAlert className={iconCls(pending)} />}
      title={`${name} wants to use ${toolName}`}
      pending={pending}
      resolution={resolution}
      actions={
        <>
          <Button size="sm" onClick={() => onDecide({ behavior: 'allow' })} disabled={busy || !pending}>
            <Check />
            Approve
          </Button>
          {features.approveForSession && (
            <Button size="sm" variant="outline" onClick={() => onDecide({ behavior: 'allow', forSession: true })} disabled={busy || !pending}>
              Always allow this session
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => onDecide({ behavior: 'deny' })} disabled={busy || !pending}>
            <X />
            Deny
          </Button>
        </>
      }
    >
      {edits ? (
        <DiffView className="mt-1.5" path={edits.path} lines={edits.lines} />
      ) : (
        <code className="mt-1.5 block overflow-x-auto whitespace-pre rounded bg-surface-2 px-2 py-1.5 font-mono text-xs">{toolSummary(toolName, input)}</code>
      )}
      {reason && <p className="mt-1 text-xs text-muted-foreground">{reason}</p>}
    </Shell>
  )
}

interface Question {
  question: string
  header?: string
  multiSelect?: boolean
  options: { label: string; description?: string }[]
}

const OTHER = '__other__'

function QuestionPermission({ input, resolution, pending, busy, onDecide }: CardProps) {
  const { name } = useProvider()
  const questions = (Array.isArray(input.questions) ? input.questions : []) as Question[]
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const answerFor = (q: Question) =>
    (picked[q.question] ?? [])
      .map((p) => (p === OTHER ? other[q.question]?.trim() ?? '' : p))
      .filter(Boolean)
      .join(', ')
  const complete = questions.every((q) => answerFor(q))
  const toggle = (q: Question, label: string, on: boolean) =>
    setPicked((p) => {
      const cur = p[q.question] ?? []
      return { ...p, [q.question]: q.multiSelect ? (on ? [...cur, label] : cur.filter((x) => x !== label)) : [label] }
    })

  return (
    <Shell
      icon={<MessageCircleQuestion className={cn('size-4 shrink-0', pending ? 'text-claude' : 'text-muted-foreground')} />}
      title={`${name} has a question`}
      pending={pending}
      resolution={resolution}
      labels={['Answered', 'Skipped']}
      actions={
        <>
          <Button size="sm" disabled={busy || !pending || !complete} onClick={() => onDecide({ behavior: 'allow', updatedInput: { ...input, answers: Object.fromEntries(questions.map((q) => [q.question, answerFor(q)])) } })}>
            <Check />
            Submit answers
          </Button>
          <Button size="sm" variant="outline" disabled={busy || !pending} onClick={() => onDecide({ behavior: 'deny', message: 'The operator skipped this question; use your best judgement.' })}>
            Skip
          </Button>
        </>
      }
    >
      <div className="mt-2 space-y-3" data-testid="question-card">
        {questions.map((q, qi) => {
          const id = (o: string) => `q${qi}-${o}`
          const options = [...q.options, { label: OTHER, description: undefined }]
          const sel = picked[q.question] ?? []
          return (
            <fieldset key={q.question} disabled={!pending} className="space-y-1.5">
              <legend className="mb-1 text-sm">
                {q.header && <span className="mr-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{q.header}</span>}
                {q.question}
              </legend>
              {q.multiSelect ? (
                options.map((o) => (
                  <div key={o.label} className="flex items-start gap-2">
                    <Checkbox id={id(o.label)} checked={sel.includes(o.label)} onCheckedChange={(c) => toggle(q, o.label, c === true)} className="mt-0.5" />
                    <OptionLabel htmlFor={id(o.label)} label={o.label} description={o.description} />
                  </div>
                ))
              ) : (
                <RadioGroup value={sel[0] ?? ''} onValueChange={(v) => toggle(q, v, true)} aria-label={q.question}>
                  {options.map((o) => (
                    <div key={o.label} className="flex items-start gap-2">
                      <RadioGroupItem id={id(o.label)} value={o.label} className="mt-0.5" />
                      <OptionLabel htmlFor={id(o.label)} label={o.label} description={o.description} />
                    </div>
                  ))}
                </RadioGroup>
              )}
              {sel.includes(OTHER) && (
                <Input autoFocus value={other[q.question] ?? ''} onChange={(e) => setOther((o) => ({ ...o, [q.question]: e.target.value }))} placeholder="Your answer" aria-label={`Other answer for: ${q.question}`} className="h-8" />
              )}
            </fieldset>
          )
        })}
      </div>
    </Shell>
  )
}

function OptionLabel({ htmlFor, label, description }: { htmlFor: string; label: string; description?: string }) {
  return (
    <Label htmlFor={htmlFor} className="flex flex-col items-start gap-0 font-normal">
      <span>{label === OTHER ? 'Other…' : label}</span>
      {description && <span className="text-xs text-muted-foreground">{description}</span>}
    </Label>
  )
}

function PlanPermission({ input, resolution, pending, busy, onDecide }: CardProps) {
  const plan = typeof input.plan === 'string' ? input.plan : ''
  return (
    <Shell
      icon={<NotebookPen className={cn('size-4 shrink-0', pending ? 'text-claude' : 'text-muted-foreground')} />}
      title="Claude’s plan"
      pending={pending}
      resolution={resolution}
      labels={['Approved', 'Kept planning']}
      actions={
        <>
          <Button size="sm" disabled={busy || !pending} onClick={() => onDecide({ behavior: 'allow', mode: 'acceptEdits' })}>
            <Check />
            Approve & auto-accept edits
          </Button>
          <Button size="sm" variant="outline" disabled={busy || !pending} onClick={() => onDecide({ behavior: 'allow', mode: 'default' })}>
            Approve
          </Button>
          <Button size="sm" variant="ghost" disabled={busy || !pending} onClick={() => onDecide({ behavior: 'deny', message: 'The operator wants to keep planning. Refine the plan before making changes.' })}>
            Keep planning
          </Button>
        </>
      }
    >
      <div className="mt-2 max-h-96 overflow-y-auto rounded-md border bg-card px-3 py-2" data-testid="plan-card">
        <Markdown text={plan} />
      </div>
    </Shell>
  )
}

export function PermissionCard(props: CardProps) {
  if (props.toolName === 'AskUserQuestion') return <QuestionPermission {...props} />
  if (props.toolName === 'ExitPlanMode') return <PlanPermission {...props} />
  return <ToolPermission {...props} />
}
