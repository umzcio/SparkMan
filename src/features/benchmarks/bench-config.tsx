import type { BenchKind, DecodeBenchConfig, DecodePromptType, PrefillBenchConfig, QualityBenchConfig, QualityCategory, ToolEvalBenchConfig } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  CONCURRENCY_OPTIONS, CONTEXT_SIZES, MAX_TOKENS_RANGE, PROMPT_TYPES, QUALITY_CATEGORIES, TOOL_EVAL_CATEGORIES, fittingContextSizes, formatContextSize, toolEvalScenarioCount,
} from '@/lib/bench'
import { formatNumber } from '@/lib/format'
import type { BenchConfigs } from './config'

const SECTION = 'flex flex-col gap-2'
/** pressed toggles read as selected in both themes */
const ON = 'data-[state=on]:bg-brand/15 data-[state=on]:text-brand data-[state=on]:font-semibold'
const LEGEND = 'mb-2 text-sm font-medium'

function DecodeForm({ value, onChange }: { value: DecodeBenchConfig; onChange: (c: DecodeBenchConfig) => void }) {
  return (
    <>
      <fieldset className={SECTION}>
        <legend className={LEGEND}>Concurrent streams</legend>
        <ToggleGroup
          type="multiple"
          variant="outline"
          size="sm"
          spacing={0}
          aria-label="Concurrency levels"
          value={value.concurrency.map(String)}
          onValueChange={(v) => onChange({ ...value, concurrency: v.map(Number).sort((a, b) => a - b) })}
          className="w-full"
        >
          {CONCURRENCY_OPTIONS.map((c) => (
            <ToggleGroupItem key={c} value={String(c)} className={`flex-1 font-mono tabular-nums ${ON}`} aria-label={`${c} concurrent`}>
              {c}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="text-xs text-muted-foreground">One level per step; aggregate tok/s should rise until the engine saturates.</p>
      </fieldset>
      <div className={SECTION}>
        <Label htmlFor="bench-max-tokens">Max tokens per stream</Label>
        <Input
          id="bench-max-tokens"
          type="number"
          inputMode="numeric"
          min={MAX_TOKENS_RANGE.min}
          max={MAX_TOKENS_RANGE.max}
          step={MAX_TOKENS_RANGE.step}
          value={Number.isNaN(value.maxTokens) ? '' : value.maxTokens}
          onChange={(e) => onChange({ ...value, maxTokens: e.target.value === '' ? Number.NaN : Number(e.target.value) })}
          className="font-mono tabular-nums"
        />
      </div>
      <fieldset className={SECTION}>
        <legend className={LEGEND}>Prompt type</legend>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          aria-label="Prompt type"
          value={value.promptType}
          onValueChange={(v) => v && onChange({ ...value, promptType: v as DecodePromptType })}
          className="w-full"
        >
          {PROMPT_TYPES.map((p) => (
            <ToggleGroupItem key={p.id} value={p.id} className={`flex-1 ${ON}`}>
              {p.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="text-xs text-muted-foreground">Temperature 0, thinking off. Code gives each stream a different task.</p>
      </fieldset>
    </>
  )
}

function PrefillForm({ value, onChange, contextLength }: { value: PrefillBenchConfig; onChange: (c: PrefillBenchConfig) => void; contextLength: number }) {
  const { fit } = fittingContextSizes(CONTEXT_SIZES, contextLength)
  return (
    <fieldset className={SECTION}>
      <legend className={LEGEND}>Context sizes</legend>
      <ToggleGroup
        type="multiple"
        variant="outline"
        size="sm"
        aria-label="Context sizes"
        value={value.contextSizes.map(String)}
        onValueChange={(v) => onChange({ ...value, contextSizes: v.map(Number).sort((a, b) => a - b) })}
        className="grid w-full grid-cols-5 gap-1"
      >
        {CONTEXT_SIZES.map((s) => (
          <ToggleGroupItem key={s} value={String(s)} disabled={!fit.includes(s)} className={`font-mono tabular-nums ${ON}`} aria-label={`${formatContextSize(s)} tokens`}>
            {formatContextSize(s)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <p className="text-xs text-muted-foreground">
        Unique prefix per size, so nothing is served from the prefix cache. Sizes that leave no room for a reply in the model’s {formatContextSize(contextLength)} context are skipped.
      </p>
    </fieldset>
  )
}

function QualityForm({ value, onChange }: { value: QualityBenchConfig; onChange: (c: QualityBenchConfig) => void }) {
  const toggle = (id: QualityCategory, on: boolean) =>
    onChange({ ...value, categories: QUALITY_CATEGORIES.map((q) => q.id).filter((q) => (q === id ? on : value.categories.includes(q))) })
  const total = QUALITY_CATEGORIES.filter((q) => value.categories.includes(q.id)).reduce((s, q) => s + q.items, 0)
  return (
    <fieldset className={SECTION}>
      <legend className={LEGEND}>Categories</legend>
      {QUALITY_CATEGORIES.map((q) => (
        <div key={q.id} className="flex items-center gap-2">
          <Checkbox id={`quality-${q.id}`} checked={value.categories.includes(q.id)} onCheckedChange={(c) => toggle(q.id, c === true)} />
          <Label htmlFor={`quality-${q.id}`} className="flex-1 font-normal">
            {q.label}
            {q.thinking && (
              <Badge variant="outline" className="ml-1 px-1 text-[10px] text-muted-foreground">
                thinking
              </Badge>
            )}
          </Label>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">{q.items}</span>
        </div>
      ))}
      <p className="mt-1 text-xs text-muted-foreground">
        <span className="font-mono tabular-nums">{formatNumber(total)}</span> seeded items at temperature 0. Same ids every run, so two runs pair item by item.
      </p>
    </fieldset>
  )
}

function ToolEvalForm({ value, onChange }: { value: ToolEvalBenchConfig; onChange: (c: ToolEvalBenchConfig) => void }) {
  const count = (suite: ToolEvalBenchConfig['suite']) => TOOL_EVAL_CATEGORIES.reduce((s, c) => s + toolEvalScenarioCount(c.id, suite), 0)
  return (
    <fieldset className={SECTION}>
      <legend className={LEGEND}>Scenario suite</legend>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        spacing={0}
        aria-label="Scenario suite"
        value={value.suite}
        onValueChange={(v) => v && onChange({ ...value, suite: v as ToolEvalBenchConfig['suite'] })}
        className="w-full"
      >
        <ToggleGroupItem value="quick" className={`flex-1 ${ON}`}>
          Quick · {count('quick')}
        </ToggleGroupItem>
        <ToggleGroupItem value="full" className={`flex-1 ${ON}`}>
          Full · {count('full')}
        </ToggleGroupItem>
      </ToggleGroup>
      <p className="text-xs text-muted-foreground">
        {TOOL_EVAL_CATEGORIES.length} categories, from tool selection and parameter precision to safety and structured output. Each scenario passes, partially passes or fails.
      </p>
    </fieldset>
  )
}

export function BenchConfigForm({ kind, configs, onChange, contextLength }: { kind: BenchKind; configs: BenchConfigs; onChange: (c: BenchConfigs) => void; contextLength: number }) {
  switch (kind) {
    case 'decode':
      return <DecodeForm value={configs.decode} onChange={(decode) => onChange({ ...configs, decode })} />
    case 'prefill':
      return <PrefillForm value={configs.prefill} onChange={(prefill) => onChange({ ...configs, prefill })} contextLength={contextLength} />
    case 'quality':
      return <QualityForm value={configs.quality} onChange={(quality) => onChange({ ...configs, quality })} />
    case 'tool-eval':
      return <ToolEvalForm value={configs['tool-eval']} onChange={(t) => onChange({ ...configs, 'tool-eval': t })} />
  }
}
