import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { FlaskConical, Info, KeyRound, Moon, Network, Palette, Plug, Sun, type LucideIcon } from 'lucide-react'
import { useTheme } from 'next-themes'
import type { ReactNode } from 'react'
import { agentApi, codexApi } from '@/agent/agent-api'
import type { HealthResponse } from '@/agent/protocol'
import { useFailures, useFleetConfig, useGatewayInfo, useNodes, useSetFailures } from '@/api/hooks'
import { BrandFigure } from '@/components/brand-mark'
import { ClaudeMark } from '@/components/claude-mark'
import { CodexMark } from '@/components/codex-mark'
import { CopyButton } from '@/components/copy-button'
import { Faceplate } from '@/components/faceplate'
import { NodeStatusDot } from '@/components/node-status-dot'
import { PageBody, PageHeader } from '@/components/page-header'
import { QueryState } from '@/components/query-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { getSession, signOut } from '@/features/auth/login-screen'
import { useFleetDataSource, useSimulatorOn } from '@/lib/data-source'
import { cn } from '@/lib/utils'
import { useLocalSetting } from '@/lib/use-local-setting'

export const SETTINGS_SECTIONS = [
  { id: 'appearance', label: 'Appearance', icon: Palette, blurb: 'How SparkMan looks in this browser.' },
  { id: 'fleet', label: 'Fleet connection', icon: Network, blurb: 'How SparkMan reaches the Sparks: agentless, over SSH, reading the DGX Spark manageability tools’ JSON.' },
  { id: 'gateway', label: 'Gateway', icon: Plug, blurb: 'Defaults for the OpenAI-compatible endpoint your coding agents point at.' },
  { id: 'agents', label: 'Host agents', icon: KeyRound, blurb: 'Claude Code and Codex running on this SparkMan host, and who may use them.' },
  { id: 'simulator', label: 'Simulator', icon: FlaskConical, blurb: 'Inject failures to exercise offline, error and incident states. Resets on page reload.' },
  { id: 'about', label: 'About', icon: Info, blurb: 'Where this console’s data comes from.' },
] as const satisfies readonly { id: string; label: string; icon: LucideIcon; blurb: string }[]

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['id']

const NONE = '__none__'

/** One setting: what it is (and why) on the left, the control on the right. */
function Row({ label, hint, htmlFor, children, stack = false }: { label: string; hint?: ReactNode; htmlFor?: string; children: ReactNode; stack?: boolean }) {
  return (
    <div className={cn('flex flex-col gap-3 px-5 py-4', !stack && 'sm:flex-row sm:items-center sm:justify-between sm:gap-8')}>
      <div className="min-w-0">
        <Label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
        </Label>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className={cn('shrink-0', stack && 'w-full')}>{children}</div>
    </div>
  )
}

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      {title && <h3 className="px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>}
      <Card className="gap-0 divide-y py-0">{children}</Card>
    </section>
  )
}

const Mono = ({ children }: { children: ReactNode }) => <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">{children}</code>

function Appearance() {
  const { theme, setTheme } = useTheme()
  return (
    <Group>
      <Row label="Theme" hint="Dark matches the NVIDIA look; light is easier in a bright room.">
        <ToggleGroup type="single" variant="outline" size="sm" value={theme} onValueChange={(v) => v && setTheme(v)} aria-label="Theme">
          <ToggleGroupItem value="dark" className="gap-1.5 px-3">
            <Moon className="size-3.5" />
            Dark
          </ToggleGroupItem>
          <ToggleGroupItem value="light" className="gap-1.5 px-3">
            <Sun className="size-3.5" />
            Light
          </ToggleGroupItem>
        </ToggleGroup>
      </Row>
    </Group>
  )
}

function Fleet() {
  const config = useFleetConfig()
  const nodes = useNodes()
  return (
    <QueryState query={config} skeleton={<Skeleton className="h-64" />}>
      {(c) => (
        <>
          <Group title="Access">
            <Row label="SSH user" hint="A dedicated, non-root account on every node.">
              <Mono>{c.sshUser}</Mono>
            </Row>
            <Row label="SSH key" hint="Ed25519, BatchMode only — SparkMan never types passwords.">
              <Mono>{c.sshKeyPath}</Mono>
            </Row>
          </Group>
          <Group title={`Hosts · ${c.hosts.length}`}>
            <ul className="divide-y" data-testid="settings-hosts">
              {[...c.hosts]
                .sort((a, b) => {
                  // rack order: top shelf first, left to right
                  const ra = nodes.data?.find((n) => n.id === a.id)?.rack
                  const rb = nodes.data?.find((n) => n.id === b.id)?.rack
                  return ra && rb ? ra.shelf - rb.shelf || ra.slot - rb.slot : 0
                })
                .map((h) => {
                const n = nodes.data?.find((x) => x.id === h.id)
                return (
                  <li key={h.id} className="flex items-center gap-4 px-5 py-2.5">
                    {n ? <Faceplate model={n.model} className="h-9 w-auto" /> : <span className="h-9 w-3" />}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 font-mono text-sm">
                        {n && <NodeStatusDot status={n.status} />}
                        <Link to="/nodes/$nodeId" params={{ nodeId: h.id }} className="hover:underline">
                          {h.id}
                        </Link>
                      </div>
                      {n && <div className="text-xs text-muted-foreground">{n.model}</div>}
                    </div>
                    {n && <span className="hidden text-xs text-muted-foreground sm:inline">shelf {n.rack.shelf} · slot {n.rack.slot}</span>}
                    <span className="w-24 text-right font-mono text-xs text-muted-foreground">{h.ip}</span>
                  </li>
                )
              })}
            </ul>
          </Group>
          <p className="px-1 text-xs text-muted-foreground">Read-only in the prototype. On the SparkMan host these come from SparkMan’s fleet file.</p>
        </>
      )}
    </QueryState>
  )
}

function Gateway() {
  const gateway = useGatewayInfo()
  const [defaultModel, setDefaultModel] = useLocalSetting<string>('sparkman.defaultModel', 'qwen3-235b-a22b')
  const [retention, setRetention] = useLocalSetting<string>('sparkman.logRetentionDays', '30')
  const served = gateway.data?.models ?? []
  // a stored model that is no longer served would leave the select blank: show the server default instead
  const shownModel = served.includes(defaultModel) ? defaultModel : (gateway.data?.defaultModel ?? defaultModel)
  const modelOptions = served.includes(shownModel) ? served : [shownModel, ...served]
  return (
    <Group>
      <Row label="Base URL" hint="Point Claude Code, Codex, Kimi or any OpenAI-compatible client here.">
        <div className="flex items-center gap-2">
          <Mono>{gateway.data?.baseUrl ?? '—'}</Mono>
          {gateway.data && <CopyButton value={gateway.data.baseUrl} label="Copy" />}
        </div>
      </Row>
      <Row label="Default model" htmlFor="default-model" hint="Used when a request names no model.">
        <Select value={shownModel} onValueChange={setDefaultModel}>
          <SelectTrigger id="default-model" className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {modelOptions.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label="Log retention" htmlFor="retention" hint="How long request logs are kept on the host.">
        <Select value={retention} onValueChange={setRetention}>
          <SelectTrigger id="retention" className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {['7', '14', '30', '90'].map((d) => (
              <SelectItem key={d} value={d}>
                {d} days
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
    </Group>
  )
}

function AgentStatus({ name, Mark, health, to }: { name: string; Mark: typeof ClaudeMark; health: UseQueryResult<HealthResponse>; to: '/agent' | '/codex' }) {
  return (
    <Row
      label={name}
      hint={
        health.isError ? (
          <>Not available on this host — {health.error.message}</>
        ) : health.data ? (
          <>
            Signed-in sessions start in <Mono>{health.data.defaultCwd}</Mono>
            {health.data.fake && ' · simulated'}
          </>
        ) : (
          'Checking…'
        )
      }
    >
      <div className="flex items-center gap-3">
        <Mark className="size-5" label={null} />
        {health.isPending ? (
          <Skeleton className="h-5 w-20" />
        ) : health.isError ? (
          <Badge variant="outline" className="text-muted-foreground">unavailable</Badge>
        ) : (
          <Badge variant="outline" className="border-brand/40 text-brand">running</Badge>
        )}
        <Link to={to} className="text-xs text-muted-foreground hover:text-foreground hover:underline">
          Open
        </Link>
      </div>
    </Row>
  )
}

function Agents() {
  const claude = useQuery({ queryKey: ['claude', 'health'], queryFn: agentApi.health, retry: false })
  const codex = useQuery({ queryKey: ['codex', 'health'], queryFn: codexApi.health, retry: false })
  const h = claude.data ?? codex.data
  return (
    <>
      <Group title="Agents">
        <AgentStatus name="Claude Code" Mark={ClaudeMark} health={claude} to="/agent" />
        <AgentStatus name="Codex" Mark={CodexMark} health={codex} to="/codex" />
      </Group>
      <Group title="Access">
        <Row label="You are" hint="Your Tailscale login, or “local” when you’re on the host itself.">
          <Mono>{h?.user ?? 'local'}</Mono>
        </Row>
        <Row label="No-guardrails modes" hint="Claude’s Bypass and Codex’s Full access run anything without asking.">
          {h ? (
            <Badge variant="outline" className={h.allowBypass ? 'text-level-warn' : 'text-muted-foreground'}>
              {h.allowBypass ? 'enabled' : 'disabled'}
            </Badge>
          ) : (
            <Skeleton className="h-5 w-16" />
          )}
        </Row>
      </Group>
      <p className="px-1 text-xs text-muted-foreground">
        Set on the host in <Mono>~/.config/sparkman/sparkman.env</Mono> (<Mono>SPARKMAN_ALLOWED_USERS</Mono>, <Mono>SPARKMAN_ALLOW_BYPASS</Mono>), then{' '}
        <Mono>systemctl --user restart sparkman</Mono>.
      </p>
    </>
  )
}

function Simulator() {
  const nodes = useNodes()
  const failures = useFailures()
  const setFailures = useSetFailures()
  return (
    <Group>
      <Row label="Take a node offline" htmlFor="sim-offline" hint="Stops its heartbeat; alerts, the rack and deployments react.">
        <Select value={failures.data?.nodeOffline ?? NONE} onValueChange={(v) => setFailures.mutate({ nodeOffline: v === NONE ? null : v })}>
          <SelectTrigger id="sim-offline" className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>None</SelectItem>
            {nodes.data?.map((n) => (
              <SelectItem key={n.id} value={n.id}>
                {n.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label="Gateway 5xx errors" htmlFor="sim-5xx" hint="About 10% of gateway requests fail.">
        <Switch id="sim-5xx" checked={failures.data?.gatewayErrors ?? false} onCheckedChange={(v) => setFailures.mutate({ gatewayErrors: v })} />
      </Row>
      <Row label="Xid storm on gx10-03" htmlFor="sim-xid" hint="GPU Xid errors flood the logs and open an incident.">
        <Switch id="sim-xid" checked={failures.data?.xidStorm ?? false} onCheckedChange={(v) => setFailures.mutate({ xidStorm: v })} />
      </Row>
      <Row label="Disconnect the Pico" htmlFor="sim-pico" hint="The fan controller stops answering; after 10 s its watchdog runs every fan at 100%.">
        <Switch id="sim-pico" checked={failures.data?.picoDisconnected ?? false} onCheckedChange={(v) => setFailures.mutate({ picoDisconnected: v })} />
      </Row>
      <Row label="Stall a fan" htmlFor="sim-stall" hint="Its tach reads 0 RPM while driven, as if a cable came loose.">
        <Select value={failures.data?.fanStalled ?? NONE} onValueChange={(v) => setFailures.mutate({ fanStalled: v === NONE ? null : v })}>
          <SelectTrigger id="sim-stall" className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>None</SelectItem>
            {['fan-1', 'fan-2', 'fan-3'].map((id, i) => (
              <SelectItem key={id} value={id}>Fan {i + 1}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label="Fail API requests" htmlFor="sim-api" hint="Every fleet request errors, to check loading and retry states.">
        <Switch id="sim-api" checked={failures.data?.apiErrors ?? false} onCheckedChange={(v) => setFailures.mutate({ apiErrors: v })} />
      </Row>
    </Group>
  )
}

function About() {
  const source = useFleetDataSource()
  const session = useQuery({ queryKey: ['auth', 'session'], queryFn: getSession, staleTime: 60_000 })
  return (
    <>
    <div className="flex items-center gap-6 rounded-xl border bg-card px-6 py-5" data-testid="about-hero">
      <BrandFigure className="h-32 w-auto shrink-0" alt="SparkMan" />
      <div>
        <div className="text-xl font-semibold tracking-tight">SparkMan</div>
        <p className="mt-1 text-sm text-muted-foreground">Fleet console for the DGX Spark / GB10 rack — one front door for coding agents, plus telemetry, logs, updates, benchmarks, and Claude and Codex on the host.</p>
      </div>
    </div>
    <Group>
      {session.data?.authEnabled && session.data.user && (
        <Row label="Account" hint={`Signed in as ${session.data.user}.`}>
          <Button variant="outline" size="sm" onClick={() => void signOut()} data-testid="sign-out">
            Sign out
          </Button>
        </Row>
      )}
      <Row label="Fleet data" hint={source === 'simulated' ? 'Nodes, metrics, logs and deployments come from the built-in simulator, not the real Sparks.' : source === 'mixed' ? 'Pages without a badge are live from the SparkMan backend; pages marked “Not connected yet” have no backend yet.' : 'Live from the SparkMan backend.'}>
        <Badge variant="outline" className={source === 'live' ? 'border-brand/40 text-brand' : 'border-level-warn/40 text-level-warn'}>
          {source}
        </Badge>
      </Row>
      <Row label="Host agents" hint="The Claude and Codex pages are real: they run on this host.">
        <Badge variant="outline" className="border-brand/40 text-brand">live</Badge>
      </Row>
      <Row label="Source" hint="Private repository.">
        <a href="https://github.com/umzcio/SparkMan" target="_blank" rel="noreferrer" className="font-mono text-xs hover:underline">
          umzcio/SparkMan
        </a>
      </Row>
    </Group>
    </>
  )
}

const BODY: Record<SettingsSection, () => ReactNode> = {
  appearance: Appearance,
  fleet: Fleet,
  gateway: Gateway,
  agents: Agents,
  simulator: Simulator,
  about: About,
}

export function SettingsPage({ section, onSection }: { section: SettingsSection; onSection: (s: SettingsSection) => void }) {
  // the failure switches only exist on the simulator
  const simulatorOn = useSimulatorOn()
  const sections = SETTINGS_SECTIONS.filter((s) => s.id !== 'simulator' || simulatorOn)
  const current = sections.find((s) => s.id === section) ?? sections[0]
  const Body = BODY[current.id]
  return (
    <>
      <PageHeader fleetData={false} crumbs={[{ label: 'Maintain', to: '/updates' }, { label: 'Settings' }]} title="Settings" />
      <PageBody>
        <div className="mx-auto grid w-full max-w-5xl gap-8 md:grid-cols-[12rem_minmax(0,1fr)]">
          <nav aria-label="Settings sections" className="-mx-1 flex flex-wrap gap-1 pb-1 md:sticky md:top-6 md:mx-0 md:flex-col md:self-start md:overflow-visible md:pb-0">
            {sections.map((s) => {
              const Icon = s.icon
              const active = s.id === current.id
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onSection(s.id)}
                  aria-current={active ? 'page' : undefined}
                  data-testid={`settings-nav-${s.id}`}
                  className={cn(
                    'flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors duration-150',
                    active ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                  )}
                >
                  <Icon className={cn('size-4', active && 'text-brand')} />
                  {s.label}
                </button>
              )
            })}
          </nav>
          <div key={current.id} className="enter-fade flex min-w-0 flex-col gap-6">
            <div>
              <h2 className="text-lg font-semibold">{current.label}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{current.blurb}</p>
            </div>
            <Body />
          </div>
        </div>
      </PageBody>
    </>
  )
}
