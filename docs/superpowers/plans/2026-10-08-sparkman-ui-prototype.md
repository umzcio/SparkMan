# SparkMan UI Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a clickable, live-updating fleet-management UI for 12 NVIDIA DGX Spark / ASUS GX10 nodes, driven by a deterministic in-browser simulator behind a swappable client interface.

**Architecture:** Vite SPA. Every screen reads data through TanStack Query hooks that call one `SparkManClient` interface. Phase 1 backs that interface with `MockClient`, which wraps a seeded `Simulator`. The simulator computes metrics, logs, usage and gateway stats as pure functions of `(seed, entity, time)` plus a small mutable state for actions such as reboot, deploy and rollout. A single root hook turns simulator events into query invalidations, so live data refreshes every 2 s.

**Tech Stack:** Node 26 / pnpm 10, Vite 8, React 19, TypeScript ~6 (strict), Tailwind CSS 4, shadcn/ui (radix base, `nova` preset), Recharts 3 via shadcn Chart, TanStack Router (file-based) + TanStack Query 5, next-themes, sonner, lucide-react, Vitest 5 + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-08-sparkman-ui-prototype-design.md`

## Global Constraints

- Package manager is **pnpm**. Scaffold with `pnpm create vite@latest … --template react-ts` (Vite 8, TS ~6).
- `tsconfig.app.json` has `"strict": true` and `"verbatimModuleSyntax": true`: type-only imports **must** use `import type`. `"erasableSyntaxOnly": true`: **no `enum`, no parameter properties, no namespaces**. Use union string types.
- Do **not** set `baseUrl` (deprecated in TS 6 → build error). Use `"paths": { "@/*": ["./src/*"] }` only.
- shadcn: init with `pnpm dlx shadcn@latest init -t vite -b radix -p nova -y`, add components with `pnpm dlx shadcn@latest add <names> -y`. The CLI can block on an interactive prompt; always pass `-y` and redirect stdin with `< /dev/null`. Do not hand-edit files in `src/components/ui/`.
- The build script must run `tsr generate` before `tsc -b`, because `routeTree.gen.ts` has to exist for typechecking. Commit `src/routeTree.gen.ts`.
- Brand: product name **SparkMan**, original spark glyph. **Never** use the NVIDIA logo.
- NVIDIA Green `#76B900` (hover `#8CD600`) is an accent only: active nav, focus rings, primary buttons, Live dot, selected toggles. Never a large background fill.
- Exact dark tokens: window `#0A0B0A`, card `#111311`, popover/surface-2 `#171A17`, borders `rgb(255 255 255 / 0.08)`. Data colors: GPU green, CPU `#2DD4BF`, memory `#A78BFA`, power/temp `#F5A524`. Log levels: Error `#F2545B`, Warn `#F5A524`, Info `#5B7CFA`, Debug `#8A8F98`. Light-theme equivalents are defined in Task 2. Components reference colors **only** through CSS variables (`var(--gpu)`, Tailwind `text-gpu`, etc.), never hard-coded hex.
- Fonts: Inter (UI) and JetBrains Mono (numbers, logs, hostnames, code) via `@fontsource-variable/*`. Live numeric values use the `tabular-nums` class.
- Dark theme is the default; theme storage key is `sparkman-theme`. Respect `prefers-reduced-motion`.
- UI code (`src/features`, `src/components`, `src/routes`) **must not** import from `src/api/mock/`. Only `src/main.tsx` (composition root) and tests may. Enforced by the test in Task 8.
- Simulator seed `1729`; tick interval `2000` ms; metric series always return `120` points.
- Mock data must look like real GB10 output: 128 GB unified memory per node (memory comes from `/proc/meminfo`-style numbers, not nvidia-smi), GPU-only power draw, GPU temperature vs. ACPI zone temperature, and the Spark manageability JSON envelope `{tool, ts, host, status, rc, duration_ms, summary, warnings, artifacts}`.
- Desktop first, usable down to 1024 px wide. No auth, no server persistence (only `localStorage` for theme and settings).
- Commit at the end of every task with a conventional message ending in the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Live log stream with a line selected.** With Live on, new lines arrive every 2 s. The detail pane must keep showing the line the user clicked, not whatever moved into that row index. *Pinned by the Task 12 e2e test "live mode keeps selected line".*
2. **A node goes offline (reboot or injected failure).** The node list and detail page must say Offline or Rebooting, and charts must show a gap or "No data". Stale numbers must never be presented as live. *Pinned by the Task 7 unit test "offline node yields null metrics and null live stats" and the Task 20 e2e test "injected offline node shows offline state".*
3. **Unknown node URL** (`/nodes/does-not-exist`, e.g. from an old bookmark) must render a "Node not found" state with a way back, not a crash or a blank page. *Pinned by the Task 13 e2e test "unknown node shows not found".*
4. **Malformed or no-match log queries** (`host:`, an unterminated `"`, a lone `-`, or a query nothing matches) must not throw. They show the empty state. *Pinned by the Task 6 unit test "malformed input never throws" and the Task 12 e2e test "no-match query shows empty state".*
5. **Starting a second rollout while one is active** must be blocked: the button is disabled in the UI and the simulator rejects it with a conflict. *Pinned by the Task 7 unit test "rejects a second active rollout" and the Task 19 e2e test "plan button disabled during rollout".*

---

## File Structure

```
package.json, vite.config.ts, tsconfig*.json, playwright.config.ts, components.json, index.html, README.md
src/
  main.tsx                     composition root: Simulator → MockClient → providers → router
  index.css                    Tailwind + shadcn + SparkMan theme tokens (light :root, .dark)
  routeTree.gen.ts             generated by TanStack Router (committed)
  test/setup.ts                jest-dom matchers
  api/
    types.ts                   all domain types (shared by UI, client, mock)
    client.tsx                 SparkManClient interface, ClientEvent, ClientProvider, useClient
    hooks.ts                   query keys, TanStack Query hooks, mutations, useClientEvents
    architecture.test.ts       guards: UI never imports api/mock
    mock/
      rng.ts                   seeded hash/noise helpers
      fixtures.ts              static fleet definition (nodes, deployments, keys, rules, incidents, updates, catalog)
      metrics.ts               pure metric/load/gateway/usage models
      logs.ts                  deterministic log generator, query + histogram
      simulator.ts             mutable sim state, tick, actions, derived reads, events
      mock-client.ts           MockClient implements SparkManClient
  lib/
    utils.ts                   cn() (from shadcn)
    colors.ts                  theme tokens mirror + contrast math (tests only use the math)
    format.ts                  bytes, %, W, °C, durations, relative time, clocks
    log-query.ts               log query parser, matcher, highlight tokenizer
    nav.ts                     navigation config shared by rail + command menu
    use-local-setting.ts       localStorage-backed setting hook
  components/
    ui/*                       shadcn generated
    app-shell.tsx, app-rail.tsx, brand-mark.tsx, command-menu.tsx, page-header.tsx
    stat-tile.tsx, metric-chart.tsx, node-status-dot.tsx, time-range-toggle.tsx
    live-badge.tsx, usage-bar.tsx, query-state.tsx, copy-button.tsx
  features/
    overview/overview-page.tsx
    nodes/nodes-page.tsx, node-detail-page.tsx, node-metrics-tab.tsx, node-processes-tab.tsx,
          node-inventory-tab.tsx, node-health-tab.tsx, node-actions.tsx
    logs/log-explorer.tsx, log-query-input.tsx, log-histogram.tsx, log-table.tsx,
         log-patterns.tsx, log-detail-sheet.tsx, logs-page.tsx
    gateway/gateway-page.tsx, snippets.ts
    deployments/deployments-page.tsx, deploy-sheet.tsx, fit.ts
    usage/usage-page.tsx, to-chart.ts
    keys/keys-page.tsx, create-key-dialog.tsx
    alerts/alerts-page.tsx, incident-sheet.tsx
    updates/updates-page.tsx, rollout-sheet.tsx, rollout-progress.tsx
    settings/settings-page.tsx
  routes/
    __root.tsx, index.tsx, nodes.index.tsx, nodes.$nodeId.tsx, gateway.tsx, deployments.tsx,
    usage.tsx, keys.tsx, logs.tsx, alerts.tsx, updates.tsx, settings.tsx
e2e/
  fixtures.ts                  test fixture that fails on console errors
  shell.spec.ts, overview.spec.ts, nodes.spec.ts, node-detail.spec.ts, logs.spec.ts, gateway.spec.ts,
  deployments.spec.ts, usage.spec.ts, keys.spec.ts, alerts.spec.ts, updates.spec.ts, settings.spec.ts,
  all-routes.spec.ts, screenshots.spec.ts
docs/screenshots/              dark/light screenshots produced by Task 21
```

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`, `index.html`, `components.json`, `src/main.tsx`, `src/routes/__root.tsx`, `src/routes/index.tsx`, `src/test/setup.ts`, `src/lib/utils.ts` (generated), `src/components/ui/*` (generated), `src/lib/utils.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `@/` path alias; `pnpm dev | build | test | e2e | typecheck` scripts; shadcn components in `@/components/ui/*`; `cn()` from `@/lib/utils`.

- [ ] **Step 1: Scaffold Vite into a temp dir and move it into the repo root** (the repo already contains `docs/` and `screenshots/`)

```bash
cd /path/to/SparkMan
pnpm create vite@latest .sparkman-tmp --template react-ts --no-interactive
rsync -a .sparkman-tmp/ ./ && rm -rf .sparkman-tmp
rm -rf src/App.tsx src/App.css src/assets
pnpm install
```

- [ ] **Step 2: Install runtime and dev dependencies**

```bash
pnpm add tailwindcss @tailwindcss/vite @tanstack/react-router @tanstack/react-query next-themes @fontsource-variable/inter @fontsource-variable/jetbrains-mono
pnpm add -D @tanstack/router-plugin @tanstack/router-cli vitest jsdom @testing-library/react @testing-library/jest-dom @playwright/test
```

- [ ] **Step 3: Write `vite.config.ts`**

```ts
/// <reference types="vitest/config" />
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
  },
})
```

- [ ] **Step 4: Replace the three tsconfig files**

`tsconfig.json`:
```json
{
  "files": [],
  "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }],
  "compilerOptions": { "paths": { "@/*": ["./src/*"] } }
}
```

`tsconfig.app.json`:
```json
{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
    "target": "es2023",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "esnext",
    "types": ["vite/client", "node"],
    "allowArbitraryExtensions": true,
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true,
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src"]
}
```

`tsconfig.node.json`:
```json
{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.node.tsbuildinfo",
    "target": "es2023",
    "lib": ["ES2023", "DOM"],
    "types": ["node"],
    "skipLibCheck": true,
    "module": "nodenext",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["vite.config.ts", "playwright.config.ts", "e2e/**/*.ts"]
}
```

- [ ] **Step 5: Initialize shadcn and add every component the plan uses**

```bash
echo '@import "tailwindcss";' > src/index.css
pnpm dlx shadcn@latest init -t vite -b radix -p nova -y < /dev/null
pnpm dlx shadcn@latest add sidebar card table tabs badge sheet command dialog toggle-group tooltip progress dropdown-menu switch input skeleton sonner chart separator breadcrumb label select scroll-area checkbox textarea alert -y < /dev/null
pnpm remove @fontsource-variable/geist
```
Expected: `components.json` with `"style": "radix-nova"`, and `src/components/ui/` containing `sidebar.tsx`, `chart.tsx`, `command.tsx`, `sonner.tsx` and the rest. Dependencies now include `radix-ui`, `recharts`, `cmdk`, `sonner`, `lucide-react`, `tw-animate-css`, `class-variance-authority`. (`src/index.css` gets fully replaced in Task 2. Remove the `@import "@fontsource-variable/geist";` line now so the build does not break after removing the package.)

```bash
sed -i '' '/fontsource-variable\/geist/d' src/index.css
```

- [ ] **Step 6: Minimal router entry**

`src/routes/__root.tsx`:
```tsx
import { createRootRoute, Outlet } from '@tanstack/react-router'

export const Route = createRootRoute({ component: () => <Outlet /> })
```

`src/routes/index.tsx`:
```tsx
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: () => <h1>SparkMan</h1> })
```

`src/main.tsx`:
```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import './index.css'

const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
```

`src/test/setup.ts`:
```ts
import '@testing-library/jest-dom/vitest'
```

Edit `index.html`: set `<title>SparkMan</title>` and add `class="dark"` to `<html>` (avoids a light flash before next-themes hydrates).

- [ ] **Step 7: Scripts and ignores**

In `package.json` set `"name": "sparkman"` and replace `"scripts"` with:
```json
{
  "dev": "vite",
  "build": "tsr generate && tsc -b && vite build",
  "typecheck": "tsr generate && tsc -b",
  "test": "vitest run",
  "test:watch": "vitest",
  "e2e": "playwright test",
  "lint": "oxlint",
  "preview": "vite preview"
}
```
Append to `.gitignore`:
```
test-results/
playwright-report/
.sparkman-tmp/
```

- [ ] **Step 8: Write a sanity test for `cn`**

`src/lib/utils.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { cn } from './utils'

describe('cn', () => {
  it('merges tailwind classes with last-wins semantics', () => {
    expect(cn('px-2 text-sm', false && 'hidden', 'px-4')).toBe('text-sm px-4')
  })
})
```

- [ ] **Step 9: Run tests and build**

Run: `pnpm test && pnpm build`
Expected: 1 test passes; build prints `✓ built in …` with no TS errors.

- [ ] **Step 10: Commit**

```bash
git add -A ':!screenshots'
git commit -m "chore: scaffold Vite + React + shadcn + TanStack project

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Theme tokens and contrast validation

**Files:**
- Create: `src/lib/colors.ts`, `src/lib/colors.test.ts`
- Modify: `src/index.css` (full replace)

**Interfaces:**
- Produces: CSS variables `--background --card --popover --foreground --muted-foreground --primary --brand --brand-hover --canvas --surface-2 --gpu --cpu --memory --power --level-error --level-warn --level-info --level-debug --cat-1…--cat-7` plus the standard shadcn set. Tailwind utilities `bg-canvas`, `bg-surface-2`, `text-brand`, `text-gpu`, `text-cpu`, `text-memory`, `text-power`, `text-level-error|warn|info|debug` (and `bg-*`/`border-*` variants). `font-mono`, `font-sans`.
- Produces (`colors.ts`): `themes: Record<'dark' | 'light', ThemeTokens>`, `contrastRatio(a: string, b: string): number`, `CSS_VAR: Record<keyof Omit<ThemeTokens,'categorical'>, string>`.

- [ ] **Step 1: Write the failing test**

`src/lib/colors.test.ts`:
```ts
// @vitest-environment node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CSS_VAR, contrastRatio, themes } from './colors'

function cssBlock(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  if (start === -1) throw new Error(`missing ${selector}`)
  const body = css.slice(start, css.indexOf('}', start))
  const vars: Record<string, string> = {}
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) vars[m[1]] = m[2].trim().toLowerCase()
  return vars
}

const css = readFileSync(path.resolve(__dirname, '../index.css'), 'utf8')

describe('contrastRatio', () => {
  it('is 21 for black on white and 1 for identical colors', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1)
    expect(contrastRatio('#76B900', '#76B900')).toBeCloseTo(1, 5)
  })
})

describe.each([
  ['dark', '.dark'],
  ['light', ':root'],
] as const)('%s theme', (name, selector) => {
  const t = themes[name]
  const vars = cssBlock(css, selector)

  it('index.css mirrors the token table', () => {
    for (const [key, cssVar] of Object.entries(CSS_VAR)) {
      expect(vars[cssVar], cssVar).toBe(t[key as keyof typeof CSS_VAR].toLowerCase())
    }
    t.categorical.forEach((hex, i) => expect(vars[`--cat-${i + 1}`]).toBe(hex.toLowerCase()))
  })

  it('text meets 4.5:1 on background and card', () => {
    for (const bg of [t.background, t.card]) {
      expect(contrastRatio(t.foreground, bg)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(t.mutedForeground, bg)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('data, level and brand colors meet 3:1 on card', () => {
    const marks = [t.brand, t.gpu, t.cpu, t.memory, t.power, t.levelError, t.levelWarn, t.levelInfo, t.levelDebug, ...t.categorical]
    for (const c of marks) expect(contrastRatio(c, t.card), c).toBeGreaterThanOrEqual(3)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/lib/colors.test.ts`
Expected: FAIL, `Cannot find module './colors'`.

- [ ] **Step 3: Write `src/lib/colors.ts`**

```ts
export interface ThemeTokens {
  background: string
  card: string
  foreground: string
  mutedForeground: string
  brand: string
  gpu: string
  cpu: string
  memory: string
  power: string
  levelError: string
  levelWarn: string
  levelInfo: string
  levelDebug: string
  categorical: string[]
}

export const themes: Record<'dark' | 'light', ThemeTokens> = {
  dark: {
    background: '#0A0B0A',
    card: '#111311',
    foreground: '#EDEEEC',
    mutedForeground: '#9BA19A',
    brand: '#76B900',
    gpu: '#76B900',
    cpu: '#2DD4BF',
    memory: '#A78BFA',
    power: '#F5A524',
    levelError: '#F2545B',
    levelWarn: '#F5A524',
    levelInfo: '#5B7CFA',
    levelDebug: '#8A8F98',
    categorical: ['#76B900', '#2DD4BF', '#A78BFA', '#F5A524', '#5B7CFA', '#F472B6', '#94A3B8'],
  },
  light: {
    background: '#F7F8F6',
    card: '#FFFFFF',
    foreground: '#0F120E',
    mutedForeground: '#5C6359',
    brand: '#4F7D00',
    gpu: '#4F7D00',
    cpu: '#0F9488',
    memory: '#7C3AED',
    power: '#D97706',
    levelError: '#DC2626',
    levelWarn: '#B45309',
    levelInfo: '#3B5BDB',
    levelDebug: '#6B7280',
    categorical: ['#4F7D00', '#0F9488', '#7C3AED', '#D97706', '#3B5BDB', '#DB2777', '#64748B'],
  },
}

export const CSS_VAR: Record<Exclude<keyof ThemeTokens, 'categorical'>, string> = {
  background: '--background',
  card: '--card',
  foreground: '--foreground',
  mutedForeground: '--muted-foreground',
  brand: '--brand',
  gpu: '--gpu',
  cpu: '--cpu',
  memory: '--memory',
  power: '--power',
  levelError: '--level-error',
  levelWarn: '--level-warn',
  levelInfo: '--level-info',
  levelDebug: '--level-debug',
}

function channel(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.replace('#', ''), 16)
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
```

- [ ] **Step 4: Replace `src/index.css`**

```css
@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";
@import "@fontsource-variable/inter";
@import "@fontsource-variable/jetbrains-mono";

@custom-variant dark (&:is(.dark *));

@theme inline {
  --font-sans: 'Inter Variable', ui-sans-serif, system-ui, sans-serif;
  --font-heading: var(--font-sans);
  --font-mono: 'JetBrains Mono Variable', ui-monospace, SFMono-Regular, monospace;
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-chart-1: var(--chart-1);
  --color-chart-2: var(--chart-2);
  --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4);
  --color-chart-5: var(--chart-5);
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-ring: var(--sidebar-ring);
  --color-canvas: var(--canvas);
  --color-surface-2: var(--surface-2);
  --color-brand: var(--brand);
  --color-brand-hover: var(--brand-hover);
  --color-gpu: var(--gpu);
  --color-cpu: var(--cpu);
  --color-memory: var(--memory);
  --color-power: var(--power);
  --color-level-error: var(--level-error);
  --color-level-warn: var(--level-warn);
  --color-level-info: var(--level-info);
  --color-level-debug: var(--level-debug);
  --radius-sm: calc(var(--radius) * 0.6);
  --radius-md: calc(var(--radius) * 0.8);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) * 1.4);
  --radius-2xl: calc(var(--radius) * 1.8);
  --radius-3xl: calc(var(--radius) * 2.2);
}

:root {
  --radius: 0.625rem;
  --canvas: #e4e8e0;
  --background: #f7f8f6;
  --foreground: #0f120e;
  --card: #ffffff;
  --card-foreground: #0f120e;
  --popover: #ffffff;
  --popover-foreground: #0f120e;
  --primary: #76b900;
  --primary-foreground: #0a0b0a;
  --secondary: #eef0ec;
  --secondary-foreground: #0f120e;
  --muted: #eef0ec;
  --muted-foreground: #5c6359;
  --accent: #e6eae2;
  --accent-foreground: #0f120e;
  --destructive: #dc2626;
  --border: rgb(15 18 14 / 0.1);
  --input: rgb(15 18 14 / 0.14);
  --ring: #4f7d00;
  --brand: #4f7d00;
  --brand-hover: #3f6600;
  --surface-2: #f1f3ef;
  --gpu: #4f7d00;
  --cpu: #0f9488;
  --memory: #7c3aed;
  --power: #d97706;
  --level-error: #dc2626;
  --level-warn: #b45309;
  --level-info: #3b5bdb;
  --level-debug: #6b7280;
  --cat-1: #4f7d00;
  --cat-2: #0f9488;
  --cat-3: #7c3aed;
  --cat-4: #d97706;
  --cat-5: #3b5bdb;
  --cat-6: #db2777;
  --cat-7: #64748b;
  --chart-1: #4f7d00;
  --chart-2: #0f9488;
  --chart-3: #7c3aed;
  --chart-4: #d97706;
  --chart-5: #3b5bdb;
  --sidebar: #f1f3ef;
  --sidebar-foreground: #5c6359;
  --sidebar-primary: #4f7d00;
  --sidebar-primary-foreground: #ffffff;
  --sidebar-accent: #e6eae2;
  --sidebar-accent-foreground: #0f120e;
  --sidebar-border: rgb(15 18 14 / 0.08);
  --sidebar-ring: #4f7d00;
}

.dark {
  --canvas: #050605;
  --background: #0a0b0a;
  --foreground: #edeeec;
  --card: #111311;
  --card-foreground: #edeeec;
  --popover: #171a17;
  --popover-foreground: #edeeec;
  --primary: #76b900;
  --primary-foreground: #0a0b0a;
  --secondary: #1c201b;
  --secondary-foreground: #edeeec;
  --muted: #171a17;
  --muted-foreground: #9ba19a;
  --accent: #1c201b;
  --accent-foreground: #edeeec;
  --destructive: #f2545b;
  --border: rgb(255 255 255 / 0.08);
  --input: rgb(255 255 255 / 0.1);
  --ring: #76b900;
  --brand: #76b900;
  --brand-hover: #8cd600;
  --surface-2: #171a17;
  --gpu: #76b900;
  --cpu: #2dd4bf;
  --memory: #a78bfa;
  --power: #f5a524;
  --level-error: #f2545b;
  --level-warn: #f5a524;
  --level-info: #5b7cfa;
  --level-debug: #8a8f98;
  --cat-1: #76b900;
  --cat-2: #2dd4bf;
  --cat-3: #a78bfa;
  --cat-4: #f5a524;
  --cat-5: #5b7cfa;
  --cat-6: #f472b6;
  --cat-7: #94a3b8;
  --chart-1: #76b900;
  --chart-2: #2dd4bf;
  --chart-3: #a78bfa;
  --chart-4: #f5a524;
  --chart-5: #5b7cfa;
  --sidebar: #0e100e;
  --sidebar-foreground: #9ba19a;
  --sidebar-primary: #76b900;
  --sidebar-primary-foreground: #0a0b0a;
  --sidebar-accent: #1c201b;
  --sidebar-accent-foreground: #edeeec;
  --sidebar-border: rgb(255 255 255 / 0.06);
  --sidebar-ring: #76b900;
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  html,
  body,
  #root {
    height: 100%;
  }
  body {
    @apply bg-canvas text-foreground font-sans antialiased;
  }
}

@layer utilities {
  .tabular-nums {
    font-variant-numeric: tabular-nums;
  }
  .animate-row-in {
    animation: row-in 400ms ease-out;
  }
}

@keyframes row-in {
  from {
    opacity: 0;
    background-color: color-mix(in oklch, var(--brand) 12%, transparent);
  }
  to {
    opacity: 1;
    background-color: transparent;
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/colors.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Build and commit**

Run: `pnpm build`. Expected: success.

```bash
git add src/lib/colors.ts src/lib/colors.test.ts src/index.css
git commit -m "feat: NVIDIA-green theme tokens with contrast validation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Formatting helpers

**Files:**
- Create: `src/lib/format.ts`, `src/lib/format.test.ts`

**Interfaces:**
- Produces: `formatBytes(n|null)`, `formatGB(gb|null)`, `formatRate(bytesPerSec|null)`, `formatPercent(v|null, digits?=0)`, `formatWatts(w|null)`, `formatTemp(c|null)`, `formatNumber(n)`, `formatCompact(n)`, `formatUsd(n)`, `formatDuration(ms)`, `formatRelative(ts, now)`, `formatClock(ts, withMs?=true)`, `formatTimeTick(ts, range: TimeRange)`, `formatDateTime(ts)`. All return `string`; null-ish input returns `'—'`.
- Consumes: `TimeRange` type, which is defined here first as `export type TimeRange = '15m' | '1h' | '6h' | '24h' | '7d'` and re-exported from `src/api/types.ts` in Task 4.

- [ ] **Step 1: Write the failing test**

`src/lib/format.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import {
  formatBytes, formatClock, formatCompact, formatDateTime, formatDuration, formatGB, formatNumber,
  formatPercent, formatRate, formatRelative, formatTemp, formatTimeTick, formatUsd, formatWatts,
} from './format'

describe('format', () => {
  it('formatBytes uses 1024 steps and trims .0', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(128 * 1024 ** 3)).toBe('128 GB')
    expect(formatBytes(0.4)).toBe('0.4 B')
    expect(formatBytes(null)).toBe('—')
  })
  it('formatGB and formatRate', () => {
    expect(formatGB(1536)).toBe('1.5 TB')
    expect(formatGB(97.25)).toBe('97.3 GB')
    expect(formatRate(4.8 * 1024 ** 2)).toBe('4.8 MB/s')
    expect(formatRate(null)).toBe('—')
  })
  it('percent, watts, temp', () => {
    expect(formatPercent(27.4)).toBe('27%')
    expect(formatPercent(0.123, 1)).toBe('0.1%')
    expect(formatPercent(null)).toBe('—')
    expect(formatWatts(86.6)).toBe('87 W')
    expect(formatTemp(64.2)).toBe('64 °C')
  })
  it('numbers and money', () => {
    expect(formatNumber(28369)).toBe('28,369')
    expect(formatCompact(1_234_000)).toBe('1.2M')
    expect(formatCompact(950)).toBe('950')
    expect(formatUsd(1234.5)).toBe('$1,234.50')
  })
  it('formatDuration picks a sensible unit', () => {
    expect(formatDuration(312)).toBe('312 ms')
    expect(formatDuration(5012)).toBe('5.0 s')
    expect(formatDuration(65_000)).toBe('1m 5s')
    expect(formatDuration(3_720_000)).toBe('1h 2m')
    expect(formatDuration(2 * 86_400_000 + 3 * 3_600_000)).toBe('2d 3h')
  })
  it('formatRelative', () => {
    const now = 1_000_000_000
    expect(formatRelative(now - 2_000, now)).toBe('just now')
    expect(formatRelative(now - 12_000, now)).toBe('12s ago')
    expect(formatRelative(now - 4 * 60_000, now)).toBe('4m ago')
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(formatRelative(now - 2 * 86_400_000, now)).toBe('2d ago')
    expect(formatRelative(now + 5_000, now)).toBe('just now')
  })
  it('clock, ticks and date-time use local time', () => {
    const ts = new Date(2026, 9, 8, 16, 16, 31, 640).getTime()
    expect(formatClock(ts)).toBe('16:16:31.640')
    expect(formatClock(ts, false)).toBe('16:16:31')
    expect(formatTimeTick(ts, '1h')).toBe('16:16')
    expect(formatTimeTick(ts, '7d')).toBe('Oct 8')
    expect(formatDateTime(ts)).toBe('Oct 8, 16:16:31')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/lib/format.test.ts`
Expected: FAIL, `Cannot find module './format'`.

- [ ] **Step 3: Write `src/lib/format.ts`**

```ts
export type TimeRange = '15m' | '1h' | '6h' | '24h' | '7d'

const DASH = '—'
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const isMissing = (v: number | null | undefined): v is null | undefined => v == null || Number.isNaN(v)

function trimNumber(value: number): string {
  const fixed = Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1)
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed
}

export function formatBytes(bytes: number | null | undefined): string {
  if (isMissing(bytes)) return DASH
  if (bytes === 0) return '0 B'
  const exp = Math.max(0, Math.min(Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)), UNITS.length - 1))
  return `${trimNumber(bytes / 1024 ** exp)} ${UNITS[exp]}`
}

export function formatGB(gb: number | null | undefined): string {
  return isMissing(gb) ? DASH : formatBytes(gb * 1024 ** 3)
}

export function formatRate(bytesPerSec: number | null | undefined): string {
  return isMissing(bytesPerSec) ? DASH : `${formatBytes(bytesPerSec)}/s`
}

export function formatPercent(v: number | null | undefined, digits = 0): string {
  return isMissing(v) ? DASH : `${v.toFixed(digits)}%`
}

export function formatWatts(w: number | null | undefined): string {
  return isMissing(w) ? DASH : `${Math.round(w)} W`
}

export function formatTemp(c: number | null | undefined): string {
  return isMissing(c) ? DASH : `${Math.round(c)} °C`
}

const numberFmt = new Intl.NumberFormat('en-US')
const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

export const formatNumber = (n: number): string => numberFmt.format(Math.round(n))
export const formatCompact = (n: number): string => compactFmt.format(n)
export const formatUsd = (n: number): string => usdFmt.format(n)

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const s = Math.floor(ms / 1000)
  if (ms < 3_600_000) return `${Math.floor(s / 60)}m ${s % 60}s`
  const m = Math.floor(s / 60)
  if (ms < 86_400_000) return `${Math.floor(m / 60)}h ${m % 60}m`
  const h = Math.floor(m / 60)
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

export function formatRelative(ts: number, now: number): string {
  const s = Math.floor(Math.max(0, now - ts) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

export function formatClock(ts: number, withMs = true): string {
  const d = new Date(ts)
  const base = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return withMs ? `${base}.${pad(d.getMilliseconds(), 3)}` : base
}

export function formatTimeTick(ts: number, range: TimeRange): string {
  const d = new Date(ts)
  if (range === '7d') return `${MONTHS[d.getMonth()]} ${d.getDate()}`
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function formatDateTime(ts: number): string {
  const d = new Date(ts)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${formatClock(ts, false)}`
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/format.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/format.ts src/lib/format.test.ts
git commit -m "feat: formatting helpers for bytes, units, durations and clocks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: Domain types, seeded RNG, fleet fixtures

**Files:**
- Create: `src/api/types.ts`, `src/api/mock/rng.ts`, `src/api/mock/rng.test.ts`, `src/api/mock/fixtures.ts`, `src/api/mock/fixtures.test.ts`

**Interfaces:**
- Consumes: `TimeRange` from `@/lib/format`.
- Produces: every domain type below (imported by all later tasks), RNG helpers `hash`, `noise`, `smoothNoise`, `mulberry32`, `pick`, `pickWeighted`, `clamp`, and fixture constants `SIM_SEED`, `GATEWAY_BASE_URL`, `FLEET_CONFIG`, `CLOUD_PRICE_PER_M`, `BASE_OS`, `TARGET_OS`, `NODE_SPECS`, `DEPLOYMENT_SPECS`, `MODEL_CATALOG`, `KEY_SPECS`, `ALERT_RULES`, `INCIDENT_SPECS`, `ACTIVITY_SPECS`, `ROLLOUT_HISTORY`, `RINGS`, `FIRMWARE_PENDING`, `APT_PENDING`, `PACKAGES`.

- [ ] **Step 1: Write `src/api/types.ts`** (types only, nothing to test yet)

```ts
import type { TimeRange } from '@/lib/format'

export type { TimeRange }

export type NodeModel = 'DGX Spark FE' | 'ASUS GX10'
export type NodeStatus = 'online' | 'degraded' | 'offline' | 'rebooting'

export interface OsInfo {
  dgxOs: string
  kernel: string
  driver: string
  cuda: string
  uefi: string
}

export interface NodeLiveStats {
  gpuUtil: number
  memUsedGB: number
  gpuPowerW: number
  gpuTempC: number
  acpiTempC: number
  cpuUtil: number
  diskUsedPct: number
  throttling: boolean
}

export interface FleetNode {
  id: string
  hostname: string
  model: NodeModel
  ip: string
  status: NodeStatus
  drained: boolean
  os: OsInfo
  memoryGB: number
  cpuCores: number
  diskGB: number
  assetTag: string
  serial: string
  bootedAt: number
  lastSeen: number
  deploymentId: string | null
  /** id of the multi-node replica this node belongs to (null when single-node or idle) */
  groupId: string | null
  /** latest sample; null whenever the node is offline or rebooting */
  live: NodeLiveStats | null
}

export type MetricKey =
  | 'gpuUtil' | 'memUsedGB' | 'gpuPowerW' | 'gpuTempC' | 'acpiTempC' | 'cpuUser' | 'cpuSystem'
  | 'netRxBps' | 'netTxBps' | 'cx7RxBps' | 'cx7TxBps' | 'diskReadBps' | 'diskWriteBps' | 'diskUsedPct'

export type MetricPoint = { t: number } & Record<MetricKey, number | null>

export type Engine = 'vLLM' | 'Ollama' | 'NIM' | 'SGLang'
export type DeploymentStatus = 'pending' | 'loading' | 'serving' | 'degraded' | 'stopped'

export interface Replica {
  id: string
  nodeIds: string[]
}

export interface Deployment {
  id: string
  model: string
  displayName: string
  engine: Engine
  quant: string
  replicas: Replica[]
  status: DeploymentStatus
  contextLength: number
  port: number
  memoryGBPerNode: number
  createdAt: number
  tokensPerSec: number
  requestsPerSec: number
}

export interface CreateDeploymentInput {
  catalogId: string
  engine: Engine
  nodeIds: string[]
}

export interface CatalogModel {
  id: string
  displayName: string
  sizeGB: number
  quant: string
  contextLength: number
  engines: Engine[]
}

export interface ApiKey {
  id: string
  name: string
  prefix: string
  createdAt: number
  lastUsedAt: number | null
  rateLimitRpm: number
  revokedAt: number | null
  requests24h: number
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'
export type LogSource = 'gateway' | 'engine' | 'journald' | 'kernel'

export interface LogLine {
  id: string
  ts: number
  level: LogLevel
  source: LogSource
  host: string
  service: string
  message: string
  pattern: string
  attributes: Record<string, string>
}

export interface HistogramBucket {
  t: number
  error: number
  warn: number
  info: number
  debug: number
}

export interface LogQueryInput {
  query: string
  range: TimeRange
  /** when set, ignore range and show ±60 s around this timestamp */
  around?: number
  limit?: number
}

export interface LogIncidentBand {
  from: number
  to: number
  label: string
}

export interface LogQueryResult {
  lines: LogLine[]
  histogram: HistogramBucket[]
  total: number
  truncated: boolean
  bands: LogIncidentBand[]
  from: number
  to: number
}

export type IncidentSeverity = 'critical' | 'warning' | 'info'
export type IncidentStatus = 'ongoing' | 'resolved'

export interface Incident {
  id: string
  title: string
  severity: IncidentSeverity
  status: IncidentStatus
  nodeId: string | null
  ruleId: string
  startedAt: number
  resolvedAt: number | null
  timeline: { ts: number; text: string }[]
}

export interface AlertRule {
  id: string
  name: string
  condition: string
  severity: IncidentSeverity
  enabled: boolean
}

export type UpdateRing = 'canary' | 'ring1' | 'ring2'

export interface FirmwareUpdate {
  component: string
  current: string
  available: string
}

export interface SparkToolEnvelope {
  tool: string
  ts: string
  host: string
  status: 'ok' | 'warn' | 'error'
  rc: number
  duration_ms: number
  summary: Record<string, unknown>
  warnings: string[]
  artifacts: string[]
}

export interface NodeUpdateStatus {
  nodeId: string
  model: NodeModel
  ring: UpdateRing
  currentOs: string
  targetOs: string
  aptPending: string[]
  firmwarePending: FirmwareUpdate[]
  rebootRequired: boolean
  lastChecked: number
  envelope: SparkToolEnvelope
}

export type RolloutStep = 'queued' | 'precheck' | 'apply' | 'reboot' | 'postcheck' | 'done' | 'failed'
export type RolloutStatus = 'awaiting-approval' | 'running' | 'completed' | 'failed'

export interface RolloutNode {
  nodeId: string
  ring: UpdateRing
  step: RolloutStep
}

export interface Rollout {
  id: string
  name: string
  targetOs: string
  rings: UpdateRing[]
  window: string
  status: RolloutStatus
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  nodes: RolloutNode[]
}

export interface StartRolloutInput {
  targetOs: string
  rings: UpdateRing[]
  window: string
  requireApproval: boolean
}

export type ActivityKind = 'reboot' | 'deploy' | 'update' | 'alert' | 'key' | 'drain' | 'diag' | 'system'

export interface ActivityEvent {
  id: string
  ts: number
  kind: ActivityKind
  text: string
  nodeId: string | null
}

export interface GatewayPoint {
  t: number
  rps: number
  p50Ms: number
  p95Ms: number
  ttftMs: number
  errorRate: number
  tokensPerSec: number
}

export interface GatewayRoute {
  model: string
  deploymentId: string
  engine: Engine
  replicas: number
  nodeIds: string[]
  healthy: boolean
}

export interface GatewayInfo {
  baseUrl: string
  defaultModel: string
  models: string[]
}

export interface UsagePoint {
  t: number
  requests: number
  byModel: Record<string, number>
  byKey: Record<string, number>
}

export interface UsageReport {
  points: UsagePoint[]
  tokensIn: number
  tokensOut: number
  requests: number
  cloudCostUsd: number
  topKeys: { keyId: string; name: string; tokens: number; requests: number }[]
  models: string[]
  keys: { id: string; name: string }[]
}

export interface FleetSummary {
  online: number
  total: number
  gpuUtilAvg: number
  memUsedGB: number
  memTotalGB: number
  powerW: number
  tokensPerSec: number
  activeIncidents: number
}

export interface GpuProcess {
  pid: number
  user: string
  name: string
  engine: Engine | null
  gpuMemMiB: number
}

export interface HealthCheck {
  name: string
  status: 'pass' | 'warn' | 'fail'
  detail: string
}

export interface NodeHealth {
  checks: HealthCheck[]
  envelope: SparkToolEnvelope
}

export interface NodeInventory {
  firmware: { component: string; version: string }[]
  packages: { name: string; version: string }[]
  envelope: SparkToolEnvelope
}

export interface FailureInjection {
  nodeOffline: string | null
  gatewayErrors: boolean
  xidStorm: boolean
  /** when true, MockClient rejects every request except failure get/set (exercises UI error states) */
  apiErrors: boolean
}

export type Topic =
  | 'nodes' | 'deployments' | 'keys' | 'rules' | 'incidents' | 'updates' | 'rollouts' | 'activity' | 'failures'

export type SimEvent = { type: 'tick'; now: number } | { type: 'changed'; topic: Topic }
```

- [ ] **Step 2: Write the failing RNG test**

`src/api/mock/rng.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { clamp, hash, mulberry32, noise, pick, pickWeighted, smoothNoise } from './rng'

describe('rng', () => {
  it('hash is stable and input-sensitive', () => {
    expect(hash('spark-01', 3)).toBe(hash('spark-01', 3))
    expect(hash('spark-01', 3)).not.toBe(hash('spark-01', 4))
  })
  it('noise is deterministic and within [0,1)', () => {
    for (let i = 0; i < 1000; i++) {
      const v = noise(1729, 'x', i)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
      expect(noise(1729, 'x', i)).toBe(v)
    }
  })
  it('noise is roughly uniform', () => {
    let sum = 0
    for (let i = 0; i < 5000; i++) sum += noise('u', i)
    expect(sum / 5000).toBeGreaterThan(0.45)
    expect(sum / 5000).toBeLessThan(0.55)
  })
  it('mulberry32 repeats for the same seed', () => {
    const a = mulberry32(7)
    const b = mulberry32(7)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })
  it('smoothNoise is continuous', () => {
    const p = 60_000
    const a = smoothNoise(p, 1_000_000, 's')
    const b = smoothNoise(p, 1_000_100, 's')
    expect(Math.abs(a - b)).toBeLessThan(0.02)
  })
  it('pick, pickWeighted, clamp', () => {
    expect(pick(['a', 'b', 'c'], 0.999)).toBe('c')
    expect(pickWeighted([{ value: 'x', weight: 1 }, { value: 'y', weight: 3 }], 0.2)).toBe('x')
    expect(pickWeighted([{ value: 'x', weight: 1 }, { value: 'y', weight: 3 }], 0.3)).toBe('y')
    expect(clamp(120, 0, 100)).toBe(100)
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run src/api/mock/rng.test.ts`
Expected: FAIL, `Cannot find module './rng'`.

- [ ] **Step 4: Write `src/api/mock/rng.ts`**

```ts
type Part = string | number

/** FNV-1a 32-bit over the joined parts. */
export function hash(...parts: Part[]): number {
  const input = parts.join('|')
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function mix(seed: number): number {
  let t = (seed + 0x6d2b79f5) >>> 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** Deterministic pseudo-random number in [0, 1) for the given parts. */
export function noise(...parts: Part[]): number {
  return mix(hash(...parts))
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    return mix(a - 0x6d2b79f5)
  }
}

/** Cosine-interpolated value noise in [0, 1): continuous in t, knots every periodMs. */
export function smoothNoise(periodMs: number, t: number, ...parts: Part[]): number {
  const k = Math.floor(t / periodMs)
  const f = (t - k * periodMs) / periodMs
  const a = noise(...parts, k)
  const b = noise(...parts, k + 1)
  const w = (1 - Math.cos(f * Math.PI)) / 2
  return a + (b - a) * w
}

export function pick<T>(items: readonly T[], r: number): T {
  return items[Math.min(items.length - 1, Math.floor(r * items.length))]
}

export function pickWeighted<T>(items: readonly { value: T; weight: number }[], r: number): T {
  const total = items.reduce((s, i) => s + i.weight, 0)
  let acc = 0
  for (const item of items) {
    acc += item.weight / total
    if (r < acc) return item.value
  }
  return items[items.length - 1].value
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run src/api/mock/rng.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Write the failing fixtures test**

`src/api/mock/fixtures.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { DEPLOYMENT_SPECS, KEY_SPECS, MODEL_CATALOG, NODE_SPECS, RINGS } from './fixtures'

describe('fixtures', () => {
  it('defines 8 DGX Spark FE + 4 ASUS GX10 with unique ids', () => {
    expect(NODE_SPECS).toHaveLength(12)
    expect(NODE_SPECS.filter((n) => n.model === 'DGX Spark FE')).toHaveLength(8)
    expect(NODE_SPECS.filter((n) => n.model === 'ASUS GX10')).toHaveLength(4)
    expect(new Set(NODE_SPECS.map((n) => n.id)).size).toBe(12)
  })
  it('assigns every node to exactly one deployment replica', () => {
    const used = DEPLOYMENT_SPECS.flatMap((d) => d.replicas.flatMap((r) => r.nodeIds))
    expect(used.sort()).toEqual(NODE_SPECS.map((n) => n.id).sort())
  })
  it('has one 2-node group, one 4-node group and 6 single-node replicas', () => {
    const sizes = DEPLOYMENT_SPECS.flatMap((d) => d.replicas.map((r) => r.nodeIds.length)).sort()
    expect(sizes).toEqual([1, 1, 1, 1, 1, 1, 2, 4])
  })
  it('only multi-node-capable engines run multi-node replicas', () => {
    for (const d of DEPLOYMENT_SPECS) {
      if (d.replicas.some((r) => r.nodeIds.length > 1)) expect(['vLLM', 'SGLang']).toContain(d.engine)
    }
  })
  it('every deployment model exists in the catalog', () => {
    for (const d of DEPLOYMENT_SPECS) expect(MODEL_CATALOG.map((m) => m.id)).toContain(d.model)
  })
  it('rings cover all nodes once: canary 1, ring1 3, ring2 8', () => {
    expect(RINGS.canary).toHaveLength(1)
    expect(RINGS.ring1).toHaveLength(3)
    expect(RINGS.ring2).toHaveLength(8)
    expect([...RINGS.canary, ...RINGS.ring1, ...RINGS.ring2].sort()).toEqual(NODE_SPECS.map((n) => n.id).sort())
  })
  it('key traffic shares of active keys sum to 1', () => {
    const sum = KEY_SPECS.filter((k) => k.revokedAgoMs === null).reduce((s, k) => s + k.share, 0)
    expect(sum).toBeCloseTo(1, 5)
  })
})
```

- [ ] **Step 7: Run to verify it fails**

Run: `pnpm vitest run src/api/mock/fixtures.test.ts`
Expected: FAIL, `Cannot find module './fixtures'`.

- [ ] **Step 8: Write `src/api/mock/fixtures.ts`**

```ts
import type {
  AlertRule, CatalogModel, Engine, IncidentSeverity, NodeModel, OsInfo, Replica, UpdateRing, ActivityKind, FirmwareUpdate,
} from '../types'

export const SIM_SEED = 1729
export const GATEWAY_BASE_URL = 'http://sparkman.local:4000'
export const FLEET_CONFIG = { sshUser: 'sparkman', sshKeyPath: '~/.ssh/sparkman_ed25519', domain: 'lab.local' }
/** Assumed frontier-API list price used for the "cloud equivalent" estimate (USD per 1M tokens). */
export const CLOUD_PRICE_PER_M = { input: 3, output: 15 }
/** Share of gateway tokens that are prompt (input) tokens; coding agents are input-heavy. */
export const INPUT_TOKEN_SHARE = 0.85

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export const BASE_OS: OsInfo = {
  dgxOs: '7.4.1', kernel: '6.14.0-1013-nvidia', driver: '580.126.09', cuda: '13.0.1', uefi: '1.104.7',
}
export const TARGET_OS: OsInfo = {
  dgxOs: '7.5.0', kernel: '6.17.0-1004-nvidia', driver: '580.159.03', cuda: '13.0.2', uefi: '1.110.13',
}

export interface NodeSpec {
  id: string
  model: NodeModel
  ip: string
  diskGB: number
  diskBasePct: number
  assetTag: string
  serial: string
  thermalIssue: boolean
  bootedAgoMs: number
}

const spark = (n: number, diskBasePct: number, extra: Partial<NodeSpec> = {}): NodeSpec => ({
  id: `spark-0${n}`, model: 'DGX Spark FE', ip: `10.42.0.${10 + n}`, diskGB: 4000, diskBasePct,
  assetTag: `UM-AI-${1000 + n}`, serial: `1G7A25${300 + n}0${n}`, thermalIssue: false, bootedAgoMs: (9 + n) * DAY,
  ...extra,
})
const gx10 = (n: number, diskBasePct: number): NodeSpec => ({
  id: `gx10-0${n}`, model: 'ASUS GX10', ip: `10.42.0.${30 + n}`, diskGB: 2000, diskBasePct,
  assetTag: `UM-AI-${2000 + n}`, serial: `S8N0GX10${700 + n}`, thermalIssue: false, bootedAgoMs: (21 + n) * DAY,
})

export const NODE_SPECS: NodeSpec[] = [
  spark(1, 41), spark(2, 38), spark(3, 57), spark(4, 22), spark(5, 63, { thermalIssue: true, bootedAgoMs: 2 * DAY }),
  spark(6, 49), spark(7, 31), spark(8, 72), gx10(1, 44), gx10(2, 46), gx10(3, 45), gx10(4, 51),
]

export const MODEL_CATALOG: CatalogModel[] = [
  { id: 'qwen3-235b-a22b', displayName: 'Qwen3 235B A22B Instruct', sizeGB: 140, quant: 'NVFP4', contextLength: 131072, engines: ['vLLM', 'SGLang'] },
  { id: 'gpt-oss-120b', displayName: 'gpt-oss 120B', sizeGB: 65, quant: 'MXFP4', contextLength: 131072, engines: ['vLLM', 'Ollama', 'SGLang'] },
  { id: 'gpt-oss-20b', displayName: 'gpt-oss 20B', sizeGB: 14, quant: 'MXFP4', contextLength: 131072, engines: ['vLLM', 'Ollama'] },
  { id: 'qwen3-coder-30b-a3b', displayName: 'Qwen3 Coder 30B A3B', sizeGB: 19, quant: 'Q4_K_M', contextLength: 262144, engines: ['Ollama', 'vLLM'] },
  { id: 'qwen3.6-35b-a3b', displayName: 'Qwen3.6 35B A3B', sizeGB: 23, quant: 'Q4_K_M', contextLength: 262144, engines: ['Ollama', 'vLLM'] },
  { id: 'llama-3.1-8b-instruct', displayName: 'Llama 3.1 8B Instruct', sizeGB: 16, quant: 'FP16', contextLength: 131072, engines: ['NIM', 'vLLM', 'Ollama'] },
  { id: 'mistral-small-3.2-24b', displayName: 'Mistral Small 3.2 24B', sizeGB: 25, quant: 'FP8', contextLength: 131072, engines: ['vLLM', 'Ollama'] },
  { id: 'nemotron-nano-9b-v2', displayName: 'NVIDIA Nemotron Nano 9B v2', sizeGB: 18, quant: 'BF16', contextLength: 131072, engines: ['NIM', 'vLLM'] },
  { id: 'deepseek-v3.1', displayName: 'DeepSeek V3.1', sizeGB: 380, quant: 'NVFP4', contextLength: 131072, engines: ['SGLang', 'vLLM'] },
]

export const ENGINE_PORT: Record<Engine, number> = { vLLM: 8000, NIM: 8000, Ollama: 11434, SGLang: 30000 }

export interface DeploymentSpec {
  id: string
  model: string
  engine: Engine
  replicas: Replica[]
  memoryGBPerNode: number
  /** relative share of gateway traffic, 0..1 */
  trafficWeight: number
  peakTokensPerSec: number
  peakRps: number
  createdAgoMs: number
}

export const DEPLOYMENT_SPECS: DeploymentSpec[] = [
  { id: 'dep-qwen235', model: 'qwen3-235b-a22b', engine: 'vLLM', replicas: [{ id: 'grp-coder', nodeIds: ['spark-01', 'spark-02'] }], memoryGBPerNode: 92, trafficWeight: 0.95, peakTokensPerSec: 1400, peakRps: 3.2, createdAgoMs: 12 * DAY },
  { id: 'dep-gptoss120', model: 'gpt-oss-120b', engine: 'vLLM', replicas: [{ id: 'rep-gptoss-a', nodeIds: ['spark-03'] }, { id: 'rep-gptoss-b', nodeIds: ['spark-06'] }], memoryGBPerNode: 88, trafficWeight: 0.8, peakTokensPerSec: 2600, peakRps: 5.5, createdAgoMs: 20 * DAY },
  { id: 'dep-qwencoder', model: 'qwen3-coder-30b-a3b', engine: 'Ollama', replicas: [{ id: 'rep-qwencoder', nodeIds: ['spark-04'] }], memoryGBPerNode: 26, trafficWeight: 0.6, peakTokensPerSec: 1100, peakRps: 2.4, createdAgoMs: 15 * DAY },
  { id: 'dep-llama8b', model: 'llama-3.1-8b-instruct', engine: 'NIM', replicas: [{ id: 'rep-llama8b', nodeIds: ['spark-05'] }], memoryGBPerNode: 34, trafficWeight: 0.55, peakTokensPerSec: 1800, peakRps: 4.1, createdAgoMs: 30 * DAY },
  { id: 'dep-qwen36', model: 'qwen3.6-35b-a3b', engine: 'Ollama', replicas: [{ id: 'rep-qwen36', nodeIds: ['spark-07'] }], memoryGBPerNode: 30, trafficWeight: 0.7, peakTokensPerSec: 1200, peakRps: 2.6, createdAgoMs: 6 * DAY },
  { id: 'dep-mistral24', model: 'mistral-small-3.2-24b', engine: 'vLLM', replicas: [{ id: 'rep-mistral24', nodeIds: ['spark-08'] }], memoryGBPerNode: 70, trafficWeight: 0.35, peakTokensPerSec: 900, peakRps: 1.5, createdAgoMs: 9 * DAY },
  { id: 'dep-deepseek', model: 'deepseek-v3.1', engine: 'SGLang', replicas: [{ id: 'grp-lab', nodeIds: ['gx10-01', 'gx10-02', 'gx10-03', 'gx10-04'] }], memoryGBPerNode: 104, trafficWeight: 0.25, peakTokensPerSec: 600, peakRps: 0.6, createdAgoMs: 4 * DAY },
]

export interface KeySpec {
  id: string
  name: string
  prefix: string
  rateLimitRpm: number
  createdAgoMs: number
  revokedAgoMs: number | null
  share: number
}

export const KEY_SPECS: KeySpec[] = [
  { id: 'key-claude', name: 'claude-code-laptop', prefix: 'sk-spark-7Qm2', rateLimitRpm: 600, createdAgoMs: 40 * DAY, revokedAgoMs: null, share: 0.38 },
  { id: 'key-codex', name: 'codex-cli', prefix: 'sk-spark-c0D3', rateLimitRpm: 600, createdAgoMs: 33 * DAY, revokedAgoMs: null, share: 0.22 },
  { id: 'key-opencode', name: 'opencode-workstation', prefix: 'sk-spark-0pNc', rateLimitRpm: 300, createdAgoMs: 21 * DAY, revokedAgoMs: null, share: 0.14 },
  { id: 'key-cursor', name: 'cursor', prefix: 'sk-spark-Cur5', rateLimitRpm: 300, createdAgoMs: 18 * DAY, revokedAgoMs: null, share: 0.12 },
  { id: 'key-ci', name: 'ci-review-bot', prefix: 'sk-spark-ci9R', rateLimitRpm: 120, createdAgoMs: 12 * DAY, revokedAgoMs: null, share: 0.1 },
  { id: 'key-continue', name: 'continue-vscode', prefix: 'sk-spark-Ctn4', rateLimitRpm: 120, createdAgoMs: 7 * DAY, revokedAgoMs: null, share: 0.04 },
  { id: 'key-old', name: 'old-vscode', prefix: 'sk-spark-x0Ld', rateLimitRpm: 60, createdAgoMs: 90 * DAY, revokedAgoMs: 30 * DAY, share: 0 },
]

export const ALERT_RULES: AlertRule[] = [
  { id: 'rule-offline', name: 'Node offline', condition: 'no heartbeat for 60 s', severity: 'critical', enabled: true },
  { id: 'rule-gpu-temp', name: 'GPU temperature high', condition: 'gpu_temp > 80 °C for 5 min', severity: 'warning', enabled: true },
  { id: 'rule-xid', name: 'GPU Xid error', condition: 'kernel log matches NVRM: Xid', severity: 'critical', enabled: true },
  { id: 'rule-disk', name: 'Disk almost full', condition: 'disk_used > 90 %', severity: 'warning', enabled: true },
  { id: 'rule-5xx', name: 'Gateway error rate', condition: '5xx rate > 2 % for 2 min', severity: 'critical', enabled: true },
  { id: 'rule-update', name: 'Update failed', condition: 'spark_updatectl postcheck != ok', severity: 'warning', enabled: false },
]

export interface IncidentSpec {
  id: string
  title: string
  severity: IncidentSeverity
  nodeId: string | null
  ruleId: string
  startedAgoMs: number
  durationMs: number | null
  logKind: 'thermal' | 'xid' | 'gateway-5xx'
  timeline: { agoMs: number; text: string }[]
}

export const INCIDENT_SPECS: IncidentSpec[] = [
  {
    id: 'inc-thermal-05', title: 'spark-05 thermal throttling', severity: 'warning', nodeId: 'spark-05', ruleId: 'rule-gpu-temp',
    startedAgoMs: 3 * HOUR, durationMs: null, logKind: 'thermal',
    timeline: [
      { agoMs: 3 * HOUR, text: 'GPU temperature crossed 80 °C (sustained 5 min)' },
      { agoMs: 3 * HOUR - 4 * MIN, text: 'Clocks reduced; NIM throughput down 18 %' },
      { agoMs: 2 * HOUR, text: 'ACPI zone acpitz reported 91 °C' },
    ],
  },
  {
    id: 'inc-xid-05', title: 'Xid 31 on spark-05', severity: 'critical', nodeId: 'spark-05', ruleId: 'rule-xid',
    startedAgoMs: 2 * DAY + 2 * HOUR, durationMs: 4 * MIN, logKind: 'xid',
    timeline: [
      { agoMs: 2 * DAY + 2 * HOUR, text: 'NVRM: Xid 31 (MMU fault) from python3' },
      { agoMs: 2 * DAY + 2 * HOUR - 2 * MIN, text: 'NIM container restarted' },
      { agoMs: 2 * DAY + 2 * HOUR - 4 * MIN, text: 'Node rebooted by operator; resolved' },
    ],
  },
  {
    id: 'inc-5xx', title: 'Gateway 5xx spike', severity: 'critical', nodeId: null, ruleId: 'rule-5xx',
    startedAgoMs: 26 * HOUR, durationMs: 6 * MIN, logKind: 'gateway-5xx',
    timeline: [
      { agoMs: 26 * HOUR, text: '5xx rate 7.8 % (threshold 2 %)' },
      { agoMs: 26 * HOUR - 3 * MIN, text: 'Upstream spark-03 connection resets' },
      { agoMs: 26 * HOUR - 6 * MIN, text: 'Error rate back under 0.5 %; resolved' },
    ],
  },
]

export const ACTIVITY_SPECS: { agoMs: number; kind: ActivityKind; text: string; nodeId: string | null }[] = [
  { agoMs: 3 * HOUR, kind: 'alert', text: 'Alert opened: spark-05 thermal throttling', nodeId: 'spark-05' },
  { agoMs: 6 * HOUR, kind: 'key', text: 'API key continue-vscode used for the first time', nodeId: null },
  { agoMs: 26 * HOUR, kind: 'alert', text: 'Gateway 5xx spike resolved after 6 min', nodeId: null },
  { agoMs: 2 * DAY, kind: 'reboot', text: 'spark-05 rebooted after Xid 31', nodeId: 'spark-05' },
  { agoMs: 4 * DAY, kind: 'deploy', text: 'Deployed deepseek-v3.1 on gx10-01…04 (SGLang, 4 nodes)', nodeId: null },
  { agoMs: 6 * DAY, kind: 'deploy', text: 'Deployed qwen3.6-35b-a3b on spark-07 (Ollama)', nodeId: 'spark-07' },
  { agoMs: 9 * DAY, kind: 'update', text: 'Rollout "Security updates" completed on 12 nodes', nodeId: null },
]

export const RINGS: Record<UpdateRing, string[]> = {
  canary: ['spark-08'],
  ring1: ['spark-03', 'spark-04', 'spark-07'],
  ring2: ['spark-01', 'spark-02', 'spark-05', 'spark-06', 'gx10-01', 'gx10-02', 'gx10-03', 'gx10-04'],
}

export const APT_PENDING: string[] = [
  'nvidia-driver-580-open', 'cuda-toolkit-13-0', 'linux-image-6.17.0-1004-nvidia', 'dgx-dashboard',
  'nvidia-container-toolkit', 'docker-ce', 'openssl', 'libnccl2', 'nvidia-sync-agent', 'dgx-release',
]

export const FIRMWARE_PENDING: Record<NodeModel, FirmwareUpdate[]> = {
  'DGX Spark FE': [
    { component: 'UEFI', current: '1.104.7', available: '1.110.13' },
    { component: 'EC', current: '0.9.18', available: '0.9.21' },
  ],
  'ASUS GX10': [{ component: 'ASUS SOC capsule', current: '2.3.1', available: '2.4.0' }],
}

export const PACKAGES: { name: string; version: string }[] = [
  { name: 'nvidia-driver-580-open', version: '580.126.09-0ubuntu1' },
  { name: 'cuda-toolkit-13-0', version: '13.0.1-1' },
  { name: 'libnccl2', version: '2.28.3-1+cuda13.0' },
  { name: 'nvidia-container-toolkit', version: '1.18.0-1' },
  { name: 'docker-ce', version: '5:28.4.0-1~ubuntu.24.04~noble' },
  { name: 'dgx-dashboard', version: '0.112.4' },
  { name: 'dgx-release', version: '7.4.1' },
]

export const ROLLOUT_HISTORY: { id: string; name: string; targetOs: string; startedAgoMs: number; durationMs: number }[] = [
  { id: 'ro-sec-0929', name: 'Security updates (openssl, kernel)', targetOs: '7.4.1', startedAgoMs: 9 * DAY, durationMs: 41 * MIN },
  { id: 'ro-741', name: 'DGX OS 7.4.1', targetOs: '7.4.1', startedAgoMs: 28 * DAY, durationMs: 2 * HOUR + 12 * MIN },
]
```

- [ ] **Step 9: Run to verify it passes**

Run: `pnpm vitest run src/api/mock/fixtures.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 10: Typecheck and commit**

Run: `pnpm typecheck` — expected: no errors.

```bash
git add src/api
git commit -m "feat: domain types, seeded RNG and fleet fixtures

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Metric, gateway and usage models

**Files:**
- Create: `src/api/mock/metrics.ts`, `src/api/mock/metrics.test.ts`

**Interfaces:**
- Consumes: `NodeSpec`, `DeploymentSpec`, `KEY_SPECS`, `CLOUD_PRICE_PER_M`, `INPUT_TOKEN_SHARE` from `./fixtures`; `noise`, `smoothNoise`, `clamp` from `./rng`; types from `../types`.
- Produces:
  - `RANGE_MS: Record<TimeRange, number>`, `SERIES_POINTS = 120`, `seriesTimes(range, now): number[]`
  - `interface Outage { nodeId: string; from: number; to: number | null }`
  - `isOffline(outages, nodeId, t): boolean`
  - `interface MetricWorld { seed: number; outages: Outage[]; gatewayErrorWindows: { from: number; to: number | null }[] }`
  - `deploymentLoad(seed, dep: DeploymentSpec, t): number` (0..1)
  - `sampleNode(world, node: NodeSpec, dep: DeploymentSpec | null, t): MetricPoint`
  - `nodeSeries(world, node, dep, range, now): MetricPoint[]`
  - `gatewayPoint(world, deps: DeploymentSpec[], t): GatewayPoint`, `gatewaySeries(world, deps, range, now): GatewayPoint[]`
  - `usageReport(world, deps, keys: KeySpec[], range, now): UsageReport`
  - `DIURNAL(t): number`

- [ ] **Step 1: Write the failing test**

`src/api/mock/metrics.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { DEPLOYMENT_SPECS, KEY_SPECS, NODE_SPECS } from './fixtures'
import {
  SERIES_POINTS, deploymentLoad, gatewaySeries, isOffline, nodeSeries, sampleNode, seriesTimes, usageReport,
  type MetricWorld,
} from './metrics'

const NOW = new Date(2026, 9, 8, 15, 0, 0).getTime()
const world: MetricWorld = { seed: 1729, outages: [], gatewayErrorWindows: [] }
const depFor = (id: string) => DEPLOYMENT_SPECS.find((d) => d.replicas.some((r) => r.nodeIds.includes(id))) ?? null

describe('metrics model', () => {
  it('seriesTimes returns 120 aligned points ending at or before now', () => {
    const ts = seriesTimes('1h', NOW + 1234)
    expect(ts).toHaveLength(SERIES_POINTS)
    expect(ts[ts.length - 1]).toBeLessThanOrEqual(NOW + 1234)
    expect(seriesTimes('1h', NOW + 1234)).toEqual(ts)
  })

  it('deploymentLoad stays within 0..1', () => {
    for (const d of DEPLOYMENT_SPECS) {
      for (let i = 0; i < 500; i++) {
        const l = deploymentLoad(1729, d, NOW - i * 600_000)
        expect(l).toBeGreaterThanOrEqual(0)
        expect(l).toBeLessThanOrEqual(1)
      }
    }
  })

  it('every node sample over 7 days stays in physical bounds', () => {
    for (const node of NODE_SPECS) {
      for (const p of nodeSeries(world, node, depFor(node.id), '7d', NOW)) {
        expect(p.gpuUtil!).toBeGreaterThanOrEqual(0)
        expect(p.gpuUtil!).toBeLessThanOrEqual(100)
        expect(p.memUsedGB!).toBeGreaterThan(0)
        expect(p.memUsedGB!).toBeLessThanOrEqual(128)
        expect(p.gpuTempC!).toBeGreaterThan(20)
        expect(p.gpuTempC!).toBeLessThan(105)
        expect(p.acpiTempC!).toBeGreaterThan(p.gpuTempC!)
        expect(p.gpuPowerW!).toBeLessThanOrEqual(100)
        expect(p.diskUsedPct!).toBeLessThanOrEqual(100)
      }
    }
  })

  it('is deterministic for the same world and time', () => {
    const n = NODE_SPECS[0]
    expect(sampleNode(world, n, depFor(n.id), NOW)).toEqual(sampleNode(world, n, depFor(n.id), NOW))
  })

  it('only multi-node replicas move traffic over ConnectX-7', () => {
    const single = NODE_SPECS.find((n) => n.id === 'spark-04')!
    const grouped = NODE_SPECS.find((n) => n.id === 'spark-01')!
    expect(sampleNode(world, single, depFor('spark-04'), NOW).cx7RxBps).toBeLessThan(1e6)
    expect(sampleNode(world, grouped, depFor('spark-01'), NOW).cx7RxBps).toBeGreaterThan(1e8)
  })

  it('the thermal-issue node runs hotter than its peers on average', () => {
    const avgTemp = (id: string) => {
      const node = NODE_SPECS.find((n) => n.id === id)!
      const s = nodeSeries(world, node, depFor(id), '24h', NOW)
      return s.reduce((a, p) => a + p.gpuTempC!, 0) / s.length
    }
    expect(avgTemp('spark-05')).toBeGreaterThan(avgTemp('spark-04') + 8)
  })

  it('outages produce null metrics inside the window only', () => {
    const w: MetricWorld = { ...world, outages: [{ nodeId: 'spark-03', from: NOW - 60_000, to: null }] }
    const node = NODE_SPECS.find((n) => n.id === 'spark-03')!
    expect(isOffline(w.outages, 'spark-03', NOW)).toBe(true)
    expect(sampleNode(w, node, depFor('spark-03'), NOW).gpuUtil).toBeNull()
    expect(sampleNode(w, node, depFor('spark-03'), NOW - 120_000).gpuUtil).not.toBeNull()
  })

  it('gateway error windows raise the error rate', () => {
    const calm = gatewaySeries(world, DEPLOYMENT_SPECS, '15m', NOW)
    const bad = gatewaySeries({ ...world, gatewayErrorWindows: [{ from: NOW - 900_000, to: null }] }, DEPLOYMENT_SPECS, '15m', NOW)
    const avg = (s: typeof calm) => s.reduce((a, p) => a + p.errorRate, 0) / s.length
    expect(avg(calm)).toBeLessThan(0.01)
    expect(avg(bad)).toBeGreaterThan(0.04)
  })

  it('usage report splits tokens across active keys and models', () => {
    const r = usageReport(world, DEPLOYMENT_SPECS, KEY_SPECS, '24h', NOW)
    expect(r.points).toHaveLength(SERIES_POINTS)
    expect(r.tokensIn + r.tokensOut).toBeGreaterThan(0)
    expect(r.tokensIn).toBeGreaterThan(r.tokensOut)
    expect(r.keys.map((k) => k.id)).not.toContain('key-old')
    expect(r.topKeys[0].name).toBe('claude-code-laptop')
    expect(r.cloudCostUsd).toBeGreaterThan(0)
    const p = r.points[60]
    const byModel = Object.values(p.byModel).reduce((a, b) => a + b, 0)
    const byKey = Object.values(p.byKey).reduce((a, b) => a + b, 0)
    expect(byKey).toBeCloseTo(byModel, 0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/api/mock/metrics.test.ts`
Expected: FAIL, `Cannot find module './metrics'`.

- [ ] **Step 3: Write `src/api/mock/metrics.ts`**

```ts
import type { GatewayPoint, MetricPoint, TimeRange, UsageReport } from '../types'
import { CLOUD_PRICE_PER_M, INPUT_TOKEN_SHARE, type DeploymentSpec, type KeySpec, type NodeSpec } from './fixtures'
import { clamp, noise, smoothNoise } from './rng'

export const SERIES_POINTS = 120
export const RANGE_MS: Record<TimeRange, number> = {
  '15m': 15 * 60_000,
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
}

export interface Outage {
  nodeId: string
  from: number
  to: number | null
}

export interface MetricWorld {
  seed: number
  outages: Outage[]
  gatewayErrorWindows: { from: number; to: number | null }[]
}

const GB = 1024 ** 3
const MB = 1024 ** 2

export function seriesTimes(range: TimeRange, now: number): number[] {
  const step = RANGE_MS[range] / SERIES_POINTS
  const end = Math.floor(now / step) * step
  return Array.from({ length: SERIES_POINTS }, (_, i) => end - (SERIES_POINTS - 1 - i) * step)
}

export function isOffline(outages: Outage[], nodeId: string, t: number): boolean {
  return outages.some((o) => o.nodeId === nodeId && t >= o.from && (o.to === null || t < o.to))
}

const inWindow = (ws: { from: number; to: number | null }[], t: number) =>
  ws.some((w) => t >= w.from && (w.to === null || t < w.to))

/** Working-hours curve: ~0.25 overnight, ~1.0 mid-afternoon (local time). */
export function DIURNAL(t: number): number {
  const d = new Date(t)
  const hour = d.getHours() + d.getMinutes() / 60
  return 0.625 + 0.375 * Math.sin(((hour - 9) / 24) * 2 * Math.PI)
}

export function deploymentLoad(seed: number, dep: DeploymentSpec, t: number): number {
  const slow = smoothNoise(20 * 60_000, t, seed, dep.id, 'slow')
  const fast = smoothNoise(90_000, t, seed, dep.id, 'fast')
  const raw = dep.trafficWeight * DIURNAL(t) * (0.55 + 0.35 * slow + 0.25 * fast)
  return clamp(raw, 0, 1)
}

const NULL_POINT = (t: number): MetricPoint => ({
  t, gpuUtil: null, memUsedGB: null, gpuPowerW: null, gpuTempC: null, acpiTempC: null, cpuUser: null, cpuSystem: null,
  netRxBps: null, netTxBps: null, cx7RxBps: null, cx7TxBps: null, diskReadBps: null, diskWriteBps: null, diskUsedPct: null,
})

export function sampleNode(world: MetricWorld, node: NodeSpec, dep: DeploymentSpec | null, t: number): MetricPoint {
  if (isOffline(world.outages, node.id, t)) return NULL_POINT(t)
  const n = (k: string) => noise(world.seed, node.id, k, Math.floor(t / 5000))
  const load = dep ? deploymentLoad(world.seed, dep, t) : 0.02
  const grouped = dep?.replicas.some((r) => r.nodeIds.length > 1 && r.nodeIds.includes(node.id)) ?? false
  const gpuUtil = clamp(dep ? load * 100 * (0.88 + 0.12 * n('u')) : 1 + 3 * n('u'), 0, 100)
  const memUsedGB = clamp(7 + (dep?.memoryGBPerNode ?? 0) + load * 6 + n('m') * 0.8, 1, 126)
  const gpuPowerW = clamp(11 + gpuUtil * 0.82 + n('p') * 3, 5, 99)
  const thermal = node.thermalIssue ? 18 + 6 * smoothNoise(15 * 60_000, t, world.seed, node.id, 'th') : 0
  const gpuTempC = clamp(36 + gpuUtil * 0.38 + n('t') * 2 + thermal, 25, 102)
  const acpiTempC = gpuTempC + 8 + n('a') * 5
  return {
    t,
    gpuUtil,
    memUsedGB,
    gpuPowerW,
    gpuTempC,
    acpiTempC,
    cpuUser: clamp(3 + load * 18 + n('cu') * 4, 0, 100),
    cpuSystem: clamp(1 + load * 4 + n('cs') * 1.5, 0, 100),
    netRxBps: 50 * 1024 + load * 2.5 * MB * (0.7 + 0.6 * n('rx')),
    netTxBps: 20 * 1024 + load * 4 * MB * (0.7 + 0.6 * n('tx')),
    cx7RxBps: grouped ? load * 6 * GB * (0.6 + 0.4 * n('crx')) + 2e8 : n('crx') * 2e4,
    cx7TxBps: grouped ? load * 6 * GB * (0.6 + 0.4 * n('ctx')) + 2e8 : n('ctx') * 2e4,
    diskReadBps: (1 + 19 * n('dr')) * MB,
    diskWriteBps: (1 + 4 * n('dw')) * MB,
    diskUsedPct: clamp(node.diskBasePct + 0.5 * smoothNoise(6 * 3_600_000, t, node.id, 'disk'), 0, 100),
  }
}

export function nodeSeries(world: MetricWorld, node: NodeSpec, dep: DeploymentSpec | null, range: TimeRange, now: number): MetricPoint[] {
  return seriesTimes(range, now).map((t) => sampleNode(world, node, dep, t))
}

export function gatewayPoint(world: MetricWorld, deps: DeploymentSpec[], t: number): GatewayPoint {
  let rps = 0
  let tps = 0
  let loadSum = 0
  for (const d of deps) {
    const l = deploymentLoad(world.seed, d, t)
    rps += l * d.peakRps
    tps += l * d.peakTokensPerSec * d.replicas.length
    loadSum += l
  }
  const avgLoad = deps.length ? loadSum / deps.length : 0
  const n = (k: string) => noise(world.seed, 'gw', k, Math.floor(t / 5000))
  const erroring = inWindow(world.gatewayErrorWindows, t)
  return {
    t,
    rps,
    tokensPerSec: tps,
    p50Ms: 900 + avgLoad * 1400 + n('p50') * 200,
    p95Ms: 3200 + avgLoad * 5200 + n('p95') * 900,
    ttftMs: 160 + avgLoad * 420 + n('ttft') * 60,
    errorRate: erroring ? 0.06 + 0.04 * n('err') : 0.001 + 0.003 * n('err'),
  }
}

export function gatewaySeries(world: MetricWorld, deps: DeploymentSpec[], range: TimeRange, now: number): GatewayPoint[] {
  return seriesTimes(range, now).map((t) => gatewayPoint(world, deps, t))
}

export function usageReport(world: MetricWorld, deps: DeploymentSpec[], keys: KeySpec[], range: TimeRange, now: number): UsageReport {
  const active = keys.filter((k) => k.revokedAgoMs === null)
  const stepSec = RANGE_MS[range] / SERIES_POINTS / 1000
  const keyTotals = new Map<string, { tokens: number; requests: number }>()
  let tokens = 0
  let requests = 0
  const points = seriesTimes(range, now).map((t) => {
    const byModel: Record<string, number> = {}
    let pointTokens = 0
    let pointReq = 0
    for (const d of deps) {
      const l = deploymentLoad(world.seed, d, t)
      const tok = l * d.peakTokensPerSec * d.replicas.length * stepSec
      byModel[d.model] = (byModel[d.model] ?? 0) + tok
      pointTokens += tok
      pointReq += l * d.peakRps * stepSec
    }
    const weights = active.map((k) => k.share * (0.75 + 0.5 * noise(world.seed, k.id, Math.floor(t / 600_000))))
    const wSum = weights.reduce((a, b) => a + b, 0)
    const byKey: Record<string, number> = {}
    active.forEach((k, i) => {
      const share = weights[i] / wSum
      byKey[k.id] = pointTokens * share
      const acc = keyTotals.get(k.id) ?? { tokens: 0, requests: 0 }
      acc.tokens += pointTokens * share
      acc.requests += pointReq * share
      keyTotals.set(k.id, acc)
    })
    tokens += pointTokens
    requests += pointReq
    return { t, requests: pointReq, byModel, byKey }
  })
  const tokensIn = tokens * INPUT_TOKEN_SHARE
  const tokensOut = tokens - tokensIn
  return {
    points,
    tokensIn,
    tokensOut,
    requests,
    cloudCostUsd: (tokensIn / 1e6) * CLOUD_PRICE_PER_M.input + (tokensOut / 1e6) * CLOUD_PRICE_PER_M.output,
    topKeys: active
      .map((k) => ({ keyId: k.id, name: k.name, ...(keyTotals.get(k.id) ?? { tokens: 0, requests: 0 }) }))
      .sort((a, b) => b.tokens - a.tokens),
    models: [...new Set(deps.map((d) => d.model))],
    keys: active.map((k) => ({ id: k.id, name: k.name })),
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/api/mock/metrics.test.ts`
Expected: PASS (9 tests). If "thermal-issue node runs hotter" fails, check that `thermal` is added to `gpuTempC`; spark-05 and spark-04 have similar load, so the gap is ~18–24 °C.

- [ ] **Step 5: Commit**

```bash
git add src/api/mock/metrics.ts src/api/mock/metrics.test.ts
git commit -m "feat: deterministic metric, gateway and usage models

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 6: Log query language and deterministic log generator

**Files:**
- Create: `src/lib/log-query.ts`, `src/lib/log-query.test.ts`, `src/api/mock/logs.ts`, `src/api/mock/logs.test.ts`

**Interfaces:**
- Consumes: `LogLine`, `LogLevel`, `LogSource`, `HistogramBucket` from `@/api/types`; `NodeSpec`, `DeploymentSpec`, `ENGINE_PORT` from `./fixtures`; `Outage`, `isOffline` from `./metrics`; `noise`, `hash`, `pick`, `pickWeighted` from `./rng`.
- Produces (`log-query.ts`): `interface LogFilter { key: string; value: string; negate: boolean }`, `interface LogTerm { text: string; negate: boolean }`, `interface ParsedLogQuery { filters: LogFilter[]; terms: LogTerm[] }`, `parseLogQuery(input: string): ParsedLogQuery`, `matchesLogQuery(line: LogLine, q: ParsedLogQuery): boolean`, `type HighlightKind = 'key' | 'value' | 'negate' | 'term' | 'space'`, `highlightLogQuery(input: string): { text: string; kind: HighlightKind }[]`.
- Produces (`logs.ts`): `SLOT_MS = 5000`, `MAX_SCAN_SLOTS = 20000`, `GATEWAY_HOST = 'sparkman-gw'`, `interface LogWindow { from: number; to: number | null; nodeId: string | null; kind: 'thermal' | 'xid' | 'gateway-5xx'; label: string }`, `interface LogWorld { seed: number; nodes: NodeSpec[]; deployments: DeploymentSpec[]; keys: { id: string; name: string; share: number }[]; windows: LogWindow[]; outages: Outage[] }`, `linesForSlot(world, slot): LogLine[]`, `queryLogs(world, { from, to, query, limit }): { lines: LogLine[]; truncated: boolean }`, `logHistogram(world, { from, to, query, buckets }): HistogramBucket[]`.

- [ ] **Step 1: Write the failing query-language test**

`src/lib/log-query.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import type { LogLine } from '@/api/types'
import { highlightLogQuery, matchesLogQuery, parseLogQuery } from './log-query'

const line = (over: Partial<LogLine> = {}): LogLine => ({
  id: '1', ts: 0, level: 'error', source: 'gateway', host: 'sparkman-gw', service: 'gateway',
  message: 'POST /v1/chat/completions 502 812ms upstream=spark-03 connection reset', pattern: 'abc123',
  attributes: { 'http.status_code': '502', model: 'gpt-oss-120b' }, ...over,
})

describe('parseLogQuery', () => {
  it('parses filters, negations, terms and quoted phrases', () => {
    expect(parseLogQuery('level:error host:spark-03 -healthcheck "connection reset" -"foo bar"')).toEqual({
      filters: [
        { key: 'level', value: 'error', negate: false },
        { key: 'host', value: 'spark-03', negate: false },
      ],
      terms: [
        { text: 'healthcheck', negate: true },
        { text: 'connection reset', negate: false },
        { text: 'foo bar', negate: true },
      ],
    })
  })
  it('supports quoted filter values and negated filters', () => {
    expect(parseLogQuery('host:"spark-01" -level:debug').filters).toEqual([
      { key: 'host', value: 'spark-01', negate: false },
      { key: 'level', value: 'debug', negate: true },
    ])
  })
  it('malformed input never throws', () => {
    for (const q of ['', '   ', 'host:', '"unterminated', '-', ':::', '-"', 'a:b:c', '""', '-host:']) {
      expect(() => parseLogQuery(q)).not.toThrow()
    }
    expect(parseLogQuery('host:')).toEqual({ filters: [], terms: [] })
    expect(parseLogQuery('"unterminated phrase')).toEqual({ filters: [], terms: [{ text: 'unterminated phrase', negate: false }] })
    expect(parseLogQuery(':::').terms).toEqual([{ text: ':::', negate: false }])
    expect(parseLogQuery('a:b:c').filters).toEqual([{ key: 'a', value: 'b:c', negate: false }])
  })
})

describe('matchesLogQuery', () => {
  it('ANDs across keys and ORs within the same key', () => {
    expect(matchesLogQuery(line(), parseLogQuery('level:error level:warn'))).toBe(true)
    expect(matchesLogQuery(line(), parseLogQuery('level:warn'))).toBe(false)
    expect(matchesLogQuery(line(), parseLogQuery('level:error host:spark-01'))).toBe(false)
  })
  it('handles negation, attributes, pattern and case-insensitive terms', () => {
    expect(matchesLogQuery(line(), parseLogQuery('-level:error'))).toBe(false)
    expect(matchesLogQuery(line(), parseLogQuery('http.status_code:502'))).toBe(true)
    expect(matchesLogQuery(line(), parseLogQuery('pattern:abc123'))).toBe(true)
    expect(matchesLogQuery(line(), parseLogQuery('CONNECTION -timeout'))).toBe(true)
    expect(matchesLogQuery(line(), parseLogQuery('-reset'))).toBe(false)
    expect(matchesLogQuery(line(), parseLogQuery('nosuchattr:1'))).toBe(false)
  })
})

describe('highlightLogQuery', () => {
  it('round-trips the input text and classifies chunks', () => {
    const input = 'host:spark-03  -healthcheck timeout'
    const tokens = highlightLogQuery(input)
    expect(tokens.map((t) => t.text).join('')).toBe(input)
    expect(tokens.map((t) => t.kind)).toEqual(['key', 'value', 'space', 'negate', 'space', 'term'])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/lib/log-query.test.ts`
Expected: FAIL, `Cannot find module './log-query'`.

- [ ] **Step 3: Write `src/lib/log-query.ts`**

```ts
import type { LogLine } from '@/api/types'

export interface LogFilter {
  key: string
  value: string
  negate: boolean
}
export interface LogTerm {
  text: string
  negate: boolean
}
export interface ParsedLogQuery {
  filters: LogFilter[]
  terms: LogTerm[]
}
export type HighlightKind = 'key' | 'value' | 'negate' | 'term' | 'space'

interface RawToken {
  text: string
  /** text accumulated before the first quote, or null when the token had no quote */
  beforeQuote: string | null
}

function tokenize(input: string): RawToken[] {
  const tokens: RawToken[] = []
  let i = 0
  while (i < input.length) {
    if (/\s/.test(input[i])) {
      i++
      continue
    }
    let text = ''
    let beforeQuote: string | null = null
    while (i < input.length && !/\s/.test(input[i])) {
      if (input[i] === '"') {
        if (beforeQuote === null) beforeQuote = text
        const close = input.indexOf('"', i + 1)
        const end = close === -1 ? input.length : close
        text += input.slice(i + 1, end)
        i = close === -1 ? input.length : close + 1
      } else {
        text += input[i]
        i++
      }
    }
    tokens.push({ text, beforeQuote })
  }
  return tokens
}

export function parseLogQuery(input: string): ParsedLogQuery {
  const filters: LogFilter[] = []
  const terms: LogTerm[] = []
  for (const tok of tokenize(input)) {
    let text = tok.text
    let negate = false
    if (text.startsWith('-')) {
      if (text.length === 1) continue
      negate = true
      text = text.slice(1)
    }
    const keyPart = tok.beforeQuote === null ? text : tok.beforeQuote.replace(/^-/, '')
    const colon = keyPart.indexOf(':')
    const isFilter = tok.beforeQuote === null ? colon > 0 : colon > 0 && colon === keyPart.length - 1
    if (isFilter) {
      const value = text.slice(colon + 1)
      if (value) filters.push({ key: text.slice(0, colon).toLowerCase(), value, negate })
      continue
    }
    if (text) terms.push({ text, negate })
  }
  return { filters, terms }
}

function fieldValue(line: LogLine, key: string): string | undefined {
  switch (key) {
    case 'level':
      return line.level
    case 'host':
      return line.host
    case 'source':
      return line.source
    case 'service':
      return line.service
    case 'pattern':
      return line.pattern
    default:
      return line.attributes[key]
  }
}

export function matchesLogQuery(line: LogLine, q: ParsedLogQuery): boolean {
  const positive = new Map<string, string[]>()
  for (const f of q.filters) {
    const target = f.value.toLowerCase()
    if (f.negate) {
      if (fieldValue(line, f.key)?.toLowerCase() === target) return false
      continue
    }
    positive.set(f.key, [...(positive.get(f.key) ?? []), target])
  }
  for (const [key, values] of positive) {
    const v = fieldValue(line, key)?.toLowerCase()
    if (v === undefined || !values.includes(v)) return false
  }
  const msg = line.message.toLowerCase()
  for (const t of q.terms) {
    const hit = msg.includes(t.text.toLowerCase())
    if (t.negate ? hit : !hit) return false
  }
  return true
}

export function highlightLogQuery(input: string): { text: string; kind: HighlightKind }[] {
  return input
    .split(/(\s+)/)
    .filter(Boolean)
    .flatMap((chunk): { text: string; kind: HighlightKind }[] => {
      if (/^\s+$/.test(chunk)) return [{ text: chunk, kind: 'space' }]
      if (chunk.startsWith('-') && chunk.length > 1) return [{ text: chunk, kind: 'negate' }]
      const m = /^([\w.]+:)(.*)$/.exec(chunk)
      if (m) return m[2] ? [{ text: m[1], kind: 'key' }, { text: m[2], kind: 'value' }] : [{ text: m[1], kind: 'key' }]
      return [{ text: chunk, kind: 'term' }]
    })
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/lib/log-query.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing generator test**

`src/api/mock/logs.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { parseLogQuery } from '@/lib/log-query'
import { DEPLOYMENT_SPECS, KEY_SPECS, NODE_SPECS } from './fixtures'
import { SLOT_MS, linesForSlot, logHistogram, queryLogs, type LogWorld } from './logs'

const NOW = new Date(2026, 9, 8, 15, 0, 0).getTime()
const base: LogWorld = {
  seed: 1729,
  nodes: NODE_SPECS,
  deployments: DEPLOYMENT_SPECS,
  keys: KEY_SPECS.filter((k) => k.revokedAgoMs === null).map(({ id, name, share }) => ({ id, name, share })),
  windows: [],
  outages: [],
}
const slotOf = (t: number) => Math.floor(t / SLOT_MS)

describe('log generator', () => {
  it('is deterministic, sorted newest-first, ids unique, timestamps inside the slot', () => {
    const s = slotOf(NOW)
    const a = linesForSlot(base, s)
    expect(a).toEqual(linesForSlot(base, s))
    expect(a.length).toBeGreaterThan(0)
    for (let i = 1; i < a.length; i++) expect(a[i - 1].ts).toBeGreaterThanOrEqual(a[i].ts)
    expect(new Set(a.map((l) => l.id)).size).toBe(a.length)
    for (const l of a) {
      expect(l.ts).toBeGreaterThanOrEqual(s * SLOT_MS)
      expect(l.ts).toBeLessThan((s + 1) * SLOT_MS)
      expect(l.pattern).toMatch(/^[0-9a-f]{16}$/)
    }
  })

  it('xid windows emit NVRM Xid kernel errors for the window node', () => {
    const w: LogWorld = { ...base, windows: [{ from: NOW - 60_000, to: NOW + 60_000, nodeId: 'spark-05', kind: 'xid', label: 'Xid 31 on spark-05' }] }
    const lines = Array.from({ length: 6 }, (_, i) => linesForSlot(w, slotOf(NOW) - i)).flat()
    const xid = lines.filter((l) => l.message.includes('NVRM: Xid'))
    expect(xid.length).toBeGreaterThan(0)
    expect(xid.every((l) => l.host === 'spark-05' && l.level === 'error' && l.source === 'kernel')).toBe(true)
  })

  it('skips lines from hosts that are offline', () => {
    const w: LogWorld = { ...base, outages: [{ nodeId: 'spark-03', from: NOW - 3_600_000, to: null }] }
    const { lines } = queryLogs(w, { from: NOW - 3_600_000, to: NOW, query: parseLogQuery(''), limit: 2000 })
    expect(lines.some((l) => l.host === 'spark-03')).toBe(false)
  })

  it('queryLogs respects range, limit, filters and order', () => {
    const q = parseLogQuery('level:info source:gateway')
    const { lines } = queryLogs(base, { from: NOW - 3_600_000, to: NOW, query: q, limit: 50 })
    expect(lines).toHaveLength(50)
    expect(lines.every((l) => l.level === 'info' && l.source === 'gateway')).toBe(true)
    expect(lines.every((l) => l.ts <= NOW && l.ts >= NOW - 3_600_000)).toBe(true)
    for (let i = 1; i < lines.length; i++) expect(lines[i - 1].ts).toBeGreaterThanOrEqual(lines[i].ts)
  })

  it('queryLogs stops scanning and flags truncation for impossible queries', () => {
    const r = queryLogs(base, { from: NOW - 7 * 86_400_000, to: NOW, query: parseLogQuery('zzzz-never'), limit: 10 })
    expect(r.lines).toHaveLength(0)
    expect(r.truncated).toBe(true)
  })

  it('histogram over 15m equals an exhaustive count', () => {
    const from = NOW - 15 * 60_000
    const q = parseLogQuery('')
    const hist = logHistogram(base, { from, to: NOW, query: q, buckets: 60 })
    expect(hist).toHaveLength(60)
    const total = hist.reduce((s, b) => s + b.error + b.warn + b.info + b.debug, 0)
    const exhaustive = queryLogs(base, { from, to: NOW, query: q, limit: 100_000 }).lines.length
    expect(total).toBe(exhaustive)
  })
})
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm vitest run src/api/mock/logs.test.ts`
Expected: FAIL, `Cannot find module './logs'`.

- [ ] **Step 7: Write `src/api/mock/logs.ts`**

```ts
import { matchesLogQuery, type ParsedLogQuery } from '@/lib/log-query'
import type { HistogramBucket, LogLevel, LogLine, LogSource } from '../types'
import { ENGINE_PORT, type DeploymentSpec, type NodeSpec } from './fixtures'
import { isOffline, type Outage } from './metrics'
import { hash, noise, pick, pickWeighted } from './rng'

export const SLOT_MS = 5000
export const MAX_SCAN_SLOTS = 20_000
export const GATEWAY_HOST = 'sparkman-gw'

export interface LogWindow {
  from: number
  to: number | null
  nodeId: string | null
  kind: 'thermal' | 'xid' | 'gateway-5xx'
  label: string
}

export interface LogWorld {
  seed: number
  nodes: NodeSpec[]
  deployments: DeploymentSpec[]
  keys: { id: string; name: string; share: number }[]
  windows: LogWindow[]
  outages: Outage[]
}

type Rand = (k: string) => number

interface Draft {
  level: LogLevel
  source: LogSource
  host: string
  service: string
  message: string
  patternKey: string
  attributes?: Record<string, string>
}

const patternId = (key: string) =>
  hash('pattern', key).toString(16).padStart(8, '0') + hash('pattern-2', key).toString(16).padStart(8, '0')

const int = (r: number, min: number, max: number) => Math.floor(min + r * (max - min + 1))

function pickDeployment(world: LogWorld, r: number): { dep: DeploymentSpec; node: string } | null {
  if (world.deployments.length === 0) return null
  const dep = pickWeighted(world.deployments.map((d) => ({ value: d, weight: d.trafficWeight })), r)
  const nodes = dep.replicas.flatMap((rep) => rep.nodeIds)
  return { dep, node: pick(nodes, (r * 7919) % 1) }
}

function gatewayLine(world: LogWorld, rand: Rand): Draft | null {
  const target = pickDeployment(world, rand('dep'))
  if (!target) return null
  const { dep, node } = target
  const key = world.keys.length ? pickWeighted(world.keys.map((k) => ({ value: k, weight: Math.max(k.share, 0.001) })), rand('key')) : null
  const route = key?.id === 'key-claude' ? '/v1/messages' : '/v1/chat/completions'
  const ms = int(rand('ms'), 180, 9000)
  const roll = rand('lvl')
  const common = { source: 'gateway' as const, host: GATEWAY_HOST, service: 'gateway' }
  if (roll < 0.04) {
    return { ...common, level: 'debug', message: `route model=${dep.model} -> ${node}:${ENGINE_PORT[dep.engine]} (least-loaded)`, patternKey: 'gw-route', attributes: { model: dep.model, upstream: node } }
  }
  if (roll < 0.07) {
    return { ...common, level: 'warn', message: `Upstream ${node} slow: ttft ${int(rand('ttft'), 1500, 4000)}ms (model=${dep.model})`, patternKey: 'gw-slow', attributes: { model: dep.model, upstream: node } }
  }
  if (roll < 0.075) {
    return { ...common, level: 'error', message: `POST ${route} 502 ${ms}ms upstream=${node} connection reset`, patternKey: 'gw-502', attributes: { model: dep.model, upstream: node, 'http.status_code': '502' } }
  }
  const tokensIn = int(rand('tin'), 800, 60_000)
  const tokensOut = int(rand('tout'), 40, 2400)
  return {
    ...common,
    level: 'info',
    message: `POST ${route} 200 ${ms}ms`,
    patternKey: `gw-ok-${route}`,
    attributes: {
      model: dep.model,
      api_key: key?.name ?? 'unknown',
      tokens_in: String(tokensIn),
      tokens_out: String(tokensOut),
      duration_ms: String(ms),
      'http.method': 'POST',
      'http.route': route,
      'http.status_code': '200',
      request_id: `req_${hash('req', rand('id')).toString(36)}`,
      upstream: node,
    },
  }
}

function engineLine(world: LogWorld, rand: Rand): Draft | null {
  const target = pickDeployment(world, rand('dep'))
  if (!target) return null
  const { dep, node } = target
  const service = dep.engine.toLowerCase()
  const common = { source: 'engine' as const, host: node, service, attributes: { model: dep.model, engine: dep.engine } }
  const roll = rand('lvl')
  if (roll < 0.05) return { ...common, level: 'debug', message: `Scheduler step ${int(rand('n'), 1000, 99999)} finished in ${int(rand('ms'), 8, 60)}ms`, patternKey: 'engine-step' }
  if (roll < 0.09) return { ...common, level: 'warn', message: `KV cache usage ${(90 + rand('kv') * 9).toFixed(1)}%; preempting ${int(rand('k'), 1, 4)} requests (recompute)`, patternKey: 'engine-preempt' }
  const running = int(rand('run'), 1, 24)
  const gen = (rand('gen') * 2200 + 100).toFixed(1)
  switch (dep.engine) {
    case 'Ollama':
      return { ...common, level: 'info', message: `[GIN] | 200 | ${(rand('s') * 9 + 0.4).toFixed(2)}s | 10.42.0.2 | POST "/v1/chat/completions"`, patternKey: 'ollama-gin' }
    case 'SGLang':
      return { ...common, level: 'info', message: `Decode batch. #running-req: ${running}, #token: ${int(rand('tok'), 2000, 90000)}, token usage: ${rand('u').toFixed(2)}, gen throughput (token/s): ${gen}, #queue-req: 0`, patternKey: 'sglang-decode' }
    default:
      return { ...common, level: 'info', message: `Engine 000: Avg prompt throughput: ${(rand('p') * 9000).toFixed(1)} tokens/s, Avg generation throughput: ${gen} tokens/s, Running: ${running} reqs, Waiting: 0 reqs, GPU KV cache usage: ${(rand('kv') * 80 + 5).toFixed(1)}%`, patternKey: 'vllm-stats' }
  }
}

function journalLine(world: LogWorld, rand: Rand): Draft {
  const host = pick(world.nodes, rand('host')).id
  const roll = rand('lvl')
  const common = { source: 'journald' as const, host }
  if (roll < 0.03) return { ...common, level: 'warn', service: 'systemd-resolved', message: 'Using degraded feature set UDP instead of UDP+EDNS0 for DNS server 10.42.0.1.', patternKey: 'jd-dns' }
  if (roll < 0.08) return { ...common, level: 'debug', service: 'cron', message: '(root) CMD (/opt/sparkman/agent --collect)', patternKey: 'jd-cron' }
  if (roll < 0.5) return { ...common, level: 'info', service: 'dockerd', message: `Container ${pick(['vllm-server', 'ollama', 'nim-llm', 'sglang', 'node-exporter'], rand('c'))} health_status: healthy`, patternKey: 'jd-docker' }
  return { ...common, level: 'info', service: 'systemd-logind', message: `New session ${int(rand('n'), 10, 900)} of user sparkman.`, patternKey: 'jd-session' }
}

function kernelLine(world: LogWorld, rand: Rand): Draft {
  const node = pick(world.nodes, rand('host'))
  const grouped = world.deployments.some((d) => d.replicas.some((r) => r.nodeIds.length > 1 && r.nodeIds.includes(node.id)))
  const common = { source: 'kernel' as const, host: node.id, service: 'kernel' }
  if (rand('lvl') < 0.5) {
    return grouped
      ? { ...common, level: 'info', message: 'mlx5_core 0000:01:00.0 enp1s0f0np0: Link up, 200000Mb/s', patternKey: 'k-cx7-link' }
      : { ...common, level: 'info', message: 'r8127 0000:02:00.0 enP7s7: Link is Up - 10Gbps/Full - flow control rx/tx', patternKey: 'k-eth-link' }
  }
  return { ...common, level: 'info', message: 'audit: type=1400 apparmor="STATUS" operation="profile_load" profile="docker-default"', patternKey: 'k-audit' }
}

function incidentLine(w: LogWindow, rand: Rand): Draft {
  const node = w.nodeId ?? 'spark-03'
  switch (w.kind) {
    case 'thermal':
      return rand('v') < 0.6
        ? { level: 'warn', source: 'journald', host: node, service: 'thermald', message: `zone acpitz ${int(rand('t'), 86, 93)}°C above passive trip point (85°C); throttling GPU clocks`, patternKey: 'th-trip' }
        : { level: 'warn', source: 'engine', host: node, service: 'nim', message: `Generation throughput degraded: ${int(rand('g'), 900, 1300)} tokens/s (-18%)`, patternKey: 'th-throughput' }
    case 'xid':
      return rand('v') < 0.7
        ? { level: 'error', source: 'kernel', host: node, service: 'kernel', message: `NVRM: Xid (PCI:000f:01:00): 31, pid=${int(rand('pid'), 40000, 60000)}, name=python3, Ch 0000000a, intr 10000000. MMU Fault: ENGINE GRAPHICS GPC1 GPCCLIENT_T1_3 faulted @ 0x7f3a_1c000000. Fault is of type FAULT_PDE ACCESS_TYPE_VIRT_READ`, patternKey: 'xid-31' }
        : { level: 'error', source: 'engine', host: node, service: 'engine', message: 'CUDA error: an illegal memory access was encountered', patternKey: 'cuda-illegal' }
    case 'gateway-5xx': {
      const v = rand('v')
      const common = { source: 'gateway' as const, host: GATEWAY_HOST, service: 'gateway', attributes: { upstream: node } }
      if (v < 0.5) return { ...common, level: 'error', message: `POST /v1/chat/completions 502 ${int(rand('ms'), 300, 2000)}ms upstream=${node} connection reset by peer`, patternKey: 'gw-502-reset', attributes: { ...common.attributes, 'http.status_code': '502' } }
      if (v < 0.8) return { ...common, level: 'error', message: `Timeout after 60000ms waiting for upstream ${node}`, patternKey: 'gw-timeout', attributes: { ...common.attributes, 'http.status_code': '504' } }
      return { ...common, level: 'warn', message: 'Retrying request on next replica (attempt 2/3)', patternKey: 'gw-retry' }
    }
  }
}

export function linesForSlot(world: LogWorld, slot: number): LogLine[] {
  const t0 = slot * SLOT_MS
  const r = (...k: (string | number)[]) => noise(world.seed, 'log', slot, ...k)
  const active = world.windows.filter((w) => t0 >= w.from && (w.to === null || t0 < w.to))
  const baseCount = 1 + Math.floor(r('count') * 3)
  const extra = active.reduce((s, w) => s + (w.kind === 'gateway-5xx' ? 3 : w.kind === 'xid' ? 2 : r('th', w.kind) < 0.15 ? 1 : 0), 0)
  const out: LogLine[] = []
  for (let i = 0; i < baseCount + extra; i++) {
    const rand: Rand = (k) => r(i, k)
    const ts = t0 + Math.floor(rand('ts') * SLOT_MS)
    let draft: Draft | null
    if (i >= baseCount) {
      draft = incidentLine(active[(i - baseCount) % active.length], rand)
    } else {
      const source = pickWeighted<LogSource>([
        { value: 'gateway', weight: 45 }, { value: 'engine', weight: 30 }, { value: 'journald', weight: 18 }, { value: 'kernel', weight: 7 },
      ], rand('src'))
      draft = source === 'gateway' ? gatewayLine(world, rand) : source === 'engine' ? engineLine(world, rand) : source === 'journald' ? journalLine(world, rand) : kernelLine(world, rand)
    }
    if (!draft || isOffline(world.outages, draft.host, ts)) continue
    out.push({
      id: `${slot}-${i}`,
      ts,
      level: draft.level,
      source: draft.source,
      host: draft.host,
      service: draft.service,
      message: draft.message,
      pattern: patternId(draft.patternKey),
      attributes: draft.attributes ?? {},
    })
  }
  return out.sort((a, b) => b.ts - a.ts)
}

export function queryLogs(
  world: LogWorld,
  opts: { from: number; to: number; query: ParsedLogQuery; limit: number },
): { lines: LogLine[]; truncated: boolean } {
  const out: LogLine[] = []
  let scanned = 0
  for (let s = Math.floor(opts.to / SLOT_MS); s >= Math.floor(opts.from / SLOT_MS) && out.length < opts.limit; s--) {
    if (++scanned > MAX_SCAN_SLOTS) return { lines: out, truncated: true }
    for (const line of linesForSlot(world, s)) {
      if (line.ts < opts.from || line.ts > opts.to || !matchesLogQuery(line, opts.query)) continue
      out.push(line)
      if (out.length >= opts.limit) break
    }
  }
  return { lines: out, truncated: false }
}

export function logHistogram(
  world: LogWorld,
  opts: { from: number; to: number; query: ParsedLogQuery; buckets: number },
): HistogramBucket[] {
  const width = (opts.to - opts.from) / opts.buckets
  return Array.from({ length: opts.buckets }, (_, b) => {
    const bFrom = opts.from + b * width
    const bTo = b === opts.buckets - 1 ? opts.to + 1 : bFrom + width
    const s0 = Math.floor(bFrom / SLOT_MS)
    const s1 = Math.floor((bTo - 1) / SLOT_MS)
    const slotCount = s1 - s0 + 1
    const samples = Math.min(slotCount, 40)
    const counts: Record<LogLevel, number> = { error: 0, warn: 0, info: 0, debug: 0 }
    for (let k = 0; k < samples; k++) {
      const s = s0 + Math.floor((k * slotCount) / samples)
      for (const line of linesForSlot(world, s)) {
        if (line.ts >= bFrom && line.ts < bTo && matchesLogQuery(line, opts.query)) counts[line.level]++
      }
    }
    const scale = slotCount / samples
    return {
      t: bFrom,
      error: Math.round(counts.error * scale),
      warn: Math.round(counts.warn * scale),
      info: Math.round(counts.info * scale),
      debug: Math.round(counts.debug * scale),
    }
  })
}
```

Note: the last bucket's upper bound is `to + 1` so a line stamped exactly at `to` is counted, matching `queryLogs` (which includes `ts <= to`).

- [ ] **Step 8: Run to verify it passes**

Run: `pnpm vitest run src/lib/log-query.test.ts src/api/mock/logs.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 9: Commit**

```bash
git add src/lib/log-query.ts src/lib/log-query.test.ts src/api/mock/logs.ts src/api/mock/logs.test.ts
git commit -m "feat: log query language and deterministic log generator

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Simulator (state, tick, actions, derived reads)

**Files:**
- Create: `src/api/mock/simulator.ts`, `src/api/mock/simulator.test.ts`

**Interfaces:**
- Consumes: everything from `./fixtures`, `./metrics`, `./logs`, `./rng`; `parseLogQuery` from `@/lib/log-query`; all types from `../types`.
- Produces:
  - `type SimErrorCode = 'not_found' | 'conflict' | 'invalid' | 'unavailable'`, `class SimError extends Error { code: SimErrorCode }`
  - Timing constants `REBOOT_MS = 20_000`, `DEPLOY_PENDING_MS = 3_000`, `DEPLOY_LOADING_MS = 15_000`, `ROLLOUT_STEP_MS = 4_000`
  - `class Simulator` with `constructor(opts?: { seed?: number; now?: () => number })` and:
    - lifecycle: `now(): number`, `tick(): void`, `start(intervalMs?: number): void`, `stop(): void`, `subscribe(fn: (e: SimEvent) => void): () => void`
    - reads: `getNodes(): FleetNode[]`, `getNode(id): FleetNode | null`, `getMetrics(id, range): MetricPoint[]`, `getProcesses(id): GpuProcess[]`, `getInventory(id): NodeInventory`, `getHealth(id): NodeHealth`, `getFleetSummary(): FleetSummary`, `getDeployments(): Deployment[]`, `getGatewayInfo(): GatewayInfo`, `getGatewaySeries(range): GatewayPoint[]`, `getRoutes(): GatewayRoute[]`, `getUsage(range): UsageReport`, `getKeys(): ApiKey[]`, `queryLogs(input: LogQueryInput): LogQueryResult`, `getIncidents(): Incident[]`, `getRules(): AlertRule[]`, `getUpdates(): NodeUpdateStatus[]`, `getRollouts(): Rollout[]`, `getActivity(limit?: number): ActivityEvent[]`, `getFailures(): FailureInjection`
    - actions: `rebootNode(id): void`, `setDrained(id, drained: boolean): void`, `runDiagnostics(id): SparkToolEnvelope`, `createDeployment(input: CreateDeploymentInput): Deployment`, `stopDeployment(id): void`, `createKey(input: { name: string; rateLimitRpm: number }): { key: ApiKey; secret: string }`, `revokeKey(id): void`, `setRuleEnabled(id, enabled: boolean): void`, `resolveIncident(id): void`, `startRollout(input: StartRolloutInput): Rollout`, `approveRollout(id): void`, `setFailures(patch: Partial<FailureInjection>): void`
  - All reads return fresh copies; mutating them never changes simulator state.

- [ ] **Step 1: Write the failing test**

`src/api/mock/simulator.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import type { SimEvent } from '../types'
import { DEPLOY_LOADING_MS, DEPLOY_PENDING_MS, REBOOT_MS, SimError, Simulator } from './simulator'

const START = new Date(2026, 9, 8, 15, 0, 0).getTime()

function setup() {
  let t = START
  const sim = new Simulator({ seed: 1729, now: () => t })
  const advance = (ms: number) => {
    const end = t + ms
    while (t < end) {
      t = Math.min(end, t + 2000)
      sim.tick()
    }
  }
  return { sim, advance }
}

const expectSimError = (fn: () => unknown, code: SimError['code']) => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(SimError)
    expect((e as SimError).code).toBe(code)
    return
  }
  throw new Error(`expected SimError(${code})`)
}

describe('Simulator', () => {
  it('starts with 12 nodes, spark-05 degraded, all reachable', () => {
    const { sim } = setup()
    const nodes = sim.getNodes()
    expect(nodes).toHaveLength(12)
    expect(nodes.find((n) => n.id === 'spark-05')!.status).toBe('degraded')
    expect(nodes.filter((n) => n.status === 'online')).toHaveLength(11)
    expect(nodes.every((n) => n.live !== null)).toBe(true)
    expect(sim.getFleetSummary()).toMatchObject({ online: 12, total: 12, memTotalGB: 1536, activeIncidents: 1 })
    expect(sim.getNode('nope')).toBeNull()
  })

  it('returns copies, not live references', () => {
    const { sim } = setup()
    sim.getKeys()[0].name = 'mutated'
    expect(sim.getKeys()[0].name).not.toBe('mutated')
  })

  it('reboot: rebooting → online, deployment degraded → loading → serving', () => {
    const { sim, advance } = setup()
    sim.rebootNode('spark-03')
    expect(sim.getNode('spark-03')!.status).toBe('rebooting')
    expect(sim.getNode('spark-03')!.live).toBeNull()
    expect(sim.getMetrics('spark-03', '15m').at(-1)!.gpuUtil).toBeNull()
    expect(sim.getDeployments().find((d) => d.id === 'dep-gptoss120')!.status).toBe('degraded')
    expectSimError(() => sim.rebootNode('spark-03'), 'conflict')
    advance(REBOOT_MS)
    expect(sim.getNode('spark-03')!.status).toBe('online')
    expect(sim.getDeployments().find((d) => d.id === 'dep-gptoss120')!.status).toBe('loading')
    advance(DEPLOY_LOADING_MS)
    expect(sim.getDeployments().find((d) => d.id === 'dep-gptoss120')!.status).toBe('serving')
    expectSimError(() => sim.rebootNode('nope'), 'not_found')
  })

  it('offline node yields null metrics and null live stats', () => {
    const { sim, advance } = setup()
    sim.setFailures({ nodeOffline: 'spark-03' })
    advance(4000)
    const node = sim.getNode('spark-03')!
    expect(node.status).toBe('offline')
    expect(node.live).toBeNull()
    expect(sim.getMetrics('spark-03', '15m').at(-1)!.gpuUtil).toBeNull()
    expect(sim.getIncidents().some((i) => i.status === 'ongoing' && i.title.includes('spark-03'))).toBe(true)
    expect(sim.getFleetSummary().online).toBe(11)
    sim.setFailures({ nodeOffline: null })
    advance(2000)
    expect(sim.getNode('spark-03')!.status).toBe('online')
    expect(sim.getIncidents().filter((i) => i.title.includes('spark-03')).every((i) => i.status === 'resolved')).toBe(true)
  })

  it('deployments: conflicts, validation and lifecycle', () => {
    const { sim, advance } = setup()
    expectSimError(() => sim.createDeployment({ catalogId: 'gpt-oss-20b', engine: 'vLLM', nodeIds: ['spark-08'] }), 'conflict')
    sim.stopDeployment('dep-mistral24')
    expect(sim.getDeployments().some((d) => d.id === 'dep-mistral24')).toBe(false)
    expect(sim.getNode('spark-08')!.deploymentId).toBeNull()
    expectSimError(() => sim.createDeployment({ catalogId: 'deepseek-v3.1', engine: 'SGLang', nodeIds: ['spark-08'] }), 'invalid')
    expectSimError(() => sim.createDeployment({ catalogId: 'gpt-oss-20b', engine: 'NIM', nodeIds: ['spark-08'] }), 'invalid')
    expectSimError(() => sim.createDeployment({ catalogId: 'gpt-oss-20b', engine: 'vLLM', nodeIds: [] }), 'invalid')
    const dep = sim.createDeployment({ catalogId: 'gpt-oss-20b', engine: 'vLLM', nodeIds: ['spark-08'] })
    expect(dep.status).toBe('pending')
    expect(sim.getNode('spark-08')!.deploymentId).toBe(dep.id)
    advance(DEPLOY_PENDING_MS)
    expect(sim.getDeployments().find((d) => d.id === dep.id)!.status).toBe('loading')
    advance(DEPLOY_LOADING_MS)
    expect(sim.getDeployments().find((d) => d.id === dep.id)!.status).toBe('serving')
    expect(sim.getGatewayInfo().models).toContain('gpt-oss-20b')
  })

  it('multi-node deployments require vLLM or SGLang', () => {
    const { sim } = setup()
    sim.stopDeployment('dep-qwen235')
    expectSimError(() => sim.createDeployment({ catalogId: 'gpt-oss-120b', engine: 'Ollama', nodeIds: ['spark-01', 'spark-02'] }), 'invalid')
    const dep = sim.createDeployment({ catalogId: 'qwen3-235b-a22b', engine: 'vLLM', nodeIds: ['spark-01', 'spark-02'] })
    expect(sim.getNode('spark-01')!.groupId).toBe(dep.replicas[0].id)
  })

  it('keys: create reveals secret once, revoke is one-way', () => {
    const { sim } = setup()
    const { key, secret } = sim.createKey({ name: 'playwright', rateLimitRpm: 60 })
    expect(secret).toMatch(/^sk-spark-[A-Za-z0-9]{32}$/)
    expect(key.prefix).toBe(secret.slice(0, 13))
    expect(JSON.stringify(sim.getKeys())).not.toContain(secret)
    expectSimError(() => sim.createKey({ name: '  ', rateLimitRpm: 60 }), 'invalid')
    expectSimError(() => sim.createKey({ name: 'playwright', rateLimitRpm: 60 }), 'conflict')
    sim.revokeKey(key.id)
    expect(sim.getKeys().find((k) => k.id === key.id)!.revokedAt).not.toBeNull()
    expectSimError(() => sim.revokeKey(key.id), 'conflict')
  })

  it('rejects a second active rollout; a canary rollout completes and updates the node', () => {
    const { sim, advance } = setup()
    const r = sim.startRollout({ targetOs: '7.5.0', rings: ['canary'], window: 'Now', requireApproval: true })
    expect(r.status).toBe('awaiting-approval')
    expectSimError(() => sim.startRollout({ targetOs: '7.5.0', rings: ['ring1'], window: 'Now', requireApproval: false }), 'conflict')
    sim.approveRollout(r.id)
    expectSimError(() => sim.approveRollout(r.id), 'conflict')
    advance(2000)
    expect(sim.getRollouts().find((x) => x.id === r.id)!.nodes[0].step).toBe('precheck')
    advance(18_000)
    const done = sim.getRollouts().find((x) => x.id === r.id)!
    expect(done.status).toBe('completed')
    expect(sim.getNode('spark-08')!.os.dgxOs).toBe('7.5.0')
    const upd = sim.getUpdates().find((u) => u.nodeId === 'spark-08')!
    expect(upd.aptPending).toEqual([])
    expect(upd.rebootRequired).toBe(false)
    expect(sim.getRollouts().length).toBe(3)
  })

  it('emits tick and changed events', () => {
    const { sim, advance } = setup()
    const events: SimEvent[] = []
    const off = sim.subscribe((e) => events.push(e))
    sim.setRuleEnabled('rule-update', true)
    advance(2000)
    off()
    advance(2000)
    expect(events).toContainEqual({ type: 'changed', topic: 'rules' })
    expect(events.filter((e) => e.type === 'tick')).toHaveLength(1)
    expect(sim.getRules().find((r) => r.id === 'rule-update')!.enabled).toBe(true)
  })

  it('resolving the thermal incident clears the degraded state', () => {
    const { sim } = setup()
    sim.resolveIncident('inc-thermal-05')
    expect(sim.getNode('spark-05')!.status).toBe('online')
    expect(sim.getFleetSummary().activeIncidents).toBe(0)
    expectSimError(() => sim.resolveIncident('inc-thermal-05'), 'conflict')
  })

  it('queryLogs returns bounded newest-first lines, histogram and bands', () => {
    const { sim } = setup()
    const r = sim.queryLogs({ query: '', range: '24h', limit: 100 })
    expect(r.lines).toHaveLength(100)
    expect(r.histogram).toHaveLength(60)
    expect(r.total).toBeGreaterThan(100)
    expect(r.bands.some((b) => b.label.includes('thermal'))).toBe(true)
    const around = sim.queryLogs({ query: '', range: '1h', around: START - 30_000 })
    expect(around.to).toBe(START)
    expect(around.from).toBe(START - 90_000)
  })

  it('failure injection: gateway errors and xid storm', () => {
    const { sim, advance } = setup()
    sim.setFailures({ gatewayErrors: true, xidStorm: true })
    advance(30_000)
    expect(sim.getGatewaySeries('15m').at(-1)!.errorRate).toBeGreaterThan(0.04)
    const xid = sim.queryLogs({ query: 'host:gx10-03 level:error', range: '15m' })
    expect(xid.lines.some((l) => l.message.includes('NVRM: Xid'))).toBe(true)
    expect(sim.getFailures()).toEqual({ nodeOffline: null, gatewayErrors: true, xidStorm: true, apiErrors: false })
    sim.setFailures({ gatewayErrors: false, xidStorm: false })
    expect(sim.getIncidents().filter((i) => i.status === 'ongoing')).toHaveLength(1)
  })

  it('health, inventory and processes use the Spark envelope', () => {
    const { sim } = setup()
    const h = sim.getHealth('spark-05')
    expect(h.envelope.tool).toBe('spark_diagctl.py')
    expect(h.envelope.status).toBe('warn')
    expect(h.checks.find((c) => c.name === 'GPU temperature')!.status).not.toBe('pass')
    expect(sim.getInventory('spark-01').envelope.tool).toBe('firmware_reporter.py')
    expect(sim.getProcesses('spark-01')[0].engine).toBe('vLLM')
    expect(sim.runDiagnostics('spark-02').tool).toBe('spark_diagctl.py')
    expect(sim.getUpdates()[0].envelope.tool).toBe('spark_updatectl.py')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/api/mock/simulator.test.ts`
Expected: FAIL, `Cannot find module './simulator'`.

- [ ] **Step 3: Write `src/api/mock/simulator.ts`**

```ts
import { parseLogQuery } from '@/lib/log-query'
import type {
  ActivityEvent, ActivityKind, AlertRule, ApiKey, CreateDeploymentInput, Deployment, DeploymentStatus, FailureInjection,
  FirmwareUpdate, FleetNode, FleetSummary, GatewayInfo, GatewayPoint, GatewayRoute, GpuProcess, HealthCheck, Incident,
  LogQueryInput, LogQueryResult, MetricPoint, NodeHealth, NodeInventory, NodeStatus, NodeUpdateStatus, OsInfo, Rollout,
  RolloutStep, SimEvent, SparkToolEnvelope, StartRolloutInput, TimeRange, Topic, UsageReport,
} from '../types'
import {
  ACTIVITY_SPECS, ALERT_RULES, APT_PENDING, BASE_OS, DEPLOYMENT_SPECS, ENGINE_PORT, FIRMWARE_PENDING, FLEET_CONFIG,
  GATEWAY_BASE_URL, INCIDENT_SPECS, KEY_SPECS, MODEL_CATALOG, NODE_SPECS, PACKAGES, RINGS, ROLLOUT_HISTORY, SIM_SEED,
  TARGET_OS, type DeploymentSpec, type NodeSpec,
} from './fixtures'
import { logHistogram, queryLogs, type LogWindow, type LogWorld } from './logs'
import {
  RANGE_MS, deploymentLoad, gatewayPoint, gatewaySeries, isOffline, nodeSeries, sampleNode, usageReport,
  type MetricWorld, type Outage,
} from './metrics'
import { hash, mulberry32, noise } from './rng'

export const REBOOT_MS = 20_000
export const DEPLOY_PENDING_MS = 3_000
export const DEPLOY_LOADING_MS = 15_000
export const ROLLOUT_STEP_MS = 4_000

export type SimErrorCode = 'not_found' | 'conflict' | 'invalid' | 'unavailable'

export class SimError extends Error {
  code: SimErrorCode
  constructor(code: SimErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'SimError'
  }
}

interface NodeRuntime {
  drained: boolean
  bootedAt: number
  rebootUntil: number | null
  thermal: boolean
  os: OsInfo
  aptPending: string[]
  firmwarePending: FirmwareUpdate[]
  rebootRequired: boolean
  lastChecked: number
}

interface SimDeployment extends DeploymentSpec {
  status: DeploymentStatus
  statusSince: number
  createdAt: number
}

interface SimKey extends ApiKey {
  share: number
}

interface SimRollout extends Rollout {
  stepStartedAt: number
}

const STEP_ORDER: RolloutStep[] = ['queued', 'precheck', 'apply', 'reboot', 'postcheck', 'done']
const clone = <T>(v: T): T => structuredClone(v)

export class Simulator {
  readonly seed: number
  private clock: () => number
  private listeners = new Set<(e: SimEvent) => void>()
  private timer: ReturnType<typeof setInterval> | null = null
  private counter = 0
  private runtime = new Map<string, NodeRuntime>()
  private deployments: SimDeployment[]
  private keys: SimKey[]
  private rules: AlertRule[]
  private incidents: Incident[]
  private windows: LogWindow[] = []
  private outages: Outage[] = []
  private gatewayErrorWindows: { from: number; to: number | null }[] = []
  private rollouts: SimRollout[]
  private activity: ActivityEvent[]
  private failures: FailureInjection = { nodeOffline: null, gatewayErrors: false, xidStorm: false, apiErrors: false }
  private closers = new Map<string, () => void>()

  constructor(opts: { seed?: number; now?: () => number } = {}) {
    this.seed = opts.seed ?? SIM_SEED
    this.clock = opts.now ?? (() => Date.now())
    const now = this.clock()

    for (const spec of NODE_SPECS) {
      const count = 3 + Math.floor(noise(this.seed, spec.id, 'apt') * 7)
      this.runtime.set(spec.id, {
        drained: false,
        bootedAt: now - spec.bootedAgoMs,
        rebootUntil: null,
        thermal: spec.thermalIssue,
        os: { ...BASE_OS },
        aptPending: spec.id === 'spark-08' ? APT_PENDING.slice(0, 2) : APT_PENDING.slice(0, count),
        firmwarePending: FIRMWARE_PENDING[spec.model].map((f) => ({ ...f })),
        rebootRequired: spec.id === 'spark-08',
        lastChecked: now - Math.floor(noise(this.seed, spec.id, 'chk') * 3_600_000),
      })
    }

    this.deployments = DEPLOYMENT_SPECS.map((d) => ({ ...clone(d), status: 'serving', statusSince: now - d.createdAgoMs, createdAt: now - d.createdAgoMs }))

    this.keys = KEY_SPECS.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      createdAt: now - k.createdAgoMs,
      lastUsedAt: k.revokedAgoMs === null ? now - Math.floor(noise(this.seed, k.id, 'used') * 90_000) : now - k.revokedAgoMs - 86_400_000,
      rateLimitRpm: k.rateLimitRpm,
      revokedAt: k.revokedAgoMs === null ? null : now - k.revokedAgoMs,
      requests24h: 0,
      share: k.share,
    }))

    this.rules = clone(ALERT_RULES)

    this.incidents = INCIDENT_SPECS.map((s) => {
      const startedAt = now - s.startedAgoMs
      const window: LogWindow = { from: startedAt, to: s.durationMs === null ? null : startedAt + s.durationMs, nodeId: s.nodeId, kind: s.logKind, label: s.title }
      this.windows.push(window)
      if (s.logKind === 'gateway-5xx') this.gatewayErrorWindows.push({ from: window.from, to: window.to })
      if (s.durationMs === null) {
        this.closers.set(s.id, () => {
          window.to = this.now()
          if (s.logKind === 'thermal' && s.nodeId) this.rt(s.nodeId).thermal = false
        })
      }
      return {
        id: s.id,
        title: s.title,
        severity: s.severity,
        status: s.durationMs === null ? 'ongoing' : 'resolved',
        nodeId: s.nodeId,
        ruleId: s.ruleId,
        startedAt,
        resolvedAt: s.durationMs === null ? null : startedAt + s.durationMs,
        timeline: s.timeline.map((e) => ({ ts: now - e.agoMs, text: e.text })),
      }
    })

    const allNodes = (Object.keys(RINGS) as (keyof typeof RINGS)[]).flatMap((ring) => RINGS[ring].map((nodeId) => ({ nodeId, ring, step: 'done' as const })))
    this.rollouts = ROLLOUT_HISTORY.map((h) => ({
      id: h.id,
      name: h.name,
      targetOs: h.targetOs,
      rings: ['canary', 'ring1', 'ring2'],
      window: 'Sun 02:00–04:00',
      status: 'completed',
      createdAt: now - h.startedAgoMs - 3_600_000,
      startedAt: now - h.startedAgoMs,
      finishedAt: now - h.startedAgoMs + h.durationMs,
      nodes: allNodes.map((n) => ({ ...n })),
      stepStartedAt: now - h.startedAgoMs,
    }))

    this.activity = ACTIVITY_SPECS.map((a) => ({ id: this.nextId('act'), ts: now - a.agoMs, kind: a.kind, text: a.text, nodeId: a.nodeId }))
  }

  // ---------- lifecycle ----------

  now(): number {
    return this.clock()
  }

  start(intervalMs = 2000): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  subscribe(fn: (e: SimEvent) => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  tick(): void {
    const now = this.now()
    for (const [id, rt] of this.runtime) {
      if (rt.rebootUntil !== null && now >= rt.rebootUntil) {
        rt.rebootUntil = null
        rt.bootedAt = now
        for (const d of this.deploymentsOn(id)) this.setDeploymentStatus(d, 'loading', now)
        this.log('reboot', `${id} is back online`, id)
        this.changed('nodes', 'deployments')
      }
    }
    for (const d of this.deployments) {
      if (d.status === 'pending' && now - d.statusSince >= DEPLOY_PENDING_MS) {
        this.setDeploymentStatus(d, 'loading', now)
        this.changed('deployments')
      } else if (d.status === 'loading' && now - d.statusSince >= DEPLOY_LOADING_MS) {
        this.setDeploymentStatus(d, 'serving', now)
        this.log('deploy', `${d.model} is serving on ${d.replicas.flatMap((r) => r.nodeIds).join(', ')}`, null)
        this.changed('deployments')
      }
    }
    this.advanceRollouts(now)
    this.emit({ type: 'tick', now })
  }

  // ---------- reads ----------

  getNodes(): FleetNode[] {
    return NODE_SPECS.map((s) => this.toNode(s))
  }

  getNode(id: string): FleetNode | null {
    const spec = NODE_SPECS.find((s) => s.id === id)
    return spec ? this.toNode(spec) : null
  }

  getMetrics(id: string, range: TimeRange): MetricPoint[] {
    const spec = this.spec(id)
    return nodeSeries(this.metricWorld(), this.effectiveSpec(spec), this.activeDepFor(id), range, this.now())
  }

  getProcesses(id: string): GpuProcess[] {
    const node = this.requireNode(id)
    const dep = this.activeDepFor(id)
    if (!dep || !node.live) return []
    const names: Record<Deployment['engine'], string> = {
      vLLM: 'python3 -m vllm.entrypoints.openai.api_server',
      NIM: '/opt/nim/llm/nim_llm (tensorrt-llm)',
      Ollama: '/usr/bin/ollama runner',
      SGLang: 'python3 -m sglang.launch_server',
    }
    return [{ pid: 40_000 + (hash(this.seed, id, dep.id) % 20_000), user: 'sparkman', name: names[dep.engine], engine: dep.engine, gpuMemMiB: Math.round(dep.memoryGBPerNode * 1024 * 0.97) }]
  }

  getInventory(id: string): NodeInventory {
    const node = this.requireNode(id)
    const updated = node.os.dgxOs === TARGET_OS.dgxOs
    const firmware = [
      { component: 'UEFI', version: node.os.uefi },
      node.model === 'ASUS GX10' ? { component: 'ASUS SOC capsule', version: updated ? '2.4.0' : '2.3.1' } : { component: 'EC', version: updated ? '0.9.21' : '0.9.18' },
      { component: 'ConnectX-7 firmware', version: '28.45.1020' },
      { component: 'NVMe firmware', version: node.model === 'ASUS GX10' ? 'GX10N201' : 'SPK4T110' },
    ]
    const packages = PACKAGES.map((p) => {
      if (!updated) return { ...p }
      if (p.name === 'nvidia-driver-580-open') return { ...p, version: `${TARGET_OS.driver}-0ubuntu1` }
      if (p.name === 'cuda-toolkit-13-0') return { ...p, version: `${TARGET_OS.cuda}-1` }
      if (p.name === 'dgx-release') return { ...p, version: TARGET_OS.dgxOs }
      return { ...p }
    })
    return { firmware, packages, envelope: this.envelope('firmware_reporter.py', id, 'ok', { components: firmware.length, packages: packages.length }, []) }
  }

  getHealth(id: string): NodeHealth {
    const node = this.requireNode(id)
    const rt = this.rt(id)
    const live = node.live
    const grouped = node.groupId !== null
    const checks: HealthCheck[] = [
      { name: 'GPU visible (nvidia-smi)', status: live ? 'pass' : 'fail', detail: live ? `NVIDIA GB10 · driver ${node.os.driver}` : 'Node unreachable over SSH' },
      { name: 'Unified memory', status: live ? 'pass' : 'fail', detail: live ? `${Math.round(live.memUsedGB)} GB of ${node.memoryGB} GB used (MemAvailable)` : 'No data' },
      {
        name: 'GPU temperature',
        status: !live ? 'fail' : live.gpuTempC > 85 ? 'fail' : live.gpuTempC > 78 || rt.thermal ? 'warn' : 'pass',
        detail: live ? `GPU ${Math.round(live.gpuTempC)} °C · ACPI ${Math.round(live.acpiTempC)} °C${rt.thermal ? ' · thermald throttling' : ''}` : 'No data',
      },
      { name: 'NVMe health', status: 'pass', detail: 'SMART OK · 0 media errors' },
      {
        name: 'Disk usage',
        status: !live ? 'fail' : live.diskUsedPct > 90 ? 'fail' : live.diskUsedPct > 80 ? 'warn' : 'pass',
        detail: live ? `${Math.round(live.diskUsedPct)}% of ${node.diskGB} GB` : 'No data',
      },
      { name: 'ConnectX-7 link', status: 'pass', detail: grouped ? 'enp1s0f0np0 up · 200 Gb/s' : 'Not cabled (single-node)' },
      { name: 'Pending reboot', status: rt.rebootRequired ? 'warn' : 'pass', detail: rt.rebootRequired ? 'Kernel update installed; reboot required' : 'None' },
      { name: 'Last reset reason', status: 'pass', detail: id === 'spark-05' ? 'Operator reboot after Xid 31' : 'Clean shutdown' },
    ]
    const status = checks.some((c) => c.status === 'fail') ? 'error' : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok'
    const flagged = checks.filter((c) => c.status !== 'pass')
    return {
      checks,
      envelope: this.envelope('spark_diagctl.py', id, status, { level: 'L1', checks: checks.length, failed: checks.filter((c) => c.status === 'fail').length, warned: checks.filter((c) => c.status === 'warn').length }, flagged.map((c) => `${c.name}: ${c.detail}`)),
    }
  }

  getFleetSummary(): FleetSummary {
    const nodes = this.getNodes()
    const live = nodes.flatMap((n) => (n.live ? [n.live] : []))
    return {
      online: nodes.filter((n) => n.status === 'online' || n.status === 'degraded').length,
      total: nodes.length,
      gpuUtilAvg: live.length ? live.reduce((s, l) => s + l.gpuUtil, 0) / live.length : 0,
      memUsedGB: live.reduce((s, l) => s + l.memUsedGB, 0),
      memTotalGB: nodes.reduce((s, n) => s + n.memoryGB, 0),
      powerW: live.reduce((s, l) => s + l.gpuPowerW, 0),
      tokensPerSec: gatewayPoint(this.metricWorld(), this.servingSpecs(), this.now()).tokensPerSec,
      activeIncidents: this.incidents.filter((i) => i.status === 'ongoing').length,
    }
  }

  getDeployments(): Deployment[] {
    return this.deployments.filter((d) => d.status !== 'stopped').map((d) => this.toDeployment(d))
  }

  getGatewayInfo(): GatewayInfo {
    return { baseUrl: GATEWAY_BASE_URL, defaultModel: 'qwen3-235b-a22b', models: [...new Set(this.getDeployments().filter((d) => d.status === 'serving' || d.status === 'degraded').map((d) => d.model))] }
  }

  getGatewaySeries(range: TimeRange): GatewayPoint[] {
    const now = this.now()
    const world = this.metricWorld()
    const specs = this.servingSpecs()
    const points = gatewaySeries(world, specs, range, now)
    // series points are step-aligned; append an exact "now" sample so live tiles react within one tick
    if (points[points.length - 1].t < now) points.push(gatewayPoint(world, specs, now))
    return points
  }

  getRoutes(): GatewayRoute[] {
    return this.getDeployments().map((d) => ({
      model: d.model,
      deploymentId: d.id,
      engine: d.engine,
      replicas: d.replicas.length,
      nodeIds: d.replicas.flatMap((r) => r.nodeIds),
      healthy: d.status === 'serving',
    }))
  }

  getUsage(range: TimeRange): UsageReport {
    const now = this.now()
    const keySpecs = this.keys.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, rateLimitRpm: k.rateLimitRpm, createdAgoMs: now - k.createdAt, revokedAgoMs: k.revokedAt === null ? null : now - k.revokedAt, share: k.share }))
    return usageReport(this.metricWorld(), this.servingSpecs(), keySpecs, range, now)
  }

  getKeys(): ApiKey[] {
    const day = this.getUsage('24h')
    return this.keys.map(({ share: _share, ...k }) => ({ ...k, requests24h: Math.round(day.topKeys.find((t) => t.keyId === k.id)?.requests ?? 0) }))
  }

  queryLogs(input: LogQueryInput): LogQueryResult {
    const now = this.now()
    const from = input.around !== undefined ? input.around - 60_000 : now - RANGE_MS[input.range]
    const to = input.around !== undefined ? Math.min(input.around + 60_000, now) : now
    const query = parseLogQuery(input.query)
    const world = this.logWorld()
    const { lines, truncated } = queryLogs(world, { from, to, query, limit: input.limit ?? 200 })
    const histogram = logHistogram(world, { from, to, query, buckets: 60 })
    const total = histogram.reduce((s, b) => s + b.error + b.warn + b.info + b.debug, 0)
    const bands = this.windows
      .filter((w) => w.from <= to && (w.to === null || w.to >= from))
      .map((w) => ({ from: Math.max(w.from, from), to: Math.min(w.to ?? now, to), label: w.label }))
    return { lines, histogram, total, truncated, bands, from, to }
  }

  getIncidents(): Incident[] {
    return clone([...this.incidents].sort((a, b) => (a.status === b.status ? b.startedAt - a.startedAt : a.status === 'ongoing' ? -1 : 1)))
  }

  getRules(): AlertRule[] {
    return clone(this.rules)
  }

  getUpdates(): NodeUpdateStatus[] {
    return NODE_SPECS.map((s) => {
      const rt = this.rt(s.id)
      const ring = (Object.keys(RINGS) as (keyof typeof RINGS)[]).find((r) => RINGS[r].includes(s.id))!
      const pending = rt.aptPending.length + rt.firmwarePending.length
      return {
        nodeId: s.id,
        model: s.model,
        ring,
        currentOs: rt.os.dgxOs,
        targetOs: TARGET_OS.dgxOs,
        aptPending: [...rt.aptPending],
        firmwarePending: rt.firmwarePending.map((f) => ({ ...f })),
        rebootRequired: rt.rebootRequired,
        lastChecked: rt.lastChecked,
        envelope: this.envelope('spark_updatectl.py', s.id, pending > 0 || rt.rebootRequired ? 'warn' : 'ok', { mode: 'check', pending_packages: rt.aptPending.length, firmware_updates: rt.firmwarePending.length, reboot_required: rt.rebootRequired }, rt.rebootRequired ? ['reboot required to activate installed kernel'] : []),
      }
    })
  }

  getRollouts(): Rollout[] {
    return this.rollouts.map(({ stepStartedAt: _s, ...r }) => clone(r)).sort((a, b) => b.createdAt - a.createdAt)
  }

  getActivity(limit = 50): ActivityEvent[] {
    return clone(this.activity.slice(0, limit))
  }

  getFailures(): FailureInjection {
    return { ...this.failures }
  }

  // ---------- actions ----------

  rebootNode(id: string): void {
    const rt = this.rt(id)
    const now = this.now()
    if (rt.rebootUntil !== null) throw new SimError('conflict', `${id} is already rebooting`)
    rt.rebootUntil = now + REBOOT_MS
    rt.rebootRequired = false
    this.outages.push({ nodeId: id, from: now, to: now + REBOOT_MS })
    this.log('reboot', `Reboot requested for ${id}`, id)
    this.changed('nodes', 'deployments', 'updates')
  }

  setDrained(id: string, drained: boolean): void {
    this.rt(id).drained = drained
    this.log('drain', drained ? `${id} drained: gateway stops routing new requests` : `${id} returned to service`, id)
    this.changed('nodes')
  }

  runDiagnostics(id: string): SparkToolEnvelope {
    const { envelope } = this.getHealth(id)
    this.log('diag', `L1 diagnostics on ${id}: ${envelope.status}`, id)
    return envelope
  }

  createDeployment(input: CreateDeploymentInput): Deployment {
    const model = MODEL_CATALOG.find((m) => m.id === input.catalogId)
    if (!model) throw new SimError('invalid', `Unknown model ${input.catalogId}`)
    if (!model.engines.includes(input.engine)) throw new SimError('invalid', `${model.displayName} is not packaged for ${input.engine}`)
    if (input.nodeIds.length === 0) throw new SimError('invalid', 'Select at least one node')
    if (input.nodeIds.length > 1 && input.engine !== 'vLLM' && input.engine !== 'SGLang') throw new SimError('invalid', `${input.engine} cannot span multiple nodes`)
    const perNode = model.sizeGB / input.nodeIds.length
    if (perNode > 110) throw new SimError('invalid', `${model.displayName} needs at least ${Math.ceil(model.sizeGB / 110)} nodes`)
    for (const id of input.nodeIds) {
      const node = this.requireNode(id)
      if (node.deploymentId) throw new SimError('conflict', `${id} is already serving ${node.deploymentId}`)
      if (node.status === 'offline' || node.status === 'rebooting') throw new SimError('conflict', `${id} is ${node.status}`)
    }
    const now = this.now()
    const n = ++this.counter
    const dep: SimDeployment = {
      id: `dep-${model.id}-${n}`,
      model: model.id,
      engine: input.engine,
      replicas: [{ id: input.nodeIds.length > 1 ? `grp-${n}` : `rep-${n}`, nodeIds: [...input.nodeIds] }],
      memoryGBPerNode: Math.min(110, Math.ceil(perNode * 1.15) + 8),
      trafficWeight: 0.3,
      peakTokensPerSec: 800,
      peakRps: 1.2,
      createdAgoMs: 0,
      status: 'pending',
      statusSince: now,
      createdAt: now,
    }
    this.deployments.push(dep)
    this.log('deploy', `Deploying ${model.id} on ${input.nodeIds.join(', ')} (${input.engine})`, input.nodeIds.length === 1 ? input.nodeIds[0] : null)
    this.changed('deployments', 'nodes')
    return this.toDeployment(dep)
  }

  stopDeployment(id: string): void {
    const d = this.deployments.find((x) => x.id === id && x.status !== 'stopped')
    if (!d) throw new SimError('not_found', `Deployment ${id} not found`)
    this.setDeploymentStatus(d, 'stopped', this.now())
    this.log('deploy', `Stopped ${d.model} on ${d.replicas.flatMap((r) => r.nodeIds).join(', ')}`, null)
    this.changed('deployments', 'nodes')
  }

  createKey(input: { name: string; rateLimitRpm: number }): { key: ApiKey; secret: string } {
    const name = input.name.trim()
    if (!name) throw new SimError('invalid', 'Name is required')
    if (this.keys.some((k) => k.name === name && k.revokedAt === null)) throw new SimError('conflict', `An active key named ${name} exists`)
    const now = this.now()
    const rand = mulberry32(hash(this.seed, name, now))
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    const secret = `sk-spark-${Array.from({ length: 32 }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('')}`
    const key: SimKey = { id: this.nextId('key'), name, prefix: secret.slice(0, 13), createdAt: now, lastUsedAt: null, rateLimitRpm: input.rateLimitRpm, revokedAt: null, requests24h: 0, share: 0 }
    this.keys.push(key)
    this.log('key', `API key ${name} created`, null)
    this.changed('keys')
    const { share: _share, ...pub } = key
    return { key: { ...pub }, secret }
  }

  revokeKey(id: string): void {
    const key = this.keys.find((k) => k.id === id)
    if (!key) throw new SimError('not_found', `Key ${id} not found`)
    if (key.revokedAt !== null) throw new SimError('conflict', `${key.name} is already revoked`)
    key.revokedAt = this.now()
    key.share = 0
    this.log('key', `API key ${key.name} revoked`, null)
    this.changed('keys')
  }

  setRuleEnabled(id: string, enabled: boolean): void {
    const rule = this.rules.find((r) => r.id === id)
    if (!rule) throw new SimError('not_found', `Rule ${id} not found`)
    rule.enabled = enabled
    this.changed('rules')
  }

  resolveIncident(id: string): void {
    const inc = this.incidents.find((i) => i.id === id)
    if (!inc) throw new SimError('not_found', `Incident ${id} not found`)
    if (inc.status === 'resolved') throw new SimError('conflict', `${inc.title} is already resolved`)
    const now = this.now()
    inc.status = 'resolved'
    inc.resolvedAt = now
    inc.timeline.push({ ts: now, text: 'Resolved by operator' })
    this.closers.get(id)?.()
    this.closers.delete(id)
    this.log('alert', `Incident resolved: ${inc.title}`, inc.nodeId)
    this.changed('incidents', 'nodes')
  }

  startRollout(input: StartRolloutInput): Rollout {
    if (this.rollouts.some((r) => r.status === 'running' || r.status === 'awaiting-approval')) throw new SimError('conflict', 'Another rollout is already active')
    if (input.rings.length === 0) throw new SimError('invalid', 'Select at least one ring')
    const now = this.now()
    const order: (keyof typeof RINGS)[] = ['canary', 'ring1', 'ring2']
    const rings = order.filter((r) => input.rings.includes(r))
    const rollout: SimRollout = {
      id: this.nextId('ro'),
      name: `DGX OS ${input.targetOs}`,
      targetOs: input.targetOs,
      rings,
      window: input.window,
      status: input.requireApproval ? 'awaiting-approval' : 'running',
      createdAt: now,
      startedAt: input.requireApproval ? null : now,
      finishedAt: null,
      nodes: rings.flatMap((ring) => RINGS[ring].map((nodeId) => ({ nodeId, ring, step: 'queued' as const }))),
      stepStartedAt: now,
    }
    this.rollouts.push(rollout)
    this.log('update', `Rollout ${rollout.name} planned for ${rings.join(' → ')}${input.requireApproval ? ' (awaiting approval)' : ''}`, null)
    this.changed('rollouts')
    const { stepStartedAt: _s, ...pub } = rollout
    return clone(pub)
  }

  approveRollout(id: string): void {
    const r = this.rollouts.find((x) => x.id === id)
    if (!r) throw new SimError('not_found', `Rollout ${id} not found`)
    if (r.status !== 'awaiting-approval') throw new SimError('conflict', `${r.name} is ${r.status}`)
    const now = this.now()
    r.status = 'running'
    r.startedAt = now
    r.stepStartedAt = now
    this.log('update', `Rollout ${r.name} approved`, null)
    this.changed('rollouts')
  }

  setFailures(patch: Partial<FailureInjection>): void {
    const now = this.now()
    if (patch.nodeOffline !== undefined && patch.nodeOffline !== this.failures.nodeOffline) {
      if (this.failures.nodeOffline) this.resolveInjected(`inj-offline-${this.failures.nodeOffline}`)
      const id = patch.nodeOffline
      if (id) {
        this.spec(id)
        const outage: Outage = { nodeId: id, from: now, to: null }
        this.outages.push(outage)
        this.openInjected(`inj-offline-${id}`, `${id} offline`, 'critical', id, 'rule-offline', 'No heartbeat for 60 s', () => {
          outage.to = this.now()
        })
      }
      this.failures.nodeOffline = id
    }
    if (patch.gatewayErrors !== undefined && patch.gatewayErrors !== this.failures.gatewayErrors) {
      if (patch.gatewayErrors) {
        const gw = { from: now, to: null as number | null }
        const win: LogWindow = { from: now, to: null, nodeId: 'spark-03', kind: 'gateway-5xx', label: 'Gateway 5xx (injected)' }
        this.gatewayErrorWindows.push(gw)
        this.windows.push(win)
        this.openInjected('inj-5xx', 'Gateway 5xx rate above 2 %', 'critical', null, 'rule-5xx', '5xx rate crossed 2 %', () => {
          gw.to = this.now()
          win.to = this.now()
        })
      } else {
        this.resolveInjected('inj-5xx')
      }
      this.failures.gatewayErrors = patch.gatewayErrors
    }
    if (patch.xidStorm !== undefined && patch.xidStorm !== this.failures.xidStorm) {
      if (patch.xidStorm) {
        const win: LogWindow = { from: now, to: null, nodeId: 'gx10-03', kind: 'xid', label: 'Xid storm on gx10-03 (injected)' }
        this.windows.push(win)
        this.openInjected('inj-xid', 'Xid 31 storm on gx10-03', 'critical', 'gx10-03', 'rule-xid', 'NVRM: Xid 31 repeated', () => {
          win.to = this.now()
        })
      } else {
        this.resolveInjected('inj-xid')
      }
      this.failures.xidStorm = patch.xidStorm
    }
    if (patch.apiErrors !== undefined) this.failures.apiErrors = patch.apiErrors
    this.changed('failures', 'incidents', 'nodes')
  }

  // ---------- internals ----------

  private emit(e: SimEvent): void {
    for (const fn of this.listeners) fn(e)
  }

  private changed(...topics: Topic[]): void {
    for (const topic of topics) this.emit({ type: 'changed', topic })
  }

  private nextId(prefix: string): string {
    return `${prefix}-${++this.counter}`
  }

  private log(kind: ActivityKind, text: string, nodeId: string | null): void {
    this.activity.unshift({ id: this.nextId('act'), ts: this.now(), kind, text, nodeId })
    this.activity = this.activity.slice(0, 200)
    this.changed('activity')
  }

  private spec(id: string): NodeSpec {
    const s = NODE_SPECS.find((x) => x.id === id)
    if (!s) throw new SimError('not_found', `Node ${id} not found`)
    return s
  }

  private rt(id: string): NodeRuntime {
    this.spec(id)
    return this.runtime.get(id)!
  }

  private requireNode(id: string): FleetNode {
    const n = this.getNode(id)
    if (!n) throw new SimError('not_found', `Node ${id} not found`)
    return n
  }

  private effectiveSpec(spec: NodeSpec): NodeSpec {
    return { ...spec, thermalIssue: this.rt(spec.id).thermal }
  }

  private metricWorld(): MetricWorld {
    return { seed: this.seed, outages: this.outages, gatewayErrorWindows: this.gatewayErrorWindows }
  }

  private logWorld(): LogWorld {
    return {
      seed: this.seed,
      nodes: NODE_SPECS,
      deployments: this.deployments.filter((d) => d.status !== 'stopped'),
      keys: this.keys.filter((k) => k.revokedAt === null).map(({ id, name, share }) => ({ id, name, share })),
      windows: this.windows,
      outages: this.outages,
    }
  }

  private deploymentsOn(nodeId: string): SimDeployment[] {
    return this.deployments.filter((d) => d.status !== 'stopped' && d.replicas.some((r) => r.nodeIds.includes(nodeId)))
  }

  private activeDepFor(nodeId: string): SimDeployment | null {
    return this.deploymentsOn(nodeId)[0] ?? null
  }

  private servingSpecs(): DeploymentSpec[] {
    return this.deployments.filter((d) => d.status === 'serving')
  }

  private setDeploymentStatus(d: SimDeployment, status: DeploymentStatus, now: number): void {
    d.status = status
    d.statusSince = now
  }

  private nodeStatus(id: string): NodeStatus {
    const rt = this.rt(id)
    const now = this.now()
    if (rt.rebootUntil !== null && now < rt.rebootUntil) return 'rebooting'
    if (isOffline(this.outages, id, now)) return 'offline'
    if (rt.thermal) return 'degraded'
    return 'online'
  }

  private toNode(spec: NodeSpec): FleetNode {
    const rt = this.rt(spec.id)
    const now = this.now()
    const status = this.nodeStatus(spec.id)
    const dep = this.activeDepFor(spec.id)
    const reachable = status === 'online' || status === 'degraded'
    const p = reachable ? sampleNode(this.metricWorld(), this.effectiveSpec(spec), dep, now) : null
    const lastOutage = [...this.outages].reverse().find((o) => o.nodeId === spec.id && o.from <= now)
    const group = dep?.replicas.find((r) => r.nodeIds.includes(spec.id) && r.nodeIds.length > 1)
    return {
      id: spec.id,
      hostname: `${spec.id}.${FLEET_CONFIG.domain}`,
      model: spec.model,
      ip: spec.ip,
      status,
      drained: rt.drained,
      os: { ...rt.os },
      memoryGB: 128,
      cpuCores: 20,
      diskGB: spec.diskGB,
      assetTag: spec.assetTag,
      serial: spec.serial,
      bootedAt: rt.bootedAt,
      lastSeen: reachable ? now - Math.floor(noise(this.seed, spec.id, 'seen', Math.floor(now / 2000)) * 4000) : (lastOutage?.from ?? now),
      deploymentId: dep?.id ?? null,
      groupId: group?.id ?? null,
      live: p
        ? {
            gpuUtil: p.gpuUtil!,
            memUsedGB: p.memUsedGB!,
            gpuPowerW: p.gpuPowerW!,
            gpuTempC: p.gpuTempC!,
            acpiTempC: p.acpiTempC!,
            cpuUtil: p.cpuUser! + p.cpuSystem!,
            diskUsedPct: p.diskUsedPct!,
            throttling: rt.thermal,
          }
        : null,
    }
  }

  private toDeployment(d: SimDeployment): Deployment {
    const cat = MODEL_CATALOG.find((m) => m.id === d.model)!
    const nodeIds = d.replicas.flatMap((r) => r.nodeIds)
    const anyDown = nodeIds.some((id) => {
      const s = this.nodeStatus(id)
      return s === 'offline' || s === 'rebooting'
    })
    const status: DeploymentStatus = d.status === 'serving' && anyDown ? 'degraded' : d.status
    const load = status === 'serving' ? deploymentLoad(this.seed, d, this.now()) : 0
    return {
      id: d.id,
      model: d.model,
      displayName: cat.displayName,
      engine: d.engine,
      quant: cat.quant,
      replicas: clone(d.replicas),
      status,
      contextLength: cat.contextLength,
      port: ENGINE_PORT[d.engine],
      memoryGBPerNode: d.memoryGBPerNode,
      createdAt: d.createdAt,
      tokensPerSec: load * d.peakTokensPerSec * d.replicas.length,
      requestsPerSec: load * d.peakRps,
    }
  }

  private envelope(tool: string, id: string, status: SparkToolEnvelope['status'], summary: Record<string, unknown>, warnings: string[]): SparkToolEnvelope {
    const now = this.now()
    const ts = new Date(now).toISOString()
    return {
      tool,
      ts,
      host: `${id}.${FLEET_CONFIG.domain}`,
      status,
      rc: status === 'error' ? 2 : status === 'warn' ? 1 : 0,
      duration_ms: 400 + Math.floor(noise(this.seed, tool, id, Math.floor(now / 60_000)) * 900),
      summary,
      warnings,
      artifacts: [`/var/lib/dgx_spark_management/${tool.replace('.py', '')}/${id}-${ts.replace(/[:.]/g, '')}.json`],
    }
  }

  private openInjected(id: string, title: string, severity: Incident['severity'], nodeId: string | null, ruleId: string, first: string, closer: () => void): void {
    const now = this.now()
    this.incidents.push({ id, title, severity, status: 'ongoing', nodeId, ruleId, startedAt: now, resolvedAt: null, timeline: [{ ts: now, text: first }] })
    this.closers.set(id, closer)
    this.log('alert', `Alert opened: ${title}`, nodeId)
  }

  private resolveInjected(id: string): void {
    const inc = this.incidents.find((i) => i.id === id && i.status === 'ongoing')
    if (inc) this.resolveIncident(inc.id)
    // reuse of the same injected id later: rename the resolved one so ids stay unique
    if (inc) inc.id = `${id}-${this.nextId('closed')}`
  }

  private advanceRollouts(now: number): void {
    const r = this.rollouts.find((x) => x.status === 'running')
    if (!r) return
    const ring = r.rings.find((rg) => r.nodes.some((n) => n.ring === rg && n.step !== 'done'))
    if (!ring) {
      r.status = 'completed'
      r.finishedAt = now
      this.log('update', `Rollout ${r.name} completed on ${r.nodes.length} nodes`, null)
      this.changed('rollouts')
      return
    }
    const ringNodes = r.nodes.filter((n) => n.ring === ring)
    const queued = ringNodes.every((n) => n.step === 'queued')
    if (!queued && now - r.stepStartedAt < ROLLOUT_STEP_MS) return
    r.stepStartedAt = now
    const next = STEP_ORDER[STEP_ORDER.indexOf(ringNodes[0].step) + 1]
    for (const n of ringNodes) {
      n.step = next
      if (next === 'reboot') this.outages.push({ nodeId: n.nodeId, from: now, to: now + ROLLOUT_STEP_MS })
      if (next === 'done') {
        const rt = this.rt(n.nodeId)
        if (r.targetOs === TARGET_OS.dgxOs) rt.os = { ...TARGET_OS }
        rt.aptPending = []
        rt.firmwarePending = []
        rt.rebootRequired = false
        rt.lastChecked = now
      }
    }
    if (next === 'done') this.log('update', `Ring ${ring} finished ${r.name}`, null)
    this.changed('rollouts', 'nodes', 'updates')
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/api/mock/simulator.test.ts`
Expected: PASS (13 tests). If the rollout test fails on timing: the canary ring needs 1 tick to reach `precheck` (queued advances immediately), then 4 steps × 4 s, then 1 more tick to mark the rollout completed. That is 2 s + 18 s total.

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all tests pass, no TS errors.

- [ ] **Step 6: Commit**

```bash
git add src/api/mock/simulator.ts src/api/mock/simulator.test.ts
git commit -m "feat: fleet simulator with actions, lifecycles and failure injection

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: Client interface, MockClient, query hooks, architecture guard

**Files:**
- Create: `src/api/client.tsx`, `src/api/mock/mock-client.ts`, `src/api/mock/mock-client.test.ts`, `src/api/hooks.ts`, `src/api/hooks.test.tsx`, `src/api/architecture.test.ts`

**Interfaces:**
- Consumes: `Simulator`, `SimError` from `./mock/simulator`; `FLEET_CONFIG`, `NODE_SPECS`, `MODEL_CATALOG` from `./mock/fixtures`; all types.
- Produces:
  - `interface FleetConfig { sshUser: string; sshKeyPath: string; hosts: { id: string; ip: string }[] }`
  - `interface SparkManClient` (methods listed in the code below) plus `ClientProvider({ client, children })` and `useClient()`
  - `class MockClient implements SparkManClient` with `constructor(sim: Simulator, opts?: { latencyMs?: number })`
  - `qk` query-key factory; `useClientEvents()`; query hooks `useNodes`, `useNode(id)`, `useNodeMetrics(id, range, enabled?)`, `useNodeProcesses(id, enabled?)`, `useNodeInventory(id, enabled?)`, `useNodeHealth(id, enabled?)`, `useFleetSummary`, `useDeployments`, `useCatalog`, `useGatewayInfo`, `useGatewaySeries(range)`, `useRoutes`, `useUsage(range)`, `useKeys`, `useLogs(input, live)`, `useIncidents`, `useAlertRules`, `useNodeUpdates`, `useRollouts`, `useActivity(limit?)`, `useFailures`, `useFleetConfig`; mutation hooks `useRebootNode`, `useSetDrained`, `useRunDiagnostics`, `useCreateDeployment`, `useStopDeployment`, `useCreateKey`, `useRevokeKey`, `useResolveIncident`, `useSetRuleEnabled`, `useStartRollout`, `useApproveRollout`, `useSetFailures`. Mutations toast on error via `sonner`.

- [ ] **Step 1: Write `src/api/client.tsx`**

```tsx
import { createContext, useContext, type ReactNode } from 'react'
import type {
  AlertRule, ApiKey, ActivityEvent, CatalogModel, CreateDeploymentInput, Deployment, FailureInjection, FleetNode, FleetSummary,
  GatewayInfo, GatewayPoint, GatewayRoute, GpuProcess, Incident, LogQueryInput, LogQueryResult, MetricPoint, NodeHealth,
  NodeInventory, NodeUpdateStatus, Rollout, SimEvent, SparkToolEnvelope, StartRolloutInput, TimeRange, UsageReport,
} from './types'

export type ClientEvent = SimEvent

export interface FleetConfig {
  sshUser: string
  sshKeyPath: string
  hosts: { id: string; ip: string }[]
}

export interface SparkManClient {
  listNodes(): Promise<FleetNode[]>
  getNode(id: string): Promise<FleetNode | null>
  getNodeMetrics(id: string, range: TimeRange): Promise<MetricPoint[]>
  getNodeProcesses(id: string): Promise<GpuProcess[]>
  getNodeInventory(id: string): Promise<NodeInventory>
  getNodeHealth(id: string): Promise<NodeHealth>
  rebootNode(id: string): Promise<void>
  setNodeDrained(id: string, drained: boolean): Promise<void>
  runDiagnostics(id: string): Promise<SparkToolEnvelope>
  getFleetSummary(): Promise<FleetSummary>
  getFleetConfig(): Promise<FleetConfig>
  listDeployments(): Promise<Deployment[]>
  listCatalog(): Promise<CatalogModel[]>
  createDeployment(input: CreateDeploymentInput): Promise<Deployment>
  stopDeployment(id: string): Promise<void>
  getGatewayInfo(): Promise<GatewayInfo>
  getGatewaySeries(range: TimeRange): Promise<GatewayPoint[]>
  listRoutes(): Promise<GatewayRoute[]>
  getUsage(range: TimeRange): Promise<UsageReport>
  listKeys(): Promise<ApiKey[]>
  createKey(input: { name: string; rateLimitRpm: number }): Promise<{ key: ApiKey; secret: string }>
  revokeKey(id: string): Promise<void>
  queryLogs(input: LogQueryInput): Promise<LogQueryResult>
  listIncidents(): Promise<Incident[]>
  resolveIncident(id: string): Promise<void>
  listAlertRules(): Promise<AlertRule[]>
  setAlertRuleEnabled(id: string, enabled: boolean): Promise<void>
  listNodeUpdates(): Promise<NodeUpdateStatus[]>
  listRollouts(): Promise<Rollout[]>
  startRollout(input: StartRolloutInput): Promise<Rollout>
  approveRollout(id: string): Promise<void>
  listActivity(limit?: number): Promise<ActivityEvent[]>
  getFailures(): Promise<FailureInjection>
  setFailures(patch: Partial<FailureInjection>): Promise<void>
  /** Live event stream (ticks + change notifications). Returns an unsubscribe function. */
  subscribe(listener: (e: ClientEvent) => void): () => void
}

const ClientContext = createContext<SparkManClient | null>(null)

export function ClientProvider({ client, children }: { client: SparkManClient; children: ReactNode }) {
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>
}

export function useClient(): SparkManClient {
  const client = useContext(ClientContext)
  if (!client) throw new Error('useClient must be used inside <ClientProvider>')
  return client
}
```

- [ ] **Step 2: Write the failing MockClient test**

`src/api/mock/mock-client.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { MockClient } from './mock-client'
import { SimError, Simulator } from './simulator'

const START = new Date(2026, 9, 8, 15, 0, 0).getTime()
const make = () => {
  const sim = new Simulator({ now: () => START })
  return { sim, client: new MockClient(sim, { latencyMs: 0 }) }
}

describe('MockClient', () => {
  it('serves simulator reads', async () => {
    const { client } = make()
    expect(await client.listNodes()).toHaveLength(12)
    expect(await client.getNode('missing')).toBeNull()
    expect((await client.listCatalog()).length).toBeGreaterThan(5)
    expect((await client.getFleetConfig()).hosts).toHaveLength(12)
  })
  it('round-trips mutations', async () => {
    const { client } = make()
    const { key } = await client.createKey({ name: 'e2e', rateLimitRpm: 60 })
    expect((await client.listKeys()).map((k) => k.id)).toContain(key.id)
  })
  it('rejects with SimError on invalid actions', async () => {
    const { client } = make()
    await expect(client.revokeKey('missing')).rejects.toBeInstanceOf(SimError)
  })
  it('simulated API failures reject reads but keep failure controls usable', async () => {
    const { client } = make()
    await client.setFailures({ apiErrors: true })
    await expect(client.listNodes()).rejects.toMatchObject({ code: 'unavailable' })
    expect((await client.getFailures()).apiErrors).toBe(true)
    await client.setFailures({ apiErrors: false })
    expect(await client.listNodes()).toHaveLength(12)
  })

  it('forwards simulator events to subscribers', () => {
    const { sim, client } = make()
    const seen: string[] = []
    const off = client.subscribe((e) => seen.push(e.type))
    sim.tick()
    off()
    sim.tick()
    expect(seen).toEqual(['tick'])
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run src/api/mock/mock-client.test.ts`
Expected: FAIL, `Cannot find module './mock-client'`.

- [ ] **Step 4: Write `src/api/mock/mock-client.ts`**

```ts
import type { ClientEvent, FleetConfig, SparkManClient } from '../client'
import type { CreateDeploymentInput, FailureInjection, LogQueryInput, StartRolloutInput, TimeRange } from '../types'
import { FLEET_CONFIG, MODEL_CATALOG, NODE_SPECS } from './fixtures'
import { SimError, type Simulator } from './simulator'

export class MockClient implements SparkManClient {
  private sim: Simulator
  private latencyMs: number

  constructor(sim: Simulator, opts: { latencyMs?: number } = {}) {
    this.sim = sim
    this.latencyMs = opts.latencyMs ?? 120
  }

  private async delay(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs * (0.5 + Math.random())))
  }

  private async run<T>(fn: () => T): Promise<T> {
    await this.delay()
    if (this.sim.getFailures().apiErrors) throw new SimError('unavailable', 'Simulated API failure (Settings → Simulator)')
    return fn()
  }

  listNodes() { return this.run(() => this.sim.getNodes()) }
  getNode(id: string) { return this.run(() => this.sim.getNode(id)) }
  getNodeMetrics(id: string, range: TimeRange) { return this.run(() => this.sim.getMetrics(id, range)) }
  getNodeProcesses(id: string) { return this.run(() => this.sim.getProcesses(id)) }
  getNodeInventory(id: string) { return this.run(() => this.sim.getInventory(id)) }
  getNodeHealth(id: string) { return this.run(() => this.sim.getHealth(id)) }
  rebootNode(id: string) { return this.run(() => this.sim.rebootNode(id)) }
  setNodeDrained(id: string, drained: boolean) { return this.run(() => this.sim.setDrained(id, drained)) }
  runDiagnostics(id: string) { return this.run(() => this.sim.runDiagnostics(id)) }
  getFleetSummary() { return this.run(() => this.sim.getFleetSummary()) }
  getFleetConfig(): Promise<FleetConfig> {
    return this.run(() => ({ sshUser: FLEET_CONFIG.sshUser, sshKeyPath: FLEET_CONFIG.sshKeyPath, hosts: NODE_SPECS.map((n) => ({ id: n.id, ip: n.ip })) }))
  }
  listDeployments() { return this.run(() => this.sim.getDeployments()) }
  listCatalog() { return this.run(() => structuredClone(MODEL_CATALOG)) }
  createDeployment(input: CreateDeploymentInput) { return this.run(() => this.sim.createDeployment(input)) }
  stopDeployment(id: string) { return this.run(() => this.sim.stopDeployment(id)) }
  getGatewayInfo() { return this.run(() => this.sim.getGatewayInfo()) }
  getGatewaySeries(range: TimeRange) { return this.run(() => this.sim.getGatewaySeries(range)) }
  listRoutes() { return this.run(() => this.sim.getRoutes()) }
  getUsage(range: TimeRange) { return this.run(() => this.sim.getUsage(range)) }
  listKeys() { return this.run(() => this.sim.getKeys()) }
  createKey(input: { name: string; rateLimitRpm: number }) { return this.run(() => this.sim.createKey(input)) }
  revokeKey(id: string) { return this.run(() => this.sim.revokeKey(id)) }
  queryLogs(input: LogQueryInput) { return this.run(() => this.sim.queryLogs(input)) }
  listIncidents() { return this.run(() => this.sim.getIncidents()) }
  resolveIncident(id: string) { return this.run(() => this.sim.resolveIncident(id)) }
  listAlertRules() { return this.run(() => this.sim.getRules()) }
  setAlertRuleEnabled(id: string, enabled: boolean) { return this.run(() => this.sim.setRuleEnabled(id, enabled)) }
  listNodeUpdates() { return this.run(() => this.sim.getUpdates()) }
  listRollouts() { return this.run(() => this.sim.getRollouts()) }
  startRollout(input: StartRolloutInput) { return this.run(() => this.sim.startRollout(input)) }
  approveRollout(id: string) { return this.run(() => this.sim.approveRollout(id)) }
  listActivity(limit?: number) { return this.run(() => this.sim.getActivity(limit)) }
  // failure controls bypass the simulated outage so it can always be switched off
  async getFailures() { await this.delay(); return this.sim.getFailures() }
  async setFailures(patch: Partial<FailureInjection>) { await this.delay(); this.sim.setFailures(patch) }
  subscribe(listener: (e: ClientEvent) => void) { return this.sim.subscribe(listener) }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run src/api/mock/mock-client.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Write the failing hooks test**

`src/api/hooks.test.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ClientProvider, type SparkManClient } from './client'
import { useClientEvents, useKeys, useNodes } from './hooks'
import { MockClient } from './mock/mock-client'
import { Simulator } from './mock/simulator'

const START = new Date(2026, 9, 8, 15, 0, 0).getTime()

function wrapperFor(client: SparkManClient) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <ClientProvider client={client}>{children}</ClientProvider>
    </QueryClientProvider>
  )
}

describe('hooks', () => {
  it('refetches live queries on every tick', async () => {
    const sim = new Simulator({ now: () => START })
    const client = new MockClient(sim, { latencyMs: 0 })
    const spy = vi.spyOn(client, 'listNodes')
    const { result } = renderHook(() => {
      useClientEvents()
      return useNodes()
    }, { wrapper: wrapperFor(client) })
    await waitFor(() => expect(result.current.data).toHaveLength(12))
    act(() => sim.tick())
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2))
  })

  it('invalidates topic queries on change events', async () => {
    const sim = new Simulator({ now: () => START })
    const client = new MockClient(sim, { latencyMs: 0 })
    const { result } = renderHook(() => {
      useClientEvents()
      return useKeys()
    }, { wrapper: wrapperFor(client) })
    await waitFor(() => expect(result.current.data).toHaveLength(7))
    act(() => {
      sim.createKey({ name: 'hooks-test', rateLimitRpm: 60 })
    })
    await waitFor(() => expect(result.current.data).toHaveLength(8))
  })
})
```

- [ ] **Step 7: Write the architecture guard test**

`src/api/architecture.test.ts`:
```ts
// @vitest-environment node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(__dirname, '..')

function files(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? files(full) : [full]
  })
}

describe('architecture', () => {
  it('UI code never imports the mock layer', () => {
    const offenders = ['features', 'components', 'routes', 'lib']
      .flatMap((d) => files(path.join(SRC, d)))
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => /from ['"][^'"]*api\/mock/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC, f))
    expect(offenders).toEqual([])
  })
})
```

- [ ] **Step 8: Run to verify the hooks test fails**

Run: `pnpm vitest run src/api/hooks.test.tsx src/api/architecture.test.ts`
Expected: hooks test FAILS (`Cannot find module './hooks'`); architecture test PASSES.

- [ ] **Step 9: Write `src/api/hooks.ts`**

```ts
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { useClient, type SparkManClient } from './client'
import type { CreateDeploymentInput, FailureInjection, LogQueryInput, StartRolloutInput, TimeRange, Topic } from './types'

const LIVE = { live: true } as const

export const qk = {
  nodes: ['nodes'] as const,
  node: (id: string) => ['nodes', id] as const,
  nodeMetrics: (id: string, range: TimeRange) => ['nodes', id, 'metrics', range] as const,
  nodeProcesses: (id: string) => ['nodes', id, 'processes'] as const,
  nodeInventory: (id: string) => ['nodes', id, 'inventory'] as const,
  nodeHealth: (id: string) => ['nodes', id, 'health'] as const,
  fleet: ['fleet'] as const,
  fleetConfig: ['fleet-config'] as const,
  deployments: ['deployments'] as const,
  catalog: ['catalog'] as const,
  gatewayInfo: ['gateway', 'info'] as const,
  gatewaySeries: (range: TimeRange) => ['gateway', 'series', range] as const,
  routes: ['gateway', 'routes'] as const,
  usage: (range: TimeRange) => ['usage', range] as const,
  keys: ['keys'] as const,
  logs: (input: LogQueryInput, live: boolean) => ['logs', input, live] as const,
  incidents: ['incidents'] as const,
  rules: ['rules'] as const,
  updates: ['updates'] as const,
  rollouts: ['rollouts'] as const,
  activity: (limit: number) => ['activity', limit] as const,
  failures: ['failures'] as const,
}

const TOPIC_KEYS: Record<Topic, readonly (readonly unknown[])[]> = {
  nodes: [qk.nodes, qk.fleet, qk.updates, qk.deployments],
  deployments: [qk.deployments, ['gateway'], qk.nodes, qk.fleet],
  keys: [qk.keys, ['usage']],
  rules: [qk.rules],
  incidents: [qk.incidents, qk.fleet, qk.nodes, ['logs']],
  updates: [qk.updates],
  rollouts: [qk.rollouts, qk.updates],
  activity: [['activity']],
  failures: [qk.failures, qk.nodes, qk.fleet, ['gateway'], ['logs']],
}

/** Mount once at the app root: ticks refresh live queries, change events refresh affected topics. */
export function useClientEvents(): void {
  const client = useClient()
  const qc = useQueryClient()
  useEffect(
    () =>
      client.subscribe((e) => {
        if (e.type === 'tick') {
          void qc.invalidateQueries({ predicate: (q) => q.meta?.live === true })
          return
        }
        for (const queryKey of TOPIC_KEYS[e.topic]) void qc.invalidateQueries({ queryKey })
      }),
    [client, qc],
  )
}

// ---------- queries ----------

export function useNodes() {
  const c = useClient()
  return useQuery({ queryKey: qk.nodes, queryFn: () => c.listNodes(), meta: LIVE })
}
export function useNode(id: string) {
  const c = useClient()
  return useQuery({ queryKey: qk.node(id), queryFn: () => c.getNode(id), meta: LIVE })
}
export function useNodeMetrics(id: string, range: TimeRange, enabled = true) {
  const c = useClient()
  return useQuery({ queryKey: qk.nodeMetrics(id, range), queryFn: () => c.getNodeMetrics(id, range), meta: LIVE, enabled, placeholderData: keepPreviousData })
}
export function useNodeProcesses(id: string, enabled = true) {
  const c = useClient()
  return useQuery({ queryKey: qk.nodeProcesses(id), queryFn: () => c.getNodeProcesses(id), meta: LIVE, enabled })
}
export function useNodeInventory(id: string, enabled = true) {
  const c = useClient()
  return useQuery({ queryKey: qk.nodeInventory(id), queryFn: () => c.getNodeInventory(id), enabled })
}
export function useNodeHealth(id: string, enabled = true) {
  const c = useClient()
  return useQuery({ queryKey: qk.nodeHealth(id), queryFn: () => c.getNodeHealth(id), meta: LIVE, enabled })
}
export function useFleetSummary() {
  const c = useClient()
  return useQuery({ queryKey: qk.fleet, queryFn: () => c.getFleetSummary(), meta: LIVE })
}
export function useFleetConfig() {
  const c = useClient()
  return useQuery({ queryKey: qk.fleetConfig, queryFn: () => c.getFleetConfig(), staleTime: Infinity })
}
export function useDeployments() {
  const c = useClient()
  return useQuery({ queryKey: qk.deployments, queryFn: () => c.listDeployments(), meta: LIVE })
}
export function useCatalog() {
  const c = useClient()
  return useQuery({ queryKey: qk.catalog, queryFn: () => c.listCatalog(), staleTime: Infinity })
}
export function useGatewayInfo() {
  const c = useClient()
  return useQuery({ queryKey: qk.gatewayInfo, queryFn: () => c.getGatewayInfo() })
}
export function useGatewaySeries(range: TimeRange) {
  const c = useClient()
  return useQuery({ queryKey: qk.gatewaySeries(range), queryFn: () => c.getGatewaySeries(range), meta: LIVE, placeholderData: keepPreviousData })
}
export function useRoutes() {
  const c = useClient()
  return useQuery({ queryKey: qk.routes, queryFn: () => c.listRoutes() })
}
export function useUsage(range: TimeRange) {
  const c = useClient()
  return useQuery({ queryKey: qk.usage(range), queryFn: () => c.getUsage(range), meta: LIVE, placeholderData: keepPreviousData })
}
export function useKeys() {
  const c = useClient()
  return useQuery({ queryKey: qk.keys, queryFn: () => c.listKeys() })
}
export function useLogs(input: LogQueryInput, live: boolean) {
  const c = useClient()
  return useQuery({ queryKey: qk.logs(input, live), queryFn: () => c.queryLogs(input), meta: { live }, placeholderData: keepPreviousData })
}
export function useIncidents() {
  const c = useClient()
  return useQuery({ queryKey: qk.incidents, queryFn: () => c.listIncidents() })
}
export function useAlertRules() {
  const c = useClient()
  return useQuery({ queryKey: qk.rules, queryFn: () => c.listAlertRules() })
}
export function useNodeUpdates() {
  const c = useClient()
  return useQuery({ queryKey: qk.updates, queryFn: () => c.listNodeUpdates() })
}
export function useRollouts() {
  const c = useClient()
  return useQuery({ queryKey: qk.rollouts, queryFn: () => c.listRollouts(), meta: LIVE })
}
export function useActivity(limit = 20) {
  const c = useClient()
  return useQuery({ queryKey: qk.activity(limit), queryFn: () => c.listActivity(limit) })
}
export function useFailures() {
  const c = useClient()
  return useQuery({ queryKey: qk.failures, queryFn: () => c.getFailures() })
}

// ---------- mutations ----------

function useAction<V, R>(fn: (c: SparkManClient, v: V) => Promise<R>, success?: (r: R, v: V) => string | null) {
  const c = useClient()
  return useMutation({
    mutationFn: (v: V) => fn(c, v),
    onSuccess: (r, v) => {
      const msg = success?.(r, v)
      if (msg) toast.success(msg)
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : String(e))
    },
  })
}

export const useRebootNode = () => useAction((c, id: string) => c.rebootNode(id), (_r, id) => `Rebooting ${id}…`)
export const useSetDrained = () =>
  useAction((c, v: { id: string; drained: boolean }) => c.setNodeDrained(v.id, v.drained), (_r, v) => (v.drained ? `${v.id} drained` : `${v.id} back in service`))
export const useRunDiagnostics = () => useAction((c, id: string) => c.runDiagnostics(id), (env) => `Diagnostics ${env.status.toUpperCase()} on ${env.host}`)
export const useCreateDeployment = () => useAction((c, v: CreateDeploymentInput) => c.createDeployment(v), (d) => `Deploying ${d.model}`)
export const useStopDeployment = () => useAction((c, id: string) => c.stopDeployment(id), () => 'Deployment stopped')
export const useCreateKey = () => useAction((c, v: { name: string; rateLimitRpm: number }) => c.createKey(v))
export const useRevokeKey = () => useAction((c, id: string) => c.revokeKey(id), () => 'API key revoked')
export const useResolveIncident = () => useAction((c, id: string) => c.resolveIncident(id), () => 'Incident resolved')
export const useSetRuleEnabled = () =>
  useAction((c, v: { id: string; enabled: boolean }) => c.setAlertRuleEnabled(v.id, v.enabled), (_r, v) => (v.enabled ? 'Rule enabled' : 'Rule disabled'))
export const useStartRollout = () => useAction((c, v: StartRolloutInput) => c.startRollout(v), (r) => `${r.name} planned`)
export const useApproveRollout = () => useAction((c, id: string) => c.approveRollout(id), () => 'Rollout approved')
export const useSetFailures = () => useAction((c, v: Partial<FailureInjection>) => c.setFailures(v), () => 'Simulator updated')
```

- [ ] **Step 10: Run to verify everything passes**

Run: `pnpm test && pnpm typecheck`
Expected: all tests pass (hooks: 2, architecture: 1, plus earlier suites).

- [ ] **Step 11: Commit**

```bash
git add src/api
git commit -m "feat: SparkManClient interface, MockClient and query hooks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: App shell, shared components, Playwright harness

**Files:**
- Create: `src/lib/nav.ts`, `src/components/brand-mark.tsx`, `src/components/app-shell.tsx`, `src/components/app-rail.tsx`, `src/components/command-menu.tsx`, `src/components/page-header.tsx`, `src/components/stat-tile.tsx`, `src/components/metric-chart.tsx`, `src/components/node-status-dot.tsx`, `src/components/time-range-toggle.tsx`, `src/components/live-badge.tsx`, `src/components/usage-bar.tsx`, `src/components/query-state.tsx`, `src/components/copy-button.tsx`, route files `src/routes/{index,nodes.index,nodes.$nodeId,gateway,deployments,usage,keys,logs,alerts,updates,settings}.tsx`, `playwright.config.ts`, `e2e/fixtures.ts`, `e2e/shell.spec.ts`
- Modify: `src/main.tsx`, `src/routes/__root.tsx`

**Interfaces:**
- Consumes: hooks from `@/api/hooks`; `ClientProvider` from `@/api/client`; `Simulator`, `MockClient` (in `main.tsx` only); formatters from `@/lib/format`.
- Produces (used by every page task):
  - `NAV_GROUPS: NavGroup[]`, `type NavPath`
  - `<PageHeader crumbs={{ label: string; to?: NavPath }[]} title={ReactNode} description?={ReactNode} actions?={ReactNode} />` and `<PageBody className?>{children}</PageBody>`
  - `<StatTile label value hint? icon? tone?='default'|'brand'|'warn'|'error' testId? />`
  - `<MetricChart title icon? data={MetricLike[]} series={{ key, label, color }[]} format={(v:number)=>string} range={TimeRange} domain?={[number, number | 'auto']} stacked? current?={ReactNode} height?=160 emptyText? />` where `MetricLike = { t: number } & Record<string, number | null>`
  - `<NodeStatusDot status />`, `<NodeStatusBadge status />`, `STATUS_LABEL: Record<NodeStatus, string>`
  - `<TimeRangeToggle value onChange ranges? />`
  - `<LiveBadge live onToggle? />`
  - `<UsageBar label value display? />`
  - `<QueryState query skeleton? isEmpty? empty?>{(data) => …}</QueryState>` and `<EmptyState title description? action? />`
  - `<CopyButton value label? toastText? />`
  - `openCommandMenu()`
  - e2e `test`/`expect` from `e2e/fixtures.ts`, which fail any test that logs a console error

- [ ] **Step 1: Navigation config** — `src/lib/nav.ts`

```ts
import { Bell, Boxes, ChartColumn, House, KeyRound, PackageCheck, Plug, ScrollText, Server, Settings, type LucideIcon } from 'lucide-react'

export type NavPath = '/' | '/nodes' | '/gateway' | '/deployments' | '/usage' | '/keys' | '/logs' | '/alerts' | '/updates' | '/settings'

export interface NavItem {
  to: NavPath
  label: string
  icon: LucideIcon
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  { label: 'Fleet', items: [{ to: '/', label: 'Overview', icon: House }, { to: '/nodes', label: 'Nodes', icon: Server }] },
  {
    label: 'AI Gateway',
    items: [
      { to: '/gateway', label: 'Endpoint', icon: Plug },
      { to: '/deployments', label: 'Deployments', icon: Boxes },
      { to: '/usage', label: 'Usage', icon: ChartColumn },
      { to: '/keys', label: 'API Keys', icon: KeyRound },
    ],
  },
  { label: 'Observe', items: [{ to: '/logs', label: 'Logs', icon: ScrollText }, { to: '/alerts', label: 'Alerts', icon: Bell }] },
  { label: 'Maintain', items: [{ to: '/updates', label: 'Updates', icon: PackageCheck }, { to: '/settings', label: 'Settings', icon: Settings }] },
]
```

- [ ] **Step 2: Brand mark and small display components**

`src/components/brand-mark.tsx`:
```tsx
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} role="img" aria-label="SparkMan">
      <rect width="32" height="32" rx="9" fill="var(--brand)" />
      <path d="M17.6 5 8.8 18.2h6.1L13.4 27l9.8-13.6h-6.3L17.6 5Z" fill="var(--background)" />
    </svg>
  )
}
```

`src/components/node-status-dot.tsx`:
```tsx
import type { NodeStatus } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export const STATUS_LABEL: Record<NodeStatus, string> = { online: 'Online', degraded: 'Degraded', offline: 'Offline', rebooting: 'Rebooting' }
const DOT: Record<NodeStatus, string> = { online: 'bg-brand', degraded: 'bg-level-warn', offline: 'bg-level-error', rebooting: 'bg-level-info' }

export function NodeStatusDot({ status, className }: { status: NodeStatus; className?: string }) {
  return (
    <span className={cn('relative inline-flex size-2.5 shrink-0', className)} role="img" aria-label={STATUS_LABEL[status]} title={STATUS_LABEL[status]}>
      {status === 'online' && <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand opacity-30 motion-reduce:hidden" />}
      <span className={cn('relative inline-flex size-2.5 rounded-full', DOT[status])} />
    </span>
  )
}

export function NodeStatusBadge({ status }: { status: NodeStatus }) {
  return (
    <Badge variant="outline" className="gap-1.5 font-medium" data-testid="node-status">
      <NodeStatusDot status={status} />
      {STATUS_LABEL[status]}
    </Badge>
  )
}
```

`src/components/time-range-toggle.tsx`:
```tsx
import type { TimeRange } from '@/api/types'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

export function TimeRangeToggle({ value, onChange, ranges = ['1h', '6h', '24h', '7d'] }: { value: TimeRange; onChange: (r: TimeRange) => void; ranges?: TimeRange[] }) {
  return (
    <ToggleGroup type="single" variant="outline" size="sm" value={value} onValueChange={(v) => v && onChange(v as TimeRange)} aria-label="Time range">
      {ranges.map((r) => (
        <ToggleGroupItem key={r} value={r} className="px-3 font-mono text-xs data-[state=on]:text-brand">
          {r}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
```

`src/components/live-badge.tsx`:
```tsx
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function LiveBadge({ live, onToggle }: { live: boolean; onToggle?: () => void }) {
  const dot = <span className={cn('size-2 rounded-full', live ? 'bg-brand motion-safe:animate-pulse' : 'bg-muted-foreground')} />
  if (!onToggle) {
    return (
      <Badge variant="outline" className="gap-1.5 border-brand/40 text-brand">
        {dot}Live
      </Badge>
    )
  }
  return (
    <Button variant="outline" size="sm" aria-pressed={live} onClick={onToggle} className={cn('gap-1.5', live && 'border-brand/40 text-brand')}>
      {dot}Live
    </Button>
  )
}
```

`src/components/usage-bar.tsx`:
```tsx
import { formatPercent } from '@/lib/format'
import { cn } from '@/lib/utils'

export function UsageBar({ label, value, display }: { label: string; value: number | null; display?: string }) {
  const pct = value == null ? 0 : Math.max(0, Math.min(100, value))
  const tone = value == null ? 'bg-muted' : pct >= 90 ? 'bg-level-error' : pct >= 75 ? 'bg-level-warn' : 'bg-brand'
  const text = display ?? formatPercent(value)
  return (
    <div className="flex items-end gap-2" title={`${label} ${text}`}>
      <div className="relative h-7 w-1 overflow-hidden rounded-full bg-muted">
        <div className={cn('absolute bottom-0 w-full rounded-full transition-[height] duration-500', tone)} style={{ height: `${pct}%` }} />
      </div>
      <div className="leading-none">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="mt-1 font-mono text-sm tabular-nums">{text}</div>
      </div>
    </div>
  )
}
```

`src/components/copy-button.tsx`:
```tsx
import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

export function CopyButton({ value, label = 'Copy', toastText = 'Copied to clipboard' }: { value: string; label?: string; toastText?: string }) {
  const [done, setDone] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setDone(true)
      toast.success(toastText)
      setTimeout(() => setDone(false), 1500)
    } catch {
      toast.error('Clipboard unavailable in this browser')
    }
  }
  return (
    <Button variant="outline" size="sm" onClick={() => void copy()}>
      {done ? <Check /> : <Copy />}
      {label}
    </Button>
  )
}
```

- [ ] **Step 3: Page layout, stat tile, query state** — `src/components/page-header.tsx`

```tsx
import { Link } from '@tanstack/react-router'
import { Fragment, type ReactNode } from 'react'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import type { NavPath } from '@/lib/nav'
import { cn } from '@/lib/utils'

export function PageHeader({ crumbs, title, description, actions }: { crumbs: { label: string; to?: NavPath }[]; title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-col gap-5 border-b px-6 pb-5 pt-4">
      <Breadcrumb>
        <BreadcrumbList>
          {crumbs.map((c, i) => (
            <Fragment key={c.label}>
              {i > 0 && <BreadcrumbSeparator />}
              <BreadcrumbItem>
                {c.to && i < crumbs.length - 1 ? (
                  <BreadcrumbLink asChild>
                    <Link to={c.to}>{c.label}</Link>
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage>{c.label}</BreadcrumbPage>
                )}
              </BreadcrumbItem>
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
          {description && <div className="mt-1.5 text-sm text-muted-foreground">{description}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  )
}

export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-col gap-6 p-6', className)}>{children}</div>
}
```

`src/components/stat-tile.tsx`:
```tsx
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card'
import { cn } from '@/lib/utils'

const TONE = { default: '', brand: 'text-brand', warn: 'text-level-warn', error: 'text-level-error' } as const

export function StatTile({ label, value, hint, icon: Icon, tone = 'default', testId }: { label: string; value: ReactNode; hint?: ReactNode; icon?: LucideIcon; tone?: keyof typeof TONE; testId?: string }) {
  return (
    <Card className="gap-2 py-4" data-testid={testId}>
      <CardHeader className="flex flex-row items-center justify-between px-4">
        <CardDescription className="text-xs font-medium uppercase tracking-wide">{label}</CardDescription>
        {Icon && <Icon className="size-4 text-muted-foreground" />}
      </CardHeader>
      <CardContent className="px-4">
        <div className={cn('font-mono text-2xl font-semibold tabular-nums', TONE[tone])}>{value}</div>
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  )
}
```

`src/components/query-state.tsx`:
```tsx
import type { UseQueryResult } from '@tanstack/react-query'
import { CircleAlert, CircleSlash } from 'lucide-react'
import type { ReactNode } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

export function EmptyState({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-12 text-center" data-testid="empty-state">
      <CircleSlash className="size-5 text-muted-foreground" />
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function QueryState<T>({ query, children, skeleton, isEmpty, empty }: { query: UseQueryResult<T>; children: (data: T) => ReactNode; skeleton?: ReactNode; isEmpty?: (data: T) => boolean; empty?: ReactNode }) {
  if (query.isPending) return <>{skeleton ?? <Skeleton className="h-32 w-full" />}</>
  if (query.isError) {
    return (
      <Alert variant="destructive">
        <CircleAlert />
        <AlertTitle>Couldn’t load data</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-3">
          {query.error instanceof Error ? query.error.message : 'Unknown error'}
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    )
  }
  if (isEmpty?.(query.data)) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>
  return <>{children(query.data)}</>
}
```

- [ ] **Step 4: Metric chart** — `src/components/metric-chart.tsx`

```tsx
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import type { TimeRange } from '@/api/types'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { formatDateTime, formatTimeTick } from '@/lib/format'

export type MetricLike = { t: number } & Record<string, number | null>
export interface Series {
  key: string
  label: string
  color: string
}

export function MetricChart({
  title, icon: Icon, data, series, format, range, domain, stacked = false, current, height = 160, emptyText = 'No data — node unreachable',
}: {
  title: string
  icon?: LucideIcon
  data: MetricLike[]
  series: Series[]
  format: (v: number) => string
  range: TimeRange
  domain?: [number, number | 'auto']
  stacked?: boolean
  current?: ReactNode
  height?: number
  emptyText?: string
}) {
  const config: ChartConfig = Object.fromEntries(series.map((s) => [s.key, { label: s.label, color: s.color }]))
  const hasData = data.some((p) => series.some((s) => p[s.key] != null))
  return (
    <Card className="gap-3 py-4" data-testid={`chart-${title}`}>
      <CardHeader className="flex flex-row items-center justify-between px-4">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          {Icon && <Icon className="size-4 text-muted-foreground" />}
          {title}
        </CardTitle>
        {current !== undefined && <span className="font-mono text-sm tabular-nums">{current}</span>}
      </CardHeader>
      <CardContent className="px-2">
        {hasData ? (
          <ChartContainer config={config} className="aspect-auto w-full" style={{ height }}>
            <AreaChart data={data} margin={{ left: 4, right: 8, top: 4, bottom: 0 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={(t: number) => formatTimeTick(t, range)} tickLine={false} axisLine={false} minTickGap={40} fontSize={11} />
              <YAxis width={56} tickFormatter={(v: number) => format(v)} tickLine={false} axisLine={false} domain={domain ?? [0, 'auto']} fontSize={11} />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(_, payload) => {
                      const t = payload?.[0]?.payload?.t
                      return typeof t === 'number' ? formatDateTime(t) : ''
                    }}
                    formatter={(value, name) => (
                      <div className="flex w-full items-center justify-between gap-4">
                        <span className="flex items-center gap-1.5 text-muted-foreground">
                          <span className="size-2 rounded-[2px]" style={{ background: `var(--color-${String(name)})` }} />
                          {config[String(name)]?.label ?? String(name)}
                        </span>
                        <span className="font-mono tabular-nums">{format(Number(value))}</span>
                      </div>
                    )}
                  />
                }
              />
              {series.map((s) => (
                <Area
                  key={s.key}
                  dataKey={s.key}
                  type="monotone"
                  stroke={`var(--color-${s.key})`}
                  fill={`var(--color-${s.key})`}
                  fillOpacity={0.12}
                  strokeWidth={1.5}
                  stackId={stacked ? 'stack' : undefined}
                  isAnimationActive={false}
                  connectNulls={false}
                  dot={false}
                />
              ))}
            </AreaChart>
          </ChartContainer>
        ) : (
          <div className="grid place-items-center text-sm text-muted-foreground" style={{ height }} data-testid="chart-empty">
            {emptyText}
          </div>
        )}
        {series.length > 1 && (
          <div className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {series.map((s) => (
              <span key={s.key} className="flex items-center gap-1.5">
                <span className="size-2 rounded-full" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 5: Command menu** — `src/components/command-menu.tsx`

```tsx
import { useNavigate } from '@tanstack/react-router'
import { Boxes, Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'
import { useDeployments, useNodes } from '@/api/hooks'
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { NAV_GROUPS } from '@/lib/nav'
import { NodeStatusDot } from './node-status-dot'

const OPEN_EVENT = 'sparkman:command-menu'

export function openCommandMenu() {
  window.dispatchEvent(new Event(OPEN_EVENT))
}

export function CommandMenu() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const { resolvedTheme, setTheme } = useTheme()
  const { data: nodes } = useNodes()
  const { data: deployments } = useDeployments()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    const onOpen = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(OPEN_EVENT, onOpen)
    }
  }, [])

  const run = (fn: () => void) => {
    setOpen(false)
    fn()
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Command menu" description="Jump to a page, node or deployment">
      <CommandInput placeholder="Search pages, nodes, models…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Pages">
          {NAV_GROUPS.flatMap((g) => g.items).map((item) => (
            <CommandItem key={item.to} value={`page ${item.label}`} onSelect={() => run(() => void navigate({ to: item.to }))}>
              <item.icon />
              {item.label}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Nodes">
          {nodes?.map((n) => (
            <CommandItem key={n.id} value={`node ${n.id} ${n.model}`} onSelect={() => run(() => void navigate({ to: '/nodes/$nodeId', params: { nodeId: n.id } }))}>
              <NodeStatusDot status={n.status} />
              <span className="font-mono">{n.id}</span>
              <span className="ml-auto text-xs text-muted-foreground">{n.model}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Deployments">
          {deployments?.map((d) => (
            <CommandItem key={d.id} value={`deployment ${d.model} ${d.engine}`} onSelect={() => run(() => void navigate({ to: '/deployments' }))}>
              <Boxes />
              <span className="font-mono">{d.model}</span>
              <span className="ml-auto text-xs text-muted-foreground">{d.engine}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Actions">
          <CommandItem value="toggle theme dark light" onSelect={() => run(() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'))}>
            {resolvedTheme === 'dark' ? <Sun /> : <Moon />}
            Toggle theme
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
```

- [ ] **Step 6: Rail and shell**

`src/components/app-rail.tsx`:
```tsx
import { Link, useRouterState } from '@tanstack/react-router'
import { Search } from 'lucide-react'
import { Fragment } from 'react'
import { useIncidents } from '@/api/hooks'
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarSeparator,
} from '@/components/ui/sidebar'
import { NAV_GROUPS } from '@/lib/nav'
import { BrandMark } from './brand-mark'
import { openCommandMenu } from './command-menu'

export function AppRail() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { data: incidents } = useIncidents()
  const ongoing = incidents?.filter((i) => i.status === 'ongoing').length ?? 0

  return (
    <Sidebar collapsible="icon" className="border-r-0">
      <SidebarHeader className="items-center py-4">
        <Link to="/" aria-label="SparkMan home" className="rounded-[10px] shadow-[0_0_24px_-4px_var(--brand)]">
          <BrandMark className="size-9" />
        </Link>
      </SidebarHeader>
      <SidebarContent>
        {NAV_GROUPS.map((group, gi) => (
          <Fragment key={group.label}>
            {gi > 0 && <SidebarSeparator className="mx-auto w-6!" />}
            <SidebarGroup>
              <SidebarMenu className="items-center gap-1.5">
                {group.items.map((item) => {
                  const active = item.to === '/' ? pathname === '/' : pathname.startsWith(item.to)
                  return (
                    <SidebarMenuItem key={item.to} className="relative">
                      <SidebarMenuButton asChild isActive={active} tooltip={item.label} className="justify-center data-[active=true]:text-brand">
                        <Link to={item.to} aria-label={item.label}>
                          <item.icon />
                        </Link>
                      </SidebarMenuButton>
                      {item.to === '/alerts' && ongoing > 0 && (
                        <span className="pointer-events-none absolute -right-1 -top-1 grid size-4 place-items-center rounded-full bg-level-error font-mono text-[10px] font-semibold text-background" data-testid="alert-count">
                          {ongoing}
                        </span>
                      )}
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroup>
          </Fragment>
        ))}
      </SidebarContent>
      <SidebarFooter className="items-center pb-4">
        <SidebarMenu className="items-center">
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Search (⌘K)" onClick={openCommandMenu} className="justify-center" aria-label="Open command menu">
              <Search />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
```

`src/components/app-shell.tsx`:
```tsx
import { Outlet } from '@tanstack/react-router'
import type { CSSProperties } from 'react'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { AppRail } from './app-rail'
import { CommandMenu } from './command-menu'

export function AppShell() {
  return (
    <div className="relative min-h-svh bg-canvas">
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 bg-[radial-gradient(55%_45%_at_0%_0%,color-mix(in_oklch,var(--brand)_16%,transparent),transparent_70%),radial-gradient(45%_40%_at_100%_100%,color-mix(in_oklch,var(--brand)_9%,transparent),transparent_70%)]"
      />
      <SidebarProvider open={false} style={{ '--sidebar-width-icon': '4rem' } as CSSProperties}>
        <AppRail />
        <SidebarInset className="relative my-3 mr-3 min-h-[calc(100svh-1.5rem)] overflow-hidden rounded-2xl border bg-background shadow-2xl shadow-black/40">
          <Outlet />
        </SidebarInset>
        <CommandMenu />
      </SidebarProvider>
    </div>
  )
}
```

- [ ] **Step 7: Root route, placeholder routes, composition root**

`src/routes/__root.tsx`:
```tsx
import { Link, createRootRoute } from '@tanstack/react-router'
import { useClientEvents } from '@/api/hooks'
import { AppShell } from '@/components/app-shell'
import { PageBody, PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/query-state'
import { Button } from '@/components/ui/button'

function RootLayout() {
  useClientEvents()
  return <AppShell />
}

function NotFound() {
  return (
    <>
      <PageHeader crumbs={[{ label: 'SparkMan', to: '/' }, { label: 'Not found' }]} title="Page not found" />
      <PageBody>
        <EmptyState
          title="This page doesn’t exist"
          description="The link may be out of date."
          action={
            <Button asChild variant="outline">
              <Link to="/">Back to overview</Link>
            </Button>
          }
        />
      </PageBody>
    </>
  )
}

export const Route = createRootRoute({ component: RootLayout, notFoundComponent: NotFound })
```

Create one placeholder route per page. Each later task replaces its `component`. Use exactly this shape and substitute `<path>` and `<Title>`:

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '@/components/page-header'

export const Route = createFileRoute('<path>')({
  component: () => <PageHeader crumbs={[{ label: 'SparkMan', to: '/' }, { label: '<Title>' }]} title="<Title>" />,
})
```

| File | `<path>` | `<Title>` |
|---|---|---|
| `src/routes/index.tsx` (overwrite) | `/` | `Overview` |
| `src/routes/nodes.index.tsx` | `/nodes/` | `Nodes` |
| `src/routes/gateway.tsx` | `/gateway` | `Endpoint` |
| `src/routes/deployments.tsx` | `/deployments` | `Deployments` |
| `src/routes/usage.tsx` | `/usage` | `Usage` |
| `src/routes/keys.tsx` | `/keys` | `API Keys` |
| `src/routes/logs.tsx` | `/logs` | `Logs` |
| `src/routes/alerts.tsx` | `/alerts` | `Alerts` |
| `src/routes/updates.tsx` | `/updates` | `Updates` |
| `src/routes/settings.tsx` | `/settings` | `Settings` |

`src/routes/nodes.$nodeId.tsx`:
```tsx
import { createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '@/components/page-header'

export const Route = createFileRoute('/nodes/$nodeId')({
  component: function NodePlaceholder() {
    const { nodeId } = Route.useParams()
    return <PageHeader crumbs={[{ label: 'Nodes', to: '/nodes' }, { label: nodeId }]} title={nodeId} />
  },
})
```

`src/main.tsx` (full replace):
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { ThemeProvider } from 'next-themes'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClientProvider } from '@/api/client'
import { MockClient } from '@/api/mock/mock-client'
import { Simulator } from '@/api/mock/simulator'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { routeTree } from './routeTree.gen'
import './index.css'

const simulator = new Simulator()
simulator.start(2000)
const client = new MockClient(simulator)

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 1000, refetchOnWindowFocus: false, retry: 1 } },
})

const router = createRouter({ routeTree, defaultPreload: 'intent', scrollRestoration: true })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} storageKey="sparkman-theme" disableTransitionOnChange>
      <ClientProvider client={client}>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider delayDuration={200}>
            <RouterProvider router={router} />
            <Toaster position="bottom-right" />
          </TooltipProvider>
        </QueryClientProvider>
      </ClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
```

- [ ] **Step 8: Playwright harness and the failing shell test**

```bash
pnpm exec playwright install chromium
```

`playwright.config.ts`:
```ts
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5199',
    permissions: ['clipboard-read', 'clipboard-write'],
    colorScheme: 'dark',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: 'pnpm dev --port 5199 --strictPort',
    url: 'http://localhost:5199',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
```

`e2e/fixtures.ts`:
```ts
import { test as base, expect } from '@playwright/test'

export const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = []
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text())
      })
      page.on('pageerror', (e) => errors.push(e.message))
      await use(errors)
      expect(errors, 'console errors').toEqual([])
    },
    { auto: true },
  ],
})

export { expect }
```

`e2e/shell.spec.ts`:
```ts
import { expect, test } from './fixtures'

const PAGES: [string, string][] = [
  ['Nodes', 'Nodes'], ['Endpoint', 'Endpoint'], ['Deployments', 'Deployments'], ['Usage', 'Usage'], ['API Keys', 'API Keys'],
  ['Logs', 'Logs'], ['Alerts', 'Alerts'], ['Updates', 'Updates'], ['Settings', 'Settings'], ['Overview', 'Overview'],
]

test('rail navigates to every page', async ({ page }) => {
  await page.goto('/')
  for (const [link, heading] of PAGES) {
    await page.getByRole('link', { name: link, exact: true }).click()
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
  }
})

test('command menu jumps to a node', async ({ page }) => {
  await page.goto('/')
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByPlaceholder('Search pages, nodes, models…').fill('spark-04')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/nodes\/spark-04$/)
})

test('unknown route renders not found', async ({ page }) => {
  await page.goto('/definitely-not-a-page')
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible()
  await page.getByRole('link', { name: 'Back to overview' }).click()
  await expect(page).toHaveURL(/\/$/)
})

test('dark theme is the default', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('html')).toHaveClass(/dark/)
})
```

- [ ] **Step 9: Run e2e and unit tests**

Run: `pnpm build && pnpm test && pnpm e2e e2e/shell.spec.ts`
Expected: build succeeds; unit tests pass; 4 Playwright tests pass. If `Link to="/nodes"` fails to typecheck, run `pnpm exec tsr generate` first (the build script already does this).

- [ ] **Step 10: Commit**

```bash
git add -A ':!screenshots'
git commit -m "feat: app shell with icon rail, command menu and shared components

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 10: Overview page

**Files:**
- Create: `src/features/overview/overview-page.tsx`, `e2e/overview.spec.ts`
- Modify: `src/routes/index.tsx`

**Interfaces:**
- Consumes: `useFleetSummary`, `useNodes`, `useDeployments`, `useIncidents`, `useActivity` from `@/api/hooks`; `PageHeader`, `PageBody`, `StatTile`, `QueryState`, `EmptyState`, `NodeStatusDot`, `UsageBar`, `LiveBadge`; formatters.
- Produces: `OverviewPage` component; e2e test ids `tile-online`, `node-card`.

- [ ] **Step 1: Write the failing e2e test** — `e2e/overview.spec.ts`

```ts
import { expect, test } from './fixtures'

test('overview shows fleet tiles, 12 node cards and the active incident', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('tile-online')).toContainText('12 / 12')
  await expect(page.getByTestId('node-card')).toHaveCount(12)
  await expect(page.getByText('spark-05 thermal throttling', { exact: true })).toBeVisible()
  await expect(page.getByTestId('activity-item').first()).toBeVisible()
  await page.getByTestId('node-card').filter({ hasText: 'spark-03' }).click()
  await expect(page).toHaveURL(/\/nodes\/spark-03$/)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm e2e e2e/overview.spec.ts`
Expected: FAIL — `tile-online` not found.

- [ ] **Step 3: Write `src/features/overview/overview-page.tsx`**

```tsx
import { Link } from '@tanstack/react-router'
import { Activity, ArrowRight, Boxes, CircleSlash, Gauge, KeyRound, MemoryStick, PackageCheck, RotateCw, Server, Stethoscope, TriangleAlert, Zap, type LucideIcon } from 'lucide-react'
import { useActivity, useDeployments, useFleetSummary, useIncidents, useNodes } from '@/api/hooks'
import type { ActivityKind, Deployment, FleetNode } from '@/api/types'
import { LiveBadge } from '@/components/live-badge'
import { NodeStatusDot } from '@/components/node-status-dot'
import { PageBody, PageHeader } from '@/components/page-header'
import { EmptyState, QueryState } from '@/components/query-state'
import { StatTile } from '@/components/stat-tile'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { UsageBar } from '@/components/usage-bar'
import { formatCompact, formatGB, formatPercent, formatRelative, formatTemp, formatWatts } from '@/lib/format'

const ACTIVITY_ICON: Record<ActivityKind, LucideIcon> = {
  reboot: RotateCw, deploy: Boxes, update: PackageCheck, alert: TriangleAlert, key: KeyRound, drain: CircleSlash, diag: Stethoscope, system: Activity,
}

function NodeCard({ node, deployment }: { node: FleetNode; deployment?: Deployment }) {
  return (
    <Link
      to="/nodes/$nodeId"
      params={{ nodeId: node.id }}
      data-testid="node-card"
      className="rounded-xl border bg-card p-4 transition-colors hover:border-brand/40 focus-visible:outline-2 focus-visible:outline-ring"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-mono text-sm font-medium">
          <NodeStatusDot status={node.status} />
          {node.id}
        </span>
        <span className="text-[11px] text-muted-foreground">{node.model === 'ASUS GX10' ? 'GX10' : 'Spark'}</span>
      </div>
      <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
        {deployment ? `${deployment.model} · ${deployment.engine}` : node.live ? 'idle' : 'unreachable'}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <UsageBar label="GPU" value={node.live?.gpuUtil ?? null} />
        <UsageBar label="Mem" value={node.live ? (node.live.memUsedGB / node.memoryGB) * 100 : null} />
        <UsageBar label="Temp" value={node.live?.gpuTempC ?? null} display={formatTemp(node.live?.gpuTempC ?? null)} />
      </div>
    </Link>
  )
}

export function OverviewPage() {
  const summary = useFleetSummary()
  const nodes = useNodes()
  const deployments = useDeployments()
  const incidents = useIncidents()
  const activity = useActivity(8)
  const now = Date.now()
  const ongoing = incidents.data?.filter((i) => i.status === 'ongoing') ?? []

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'SparkMan', to: '/' }, { label: 'Overview' }]}
        title="Overview"
        description="NVIDIA DGX Spark-class fleet · GB10 Grace Blackwell · 128 GB unified memory per node"
        actions={<LiveBadge live />}
      />
      <PageBody>
        <QueryState
          query={summary}
          skeleton={
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-28" />
              ))}
            </div>
          }
        >
          {(s) => (
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
              <StatTile
                testId="tile-online"
                label="Nodes online"
                value={`${s.online} / ${s.total}`}
                icon={Server}
                tone={s.online < s.total ? 'warn' : 'brand'}
                hint={s.activeIncidents ? `${s.activeIncidents} active incident${s.activeIncidents > 1 ? 's' : ''}` : 'All healthy'}
              />
              <StatTile label="GPU utilization" value={formatPercent(s.gpuUtilAvg)} icon={Gauge} hint="fleet average" />
              <StatTile label="Unified memory" value={formatGB(s.memUsedGB)} icon={MemoryStick} hint={`of ${formatGB(s.memTotalGB)}`} />
              <StatTile label="GPU power" value={formatWatts(s.powerW)} icon={Zap} hint="GPU-only draw" />
              <StatTile label="Gateway" value={`${formatCompact(s.tokensPerSec)} tok/s`} icon={Activity} hint="all deployments" />
            </div>
          )}
        </QueryState>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <section aria-labelledby="fleet-heading">
            <div className="mb-3 flex items-center justify-between">
              <h2 id="fleet-heading" className="text-sm font-medium text-muted-foreground">
                Fleet health
              </h2>
              <Button variant="ghost" size="sm" asChild>
                <Link to="/nodes">
                  All nodes <ArrowRight />
                </Link>
              </Button>
            </div>
            <QueryState query={nodes} skeleton={<Skeleton className="h-80 w-full" />}>
              {(list) => (
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-4">
                  {list.map((n) => (
                    <NodeCard key={n.id} node={n} deployment={deployments.data?.find((d) => d.id === n.deploymentId)} />
                  ))}
                </div>
              )}
            </QueryState>
          </section>

          <div className="flex flex-col gap-6">
            <Card className="gap-3">
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-sm font-medium">Active alerts</CardTitle>
                <Button variant="ghost" size="sm" asChild>
                  <Link to="/alerts">View</Link>
                </Button>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {ongoing.length === 0 ? (
                  <EmptyState title="No active incidents" />
                ) : (
                  ongoing.map((i) => (
                    <Link key={i.id} to="/alerts" className="rounded-lg border border-level-warn/30 bg-level-warn/10 px-3 py-2 hover:border-level-warn/60">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">{i.title}</span>
                        <Badge variant="outline" className={i.severity === 'critical' ? 'text-level-error' : 'text-level-warn'}>
                          {i.severity}
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground">Started {formatRelative(i.startedAt, now)}</div>
                    </Link>
                  ))
                )}
              </CardContent>
            </Card>

            <Card className="gap-3">
              <CardHeader>
                <CardTitle className="text-sm font-medium">Recent activity</CardTitle>
              </CardHeader>
              <CardContent>
                <QueryState query={activity} skeleton={<Skeleton className="h-48 w-full" />}>
                  {(events) => (
                    <ol className="flex flex-col gap-3">
                      {events.map((e) => {
                        const Icon = ACTIVITY_ICON[e.kind]
                        return (
                          <li key={e.id} className="flex gap-3" data-testid="activity-item">
                            <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md border bg-surface-2">
                              <Icon className="size-3.5 text-muted-foreground" />
                            </span>
                            <div className="min-w-0">
                              <p className="text-sm leading-snug">{e.text}</p>
                              <p className="text-xs text-muted-foreground">{formatRelative(e.ts, now)}</p>
                            </div>
                          </li>
                        )
                      })}
                    </ol>
                  )}
                </QueryState>
              </CardContent>
            </Card>
          </div>
        </div>
      </PageBody>
    </>
  )
}
```

- [ ] **Step 4: Wire the route** — replace `src/routes/index.tsx`

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { OverviewPage } from '@/features/overview/overview-page'

export const Route = createFileRoute('/')({ component: OverviewPage })
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm e2e e2e/overview.spec.ts e2e/shell.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/features/overview src/routes/index.tsx e2e/overview.spec.ts
git commit -m "feat: fleet overview with KPI tiles, node grid, alerts and activity

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Nodes list

**Files:**
- Create: `src/features/nodes/nodes-page.tsx`, `e2e/nodes.spec.ts`
- Modify: `src/routes/nodes.index.tsx`

**Interfaces:**
- Consumes: `useNodes`, `useDeployments`, `useIncidents`; `UsageBar`, `NodeStatusDot`, `STATUS_LABEL`, `EmptyState`, `QueryState`, `LiveBadge`.
- Produces: `type StatusFilter = 'all' | 'online' | 'degraded' | 'offline'`, `NodesPage({ status, onStatusChange })`; URL search param `?status=`; test ids `node-row`, `filter-<status>`, `incident-banner`.

- [ ] **Step 1: Write the failing e2e test** — `e2e/nodes.spec.ts`

```ts
import { expect, test } from './fixtures'

test('filters by status via the URL and opens a node', async ({ page }) => {
  await page.goto('/nodes')
  await expect(page.getByTestId('node-row')).toHaveCount(12)
  await page.getByTestId('filter-degraded').click()
  await expect(page).toHaveURL(/status=degraded/)
  await expect(page.getByTestId('node-row')).toHaveCount(1)
  await expect(page.getByTestId('node-row')).toContainText('spark-05')
  await page.getByTestId('filter-offline').click()
  await expect(page.getByTestId('empty-state')).toContainText('No offline nodes')
  await page.getByTestId('filter-all').click()
  await page.getByTestId('node-row').filter({ hasText: 'spark-03' }).click()
  await expect(page).toHaveURL(/\/nodes\/spark-03$/)
})

test('ongoing incident banner links to alerts', async ({ page }) => {
  await page.goto('/nodes')
  await page.getByTestId('incident-banner').filter({ hasText: 'spark-05 thermal throttling' }).click()
  await expect(page).toHaveURL(/\/alerts$/)
})

test('garbage status param falls back to all', async ({ page }) => {
  await page.goto('/nodes?status=banana')
  await expect(page.getByTestId('node-row')).toHaveCount(12)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm e2e e2e/nodes.spec.ts`
Expected: FAIL — no `node-row`.

- [ ] **Step 3: Write `src/features/nodes/nodes-page.tsx`**

```tsx
import { Link } from '@tanstack/react-router'
import { useDeployments, useIncidents, useNodes } from '@/api/hooks'
import type { FleetNode, NodeStatus } from '@/api/types'
import { LiveBadge } from '@/components/live-badge'
import { NodeStatusDot, STATUS_LABEL } from '@/components/node-status-dot'
import { PageBody, PageHeader } from '@/components/page-header'
import { EmptyState, QueryState } from '@/components/query-state'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { UsageBar } from '@/components/usage-bar'
import { formatRelative, formatTemp } from '@/lib/format'

export type StatusFilter = 'all' | 'online' | 'degraded' | 'offline'
export const STATUS_FILTERS: StatusFilter[] = ['all', 'online', 'degraded', 'offline']

const MATCH: Record<StatusFilter, (s: NodeStatus) => boolean> = {
  all: () => true,
  online: (s) => s === 'online',
  degraded: (s) => s === 'degraded',
  offline: (s) => s === 'offline' || s === 'rebooting',
}

function NodeRow({ node, model, now }: { node: FleetNode; model?: string; now: number }) {
  return (
    <li>
      <Link
        to="/nodes/$nodeId"
        params={{ nodeId: node.id }}
        data-testid="node-row"
        className="grid grid-cols-[auto_minmax(0,1fr)_repeat(4,4.75rem)_7rem] items-center gap-4 px-4 py-3 transition-colors hover:bg-muted/40 focus-visible:bg-muted/60 focus-visible:outline-none"
      >
        <NodeStatusDot status={node.status} />
        <div className="min-w-0">
          <div className="font-mono font-medium">{node.id}</div>
          <div className="truncate text-xs text-muted-foreground">
            {node.model} · DGX OS {node.os.dgxOs}
            {model ? ` · ${model}` : ''}
            {node.drained ? ' · drained' : ''}
          </div>
        </div>
        <UsageBar label="GPU" value={node.live?.gpuUtil ?? null} />
        <UsageBar label="Mem" value={node.live ? (node.live.memUsedGB / node.memoryGB) * 100 : null} />
        <UsageBar label="Disk" value={node.live?.diskUsedPct ?? null} />
        <UsageBar label="Temp" value={node.live?.gpuTempC ?? null} display={formatTemp(node.live?.gpuTempC ?? null)} />
        <div className="text-right text-xs">
          <div className="font-mono tabular-nums">{node.live ? formatRelative(node.lastSeen, now) : STATUS_LABEL[node.status]}</div>
          <div className="text-muted-foreground">{node.live ? '2 s scrape' : `since ${formatRelative(node.lastSeen, now)}`}</div>
        </div>
      </Link>
    </li>
  )
}

export function NodesPage({ status, onStatusChange }: { status: StatusFilter; onStatusChange: (s: StatusFilter) => void }) {
  const nodes = useNodes()
  const deployments = useDeployments()
  const incidents = useIncidents()
  const now = Date.now()

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'SparkMan', to: '/' }, { label: 'Nodes' }]}
        title="Nodes"
        description="DGX Spark Founders Edition and ASUS Ascent GX10 · telemetry every 2 s"
        actions={<LiveBadge live />}
      />
      <PageBody>
        <QueryState query={nodes} skeleton={<Skeleton className="h-[640px] w-full" />}>
          {(list) => {
            const counts = Object.fromEntries(STATUS_FILTERS.map((f) => [f, list.filter((n) => MATCH[f](n.status)).length])) as Record<StatusFilter, number>
            const visible = list.filter((n) => MATCH[status](n.status))
            const ongoing = incidents.data?.filter((i) => i.status === 'ongoing' && i.nodeId) ?? []
            return (
              <Card className="gap-0 py-0">
                <div className="flex flex-wrap items-center gap-2 border-b p-4">
                  {STATUS_FILTERS.map((f) => (
                    <Button
                      key={f}
                      size="sm"
                      variant={status === f ? 'secondary' : 'ghost'}
                      aria-pressed={status === f}
                      onClick={() => onStatusChange(f)}
                      className="rounded-full capitalize"
                      data-testid={`filter-${f}`}
                    >
                      {f} · {counts[f]}
                    </Button>
                  ))}
                  <span className="ml-auto font-mono text-xs text-muted-foreground">
                    {counts.online + counts.degraded} / {counts.all} reporting
                  </span>
                </div>
                {ongoing.map((i) => (
                  <Link key={i.id} to="/alerts" data-testid="incident-banner" className="mx-4 mt-4 block rounded-lg border border-level-warn/40 bg-level-warn/10 px-4 py-3 text-sm hover:border-level-warn/70">
                    <span className="font-medium text-level-warn">Ongoing · {i.title}</span>
                    <span className="block text-muted-foreground">Started {formatRelative(i.startedAt, now)} · view alert</span>
                  </Link>
                ))}
                {visible.length === 0 ? (
                  <div className="p-4">
                    <EmptyState title={`No ${status} nodes`} description="Every node is reporting in another state." />
                  </div>
                ) : (
                  <ul className="mt-2 divide-y">
                    {visible.map((n) => (
                      <NodeRow key={n.id} node={n} now={now} model={deployments.data?.find((d) => d.id === n.deploymentId)?.model} />
                    ))}
                  </ul>
                )}
              </Card>
            )
          }}
        </QueryState>
      </PageBody>
    </>
  )
}
```

- [ ] **Step 4: Wire the route** — replace `src/routes/nodes.index.tsx`

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { NodesPage, STATUS_FILTERS, type StatusFilter } from '@/features/nodes/nodes-page'

export const Route = createFileRoute('/nodes/')({
  validateSearch: (s: Record<string, unknown>): { status?: StatusFilter } => ({
    status: STATUS_FILTERS.includes(s.status as StatusFilter) && s.status !== 'all' ? (s.status as StatusFilter) : undefined,
  }),
  component: NodesRoute,
})

function NodesRoute() {
  const { status = 'all' } = Route.useSearch()
  const navigate = Route.useNavigate()
  return <NodesPage status={status} onStatusChange={(s) => void navigate({ search: { status: s === 'all' ? undefined : s } })} />
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm e2e e2e/nodes.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/features/nodes/nodes-page.tsx src/routes/nodes.index.tsx e2e/nodes.spec.ts
git commit -m "feat: nodes list with status filters and incident banner

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Log explorer

**Files:**
- Create: `src/features/logs/log-explorer.tsx`, `src/features/logs/log-query-input.tsx`, `src/features/logs/log-histogram.tsx`, `src/features/logs/log-table.tsx`, `src/features/logs/log-patterns.tsx`, `src/features/logs/log-detail-sheet.tsx`, `src/features/logs/logs-page.tsx`, `src/features/logs/format-for-ai.test.ts`, `e2e/logs.spec.ts`
- Modify: `src/routes/logs.tsx`

**Interfaces:**
- Consumes: `useLogs(input, live)`; `highlightLogQuery` from `@/lib/log-query`; `TimeRangeToggle`, `LiveBadge`, `QueryState`, `EmptyState`, `CopyButton`; shadcn `Sheet`, `ToggleGroup`, `Badge`, `Button`, `Card`, `ChartContainer`.
- Produces:
  - `interface LogExplorerState { query: string; range: TimeRange; live: boolean; view: 'list' | 'visualize'; around?: number }`
  - `LogExplorer({ state, onChange: (patch: Partial<LogExplorerState>) => void, lockedQuery?: string, compact?: boolean })`, reused by node detail (Task 13)
  - `LevelBadge({ level })`, `formatForAi(line: LogLine): string`
  - URL search on `/logs`: `q`, `range`, `live` (`false` disables), `view`
  - Test ids `log-histogram`, `log-row`, `level-badge`, `log-detail`, `log-detail-time`, `log-detail-position`, `pattern-row`, `around-badge`

- [ ] **Step 1: Write the failing unit test for `formatForAi`** — `src/features/logs/format-for-ai.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { formatForAi } from './log-detail-sheet'

describe('formatForAi', () => {
  it('produces a self-contained markdown block', () => {
    const md = formatForAi({
      id: '1', ts: Date.UTC(2026, 9, 8, 14, 16, 31, 640), level: 'error', source: 'kernel', host: 'spark-05', service: 'kernel',
      message: 'NVRM: Xid 31', pattern: 'abcdef0123456789', attributes: { pid: '4242' },
    })
    expect(md).toContain('host: spark-05')
    expect(md).toContain('time: 2026-10-08T14:16:31.640Z')
    expect(md).toContain('```\nNVRM: Xid 31\n```')
    expect(md).toContain('"pid": "4242"')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/features/logs/format-for-ai.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/features/logs/log-table.tsx`** (also exports `LevelBadge`)

```tsx
import { useEffect, useRef } from 'react'
import type { LogLevel, LogLine } from '@/api/types'
import { formatClock } from '@/lib/format'
import { cn } from '@/lib/utils'

const LEVEL_CLASS: Record<LogLevel, string> = {
  error: 'bg-level-error/15 text-level-error',
  warn: 'bg-level-warn/15 text-level-warn',
  info: 'bg-level-info/15 text-level-info',
  debug: 'bg-muted text-muted-foreground',
}

export function LevelBadge({ level }: { level: LogLevel }) {
  return (
    <span className={cn('inline-flex w-14 justify-center rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold uppercase', LEVEL_CLASS[level])} data-testid="level-badge">
      {level}
    </span>
  )
}

export function LogTable({ lines, selectedId, onSelect }: { lines: LogLine[]; selectedId: string | null; onSelect: (l: LogLine) => void }) {
  const seen = useRef(new Set<string>())
  const primed = seen.current.size > 0
  useEffect(() => {
    for (const l of lines) seen.current.add(l.id)
  }, [lines])

  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full table-fixed text-sm">
        <colgroup>
          <col className="w-32" />
          <col className="w-20" />
          <col className="w-24" />
          <col className="w-32" />
          <col />
        </colgroup>
        <thead className="text-left text-xs text-muted-foreground">
          <tr className="border-b">
            <th className="px-3 py-2 font-medium">Time</th>
            <th className="px-3 py-2 font-medium">Level</th>
            <th className="px-3 py-2 font-medium">Service</th>
            <th className="px-3 py-2 font-medium">Host</th>
            <th className="px-3 py-2 font-medium">Message</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {lines.map((l) => {
            const [hms, ms] = formatClock(l.ts).split('.')
            const selected = l.id === selectedId
            return (
              <tr
                key={l.id}
                data-testid="log-row"
                aria-selected={selected}
                tabIndex={0}
                onClick={() => onSelect(l)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onSelect(l)
                }}
                className={cn(
                  'cursor-pointer border-b border-border/50 last:border-0 hover:bg-muted/40 focus-visible:bg-muted/60 focus-visible:outline-none',
                  primed && !seen.current.has(l.id) && 'animate-row-in',
                  selected && 'bg-brand/10 shadow-[inset_3px_0_0_var(--brand)]',
                )}
              >
                <td className="px-3 py-1.5 tabular-nums">
                  {hms}
                  <span className="text-muted-foreground">.{ms}</span>
                </td>
                <td className="px-3 py-1.5">
                  <LevelBadge level={l.level} />
                </td>
                <td className="truncate px-3 py-1.5">{l.service}</td>
                <td className="truncate px-3 py-1.5 text-muted-foreground">{l.host}</td>
                <td className="truncate px-3 py-1.5" title={l.message}>
                  {l.message}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 4: Write `src/features/logs/log-detail-sheet.tsx`**

```tsx
import { ChevronDown, ChevronUp, Funnel, Rows3 } from 'lucide-react'
import type { ReactNode } from 'react'
import type { LogLine } from '@/api/types'
import { CopyButton } from '@/components/copy-button'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { formatClock, formatCompact, formatDateTime, formatDuration } from '@/lib/format'
import { cn } from '@/lib/utils'
import { LevelBadge } from './log-table'

const STATUS_TEXT: Record<string, string> = { '200': 'OK', '502': 'Bad Gateway', '504': 'Gateway Timeout' }

function annotate(key: string, value: string): { text: string; bad: boolean } | null {
  if (key === 'duration_ms') return { text: formatDuration(Number(value)), bad: Number(value) > 5000 }
  if (key === 'http.status_code') return STATUS_TEXT[value] ? { text: STATUS_TEXT[value], bad: Number(value) >= 500 } : null
  if (key.startsWith('tokens_')) return { text: `${formatCompact(Number(value))} tokens`, bad: false }
  return null
}

export function formatForAi(line: LogLine): string {
  return [
    'Log line from the SparkMan fleet (NVIDIA DGX Spark / GB10):',
    '',
    `- time: ${new Date(line.ts).toISOString()}`,
    `- level: ${line.level}`,
    `- host: ${line.host}`,
    `- service: ${line.service}`,
    `- source: ${line.source}`,
    `- pattern: ${line.pattern}`,
    '',
    'Message:',
    '```',
    line.message,
    '```',
    '',
    'Attributes:',
    '```json',
    JSON.stringify(line.attributes, null, 2),
    '```',
  ].join('\n')
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
        {count !== undefined && <span className="rounded bg-muted px-1.5 font-mono text-[11px]">{count}</span>}
      </h3>
      {children}
    </section>
  )
}

function KvTable({ rows }: { rows: { k: string; v: string; note?: { text: string; bad: boolean } | null }[] }) {
  return (
    <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] overflow-hidden rounded-lg border font-mono text-sm">
      {rows.map((r) => (
        <div key={r.k} className="contents">
          <dt className="border-b bg-surface-2/60 px-3 py-1.5 text-muted-foreground last-of-type:border-0">{r.k}</dt>
          <dd className="break-all border-b px-3 py-1.5">
            {r.v}
            {r.note && <span className={cn('ml-2', r.note.bad ? 'text-level-error' : 'text-muted-foreground')}>// {r.note.text}</span>}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function LogDetailSheet({
  line, index, total, onClose, onStep, onLinesAround, onSamePattern,
}: {
  line: LogLine | null
  index: number
  total: number
  onClose: () => void
  onStep: (dir: 1 | -1) => void
  onLinesAround: (l: LogLine) => void
  onSamePattern: (l: LogLine) => void
}) {
  const attrs = line ? Object.entries(line.attributes) : []
  return (
    <Sheet open={line !== null} onOpenChange={(o) => !o && onClose()} modal={false}>
      <SheetContent className="w-[520px] gap-0 overflow-y-auto sm:max-w-[520px]" onInteractOutside={(e) => e.preventDefault()} data-testid="log-detail">
        {line && (
          <>
            <SheetHeader className="gap-3 border-b">
              <div className="flex items-center gap-2 pr-8">
                <LevelBadge level={line.level} />
                <SheetTitle className="font-mono text-base tabular-nums" data-testid="log-detail-time">
                  {formatClock(line.ts)}
                </SheetTitle>
                <span className="truncate font-mono text-sm text-muted-foreground">{line.service}</span>
                <div className="ml-auto flex items-center gap-1">
                  <Button size="icon" variant="ghost" aria-label="Newer line" disabled={index <= 0} onClick={() => onStep(-1)}>
                    <ChevronUp />
                  </Button>
                  <Button size="icon" variant="ghost" aria-label="Older line" disabled={index === -1 || index >= total - 1} onClick={() => onStep(1)}>
                    <ChevronDown />
                  </Button>
                  <span className="font-mono text-xs tabular-nums text-muted-foreground" data-testid="log-detail-position">
                    {index === -1 ? '–' : index + 1} / {total}
                  </span>
                </div>
              </div>
              <SheetDescription className="sr-only">Details for the selected log line</SheetDescription>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => onLinesAround(line)}>
                  <Rows3 />
                  Lines around
                </Button>
                <CopyButton value={formatForAi(line)} label="Copy for AI" toastText="Log line copied for AI" />
                <Button size="sm" variant="outline" onClick={() => onSamePattern(line)}>
                  <Funnel />
                  Same pattern
                </Button>
              </div>
            </SheetHeader>
            <div className="flex flex-col gap-5 p-4">
              <Section title="Message">
                <pre className="whitespace-pre-wrap break-words rounded-lg border bg-surface-2 p-3 font-mono text-sm">{line.message}</pre>
              </Section>
              <Section title="Fields">
                <KvTable
                  rows={[
                    { k: 'time', v: `${formatDateTime(line.ts)}.${formatClock(line.ts).split('.')[1]}` },
                    { k: 'service', v: line.service },
                    { k: 'host', v: line.host },
                    { k: 'source', v: line.source },
                    { k: 'severity', v: line.level, note: line.level === 'error' ? { text: 'ERROR', bad: true } : null },
                    { k: 'pattern', v: line.pattern },
                  ]}
                />
              </Section>
              <Section title="Attributes" count={attrs.length}>
                {attrs.length ? <KvTable rows={attrs.map(([k, v]) => ({ k, v: `"${v}"`, note: annotate(k, v) }))} /> : <p className="text-sm text-muted-foreground">No attributes</p>}
              </Section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
```

- [ ] **Step 5: Run the unit test to verify it passes**

Run: `pnpm vitest run src/features/logs/format-for-ai.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the query input, histogram and patterns view**

`src/features/logs/log-query-input.tsx`:
```tsx
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
```

`src/features/logs/log-histogram.tsx`:
```tsx
import { Bar, BarChart, ReferenceArea, XAxis, YAxis } from 'recharts'
import type { LogQueryResult, TimeRange } from '@/api/types'
import { Card } from '@/components/ui/card'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { formatDateTime, formatNumber, formatTimeTick } from '@/lib/format'

const LEVELS = [
  { key: 'error', label: 'Error', color: 'var(--level-error)' },
  { key: 'warn', label: 'Warn', color: 'var(--level-warn)' },
  { key: 'info', label: 'Info', color: 'var(--level-info)' },
  { key: 'debug', label: 'Debug', color: 'var(--level-debug)' },
] as const

const RANGE_LABEL: Record<TimeRange, string> = { '15m': 'Last 15 minutes', '1h': 'Last hour', '6h': 'Last 6 hours', '24h': 'Last 24 hours', '7d': 'Last 7 days' }
const config: ChartConfig = Object.fromEntries(LEVELS.map((l) => [l.key, { label: l.label, color: l.color }]))

export function LogHistogram({ result, range, around, compact = false }: { result: LogQueryResult; range: TimeRange; around?: number; compact?: boolean }) {
  const width = result.histogram.length > 1 ? result.histogram[1].t - result.histogram[0].t : 1
  return (
    <Card className="gap-2 py-4" data-testid="log-histogram">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 text-sm">
        <span>
          <span className="font-mono font-semibold tabular-nums">{formatNumber(result.total)}</span>{' '}
          <span className="text-muted-foreground">lines · {around !== undefined ? `±60 s around ${formatDateTime(around)}` : RANGE_LABEL[range]} · newest first</span>
        </span>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {LEVELS.map((l) => (
            <span key={l.key} className="flex items-center gap-1.5">
              <span className="size-2 rounded-[2px]" style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
          {result.bands.length > 0 && (
            <span className="flex items-center gap-1.5 text-level-error">
              <span className="size-2 rounded-full border border-level-error" />
              Incidents {result.bands.length}
            </span>
          )}
        </div>
      </div>
      <ChartContainer config={config} className="aspect-auto w-full px-2" style={{ height: compact ? 96 : 140 }}>
        <BarChart data={result.histogram} margin={{ top: 18, right: 8, left: 8, bottom: 0 }} barCategoryGap={1}>
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={[result.from, result.to]}
            tickFormatter={(t: number) => formatTimeTick(t, range === '7d' ? '7d' : '1h')}
            tickLine={false}
            axisLine={false}
            minTickGap={48}
            fontSize={11}
          />
          <YAxis hide />
          {result.bands.map((b) => (
            <ReferenceArea
              key={`${b.label}-${b.from}`}
              x1={b.from}
              x2={Math.max(b.to, b.from + width)}
              fill="var(--level-error)"
              fillOpacity={0.12}
              stroke="var(--level-error)"
              strokeOpacity={0.35}
              ifOverflow="hidden"
              label={{ value: `● Incident · ${b.label}`, position: 'insideTopLeft', fill: 'var(--level-error)', fontSize: 11 }}
            />
          ))}
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(_, payload) => {
                  const t = payload?.[0]?.payload?.t
                  return typeof t === 'number' ? formatDateTime(t) : ''
                }}
              />
            }
          />
          {(['debug', 'info', 'warn', 'error'] as const).map((k) => (
            <Bar key={k} dataKey={k} stackId="lvl" fill={`var(--color-${k})`} isAnimationActive={false} />
          ))}
        </BarChart>
      </ChartContainer>
    </Card>
  )
}
```

`src/features/logs/log-patterns.tsx`:
```tsx
import { useMemo } from 'react'
import type { LogLevel, LogLine } from '@/api/types'
import { Card } from '@/components/ui/card'
import { LevelBadge } from './log-table'

const template = (message: string) => message.replace(/\d+(\.\d+)?/g, '<n>')

export function LogPatterns({ lines, onPick }: { lines: LogLine[]; onPick: (pattern: string) => void }) {
  const groups = useMemo(() => {
    const map = new Map<string, { pattern: string; level: LogLevel; sample: string; count: number }>()
    for (const l of lines) {
      const g = map.get(l.pattern)
      if (g) g.count++
      else map.set(l.pattern, { pattern: l.pattern, level: l.level, sample: l.message, count: 1 })
    }
    return [...map.values()].sort((a, b) => b.count - a.count)
  }, [lines])

  return (
    <Card className="gap-0 py-0">
      <div className="flex justify-between border-b px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <span>Grouped by pattern</span>
        <span className="font-mono">{lines.length} lines</span>
      </div>
      <ul className="divide-y">
        {groups.map((g) => (
          <li key={g.pattern}>
            <button type="button" data-testid="pattern-row" onClick={() => onPick(g.pattern)} className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-muted/40">
              <LevelBadge level={g.level} />
              <span className="min-w-0 flex-1 truncate font-mono text-sm">{template(g.sample)}</span>
              <span className="font-mono text-sm tabular-nums text-muted-foreground">{g.count}</span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  )
}
```

- [ ] **Step 7: Write the explorer and page**

`src/features/logs/log-explorer.tsx`:
```tsx
import { useState } from 'react'
import { useLogs } from '@/api/hooks'
import type { LogLine, LogQueryInput as QueryInput, TimeRange } from '@/api/types'
import { LiveBadge } from '@/components/live-badge'
import { EmptyState, QueryState } from '@/components/query-state'
import { TimeRangeToggle } from '@/components/time-range-toggle'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { formatDateTime } from '@/lib/format'
import { LogDetailSheet } from './log-detail-sheet'
import { LogHistogram } from './log-histogram'
import { LogPatterns } from './log-patterns'
import { LogQueryInput } from './log-query-input'
import { LogTable } from './log-table'

export interface LogExplorerState {
  query: string
  range: TimeRange
  live: boolean
  view: 'list' | 'visualize'
  around?: number
}

export const LOG_RANGES: TimeRange[] = ['15m', '1h', '24h', '7d']

export function LogExplorer({ state, onChange, lockedQuery, compact = false }: { state: LogExplorerState; onChange: (patch: Partial<LogExplorerState>) => void; lockedQuery?: string; compact?: boolean }) {
  const input: QueryInput = { query: [lockedQuery, state.query].filter(Boolean).join(' '), range: state.range, around: state.around, limit: 200 }
  const logs = useLogs(input, state.live && state.around === undefined)
  const [selected, setSelected] = useState<LogLine | null>(null)
  const lines = logs.data?.lines ?? []
  const index = selected ? lines.findIndex((l) => l.id === selected.id) : -1

  const step = (dir: 1 | -1) => {
    const next = index === -1 ? undefined : lines[index + dir]
    if (next) setSelected(next)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <LogQueryInput value={state.query} prefix={lockedQuery} onSubmit={(query) => onChange({ query, around: undefined })} />
        <TimeRangeToggle value={state.range} ranges={LOG_RANGES} onChange={(range) => onChange({ range, around: undefined })} />
        <ToggleGroup type="single" variant="outline" size="sm" value={state.view} onValueChange={(v) => v && onChange({ view: v as LogExplorerState['view'] })} aria-label="View">
          <ToggleGroupItem value="list" className="px-3">List</ToggleGroupItem>
          <ToggleGroupItem value="visualize" className="px-3">Visualize</ToggleGroupItem>
        </ToggleGroup>
        <LiveBadge live={state.live && state.around === undefined} onToggle={() => onChange({ live: !state.live })} />
      </div>
      {state.around !== undefined && (
        <div className="flex items-center gap-2 text-sm">
          <Badge variant="secondary" data-testid="around-badge">
            Lines around {formatDateTime(state.around)}
          </Badge>
          <Button size="sm" variant="ghost" onClick={() => onChange({ around: undefined })}>
            Clear
          </Button>
        </div>
      )}
      <QueryState query={logs} skeleton={<Skeleton className="h-72 w-full" />}>
        {(result) => (
          <>
            <LogHistogram result={result} range={state.range} around={state.around} compact={compact} />
            {result.lines.length === 0 ? (
              <EmptyState title="No log lines match" description="Widen the time range or remove a filter." />
            ) : state.view === 'list' ? (
              <LogTable lines={result.lines} selectedId={selected?.id ?? null} onSelect={setSelected} />
            ) : (
              <LogPatterns lines={result.lines} onPick={(pattern) => onChange({ query: `pattern:${pattern}`, view: 'list' })} />
            )}
            {result.truncated && <p className="text-xs text-muted-foreground">Search stopped after scanning the most recent ~28 hours of lines; narrow the range to go further back.</p>}
          </>
        )}
      </QueryState>
      <LogDetailSheet
        line={selected}
        index={index}
        total={lines.length}
        onClose={() => setSelected(null)}
        onStep={step}
        onLinesAround={(l) => {
          setSelected(null)
          onChange({ around: l.ts, query: `host:${l.host}` })
        }}
        onSamePattern={(l) => {
          setSelected(null)
          onChange({ query: `pattern:${l.pattern}`, around: undefined })
        }}
      />
    </div>
  )
}
```

`src/features/logs/logs-page.tsx`:
```tsx
import { PageBody, PageHeader } from '@/components/page-header'
import { LogExplorer, type LogExplorerState } from './log-explorer'

export function LogsPage({ state, onChange }: { state: LogExplorerState; onChange: (patch: Partial<LogExplorerState>) => void }) {
  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Logs', to: '/logs' }, { label: 'Explorer' }]}
        title="Logs"
        description="journald, gateway access, inference engines and kernel (including NVRM Xid) from every node"
      />
      <PageBody>
        <LogExplorer state={state} onChange={onChange} />
      </PageBody>
    </>
  )
}
```

Replace `src/routes/logs.tsx`:
```tsx
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import type { TimeRange } from '@/api/types'
import { LOG_RANGES, type LogExplorerState } from '@/features/logs/log-explorer'
import { LogsPage } from '@/features/logs/logs-page'

interface LogsSearch {
  q?: string
  range?: TimeRange
  live?: false
  view?: 'visualize'
}

export const Route = createFileRoute('/logs')({
  validateSearch: (s: Record<string, unknown>): LogsSearch => ({
    q: typeof s.q === 'string' && s.q ? s.q : undefined,
    range: LOG_RANGES.includes(s.range as TimeRange) ? (s.range as TimeRange) : undefined,
    live: s.live === false || s.live === 'false' ? false : undefined,
    view: s.view === 'visualize' ? 'visualize' : undefined,
  }),
  component: LogsRoute,
})

function LogsRoute() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const [around, setAround] = useState<number | undefined>()
  const state: LogExplorerState = { query: search.q ?? '', range: search.range ?? '1h', live: search.live ?? true, view: search.view ?? 'list', around }

  const onChange = (patch: Partial<LogExplorerState>) => {
    if ('around' in patch) setAround(patch.around)
    void navigate({
      replace: true,
      search: (prev) => ({
        ...prev,
        ...('query' in patch ? { q: patch.query || undefined } : {}),
        ...('range' in patch ? { range: patch.range === '1h' ? undefined : patch.range } : {}),
        ...('live' in patch ? { live: patch.live ? undefined : (false as const) } : {}),
        ...('view' in patch ? { view: patch.view === 'visualize' ? ('visualize' as const) : undefined } : {}),
      }),
    })
  }

  return <LogsPage state={state} onChange={onChange} />
}
```

- [ ] **Step 8: Write the e2e tests** — `e2e/logs.spec.ts`

```ts
import { expect, test } from './fixtures'

test('filters by level and walks the detail pane', async ({ page }) => {
  await page.goto('/logs?live=false&range=24h')
  await expect(page.getByTestId('log-histogram')).toBeVisible()
  const input = page.getByRole('textbox', { name: 'Log query' })
  await input.fill('level:error')
  await input.press('Enter')
  await expect(page.getByTestId('log-row').first()).toBeVisible()
  await expect(page.getByTestId('level-badge').filter({ hasNotText: /^error$/i })).toHaveCount(0)

  await page.getByTestId('log-row').first().click()
  const detail = page.getByTestId('log-detail')
  await expect(detail.getByText('Fields', { exact: true })).toBeVisible()
  await expect(page.getByTestId('log-detail-position')).toContainText('1 /')
  const first = await page.getByTestId('log-detail-time').textContent()
  await detail.getByRole('button', { name: 'Older line' }).click()
  await expect(page.getByTestId('log-detail-position')).toContainText('2 /')
  await expect(page.getByTestId('log-detail-time')).not.toHaveText(first ?? '')

  await detail.getByRole('button', { name: 'Same pattern' }).click()
  await expect(input).toHaveValue(/^pattern:[0-9a-f]{16}$/)
})

test('live mode keeps the selected line in the detail pane', async ({ page }) => {
  await page.goto('/logs?range=15m')
  await page.getByTestId('log-row').nth(3).click()
  const time = await page.getByTestId('log-detail-time').textContent()
  const message = await page.getByTestId('log-detail').locator('pre').textContent()
  await page.waitForTimeout(5000)
  await expect(page.getByTestId('log-detail-time')).toHaveText(time ?? '')
  await expect(page.getByTestId('log-detail').locator('pre')).toHaveText(message ?? '')
})

test('no-match and malformed queries show the empty state without crashing', async ({ page }) => {
  await page.goto('/logs?live=false&range=15m')
  const input = page.getByRole('textbox', { name: 'Log query' })
  for (const q of ['host:', '"unterminated', '-', ':::']) {
    await input.fill(q)
    await input.press('Enter')
    await expect(page.getByTestId('log-histogram')).toBeVisible()
  }
  await input.fill('zzzz-no-such-line')
  await input.press('Enter')
  await expect(page.getByTestId('empty-state')).toContainText('No log lines match')
})

test('slash focuses search, visualize groups by pattern, lines around narrows the window', async ({ page }) => {
  await page.goto('/logs?live=false&range=15m')
  await page.locator('body').press('/')
  await expect(page.getByRole('textbox', { name: 'Log query' })).toBeFocused()
  await page.getByRole('radio', { name: 'Visualize' }).click()
  await expect(page.getByTestId('pattern-row').first()).toBeVisible()
  await page.getByTestId('pattern-row').first().click()
  await expect(page.getByRole('textbox', { name: 'Log query' })).toHaveValue(/^pattern:/)
  await page.getByTestId('log-row').first().click()
  await page.getByTestId('log-detail').getByRole('button', { name: 'Lines around' }).click()
  await expect(page.getByTestId('around-badge')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Log query' })).toHaveValue(/^host:/)
})
```

Note: Radix `ToggleGroup type="single"` renders items with `role="radio"`. If your generated toggle group renders `role="button"` with `aria-pressed`, use `getByRole('button', { name: 'Visualize' })` instead.

- [ ] **Step 9: Run to verify**

Run: `pnpm test && pnpm e2e e2e/logs.spec.ts`
Expected: PASS (unit + 4 e2e).

- [ ] **Step 10: Commit**

```bash
git add src/features/logs src/routes/logs.tsx e2e/logs.spec.ts
git commit -m "feat: log explorer with query language, histogram, patterns and detail pane

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Node detail

**Files:**
- Create: `src/features/nodes/node-detail-page.tsx`, `src/features/nodes/node-metrics-tab.tsx`, `src/features/nodes/node-processes-tab.tsx`, `src/features/nodes/node-inventory-tab.tsx`, `src/features/nodes/node-health-tab.tsx`, `src/features/nodes/node-actions.tsx`, `e2e/node-detail.spec.ts`
- Modify: `src/routes/nodes.$nodeId.tsx`

**Interfaces:**
- Consumes: `useNode`, `useDeployments`, `useNodeMetrics`, `useNodeProcesses`, `useNodeInventory`, `useNodeHealth`, `useRebootNode`, `useSetDrained`, `useRunDiagnostics`; `LogExplorer` + `LogExplorerState` (Task 12); `MetricChart`, `NodeStatusBadge`, `TimeRangeToggle`, `LiveBadge`, `QueryState`, `EmptyState`.
- Produces: `type NodeTab = 'metrics' | 'processes' | 'inventory' | 'health' | 'logs'`, `NODE_TABS`, `NodeDetailPage({ nodeId, tab, range, onTab, onRange })`; URL search `?tab=&range=`; test ids `node-status`, `chart-<title>`, `chart-empty`.

- [ ] **Step 1: Write the failing e2e test** — `e2e/node-detail.spec.ts`

```ts
import { expect, test } from './fixtures'

test('degraded node shows status, charts and every tab', async ({ page }) => {
  await page.goto('/nodes/spark-05')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('spark-05')
  await expect(page.getByTestId('node-status')).toHaveText('Degraded')
  await expect(page.getByTestId('chart-Temperature')).toBeVisible()
  await expect(page.getByTestId('chart-Unified memory')).toContainText('/ 128 GB')
  await page.getByRole('tab', { name: 'Processes' }).click()
  await expect(page.getByText('nim_llm')).toBeVisible()
  await page.getByRole('tab', { name: 'Inventory' }).click()
  await expect(page.getByText('source: firmware_reporter.py')).toBeVisible()
  await page.getByRole('tab', { name: 'Health' }).click()
  await expect(page.getByText('GPU temperature', { exact: true })).toBeVisible()
  await expect(page.getByText('spark_diagctl.py')).toBeVisible()
  await page.getByRole('tab', { name: 'Logs' }).click()
  await expect(page.getByText('host:spark-05', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/tab=logs/)
})

test('only clustered nodes show the ConnectX-7 chart', async ({ page }) => {
  await page.goto('/nodes/spark-01')
  await expect(page.getByTestId('chart-ConnectX-7 (200 GbE)')).toBeVisible()
  await page.goto('/nodes/spark-04')
  await expect(page.getByTestId('chart-GPU utilization')).toBeVisible()
  await expect(page.getByTestId('chart-ConnectX-7 (200 GbE)')).toHaveCount(0)
})

test('reboot cycles the node through rebooting back to online', async ({ page }) => {
  await page.goto('/nodes/spark-07')
  await page.getByRole('button', { name: 'Actions' }).click()
  await page.getByRole('menuitem', { name: 'Reboot' }).click()
  await page.getByRole('button', { name: 'Reboot node' }).click()
  await expect(page.getByTestId('node-status')).toHaveText('Rebooting')
  await expect(page.getByTestId('chart-GPU utilization')).toContainText('—')
  await expect(page.getByTestId('node-status')).toHaveText('Online', { timeout: 35_000 })
})

test('unknown node shows not found', async ({ page }) => {
  await page.goto('/nodes/does-not-exist')
  await expect(page.getByRole('heading', { level: 1, name: 'Node not found' })).toBeVisible()
  await page.getByRole('link', { name: 'Back to nodes' }).click()
  await expect(page).toHaveURL(/\/nodes$/)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm e2e e2e/node-detail.spec.ts`
Expected: FAIL — no `node-status` test id.

- [ ] **Step 3: Write the tabs**

`src/features/nodes/node-metrics-tab.tsx`:
```tsx
import { Cable, Cpu, Gauge, HardDrive, MemoryStick, Network, Thermometer, Zap } from 'lucide-react'
import { useNodeMetrics } from '@/api/hooks'
import type { FleetNode, TimeRange } from '@/api/types'
import { MetricChart } from '@/components/metric-chart'
import { QueryState } from '@/components/query-state'
import { Skeleton } from '@/components/ui/skeleton'
import { formatGB, formatPercent, formatRate, formatTemp, formatWatts } from '@/lib/format'

export function NodeMetricsTab({ node, range }: { node: FleetNode; range: TimeRange }) {
  const metrics = useNodeMetrics(node.id, range)
  const live = node.live
  return (
    <QueryState
      query={metrics}
      skeleton={
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-56" />
          ))}
        </div>
      }
    >
      {(data) => (
        <div className="flex flex-col gap-3">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <MetricChart title="GPU utilization" icon={Gauge} data={data} range={range} domain={[0, 100]} format={(v) => formatPercent(v)} current={formatPercent(live?.gpuUtil ?? null)} series={[{ key: 'gpuUtil', label: 'GPU', color: 'var(--gpu)' }]} />
            <MetricChart title="Unified memory" icon={MemoryStick} data={data} range={range} domain={[0, 128]} format={(v) => formatGB(v)} current={live ? `${formatGB(live.memUsedGB)} / 128 GB` : '—'} series={[{ key: 'memUsedGB', label: 'Used', color: 'var(--memory)' }]} />
            <MetricChart title="GPU power" icon={Zap} data={data} range={range} format={(v) => formatWatts(v)} current={formatWatts(live?.gpuPowerW ?? null)} series={[{ key: 'gpuPowerW', label: 'GPU power', color: 'var(--power)' }]} />
            <MetricChart
              title="Temperature"
              icon={Thermometer}
              data={data}
              range={range}
              domain={[20, 'auto']}
              format={(v) => formatTemp(v)}
              current={live ? `${formatTemp(live.gpuTempC)} · ${formatTemp(live.acpiTempC)}` : '—'}
              series={[
                { key: 'gpuTempC', label: 'GPU (nvidia-smi)', color: 'var(--power)' },
                { key: 'acpiTempC', label: 'ACPI zone', color: 'var(--level-error)' },
              ]}
            />
            <MetricChart
              title="CPU"
              icon={Cpu}
              data={data}
              range={range}
              domain={[0, 100]}
              stacked
              format={(v) => formatPercent(v)}
              current={formatPercent(live?.cpuUtil ?? null)}
              series={[
                { key: 'cpuUser', label: 'user', color: 'var(--cpu)' },
                { key: 'cpuSystem', label: 'system', color: 'var(--level-info)' },
              ]}
            />
            <MetricChart
              title="Network (10GbE)"
              icon={Network}
              data={data}
              range={range}
              format={(v) => formatRate(v)}
              series={[
                { key: 'netRxBps', label: 'rx', color: 'var(--cpu)' },
                { key: 'netTxBps', label: 'tx', color: 'var(--memory)' },
              ]}
            />
            {node.groupId !== null && (
              <MetricChart
                title="ConnectX-7 (200 GbE)"
                icon={Cable}
                data={data}
                range={range}
                format={(v) => formatRate(v)}
                series={[
                  { key: 'cx7RxBps', label: 'rx', color: 'var(--gpu)' },
                  { key: 'cx7TxBps', label: 'tx', color: 'var(--level-info)' },
                ]}
              />
            )}
            <MetricChart
              title="NVMe I/O"
              icon={HardDrive}
              data={data}
              range={range}
              format={(v) => formatRate(v)}
              series={[
                { key: 'diskReadBps', label: 'read', color: 'var(--cpu)' },
                { key: 'diskWriteBps', label: 'write', color: 'var(--power)' },
              ]}
            />
            <MetricChart title="Disk usage" icon={HardDrive} data={data} range={range} domain={[0, 100]} format={(v) => formatPercent(v)} current={formatPercent(live?.diskUsedPct ?? null)} series={[{ key: 'diskUsedPct', label: 'used', color: 'var(--level-info)' }]} />
          </div>
          <p className="text-xs text-muted-foreground">
            GB10 shares 128 GB between CPU and GPU, so <code className="font-mono">nvidia-smi</code> reports memory as “Not Supported”. Memory comes from <code className="font-mono">/proc/meminfo</code> (MemAvailable). Power is GPU-only draw.
          </p>
        </div>
      )}
    </QueryState>
  )
}
```

`src/features/nodes/node-processes-tab.tsx`:
```tsx
import { useNodeProcesses } from '@/api/hooks'
import { EmptyState, QueryState } from '@/components/query-state'
import { Card } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

export function NodeProcessesTab({ nodeId }: { nodeId: string }) {
  const procs = useNodeProcesses(nodeId)
  return (
    <QueryState query={procs} isEmpty={(p) => p.length === 0} empty={<EmptyState title="No GPU processes" description="The node is idle or unreachable." />}>
      {(list) => (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>PID</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Process</TableHead>
                <TableHead>Engine</TableHead>
                <TableHead className="text-right">GPU memory</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="font-mono">
              {list.map((p) => (
                <TableRow key={p.pid}>
                  <TableCell>{p.pid}</TableCell>
                  <TableCell>{p.user}</TableCell>
                  <TableCell className="max-w-md truncate">{p.name}</TableCell>
                  <TableCell>{p.engine ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{(p.gpuMemMiB / 1024).toFixed(1)} GiB</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </QueryState>
  )
}
```

`src/features/nodes/node-inventory-tab.tsx`:
```tsx
import { useNodeInventory } from '@/api/hooks'
import type { FleetNode } from '@/api/types'
import { QueryState } from '@/components/query-state'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'

function Kv({ rows }: { rows: [string, string][] }) {
  return (
    <Table>
      <TableBody>
        {rows.map(([k, v]) => (
          <TableRow key={k}>
            <TableCell className="w-48 text-muted-foreground">{k}</TableCell>
            <TableCell className="font-mono">{v}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function NodeInventoryTab({ node }: { node: FleetNode }) {
  const inv = useNodeInventory(node.id)
  return (
    <QueryState query={inv}>
      {(data) => (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">System</CardTitle>
            </CardHeader>
            <CardContent>
              <Kv
                rows={[
                  ['Model', node.model],
                  ['Serial', node.serial],
                  ['Asset tag', node.assetTag],
                  ['Hostname', node.hostname],
                  ['IP', node.ip],
                  ['CPU', '20-core Grace (10× Cortex-X925 + 10× Cortex-A725)'],
                  ['Memory', `${node.memoryGB} GB LPDDR5x unified`],
                  ['Storage', `${node.diskGB / 1000} TB NVMe`],
                  ['DGX OS', node.os.dgxOs],
                  ['Kernel', node.os.kernel],
                  ['Driver / CUDA', `${node.os.driver} / ${node.os.cuda}`],
                ]}
              />
            </CardContent>
          </Card>
          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Firmware</CardTitle>
                <CardDescription className="font-mono text-xs">source: {data.envelope.tool} · rc={data.envelope.rc}</CardDescription>
              </CardHeader>
              <CardContent>
                <Kv rows={data.firmware.map((f) => [f.component, f.version])} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Key packages</CardTitle>
              </CardHeader>
              <CardContent>
                <Kv rows={data.packages.map((p) => [p.name, p.version])} />
              </CardContent>
            </Card>
            <details className="rounded-xl border bg-card p-4 text-sm">
              <summary className="cursor-pointer text-muted-foreground">Raw envelope</summary>
              <pre className="mt-3 overflow-x-auto font-mono text-xs">{JSON.stringify(data.envelope, null, 2)}</pre>
            </details>
          </div>
        </div>
      )}
    </QueryState>
  )
}
```

`src/features/nodes/node-health-tab.tsx`:
```tsx
import { CircleCheck, CircleX, Stethoscope, TriangleAlert } from 'lucide-react'
import { useNodeHealth, useRunDiagnostics } from '@/api/hooks'
import type { HealthCheck } from '@/api/types'
import { QueryState } from '@/components/query-state'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

const ICON: Record<HealthCheck['status'], { icon: typeof CircleCheck; className: string }> = {
  pass: { icon: CircleCheck, className: 'text-brand' },
  warn: { icon: TriangleAlert, className: 'text-level-warn' },
  fail: { icon: CircleX, className: 'text-level-error' },
}

export function NodeHealthTab({ nodeId }: { nodeId: string }) {
  const health = useNodeHealth(nodeId)
  const run = useRunDiagnostics()
  return (
    <QueryState query={health}>
      {(h) => (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">L1 health summary</CardTitle>
            <CardDescription className="font-mono text-xs">
              {h.envelope.tool} · status={h.envelope.status} · {h.envelope.duration_ms} ms
            </CardDescription>
            <CardAction>
              <Button size="sm" variant="outline" disabled={run.isPending} onClick={() => run.mutate(nodeId)}>
                <Stethoscope />
                Run diagnostics
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {h.checks.map((c) => {
                const { icon: Icon, className } = ICON[c.status]
                return (
                  <li key={c.name} className="flex items-center gap-3 py-2.5">
                    <Icon className={`size-4 shrink-0 ${className}`} aria-label={c.status} />
                    <span className="w-56 shrink-0 text-sm">{c.name}</span>
                    <span className="min-w-0 truncate font-mono text-sm text-muted-foreground">{c.detail}</span>
                  </li>
                )
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </QueryState>
  )
}
```

If the generated `card.tsx` does not export `CardAction`, put the button inside `CardHeader` with `className="flex flex-row items-start justify-between"` instead.

- [ ] **Step 4: Actions menu** — `src/features/nodes/node-actions.tsx`

```tsx
import { CircleSlash, EllipsisVertical, PackageOpen, Power, Stethoscope } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useRebootNode, useRunDiagnostics, useSetDrained } from '@/api/hooks'
import type { FleetNode } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

export function NodeActions({ node }: { node: FleetNode }) {
  const [confirm, setConfirm] = useState(false)
  const reboot = useRebootNode()
  const drain = useSetDrained()
  const diag = useRunDiagnostics()
  const reachable = node.status === 'online' || node.status === 'degraded'

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" aria-label="Actions">
            Actions <EllipsisVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem disabled={!reachable} onSelect={() => setConfirm(true)}>
            <Power />
            Reboot
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => drain.mutate({ id: node.id, drained: !node.drained })}>
            <CircleSlash />
            {node.drained ? 'Undrain' : 'Drain'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!reachable} onSelect={() => diag.mutate(node.id)}>
            <Stethoscope />
            Run L1 diagnostics
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!reachable}
            onSelect={() => toast.success(`L2 evidence bundle queued → /var/lib/dgx_spark_management/spark_diagctl/${node.id}-L2.tar.zst`)}
          >
            <PackageOpen />
            Collect L2 bundle
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reboot {node.id}?</DialogTitle>
            <DialogDescription>Models served from this node will be unavailable until it is back and reloaded (about 35 s in the simulator).</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirm(false)
                reboot.mutate(node.id)
              }}
            >
              Reboot node
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
```

- [ ] **Step 5: Page and route**

`src/features/nodes/node-detail-page.tsx`:
```tsx
import { Link } from '@tanstack/react-router'
import { Server } from 'lucide-react'
import { useState } from 'react'
import { useDeployments, useNode } from '@/api/hooks'
import type { TimeRange } from '@/api/types'
import { LiveBadge } from '@/components/live-badge'
import { NodeStatusBadge } from '@/components/node-status-dot'
import { PageBody, PageHeader } from '@/components/page-header'
import { EmptyState, QueryState } from '@/components/query-state'
import { TimeRangeToggle } from '@/components/time-range-toggle'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { LogExplorer, type LogExplorerState } from '@/features/logs/log-explorer'
import { formatDuration, formatRelative } from '@/lib/format'
import { NodeActions } from './node-actions'
import { NodeHealthTab } from './node-health-tab'
import { NodeInventoryTab } from './node-inventory-tab'
import { NodeMetricsTab } from './node-metrics-tab'
import { NodeProcessesTab } from './node-processes-tab'

export const NODE_TABS = ['metrics', 'processes', 'inventory', 'health', 'logs'] as const
export type NodeTab = (typeof NODE_TABS)[number]

function NodeLogsTab({ nodeId }: { nodeId: string }) {
  const [state, setState] = useState<LogExplorerState>({ query: '', range: '1h', live: true, view: 'list' })
  return <LogExplorer state={state} onChange={(patch) => setState((s) => ({ ...s, ...patch }))} lockedQuery={`host:${nodeId}`} compact />
}

export function NodeDetailPage({ nodeId, tab, range, onTab, onRange }: { nodeId: string; tab: NodeTab; range: TimeRange; onTab: (t: NodeTab) => void; onRange: (r: TimeRange) => void }) {
  const node = useNode(nodeId)
  const deployments = useDeployments()
  const crumbs = [{ label: 'Nodes', to: '/nodes' as const }, { label: nodeId }]

  if (node.isSuccess && node.data === null) {
    return (
      <>
        <PageHeader crumbs={crumbs} title="Node not found" />
        <PageBody>
          <EmptyState
            title={`No node “${nodeId}” in this fleet`}
            description="It may have been renamed or removed."
            action={
              <Button asChild variant="outline">
                <Link to="/nodes">Back to nodes</Link>
              </Button>
            }
          />
        </PageBody>
      </>
    )
  }

  return (
    <QueryState
      query={node}
      skeleton={
        <>
          <PageHeader crumbs={crumbs} title={nodeId} />
          <PageBody>
            <Skeleton className="h-96 w-full" />
          </PageBody>
        </>
      }
    >
      {(n) => {
        if (!n) return null
        const dep = deployments.data?.find((d) => d.id === n.deploymentId)
        const now = Date.now()
        return (
          <>
            <PageHeader
              crumbs={crumbs}
              title={
                <span className="flex flex-wrap items-center gap-3">
                  <span className="grid size-10 place-items-center rounded-xl border bg-card">
                    <Server className="size-5" />
                  </span>
                  <span className="font-mono">{n.id}</span>
                  <NodeStatusBadge status={n.status} />
                  {n.drained && <Badge variant="outline">Drained</Badge>}
                </span>
              }
              description={
                <span className="font-mono text-xs">
                  {n.model} · DGX OS {n.os.dgxOs} · driver {n.os.driver} · CUDA {n.os.cuda} · up {formatDuration(now - n.bootedAt)} · last seen {formatRelative(n.lastSeen, now)}
                  {dep ? ` · serving ${dep.model} (${dep.engine})` : ''}
                </span>
              }
              actions={
                <>
                  <LiveBadge live />
                  <TimeRangeToggle value={range} onChange={onRange} />
                  <NodeActions node={n} />
                </>
              }
            />
            <PageBody>
              <Tabs value={tab} onValueChange={(v) => onTab(v as NodeTab)}>
                <TabsList>
                  <TabsTrigger value="metrics">Metrics</TabsTrigger>
                  <TabsTrigger value="processes">Processes</TabsTrigger>
                  <TabsTrigger value="inventory">Inventory</TabsTrigger>
                  <TabsTrigger value="health">Health</TabsTrigger>
                  <TabsTrigger value="logs">Logs</TabsTrigger>
                </TabsList>
                <TabsContent value="metrics" className="mt-4">
                  <NodeMetricsTab node={n} range={range} />
                </TabsContent>
                <TabsContent value="processes" className="mt-4">
                  <NodeProcessesTab nodeId={n.id} />
                </TabsContent>
                <TabsContent value="inventory" className="mt-4">
                  <NodeInventoryTab node={n} />
                </TabsContent>
                <TabsContent value="health" className="mt-4">
                  <NodeHealthTab nodeId={n.id} />
                </TabsContent>
                <TabsContent value="logs" className="mt-4">
                  <NodeLogsTab nodeId={n.id} />
                </TabsContent>
              </Tabs>
            </PageBody>
          </>
        )
      }}
    </QueryState>
  )
}
```

Replace `src/routes/nodes.$nodeId.tsx`:
```tsx
import { createFileRoute } from '@tanstack/react-router'
import type { TimeRange } from '@/api/types'
import { NODE_TABS, NodeDetailPage, type NodeTab } from '@/features/nodes/node-detail-page'

const RANGES: TimeRange[] = ['1h', '6h', '24h', '7d']

export const Route = createFileRoute('/nodes/$nodeId')({
  validateSearch: (s: Record<string, unknown>): { tab?: NodeTab; range?: TimeRange } => ({
    tab: NODE_TABS.includes(s.tab as NodeTab) && s.tab !== 'metrics' ? (s.tab as NodeTab) : undefined,
    range: RANGES.includes(s.range as TimeRange) && s.range !== '1h' ? (s.range as TimeRange) : undefined,
  }),
  component: NodeRoute,
})

function NodeRoute() {
  const { nodeId } = Route.useParams()
  const { tab = 'metrics', range = '1h' } = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <NodeDetailPage
      key={nodeId}
      nodeId={nodeId}
      tab={tab}
      range={range}
      onTab={(t) => void navigate({ replace: true, search: (p) => ({ ...p, tab: t === 'metrics' ? undefined : t }) })}
      onRange={(r) => void navigate({ replace: true, search: (p) => ({ ...p, range: r === '1h' ? undefined : r }) })}
    />
  )
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm build && pnpm e2e e2e/node-detail.spec.ts`
Expected: PASS (4 tests). The reboot test waits up to 35 s for the 20 s simulated reboot.

- [ ] **Step 7: Commit**

```bash
git add src/features/nodes src/routes/nodes.\$nodeId.tsx e2e/node-detail.spec.ts
git commit -m "feat: node detail with metrics, processes, inventory, health, logs and actions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 14: Gateway endpoint

**Files:**
- Create: `src/features/gateway/snippets.ts`, `src/features/gateway/snippets.test.ts`, `src/features/gateway/gateway-page.tsx`, `e2e/gateway.spec.ts`
- Modify: `src/routes/gateway.tsx`

**Interfaces:**
- Consumes: `useGatewayInfo`, `useGatewaySeries`, `useRoutes`; `MetricChart`, `StatTile`, `CopyButton`, `TimeRangeToggle`, `QueryState`; shadcn `Tabs`, `Table`, `Badge`.
- Produces: `type SnippetTool`, `interface Snippet { tool; label; file; code; note? }`, `buildSnippets(baseUrl: string, models: { primary: string; coder: string }): Snippet[]`, `GatewayPage`; test ids `base-url`, `tile-errors`, `route-row`.

- [ ] **Step 1: Write the failing snippet test** — `src/features/gateway/snippets.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { buildSnippets } from './snippets'

const BASE = 'http://sparkman.local:4000'
const snippets = buildSnippets(BASE, { primary: 'qwen3-235b-a22b', coder: 'qwen3-coder-30b-a3b' })

describe('buildSnippets', () => {
  it('covers every supported tool', () => {
    expect(snippets.map((s) => s.tool)).toEqual(['claude-code', 'codex', 'opencode', 'cursor', 'vscode', 'curl'])
  })
  it('points every snippet at the gateway and never embeds a secret', () => {
    for (const s of snippets) {
      expect(s.code).toContain(BASE)
      expect(s.code).not.toMatch(/sk-spark-[A-Za-z0-9]{8,}/)
    }
  })
  it('uses the Anthropic-style root for Claude Code and /v1 for OpenAI-compatible tools', () => {
    const claude = snippets.find((s) => s.tool === 'claude-code')!
    expect(claude.code).toContain(`ANTHROPIC_BASE_URL="${BASE}"`)
    expect(snippets.find((s) => s.tool === 'codex')!.code).toContain(`base_url = "${BASE}/v1"`)
    expect(snippets.find((s) => s.tool === 'opencode')!.code).toContain(`"baseURL": "${BASE}/v1"`)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/features/gateway/snippets.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/features/gateway/snippets.ts`**

```ts
export type SnippetTool = 'claude-code' | 'codex' | 'opencode' | 'cursor' | 'vscode' | 'curl'

export interface Snippet {
  tool: SnippetTool
  label: string
  file: string
  code: string
  note?: string
}

export function buildSnippets(baseUrl: string, models: { primary: string; coder: string }): Snippet[] {
  const v1 = `${baseUrl}/v1`
  return [
    {
      tool: 'claude-code',
      label: 'Claude Code',
      file: '~/.zshrc',
      note: 'The gateway exposes an Anthropic-compatible /v1/messages route, so Claude Code needs only environment variables.',
      code: [
        '# Route Claude Code through SparkMan',
        `export ANTHROPIC_BASE_URL="${baseUrl}"`,
        'export ANTHROPIC_AUTH_TOKEN="$SPARKMAN_API_KEY"',
        `export ANTHROPIC_MODEL="${models.primary}"`,
        `export ANTHROPIC_DEFAULT_HAIKU_MODEL="${models.coder}"`,
      ].join('\n'),
    },
    {
      tool: 'codex',
      label: 'Codex CLI',
      file: '~/.codex/config.toml',
      code: [
        `model = "${models.primary}"`,
        'model_provider = "sparkman"',
        '',
        '[model_providers.sparkman]',
        'name = "SparkMan"',
        `base_url = "${v1}"`,
        'env_key = "SPARKMAN_API_KEY"',
        'wire_api = "chat"',
      ].join('\n'),
    },
    {
      tool: 'opencode',
      label: 'OpenCode',
      file: 'opencode.json',
      code: JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          provider: {
            sparkman: {
              npm: '@ai-sdk/openai-compatible',
              name: 'SparkMan',
              options: { baseURL: v1, apiKey: '{env:SPARKMAN_API_KEY}' },
              models: { [models.primary]: {}, [models.coder]: {} },
            },
          },
        },
        null,
        2,
      ),
    },
    {
      tool: 'cursor',
      label: 'Cursor',
      file: 'Settings → Models',
      note: 'Cursor needs an OpenAI-compatible base URL override; add each model name under “Add model”.',
      code: [`Override OpenAI Base URL:  ${v1}`, 'OpenAI API Key:            <your SparkMan key>', `Models:                    ${models.primary}, ${models.coder}`].join('\n'),
    },
    {
      tool: 'vscode',
      label: 'VS Code (Continue)',
      file: '~/.continue/config.yaml',
      code: [
        'models:',
        `  - name: SparkMan ${models.coder}`,
        '    provider: openai',
        `    model: ${models.coder}`,
        `    apiBase: ${v1}`,
        '    apiKey: ${{ secrets.SPARKMAN_API_KEY }}',
        '    roles: [chat, edit, apply]',
      ].join('\n'),
    },
    {
      tool: 'curl',
      label: 'curl',
      file: 'shell',
      code: [
        `curl ${v1}/chat/completions \\`,
        '  -H "Authorization: Bearer $SPARKMAN_API_KEY" \\',
        '  -H "Content-Type: application/json" \\',
        `  -d '{"model":"${models.coder}","messages":[{"role":"user","content":"ping"}]}'`,
      ].join('\n'),
    },
  ]
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/features/gateway/snippets.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing e2e test** — `e2e/gateway.spec.ts`

```ts
import { expect, test } from './fixtures'

test('endpoint page shows base URL, live stats, snippets and routes', async ({ page }) => {
  await page.goto('/gateway')
  await expect(page.getByTestId('base-url')).toHaveText('http://sparkman.local:4000')
  await expect(page.getByTestId('tile-errors')).toContainText('%')
  await page.getByRole('tab', { name: 'Codex CLI' }).click()
  await expect(page.getByText('model_provider = "sparkman"')).toBeVisible()
  await page.getByRole('button', { name: 'Copy snippet' }).click()
  await expect(page.getByText('Snippet copied')).toBeVisible()
  await expect(page.getByTestId('route-row')).toHaveCount(7)
  await expect(page.getByTestId('chart-Latency')).toBeVisible()
})
```

- [ ] **Step 6: Write `src/features/gateway/gateway-page.tsx`**

```tsx
import { Activity, Gauge, Plug, Timer, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useGatewayInfo, useGatewaySeries, useRoutes } from '@/api/hooks'
import type { TimeRange } from '@/api/types'
import { CopyButton } from '@/components/copy-button'
import { LiveBadge } from '@/components/live-badge'
import { MetricChart } from '@/components/metric-chart'
import { PageBody, PageHeader } from '@/components/page-header'
import { QueryState } from '@/components/query-state'
import { StatTile } from '@/components/stat-tile'
import { TimeRangeToggle } from '@/components/time-range-toggle'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatCompact, formatDuration, formatPercent } from '@/lib/format'
import { buildSnippets } from './snippets'

export function GatewayPage() {
  const [range, setRange] = useState<TimeRange>('1h')
  const info = useGatewayInfo()
  const series = useGatewaySeries(range)
  const routes = useRoutes()
  const last = series.data?.at(-1)

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'AI Gateway', to: '/gateway' }, { label: 'Endpoint' }]}
        title="Endpoint"
        description="One OpenAI- and Anthropic-compatible front door for every coding agent; routed by model name across the fleet"
        actions={
          <>
            <LiveBadge live />
            <TimeRangeToggle value={range} onChange={setRange} ranges={['15m', '1h', '24h', '7d']} />
          </>
        }
      />
      <PageBody>
        <QueryState query={info} skeleton={<Skeleton className="h-28 w-full" />}>
          {(gw) => {
            const coder = gw.models.includes('qwen3-coder-30b-a3b') ? 'qwen3-coder-30b-a3b' : (gw.models[0] ?? gw.defaultModel)
            const snippets = buildSnippets(gw.baseUrl, { primary: gw.defaultModel, coder })
            return (
              <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-sm">
                      <Plug className="size-4 text-brand" />
                      Base URL
                    </CardTitle>
                    <CardDescription>Point agents here and authenticate with a key from API Keys.</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-4">
                    <div className="flex items-center gap-2 rounded-lg border bg-surface-2 px-3 py-2">
                      <code className="flex-1 truncate font-mono text-sm" data-testid="base-url">
                        {gw.baseUrl}
                      </code>
                      <CopyButton value={gw.baseUrl} label="Copy" toastText="Base URL copied" />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="outline" className="font-mono">POST /v1/chat/completions</Badge>
                      <Badge variant="outline" className="font-mono">POST /v1/messages</Badge>
                      <Badge variant="outline" className="font-mono">GET /v1/models</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Serving <span className="font-mono text-foreground">{gw.models.length}</span> models. Default: <span className="font-mono text-foreground">{gw.defaultModel}</span>
                    </p>
                  </CardContent>
                </Card>
                <Card className="gap-3">
                  <CardHeader>
                    <CardTitle className="text-sm">Connect a coding agent</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Tabs defaultValue="claude-code">
                      <TabsList className="flex-wrap">
                        {snippets.map((s) => (
                          <TabsTrigger key={s.tool} value={s.tool}>
                            {s.label}
                          </TabsTrigger>
                        ))}
                      </TabsList>
                      {snippets.map((s) => (
                        <TabsContent key={s.tool} value={s.tool} className="mt-3 flex flex-col gap-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-xs text-muted-foreground">{s.file}</span>
                            <CopyButton value={s.code} label="Copy snippet" toastText="Snippet copied" />
                          </div>
                          <pre className="overflow-x-auto rounded-lg border bg-surface-2 p-3 font-mono text-xs leading-relaxed">{s.code}</pre>
                          {s.note && <p className="text-xs text-muted-foreground">{s.note}</p>}
                        </TabsContent>
                      ))}
                    </Tabs>
                  </CardContent>
                </Card>
              </div>
            )
          }}
        </QueryState>

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatTile label="Requests / s" value={last ? last.rps.toFixed(1) : '—'} icon={Activity} hint={last ? `${formatCompact(last.tokensPerSec)} tok/s` : undefined} />
          <StatTile label="Latency p50 / p95" value={last ? `${formatDuration(last.p50Ms)}` : '—'} icon={Timer} hint={last ? `p95 ${formatDuration(last.p95Ms)}` : undefined} />
          <StatTile label="Time to first token" value={last ? formatDuration(last.ttftMs) : '—'} icon={Gauge} hint="p50" />
          <StatTile testId="tile-errors" label="Error rate" value={last ? formatPercent(last.errorRate * 100, 1) : '—'} icon={TriangleAlert} tone={last && last.errorRate > 0.02 ? 'error' : 'default'} hint="5xx responses" />
        </div>

        <QueryState query={series} skeleton={<Skeleton className="h-56 w-full" />}>
          {(points) => (
            <div className="grid gap-4 lg:grid-cols-3">
              <MetricChart
                title="Throughput"
                icon={Activity}
                data={points.map((p) => ({ t: p.t, rps: p.rps }))}
                range={range}
                format={(v) => v.toFixed(1)}
                series={[{ key: 'rps', label: 'req/s', color: 'var(--gpu)' }]}
              />
              <MetricChart
                title="Latency"
                icon={Timer}
                data={points.map((p) => ({ t: p.t, ttft: p.ttftMs, p50: p.p50Ms, p95: p.p95Ms }))}
                range={range}
                format={(v) => formatDuration(v)}
                series={[
                  { key: 'ttft', label: 'TTFT', color: 'var(--cpu)' },
                  { key: 'p50', label: 'p50', color: 'var(--level-info)' },
                  { key: 'p95', label: 'p95', color: 'var(--memory)' },
                ]}
              />
              <MetricChart
                title="Errors"
                icon={TriangleAlert}
                data={points.map((p) => ({ t: p.t, err: p.errorRate * 100 }))}
                range={range}
                format={(v) => formatPercent(v, 1)}
                series={[{ key: 'err', label: '5xx %', color: 'var(--level-error)' }]}
              />
            </div>
          )}
        </QueryState>

        <Card className="gap-0 py-0">
          <CardHeader className="border-b py-4">
            <CardTitle className="text-sm">Routing table</CardTitle>
            <CardDescription>Least-loaded routing across replicas; unhealthy replicas are skipped.</CardDescription>
          </CardHeader>
          <QueryState query={routes}>
            {(list) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead>Engine</TableHead>
                    <TableHead>Replicas</TableHead>
                    <TableHead>Nodes</TableHead>
                    <TableHead>Health</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((r) => (
                    <TableRow key={r.deploymentId} data-testid="route-row">
                      <TableCell className="font-mono">{r.model}</TableCell>
                      <TableCell>{r.engine}</TableCell>
                      <TableCell className="font-mono tabular-nums">{r.replicas}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{r.nodeIds.join(', ')}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={r.healthy ? 'text-brand' : 'text-level-warn'}>
                          {r.healthy ? 'healthy' : 'degraded'}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </QueryState>
        </Card>
      </PageBody>
    </>
  )
}
```

Replace `src/routes/gateway.tsx`:
```tsx
import { createFileRoute } from '@tanstack/react-router'
import { GatewayPage } from '@/features/gateway/gateway-page'

export const Route = createFileRoute('/gateway')({ component: GatewayPage })
```

- [ ] **Step 7: Run to verify**

Run: `pnpm test && pnpm e2e e2e/gateway.spec.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/features/gateway src/routes/gateway.tsx e2e/gateway.spec.ts
git commit -m "feat: gateway endpoint page with agent setup snippets and live stats

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Deployments and deploy flow

**Files:**
- Create: `src/features/deployments/deployments-page.tsx`, `src/features/deployments/deploy-sheet.tsx`, `src/features/deployments/fit.ts`, `src/features/deployments/fit.test.ts`, `e2e/deployments.spec.ts`
- Modify: `src/routes/deployments.tsx`

**Interfaces:**
- Consumes: `useDeployments`, `useCatalog`, `useNodes`, `useCreateDeployment`, `useStopDeployment`; shadcn `Sheet`, `Select`, `Checkbox`, `Label`, `Dialog`, `Table`, `Badge`.
- Produces: `fitProblem(model: CatalogModel | undefined, engine: Engine | undefined, nodeCount: number): string | null` (client-side mirror of the simulator's validation), `DeploymentsPage`, `DeploySheet({ open, onOpenChange })`; test ids `deployment-row`, `fit-problem`.

- [ ] **Step 1: Write the failing fit test** — `src/features/deployments/fit.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import type { CatalogModel } from '@/api/types'
import { fitProblem } from './fit'

const big: CatalogModel = { id: 'deepseek-v3.1', displayName: 'DeepSeek V3.1', sizeGB: 380, quant: 'NVFP4', contextLength: 131072, engines: ['SGLang', 'vLLM'] }
const small: CatalogModel = { id: 'gpt-oss-20b', displayName: 'gpt-oss 20B', sizeGB: 14, quant: 'MXFP4', contextLength: 131072, engines: ['vLLM', 'Ollama'] }

describe('fitProblem', () => {
  it('asks for a model, engine and nodes first', () => {
    expect(fitProblem(undefined, undefined, 0)).toBe('Choose a model')
    expect(fitProblem(small, undefined, 0)).toBe('Choose an engine')
    expect(fitProblem(small, 'vLLM', 0)).toBe('Select at least one node')
  })
  it('rejects engines that are not packaged or cannot span nodes', () => {
    expect(fitProblem(small, 'NIM', 1)).toBe('gpt-oss 20B is not packaged for NIM')
    expect(fitProblem(small, 'Ollama', 2)).toBe('Ollama cannot span multiple nodes')
  })
  it('explains memory fit', () => {
    expect(fitProblem(big, 'SGLang', 1)).toBe('DeepSeek V3.1 (380 GB) needs at least 4 nodes')
    expect(fitProblem(big, 'SGLang', 4)).toBeNull()
    expect(fitProblem(small, 'vLLM', 1)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/features/deployments/fit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/features/deployments/fit.ts`**

```ts
import type { CatalogModel, Engine } from '@/api/types'

/** Usable model memory per GB10 node after OS + KV-cache headroom. Must match the simulator (110 GB). */
export const USABLE_GB_PER_NODE = 110

export function fitProblem(model: CatalogModel | undefined, engine: Engine | undefined, nodeCount: number): string | null {
  if (!model) return 'Choose a model'
  if (!engine) return 'Choose an engine'
  if (nodeCount === 0) return 'Select at least one node'
  if (!model.engines.includes(engine)) return `${model.displayName} is not packaged for ${engine}`
  if (nodeCount > 1 && engine !== 'vLLM' && engine !== 'SGLang') return `${engine} cannot span multiple nodes`
  const needed = Math.ceil(model.sizeGB / USABLE_GB_PER_NODE)
  if (nodeCount < needed) return `${model.displayName} (${model.sizeGB} GB) needs at least ${needed} nodes`
  return null
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/features/deployments/fit.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing e2e test** — `e2e/deployments.spec.ts`

```ts
import { expect, test } from './fixtures'

test('stop a deployment, then deploy a new model on the freed node', async ({ page }) => {
  await page.goto('/deployments')
  await expect(page.getByTestId('deployment-row')).toHaveCount(7)
  await page.getByTestId('deployment-row').filter({ hasText: 'mistral-small-3.2-24b' }).getByRole('button', { name: 'Stop' }).click()
  await page.getByRole('button', { name: 'Stop deployment' }).click()
  await expect(page.getByTestId('deployment-row')).toHaveCount(6)

  await page.getByRole('button', { name: 'Deploy model' }).click()
  await page.getByRole('combobox', { name: 'Model' }).click()
  await page.getByRole('option', { name: /gpt-oss 20B/ }).click()
  await page.getByRole('combobox', { name: 'Engine' }).click()
  await page.getByRole('option', { name: 'vLLM' }).click()
  await page.getByRole('checkbox', { name: /spark-08/ }).check()
  await page.getByRole('button', { name: 'Deploy', exact: true }).click()

  const fresh = page.getByTestId('deployment-row').filter({ hasText: 'gpt-oss-20b' })
  await expect(fresh).toContainText(/pending|loading/i)
  await expect(fresh).toContainText(/serving/i, { timeout: 30_000 })
})

test('deploy form explains why a model does not fit', async ({ page }) => {
  await page.goto('/deployments')
  await page.getByTestId('deployment-row').filter({ hasText: 'qwen3-235b-a22b' }).getByRole('button', { name: 'Stop' }).click()
  await page.getByRole('button', { name: 'Stop deployment' }).click()
  await page.getByRole('button', { name: 'Deploy model' }).click()
  await page.getByRole('combobox', { name: 'Model' }).click()
  await page.getByRole('option', { name: /DeepSeek V3.1/ }).click()
  await page.getByRole('combobox', { name: 'Engine' }).click()
  await page.getByRole('option', { name: 'SGLang' }).click()
  await page.getByRole('checkbox', { name: /spark-01/ }).check()
  await expect(page.getByTestId('fit-problem')).toHaveText('DeepSeek V3.1 (380 GB) needs at least 4 nodes')
  await expect(page.getByRole('button', { name: 'Deploy', exact: true })).toBeDisabled()
})
```

- [ ] **Step 6: Write the page and sheet**

`src/features/deployments/deploy-sheet.tsx`:
```tsx
import { useState } from 'react'
import { useCatalog, useCreateDeployment, useNodes } from '@/api/hooks'
import type { Engine } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { formatGB } from '@/lib/format'
import { fitProblem } from './fit'

export function DeploySheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const catalog = useCatalog()
  const nodes = useNodes()
  const create = useCreateDeployment()
  const [modelId, setModelId] = useState<string>()
  const [engine, setEngine] = useState<Engine>()
  const [picked, setPicked] = useState<string[]>([])

  const model = catalog.data?.find((m) => m.id === modelId)
  const free = (nodes.data ?? []).filter((n) => n.deploymentId === null && (n.status === 'online' || n.status === 'degraded'))
  const problem = fitProblem(model, engine, picked.length)

  const reset = () => {
    setModelId(undefined)
    setEngine(undefined)
    setPicked([])
  }

  const submit = () => {
    if (!model || !engine || problem) return
    create.mutate(
      { catalogId: model.id, engine, nodeIds: picked },
      {
        onSuccess: () => {
          reset()
          onOpenChange(false)
        },
      },
    )
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[440px] sm:max-w-[440px]">
        <SheetHeader>
          <SheetTitle>Deploy model</SheetTitle>
          <SheetDescription>Pick a model, an engine and free nodes. Multi-node replicas use ConnectX-7 with vLLM or SGLang.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-5 px-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="deploy-model">Model</Label>
            <Select
              value={modelId ?? ''}
              onValueChange={(v) => {
                setModelId(v)
                setEngine(undefined)
              }}
            >
              <SelectTrigger id="deploy-model" className="w-full">
                <SelectValue placeholder="Choose a model" />
              </SelectTrigger>
              <SelectContent>
                {catalog.data?.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.displayName} · {m.quant} · {formatGB(m.sizeGB)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="deploy-engine">Engine</Label>
            <Select value={engine ?? ''} onValueChange={(v) => setEngine(v as Engine)} disabled={!model}>
              <SelectTrigger id="deploy-engine" className="w-full">
                <SelectValue placeholder="Choose an engine" />
              </SelectTrigger>
              <SelectContent>
                {model?.engines.map((e) => (
                  <SelectItem key={e} value={e}>
                    {e}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">Nodes</legend>
            {free.length === 0 ? (
              <p className="text-sm text-muted-foreground">No free nodes. Stop a deployment to free its nodes.</p>
            ) : (
              free.map((n) => (
                <div key={n.id} className="flex items-center gap-2">
                  <Checkbox
                    id={`node-${n.id}`}
                    checked={picked.includes(n.id)}
                    onCheckedChange={(c) => setPicked((p) => (c === true ? [...p, n.id] : p.filter((x) => x !== n.id)))}
                  />
                  <Label htmlFor={`node-${n.id}`} className="font-mono font-normal">
                    {n.id}
                    <span className="ml-2 font-sans text-xs text-muted-foreground">{n.model}</span>
                  </Label>
                </div>
              ))
            )}
          </fieldset>
          {problem && (model || picked.length > 0) && (
            <p className="text-sm text-level-warn" data-testid="fit-problem">
              {problem}
            </p>
          )}
        </div>
        <SheetFooter>
          <Button onClick={submit} disabled={problem !== null || create.isPending}>
            Deploy
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
```

`src/features/deployments/deployments-page.tsx`:
```tsx
import { Cable, Loader, Plus } from 'lucide-react'
import { Fragment, useState } from 'react'
import { useDeployments, useStopDeployment } from '@/api/hooks'
import type { Deployment, DeploymentStatus } from '@/api/types'
import { LiveBadge } from '@/components/live-badge'
import { PageBody, PageHeader } from '@/components/page-header'
import { QueryState } from '@/components/query-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatCompact } from '@/lib/format'
import { cn } from '@/lib/utils'
import { DeploySheet } from './deploy-sheet'

const STATUS_CLASS: Record<DeploymentStatus, string> = {
  pending: 'text-muted-foreground',
  loading: 'text-level-info',
  serving: 'text-brand',
  degraded: 'text-level-warn',
  stopped: 'text-muted-foreground',
}

function NodeChips({ d }: { d: Deployment }) {
  return (
    <div className="flex flex-wrap gap-2">
      {d.replicas.map((r) => (
        <span key={r.id} className={cn('inline-flex items-center gap-1 rounded-md', r.nodeIds.length > 1 && 'border border-brand/30 bg-brand/5 px-1 py-0.5')}>
          {r.nodeIds.map((id, i) => (
            <Fragment key={id}>
              {i > 0 && <Cable className="size-3 text-brand" aria-label="ConnectX-7 link" />}
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{id}</span>
            </Fragment>
          ))}
        </span>
      ))}
    </div>
  )
}

export function DeploymentsPage() {
  const deployments = useDeployments()
  const stop = useStopDeployment()
  const [deployOpen, setDeployOpen] = useState(false)
  const [stopping, setStopping] = useState<Deployment | null>(null)

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'AI Gateway', to: '/gateway' }, { label: 'Deployments' }]}
        title="Deployments"
        description="Models served by vLLM, Ollama, NIM and SGLang; single-node replicas and ConnectX-7 groups"
        actions={
          <>
            <LiveBadge live />
            <Button onClick={() => setDeployOpen(true)}>
              <Plus />
              Deploy model
            </Button>
          </>
        }
      />
      <PageBody>
        <QueryState query={deployments}>
          {(list) => (
            <Card className="py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead>Engine</TableHead>
                    <TableHead>Nodes</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">tok/s</TableHead>
                    <TableHead className="text-right">Context</TableHead>
                    <TableHead className="text-right">Mem / node</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((d) => (
                    <TableRow key={d.id} data-testid="deployment-row">
                      <TableCell>
                        <div className="font-medium">{d.displayName}</div>
                        <div className="font-mono text-xs text-muted-foreground">
                          {d.model} · {d.quant} · :{d.port}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{d.engine}</Badge>
                      </TableCell>
                      <TableCell>
                        <NodeChips d={d} />
                      </TableCell>
                      <TableCell>
                        <span className={cn('inline-flex items-center gap-1.5 text-sm font-medium capitalize', STATUS_CLASS[d.status])}>
                          {(d.status === 'pending' || d.status === 'loading') && <Loader className="size-3.5 motion-safe:animate-spin" />}
                          {d.status}
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{formatCompact(d.tokensPerSec)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{formatCompact(d.contextLength)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{d.memoryGBPerNode} GB</TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="ghost" onClick={() => setStopping(d)}>
                          Stop
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </QueryState>
      </PageBody>
      <DeploySheet open={deployOpen} onOpenChange={setDeployOpen} />
      <Dialog open={stopping !== null} onOpenChange={(o) => !o && setStopping(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stop {stopping?.model}?</DialogTitle>
            <DialogDescription>Agents requesting this model will get 404 from the gateway. Its nodes become free.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStopping(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (stopping) stop.mutate(stopping.id)
                setStopping(null)
              }}
            >
              Stop deployment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
```

The status cell renders the lowercase status with CSS `capitalize`. Playwright's `toContainText` checks `textContent`, which stays lowercase, so the e2e test uses case-insensitive regexes.

Replace `src/routes/deployments.tsx`:
```tsx
import { createFileRoute } from '@tanstack/react-router'
import { DeploymentsPage } from '@/features/deployments/deployments-page'

export const Route = createFileRoute('/deployments')({ component: DeploymentsPage })
```

- [ ] **Step 7: Run to verify**

Run: `pnpm test && pnpm e2e e2e/deployments.spec.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/features/deployments src/routes/deployments.tsx e2e/deployments.spec.ts
git commit -m "feat: deployments table with stop and deploy flows

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Usage

**Files:**
- Create: `src/features/usage/usage-page.tsx`, `src/features/usage/to-chart.ts`, `src/features/usage/to-chart.test.ts`, `e2e/usage.spec.ts`
- Modify: `src/routes/usage.tsx`

**Interfaces:**
- Consumes: `useUsage(range)`; `MetricChart`, `StatTile`, `TimeRangeToggle`; shadcn `ToggleGroup`, `Table`, `Progress`.
- Produces: `toUsageChart(report: UsageReport, groupBy: 'model' | 'key'): { data: MetricLike[]; series: Series[] }` with CSS-safe series keys `s0…sN` and colors `var(--cat-1…7)`; `UsagePage`; test ids `tile-cost`, `top-key-row`.

- [ ] **Step 1: Write the failing test** — `src/features/usage/to-chart.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import type { UsageReport } from '@/api/types'
import { toUsageChart } from './to-chart'

const report: UsageReport = {
  points: [{ t: 1, requests: 2, byModel: { 'qwen3.6-35b-a3b': 10, 'gpt-oss-120b': 5 }, byKey: { 'key-a': 9, 'key-b': 6 } }],
  tokensIn: 12, tokensOut: 3, requests: 2, cloudCostUsd: 0.01, topKeys: [],
  models: ['qwen3.6-35b-a3b', 'gpt-oss-120b'], keys: [{ id: 'key-a', name: 'claude' }, { id: 'key-b', name: 'codex' }],
}

describe('toUsageChart', () => {
  it('maps models to css-safe keys with categorical colors', () => {
    const { data, series } = toUsageChart(report, 'model')
    expect(series).toEqual([
      { key: 's0', label: 'qwen3.6-35b-a3b', color: 'var(--cat-1)' },
      { key: 's1', label: 'gpt-oss-120b', color: 'var(--cat-2)' },
    ])
    expect(data).toEqual([{ t: 1, s0: 10, s1: 5 }])
  })
  it('labels keys by name', () => {
    const { data, series } = toUsageChart(report, 'key')
    expect(series.map((s) => s.label)).toEqual(['claude', 'codex'])
    expect(data[0]).toEqual({ t: 1, s0: 9, s1: 6 })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/features/usage/to-chart.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/features/usage/to-chart.ts`**

```ts
import type { UsageReport } from '@/api/types'
import type { MetricLike, Series } from '@/components/metric-chart'

export function toUsageChart(report: UsageReport, groupBy: 'model' | 'key'): { data: MetricLike[]; series: Series[] } {
  const groups = groupBy === 'model' ? report.models.map((m) => ({ id: m, label: m })) : report.keys.map((k) => ({ id: k.id, label: k.name }))
  const series = groups.map((g, i) => ({ key: `s${i}`, label: g.label, color: `var(--cat-${(i % 7) + 1})` }))
  const data = report.points.map((p) => {
    const source = groupBy === 'model' ? p.byModel : p.byKey
    const row: MetricLike = { t: p.t }
    groups.forEach((g, i) => {
      row[`s${i}`] = source[g.id] ?? 0
    })
    return row
  })
  return { data, series }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/features/usage/to-chart.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing e2e test** — `e2e/usage.spec.ts`

```ts
import { expect, test } from './fixtures'

test('usage shows totals, a stacked chart and top keys', async ({ page }) => {
  await page.goto('/usage')
  await expect(page.getByTestId('tile-cost')).toContainText('$')
  await expect(page.getByTestId('chart-Tokens')).toContainText('gpt-oss-120b')
  await page.getByRole('radio', { name: 'By key' }).click()
  await expect(page.getByTestId('chart-Tokens')).toContainText('claude-code-laptop')
  await expect(page.getByTestId('top-key-row').first()).toContainText('claude-code-laptop')
  await page.getByRole('radio', { name: '7d' }).click()
  await expect(page.getByTestId('chart-Tokens')).toBeVisible()
})
```

- [ ] **Step 6: Write `src/features/usage/usage-page.tsx`**

```tsx
import { ArrowDownToLine, ArrowUpFromLine, DollarSign, Send } from 'lucide-react'
import { useState } from 'react'
import { useUsage } from '@/api/hooks'
import type { TimeRange } from '@/api/types'
import { MetricChart } from '@/components/metric-chart'
import { PageBody, PageHeader } from '@/components/page-header'
import { QueryState } from '@/components/query-state'
import { StatTile } from '@/components/stat-tile'
import { TimeRangeToggle } from '@/components/time-range-toggle'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { formatCompact, formatNumber, formatUsd } from '@/lib/format'
import { toUsageChart } from './to-chart'

export function UsagePage() {
  const [range, setRange] = useState<TimeRange>('24h')
  const [groupBy, setGroupBy] = useState<'model' | 'key'>('model')
  const usage = useUsage(range)

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'AI Gateway', to: '/gateway' }, { label: 'Usage' }]}
        title="Usage"
        description="Tokens and requests through the gateway, by model and by API key"
        actions={
          <>
            <ToggleGroup type="single" variant="outline" size="sm" value={groupBy} onValueChange={(v) => v && setGroupBy(v as 'model' | 'key')} aria-label="Group by">
              <ToggleGroupItem value="model" className="px-3">By model</ToggleGroupItem>
              <ToggleGroupItem value="key" className="px-3">By key</ToggleGroupItem>
            </ToggleGroup>
            <TimeRangeToggle value={range} onChange={setRange} ranges={['1h', '24h', '7d']} />
          </>
        }
      />
      <PageBody>
        <QueryState query={usage} skeleton={<Skeleton className="h-96 w-full" />}>
          {(r) => {
            const chart = toUsageChart(r, groupBy)
            const totalTokens = r.tokensIn + r.tokensOut
            return (
              <>
                <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                  <StatTile label="Tokens in" value={formatCompact(r.tokensIn)} icon={ArrowDownToLine} hint="prompt tokens" />
                  <StatTile label="Tokens out" value={formatCompact(r.tokensOut)} icon={ArrowUpFromLine} hint="completion tokens" />
                  <StatTile label="Requests" value={formatCompact(r.requests)} icon={Send} />
                  <StatTile testId="tile-cost" label="Cloud equivalent" value={formatUsd(r.cloudCostUsd)} icon={DollarSign} tone="brand" hint="at an assumed $3 / $15 per 1M in / out tokens" />
                </div>
                <MetricChart title="Tokens" data={chart.data} series={chart.series} range={range} stacked height={260} format={(v) => formatCompact(v)} />
                <Card className="gap-0 py-0">
                  <CardHeader className="border-b py-4">
                    <CardTitle className="text-sm">Top API keys</CardTitle>
                  </CardHeader>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Key</TableHead>
                        <TableHead className="text-right">Tokens</TableHead>
                        <TableHead className="text-right">Requests</TableHead>
                        <TableHead className="w-48">Share</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {r.topKeys.map((k) => (
                        <TableRow key={k.keyId} data-testid="top-key-row">
                          <TableCell className="font-mono">{k.name}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums">{formatCompact(k.tokens)}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums">{formatNumber(k.requests)}</TableCell>
                          <TableCell>
                            <Progress value={totalTokens ? (k.tokens / totalTokens) * 100 : 0} aria-label={`${k.name} share`} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Card>
              </>
            )
          }}
        </QueryState>
      </PageBody>
    </>
  )
}
```

Replace `src/routes/usage.tsx`:
```tsx
import { createFileRoute } from '@tanstack/react-router'
import { UsagePage } from '@/features/usage/usage-page'

export const Route = createFileRoute('/usage')({ component: UsagePage })
```

- [ ] **Step 7: Run to verify, then commit**

Run: `pnpm test && pnpm e2e e2e/usage.spec.ts` — expected PASS.

```bash
git add src/features/usage src/routes/usage.tsx e2e/usage.spec.ts
git commit -m "feat: usage page with tokens by model/key and top keys

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: API keys

**Files:**
- Create: `src/features/keys/keys-page.tsx`, `src/features/keys/create-key-dialog.tsx`, `e2e/keys.spec.ts`
- Modify: `src/routes/keys.tsx`

**Interfaces:**
- Consumes: `useKeys`, `useCreateKey`, `useRevokeKey`; `CopyButton`; shadcn `Dialog`, `Input`, `Label`, `Select`, `Table`, `Badge`, `Alert`.
- Produces: `KeysPage`, `CreateKeyDialog({ open, onOpenChange })`; test ids `key-row`, `new-secret`.

- [ ] **Step 1: Write the failing e2e test** — `e2e/keys.spec.ts`

```ts
import { expect, test } from './fixtures'

test('create a key, see the secret once, then revoke it', async ({ page }) => {
  await page.goto('/keys')
  await expect(page.getByTestId('key-row')).toHaveCount(7)
  await page.getByRole('button', { name: 'Create key' }).click()
  const create = page.getByRole('button', { name: 'Create', exact: true })
  await expect(create).toBeDisabled()
  await page.getByLabel('Name').fill('playwright-agent')
  await create.click()
  await expect(page.getByTestId('new-secret')).toHaveText(/^sk-spark-[A-Za-z0-9]{32}$/)
  await page.getByRole('button', { name: 'Done' }).click()
  const row = page.getByTestId('key-row').filter({ hasText: 'playwright-agent' })
  await expect(row).toBeVisible()
  await expect(row).toContainText('never')
  await row.getByRole('button', { name: 'Revoke' }).click()
  await page.getByRole('button', { name: 'Revoke key' }).click()
  await expect(row).toContainText('Revoked')
  await expect(row.getByRole('button', { name: 'Revoke' })).toHaveCount(0)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm e2e e2e/keys.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/features/keys/create-key-dialog.tsx`**

```tsx
import { TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useCreateKey } from '@/api/hooks'
import { CopyButton } from '@/components/copy-button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const LIMITS = [60, 120, 300, 600]

export function CreateKeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const create = useCreateKey()
  const [name, setName] = useState('')
  const [limit, setLimit] = useState('300')
  const [secret, setSecret] = useState<string | null>(null)

  const close = () => {
    setName('')
    setLimit('300')
    setSecret(null)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent>
        {secret ? (
          <>
            <DialogHeader>
              <DialogTitle>Key created</DialogTitle>
              <DialogDescription>Copy it now and store it in your agent’s environment as SPARKMAN_API_KEY.</DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2 rounded-lg border bg-surface-2 px-3 py-2">
              <code className="flex-1 break-all font-mono text-sm" data-testid="new-secret">
                {secret}
              </code>
              <CopyButton value={secret} toastText="Key copied" />
            </div>
            <Alert>
              <TriangleAlert />
              <AlertTitle>You won’t see this key again</AlertTitle>
              <AlertDescription>SparkMan stores only the prefix. If you lose it, revoke it and create another.</AlertDescription>
            </Alert>
            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              create.mutate({ name, rateLimitRpm: Number(limit) }, { onSuccess: (r) => setSecret(r.secret) })
            }}
          >
            <DialogHeader>
              <DialogTitle>Create API key</DialogTitle>
              <DialogDescription>One key per agent or tool makes usage and revocation easy.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor="key-name">Name</Label>
              <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="claude-code-laptop" autoFocus />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="key-limit">Rate limit</Label>
              <Select value={limit} onValueChange={setLimit}>
                <SelectTrigger id="key-limit" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LIMITS.map((l) => (
                    <SelectItem key={l} value={String(l)}>
                      {l} requests / minute
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim() || create.isPending}>
                Create
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 4: Write `src/features/keys/keys-page.tsx`**

```tsx
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { useKeys, useRevokeKey } from '@/api/hooks'
import type { ApiKey } from '@/api/types'
import { PageBody, PageHeader } from '@/components/page-header'
import { QueryState } from '@/components/query-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatNumber, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { CreateKeyDialog } from './create-key-dialog'

export function KeysPage() {
  const keys = useKeys()
  const revoke = useRevokeKey()
  const [createOpen, setCreateOpen] = useState(false)
  const [revoking, setRevoking] = useState<ApiKey | null>(null)
  const now = Date.now()

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'AI Gateway', to: '/gateway' }, { label: 'API Keys' }]}
        title="API Keys"
        description="One key per agent or tool. Keys are shown once at creation."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus />
            Create key
          </Button>
        }
      />
      <PageBody>
        <QueryState query={keys}>
          {(list) => (
            <Card className="py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Key</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Last used</TableHead>
                    <TableHead className="text-right">Rate limit</TableHead>
                    <TableHead className="text-right">Requests 24h</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((k) => {
                    const revoked = k.revokedAt !== null
                    return (
                      <TableRow key={k.id} data-testid="key-row" className={cn(revoked && 'opacity-60')}>
                        <TableCell className="font-medium">{k.name}</TableCell>
                        <TableCell className="font-mono text-xs">{k.prefix}••••••••</TableCell>
                        <TableCell className="text-muted-foreground">{formatRelative(k.createdAt, now)}</TableCell>
                        <TableCell className="text-muted-foreground">{k.lastUsedAt ? formatRelative(k.lastUsedAt, now) : 'never'}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{k.rateLimitRpm}/min</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{formatNumber(k.requests24h)}</TableCell>
                        <TableCell className="text-right">
                          {revoked ? (
                            <Badge variant="outline" className="text-muted-foreground">
                              Revoked
                            </Badge>
                          ) : (
                            <Button size="sm" variant="ghost" onClick={() => setRevoking(k)}>
                              Revoke
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </Card>
          )}
        </QueryState>
      </PageBody>
      <CreateKeyDialog open={createOpen} onOpenChange={setCreateOpen} />
      <Dialog open={revoking !== null} onOpenChange={(o) => !o && setRevoking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke {revoking?.name}?</DialogTitle>
            <DialogDescription>Agents using this key will get 401 immediately. This can’t be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (revoking) revoke.mutate(revoking.id)
                setRevoking(null)
              }}
            >
              Revoke key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
```

Replace `src/routes/keys.tsx`:
```tsx
import { createFileRoute } from '@tanstack/react-router'
import { KeysPage } from '@/features/keys/keys-page'

export const Route = createFileRoute('/keys')({ component: KeysPage })
```

- [ ] **Step 5: Run to verify, then commit**

Run: `pnpm e2e e2e/keys.spec.ts` — expected PASS.

```bash
git add src/features/keys src/routes/keys.tsx e2e/keys.spec.ts
git commit -m "feat: API key management with one-time secret reveal

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: Alerts

**Files:**
- Create: `src/features/alerts/alerts-page.tsx`, `src/features/alerts/incident-sheet.tsx`, `e2e/alerts.spec.ts`
- Modify: `src/routes/alerts.tsx`

**Interfaces:**
- Consumes: `useIncidents`, `useAlertRules`, `useResolveIncident`, `useSetRuleEnabled`; shadcn `Sheet`, `Switch`, `Table`, `Badge`; `Link` to `/logs` with `search={{ q, range }}`.
- Produces: `AlertsPage`, `IncidentSheet({ incident, onClose })`; test ids `incident-row`, `rule-row`.

- [ ] **Step 1: Write the failing e2e test** — `e2e/alerts.spec.ts`

```ts
import { expect, test } from './fixtures'

test('open, inspect and resolve the ongoing incident', async ({ page }) => {
  await page.goto('/alerts')
  await expect(page.getByTestId('alert-count')).toHaveText('1')
  const row = page.getByTestId('incident-row').filter({ hasText: 'spark-05 thermal throttling' })
  await expect(row).toContainText('ongoing')
  await row.click()
  await expect(page.getByText('GPU temperature crossed 80 °C (sustained 5 min)')).toBeVisible()
  await page.getByRole('button', { name: 'Resolve' }).click()
  await expect(row).toContainText('resolved')
  await expect(page.getByTestId('alert-count')).toHaveCount(0)
})

test('incident links to related logs', async ({ page }) => {
  await page.goto('/alerts')
  await page.getByTestId('incident-row').filter({ hasText: 'Xid 31 on spark-05' }).click()
  await page.getByRole('link', { name: 'View related logs' }).click()
  await expect(page).toHaveURL(/\/logs\?/)
  await expect(page.getByRole('textbox', { name: 'Log query' })).toHaveValue('host:spark-05')
})

test('toggle an alert rule', async ({ page }) => {
  await page.goto('/alerts')
  const rule = page.getByTestId('rule-row').filter({ hasText: 'Update failed' })
  const toggle = rule.getByRole('switch')
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm e2e e2e/alerts.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/features/alerts/incident-sheet.tsx`**

```tsx
import { Link } from '@tanstack/react-router'
import { useResolveIncident } from '@/api/hooks'
import type { Incident } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { formatDateTime, formatDuration } from '@/lib/format'

export function IncidentSheet({ incident, onClose }: { incident: Incident | null; onClose: () => void }) {
  const resolve = useResolveIncident()
  return (
    <Sheet open={incident !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-[480px] sm:max-w-[480px]">
        {incident && (
          <>
            <SheetHeader>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className={incident.severity === 'critical' ? 'text-level-error' : 'text-level-warn'}>
                  {incident.severity}
                </Badge>
                <Badge variant="secondary">{incident.status}</Badge>
              </div>
              <SheetTitle>{incident.title}</SheetTitle>
              <SheetDescription>
                Started {formatDateTime(incident.startedAt)}
                {incident.resolvedAt ? ` · lasted ${formatDuration(incident.resolvedAt - incident.startedAt)}` : ''}
              </SheetDescription>
            </SheetHeader>
            <ol className="flex flex-col gap-4 border-l px-4 pl-6">
              {incident.timeline.map((e) => (
                <li key={`${e.ts}-${e.text}`} className="relative">
                  <span className="absolute -left-[1.6rem] top-1.5 size-2 rounded-full bg-brand" />
                  <p className="text-sm">{e.text}</p>
                  <p className="font-mono text-xs text-muted-foreground">{formatDateTime(e.ts)}</p>
                </li>
              ))}
            </ol>
            <SheetFooter className="flex-row gap-2">
              <Button variant="outline" asChild>
                <Link to="/logs" search={{ q: incident.nodeId ? `host:${incident.nodeId}` : 'source:gateway level:error', range: '24h' }}>
                  View related logs
                </Link>
              </Button>
              {incident.status === 'ongoing' && (
                <Button onClick={() => resolve.mutate(incident.id, { onSuccess: onClose })} disabled={resolve.isPending}>
                  Resolve
                </Button>
              )}
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
```

The Xid incident started ~2 days ago, beyond 24 h. The logs page still opens with the node filter applied (the e2e test checks the query, not matching lines). That's acceptable; an analyst widens to 7d.

- [ ] **Step 4: Write `src/features/alerts/alerts-page.tsx`**

```tsx
import { useState } from 'react'
import { useAlertRules, useIncidents, useSetRuleEnabled } from '@/api/hooks'
import { PageBody, PageHeader } from '@/components/page-header'
import { QueryState } from '@/components/query-state'
import { Badge } from '@/components/ui/badge'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDuration, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { IncidentSheet } from './incident-sheet'

export function AlertsPage() {
  const incidents = useIncidents()
  const rules = useAlertRules()
  const setRule = useSetRuleEnabled()
  const [openId, setOpenId] = useState<string | null>(null)
  const now = Date.now()
  const open = incidents.data?.find((i) => i.id === openId) ?? null

  return (
    <>
      <PageHeader crumbs={[{ label: 'Observe', to: '/logs' }, { label: 'Alerts' }]} title="Alerts" description="Incidents opened by alert rules, with timelines and links to the evidence" />
      <PageBody>
        <Card className="gap-0 py-0">
          <CardHeader className="border-b py-4">
            <CardTitle className="text-sm">Incidents</CardTitle>
          </CardHeader>
          <QueryState query={incidents}>
            {(list) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Severity</TableHead>
                    <TableHead>Incident</TableHead>
                    <TableHead>Node</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((i) => (
                    <TableRow key={i.id} data-testid="incident-row" className="cursor-pointer" onClick={() => setOpenId(i.id)}>
                      <TableCell>
                        <Badge variant="outline" className={i.severity === 'critical' ? 'text-level-error' : 'text-level-warn'}>
                          {i.severity}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-medium">{i.title}</TableCell>
                      <TableCell className="font-mono text-xs">{i.nodeId ?? 'gateway'}</TableCell>
                      <TableCell className="text-muted-foreground">{formatRelative(i.startedAt, now)}</TableCell>
                      <TableCell className="font-mono tabular-nums">{formatDuration((i.resolvedAt ?? now) - i.startedAt)}</TableCell>
                      <TableCell>
                        <span className={cn('text-sm font-medium', i.status === 'ongoing' ? 'text-level-warn' : 'text-muted-foreground')}>{i.status}</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </QueryState>
        </Card>

        <Card className="gap-0 py-0">
          <CardHeader className="border-b py-4">
            <CardTitle className="text-sm">Rules</CardTitle>
            <CardDescription>Evaluated every 30 s against node telemetry, kernel logs and gateway metrics.</CardDescription>
          </CardHeader>
          <QueryState query={rules}>
            {(list) => (
              <Table>
                <TableBody>
                  {list.map((r) => (
                    <TableRow key={r.id} data-testid="rule-row">
                      <TableCell className="font-medium">{r.name}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{r.condition}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={r.severity === 'critical' ? 'text-level-error' : 'text-level-warn'}>
                          {r.severity}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Switch checked={r.enabled} onCheckedChange={(enabled) => setRule.mutate({ id: r.id, enabled })} aria-label={`Enable ${r.name}`} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </QueryState>
        </Card>
      </PageBody>
      <IncidentSheet incident={open} onClose={() => setOpenId(null)} />
    </>
  )
}
```

Replace `src/routes/alerts.tsx`:
```tsx
import { createFileRoute } from '@tanstack/react-router'
import { AlertsPage } from '@/features/alerts/alerts-page'

export const Route = createFileRoute('/alerts')({ component: AlertsPage })
```

- [ ] **Step 5: Run to verify, then commit**

Run: `pnpm e2e e2e/alerts.spec.ts` — expected PASS.

```bash
git add src/features/alerts src/routes/alerts.tsx e2e/alerts.spec.ts
git commit -m "feat: alerts page with incident timelines, resolve and rule toggles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19: Updates and staged rollouts

**Files:**
- Create: `src/features/updates/updates-page.tsx`, `src/features/updates/rollout-sheet.tsx`, `src/features/updates/rollout-progress.tsx`, `e2e/updates.spec.ts`
- Modify: `src/routes/updates.tsx`

**Interfaces:**
- Consumes: `useNodeUpdates`, `useRollouts`, `useStartRollout`, `useApproveRollout`; shadcn `Sheet`, `Checkbox`, `Select`, `Switch`, `Label`, `Alert`, `Table`, `Badge`, `Tooltip`.
- Produces: `UpdatesPage`, `RolloutSheet({ open, onOpenChange })`, `RolloutProgress({ rollout })`, `RING_LABEL: Record<UpdateRing, string>`; test ids `active-rollout`, `rollout-node-<id>` (with `data-step`), `update-row`, `history-row`.

- [ ] **Step 1: Write the failing e2e test** — `e2e/updates.spec.ts`

```ts
import { expect, test } from './fixtures'

test('plan button disabled during rollout; canary rollout completes', async ({ page }) => {
  await page.goto('/updates')
  await expect(page.getByTestId('update-row')).toHaveCount(12)
  await expect(page.getByTestId('update-row').filter({ hasText: 'gx10-01' })).toContainText('stage carefully')
  await page.getByRole('button', { name: 'Plan rollout' }).click()
  await page.getByRole('checkbox', { name: /Ring 1/ }).uncheck()
  await page.getByRole('checkbox', { name: /Ring 2/ }).uncheck()
  await page.getByRole('button', { name: 'Create rollout' }).click()

  const active = page.getByTestId('active-rollout')
  await expect(active).toContainText('Awaiting approval')
  await expect(page.getByRole('button', { name: 'Plan rollout' })).toBeDisabled()
  await active.getByRole('button', { name: 'Approve' }).click()
  await expect(active).toContainText('Running')
  await expect(page.getByTestId('rollout-node-spark-08')).toHaveAttribute('data-step', /precheck|apply|reboot|postcheck/)

  await expect(page.getByTestId('history-row').first()).toContainText('DGX OS 7.5.0', { timeout: 45_000 })
  await expect(page.getByRole('button', { name: 'Plan rollout' })).toBeEnabled()
  await expect(page.getByTestId('update-row').filter({ hasText: 'spark-08' })).toContainText('Up to date')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm e2e e2e/updates.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/features/updates/rollout-progress.tsx`**

```tsx
import { useApproveRollout } from '@/api/hooks'
import type { Rollout, RolloutStep, UpdateRing } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export const RING_LABEL: Record<UpdateRing, string> = { canary: 'Canary', ring1: 'Ring 1', ring2: 'Ring 2' }
const STEPS: RolloutStep[] = ['precheck', 'apply', 'reboot', 'postcheck']
const STATUS_LABEL: Record<Rollout['status'], string> = { 'awaiting-approval': 'Awaiting approval', running: 'Running', completed: 'Completed', failed: 'Failed' }

function stepState(current: RolloutStep, step: RolloutStep): 'done' | 'active' | 'todo' {
  if (current === 'done') return 'done'
  const ci = STEPS.indexOf(current)
  const si = STEPS.indexOf(step)
  if (ci === -1) return 'todo'
  return si < ci ? 'done' : si === ci ? 'active' : 'todo'
}

export function RolloutProgress({ rollout }: { rollout: Rollout }) {
  const approve = useApproveRollout()
  return (
    <Card data-testid="active-rollout">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          {rollout.name}
          <Badge variant="outline" className={rollout.status === 'running' ? 'text-brand' : 'text-level-warn'}>
            {STATUS_LABEL[rollout.status]}
          </Badge>
        </CardTitle>
        <CardDescription>
          {rollout.rings.map((r) => RING_LABEL[r]).join(' → ')} · window: {rollout.window}
        </CardDescription>
        {rollout.status === 'awaiting-approval' && (
          <CardAction>
            <Button size="sm" onClick={() => approve.mutate(rollout.id)} disabled={approve.isPending}>
              Approve
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {rollout.rings.map((ring) => (
          <div key={ring} className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{RING_LABEL[ring]}</h3>
            {rollout.nodes
              .filter((n) => n.ring === ring)
              .map((n) => (
                <div key={n.nodeId} className="flex items-center gap-3" data-testid={`rollout-node-${n.nodeId}`} data-step={n.step}>
                  <span className="w-20 font-mono text-sm">{n.nodeId}</span>
                  <div className="flex flex-1 gap-1">
                    {STEPS.map((s) => {
                      const st = stepState(n.step, s)
                      return (
                        <span
                          key={s}
                          className={cn(
                            'flex-1 rounded px-2 py-1 text-center font-mono text-[11px]',
                            st === 'done' && 'bg-brand/15 text-brand',
                            st === 'active' && 'bg-level-info/20 text-level-info motion-safe:animate-pulse',
                            st === 'todo' && 'bg-muted text-muted-foreground',
                          )}
                        >
                          {s}
                        </span>
                      )
                    })}
                  </div>
                </div>
              ))}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 4: Write `src/features/updates/rollout-sheet.tsx`**

```tsx
import { TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useStartRollout } from '@/api/hooks'
import type { UpdateRing } from '@/api/types'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { RING_LABEL } from './rollout-progress'

const RINGS: { ring: UpdateRing; nodes: number }[] = [
  { ring: 'canary', nodes: 1 },
  { ring: 'ring1', nodes: 3 },
  { ring: 'ring2', nodes: 8 },
]
const WINDOWS = ['Now', 'Tonight 02:00–04:00', 'Sunday 02:00–04:00']

export function RolloutSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const start = useStartRollout()
  const [rings, setRings] = useState<UpdateRing[]>(['canary', 'ring1', 'ring2'])
  const [window, setWindow] = useState(WINDOWS[0])
  const [requireApproval, setRequireApproval] = useState(true)
  const nodeCount = RINGS.filter((r) => rings.includes(r.ring)).reduce((s, r) => s + r.nodes, 0)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[440px] sm:max-w-[440px]">
        <SheetHeader>
          <SheetTitle>Plan rollout</SheetTitle>
          <SheetDescription>spark_updatectl runs precheck → apply → reboot → postcheck on each ring before moving to the next.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-5 px-4">
          <div className="flex flex-col gap-2">
            <Label>Target</Label>
            <p className="rounded-lg border bg-surface-2 px-3 py-2 font-mono text-sm">DGX OS 7.5.0 · driver 580.159.03 · CUDA 13.0.2 · UEFI 1.110.13</p>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">Rings</legend>
            {RINGS.map((r) => (
              <div key={r.ring} className="flex items-center gap-2">
                <Checkbox
                  id={`ring-${r.ring}`}
                  checked={rings.includes(r.ring)}
                  onCheckedChange={(c) => setRings((prev) => (c === true ? [...prev, r.ring] : prev.filter((x) => x !== r.ring)))}
                />
                <Label htmlFor={`ring-${r.ring}`} className="font-normal">
                  {RING_LABEL[r.ring]} · {r.nodes} node{r.nodes > 1 ? 's' : ''}
                </Label>
              </div>
            ))}
          </fieldset>
          <div className="flex flex-col gap-2">
            <Label htmlFor="rollout-window">Maintenance window</Label>
            <Select value={window} onValueChange={setWindow}>
              <SelectTrigger id="rollout-window" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WINDOWS.map((w) => (
                  <SelectItem key={w} value={w}>
                    {w}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="rollout-approval">Require approval before starting</Label>
            <Switch id="rollout-approval" checked={requireApproval} onCheckedChange={setRequireApproval} />
          </div>
          {rings.includes('ring2') && (
            <Alert>
              <TriangleAlert />
              <AlertTitle>Ring 2 includes 4 ASUS GX10 units</AlertTitle>
              <AlertDescription>ASUS SOC capsule firmware has bricked units in the field. Let Canary and Ring 1 soak first.</AlertDescription>
            </Alert>
          )}
          <p className="text-sm text-muted-foreground">
            {nodeCount} node{nodeCount === 1 ? '' : 's'} · each reboots once
          </p>
        </div>
        <SheetFooter>
          <Button
            disabled={rings.length === 0 || start.isPending}
            onClick={() =>
              start.mutate(
                { targetOs: '7.5.0', rings, window, requireApproval },
                { onSuccess: () => onOpenChange(false) },
              )
            }
          >
            Create rollout
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
```

- [ ] **Step 5: Write `src/features/updates/updates-page.tsx`**

```tsx
import { useState } from 'react'
import { useNodeUpdates, useRollouts } from '@/api/hooks'
import { PageBody, PageHeader } from '@/components/page-header'
import { QueryState } from '@/components/query-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatDateTime, formatDuration, formatRelative } from '@/lib/format'
import { RING_LABEL, RolloutProgress } from './rollout-progress'
import { RolloutSheet } from './rollout-sheet'

export function UpdatesPage() {
  const updates = useNodeUpdates()
  const rollouts = useRollouts()
  const [planOpen, setPlanOpen] = useState(false)
  const now = Date.now()
  const active = rollouts.data?.find((r) => r.status === 'running' || r.status === 'awaiting-approval')
  const history = rollouts.data?.filter((r) => r.status === 'completed' || r.status === 'failed') ?? []

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Maintain', to: '/updates' }, { label: 'Updates' }]}
        title="Updates"
        description="DGX OS, apt packages and firmware (fwupd / ASUS capsules), rolled out ring by ring"
        actions={
          <Button onClick={() => setPlanOpen(true)} disabled={!rollouts.data || active !== undefined}>
            Plan rollout
          </Button>
        }
      />
      <PageBody>
        {active && <RolloutProgress rollout={active} />}

        <Card className="gap-0 py-0">
          <CardHeader className="border-b py-4">
            <CardTitle className="text-sm">Nodes</CardTitle>
          </CardHeader>
          <QueryState query={updates}>
            {(list) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Node</TableHead>
                    <TableHead>Ring</TableHead>
                    <TableHead>DGX OS</TableHead>
                    <TableHead>Packages</TableHead>
                    <TableHead>Firmware</TableHead>
                    <TableHead>Reboot</TableHead>
                    <TableHead className="text-right">Checked</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((u) => {
                    const upToDate = u.currentOs === u.targetOs && u.aptPending.length === 0 && u.firmwarePending.length === 0
                    return (
                      <TableRow key={u.nodeId} data-testid="update-row">
                        <TableCell className="font-mono">{u.nodeId}</TableCell>
                        <TableCell>{RING_LABEL[u.ring]}</TableCell>
                        <TableCell className="font-mono text-xs">{upToDate ? <span className="text-brand">Up to date · {u.currentOs}</span> : `${u.currentOs} → ${u.targetOs}`}</TableCell>
                        <TableCell>
                          {u.aptPending.length === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-help font-mono text-sm underline decoration-dotted">{u.aptPending.length} pending</span>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-xs font-mono text-xs">{u.aptPending.join(', ')}</TooltipContent>
                            </Tooltip>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-1.5">
                            {u.firmwarePending.length === 0 && <span className="text-muted-foreground">—</span>}
                            {u.firmwarePending.map((f) => (
                              <Badge key={f.component} variant="outline" className="font-mono text-[11px]">
                                {f.component} {f.available}
                              </Badge>
                            ))}
                            {u.model === 'ASUS GX10' && u.firmwarePending.length > 0 && (
                              <Badge variant="outline" className="text-level-warn">
                                stage carefully
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>{u.rebootRequired ? <Badge variant="outline" className="text-level-warn">required</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>
                        <TableCell className="text-right text-muted-foreground">{formatRelative(u.lastChecked, now)}</TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </QueryState>
        </Card>

        <Card className="gap-0 py-0">
          <CardHeader className="border-b py-4">
            <CardTitle className="text-sm">History</CardTitle>
          </CardHeader>
          <Table>
            <TableBody>
              {history.map((r) => (
                <TableRow key={r.id} data-testid="history-row">
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell>{r.rings.map((x) => RING_LABEL[x]).join(' → ')}</TableCell>
                  <TableCell className="text-muted-foreground">{r.startedAt ? formatDateTime(r.startedAt) : '—'}</TableCell>
                  <TableCell className="font-mono tabular-nums">{r.startedAt && r.finishedAt ? formatDuration(r.finishedAt - r.startedAt) : '—'}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={r.status === 'completed' ? 'text-brand' : 'text-level-error'}>
                      {r.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </PageBody>
      <RolloutSheet open={planOpen} onOpenChange={setPlanOpen} />
    </>
  )
}
```

Replace `src/routes/updates.tsx`:
```tsx
import { createFileRoute } from '@tanstack/react-router'
import { UpdatesPage } from '@/features/updates/updates-page'

export const Route = createFileRoute('/updates')({ component: UpdatesPage })
```

If the generated `card.tsx` has no `CardAction` export, place the Approve button inside `CardHeader` using `className="flex flex-row items-start justify-between"`. `useNodeUpdates` has no `meta.live`. It refreshes through the `updates` topic, which the simulator emits at each ring step and on completion (see `advanceRollouts`).

- [ ] **Step 6: Run to verify, then commit**

Run: `pnpm e2e e2e/updates.spec.ts` — expected PASS (about 25 s).

```bash
git add src/features/updates src/routes/updates.tsx e2e/updates.spec.ts
git commit -m "feat: update status and ring-based rollouts with approval gate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 20: Settings and simulator controls

**Files:**
- Create: `src/lib/use-local-setting.ts`, `src/lib/use-local-setting.test.tsx`, `src/features/settings/settings-page.tsx`, `e2e/settings.spec.ts`
- Modify: `src/routes/settings.tsx`

**Interfaces:**
- Consumes: `useFleetConfig`, `useGatewayInfo`, `useNodes`, `useFailures`, `useSetFailures`; `useTheme` from `next-themes`; shadcn `ToggleGroup`, `Select`, `Switch`, `Label`, `Table`.
- Produces: `useLocalSetting<T extends string>(key: string, fallback: T): [T, (v: T) => void]`, which is safe when `localStorage` throws; `SettingsPage`.

- [ ] **Step 1: Write the failing hook test** — `src/lib/use-local-setting.test.tsx`

```tsx
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useLocalSetting } from './use-local-setting'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('useLocalSetting', () => {
  it('reads the fallback, writes, and re-reads persisted values', () => {
    const { result } = renderHook(() => useLocalSetting('sparkman.test', 'a'))
    expect(result.current[0]).toBe('a')
    act(() => result.current[1]('b'))
    expect(result.current[0]).toBe('b')
    expect(localStorage.getItem('sparkman.test')).toBe('b')
    const again = renderHook(() => useLocalSetting('sparkman.test', 'a'))
    expect(again.result.current[0]).toBe('b')
  })
  it('survives a throwing localStorage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const { result } = renderHook(() => useLocalSetting('sparkman.test', 'x'))
    expect(result.current[0]).toBe('x')
    act(() => result.current[1]('y'))
    expect(result.current[0]).toBe('y')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/lib/use-local-setting.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/lib/use-local-setting.ts`**

```ts
import { useState } from 'react'

function read<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T | null) ?? fallback
  } catch {
    return fallback
  }
}

export function useLocalSetting<T extends string>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => read(key, fallback))
  const set = (v: T) => {
    setValue(v)
    try {
      localStorage.setItem(key, v)
    } catch {
      // storage unavailable (private mode / blocked): keep the in-memory value
    }
  }
  return [value, set]
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/lib/use-local-setting.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing e2e test** — `e2e/settings.spec.ts`

```ts
import { expect, test } from './fixtures'

test('theme switch persists across reloads', async ({ page }) => {
  await page.goto('/settings')
  await page.getByRole('radio', { name: 'Light' }).click()
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  await page.reload()
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  await page.getByRole('radio', { name: 'Dark' }).click()
  await expect(page.locator('html')).toHaveClass(/dark/)
})

test('injected offline node shows offline state', async ({ page }) => {
  await page.goto('/settings')
  await page.getByRole('combobox', { name: 'Take a node offline' }).click()
  await page.getByRole('option', { name: 'spark-03' }).click()
  // navigate client-side: a full reload would reset the in-memory simulator
  await page.getByRole('link', { name: 'Nodes', exact: true }).click()
  await page.getByTestId('filter-offline').click()
  await expect(page.getByTestId('node-row')).toHaveCount(1)
  await page.getByTestId('node-row').click()
  await expect(page.getByTestId('node-status')).toHaveText('Offline')
  await expect(page.getByTestId('chart-GPU utilization')).toContainText('—')
  await expect(page.getByTestId('alert-count')).toHaveText('2')
})

test('failed API requests show the error state with retry', async ({ page }) => {
  await page.goto('/settings')
  await page.getByRole('switch', { name: 'Fail API requests' }).click()
  await page.getByRole('link', { name: 'Deployments', exact: true }).click()
  await expect(page.getByText('Couldn’t load data')).toBeVisible()
  await expect(page.getByText('Simulated API failure (Settings → Simulator)')).toBeVisible()
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await page.getByRole('switch', { name: 'Fail API requests' }).click()
  await page.getByRole('link', { name: 'Deployments', exact: true }).click()
  await expect(page.getByTestId('deployment-row').first()).toBeVisible()
})

test('injected gateway errors show on the endpoint page', async ({ page }) => {
  await page.goto('/settings')
  await page.getByRole('switch', { name: 'Gateway 5xx errors' }).click()
  await page.getByRole('link', { name: 'Endpoint', exact: true }).click()
  await expect(page.getByTestId('tile-errors')).toContainText(/\b([5-9]|1\d)\.\d%/)
})
```

- [ ] **Step 6: Write `src/features/settings/settings-page.tsx`**

```tsx
import { Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import type { ReactNode } from 'react'
import { useFailures, useFleetConfig, useGatewayInfo, useNodes, useSetFailures } from '@/api/hooks'
import { PageBody, PageHeader } from '@/components/page-header'
import { QueryState } from '@/components/query-state'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useLocalSetting } from '@/lib/use-local-setting'

const NONE = '__none__'

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="grid items-center gap-2 sm:grid-cols-[14rem_1fr]">
      <Label htmlFor={htmlFor} className="text-muted-foreground">
        {label}
      </Label>
      <div>{children}</div>
    </div>
  )
}

export function SettingsPage() {
  const { resolvedTheme, setTheme } = useTheme()
  const config = useFleetConfig()
  const gateway = useGatewayInfo()
  const nodes = useNodes()
  const failures = useFailures()
  const setFailures = useSetFailures()
  const [defaultModel, setDefaultModel] = useLocalSetting('sparkman.defaultModel', 'qwen3-235b-a22b')
  const [retention, setRetention] = useLocalSetting('sparkman.logRetentionDays', '30')

  return (
    <>
      <PageHeader crumbs={[{ label: 'Maintain', to: '/updates' }, { label: 'Settings' }]} title="Settings" description="Appearance, fleet connection, gateway defaults and simulator controls" />
      <PageBody className="max-w-4xl">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Appearance</CardTitle>
          </CardHeader>
          <CardContent>
            <Field label="Theme">
              <ToggleGroup type="single" variant="outline" size="sm" value={resolvedTheme} onValueChange={(v) => v && setTheme(v)} aria-label="Theme">
                <ToggleGroupItem value="dark" className="gap-1.5 px-3">
                  <Moon className="size-3.5" />
                  Dark
                </ToggleGroupItem>
                <ToggleGroupItem value="light" className="gap-1.5 px-3">
                  <Sun className="size-3.5" />
                  Light
                </ToggleGroupItem>
              </ToggleGroup>
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Fleet connection</CardTitle>
            <CardDescription>Agentless: SparkMan runs the DGX Spark manageability tools over SSH (BatchMode) and reads their JSON envelopes. Read-only in the prototype.</CardDescription>
          </CardHeader>
          <CardContent>
            <QueryState query={config}>
              {(c) => (
                <div className="flex flex-col gap-4">
                  <Field label="SSH user">
                    <code className="font-mono text-sm">{c.sshUser}</code>
                  </Field>
                  <Field label="SSH key">
                    <code className="font-mono text-sm">{c.sshKeyPath}</code>
                  </Field>
                  <Table>
                    <TableBody>
                      {c.hosts.map((h) => (
                        <TableRow key={h.id}>
                          <TableCell className="font-mono">{h.id}</TableCell>
                          <TableCell className="font-mono text-muted-foreground">{h.ip}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </QueryState>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Gateway</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Field label="Base URL">
              <code className="font-mono text-sm">{gateway.data?.baseUrl ?? '—'}</code>
            </Field>
            <Field label="Default model" htmlFor="default-model">
              <Select value={defaultModel} onValueChange={setDefaultModel}>
                <SelectTrigger id="default-model" className="w-72">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(gateway.data?.models ?? [defaultModel]).map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Log retention" htmlFor="retention">
              <Select value={retention} onValueChange={setRetention}>
                <SelectTrigger id="retention" className="w-72">
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
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Simulator</CardTitle>
            <CardDescription>Inject failures to exercise offline, error and incident states. Resets on page reload.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Field label="Take a node offline" htmlFor="sim-offline">
              <Select value={failures.data?.nodeOffline ?? NONE} onValueChange={(v) => setFailures.mutate({ nodeOffline: v === NONE ? null : v })}>
                <SelectTrigger id="sim-offline" className="w-72">
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
            </Field>
            <Field label="Gateway 5xx errors" htmlFor="sim-5xx">
              <Switch id="sim-5xx" checked={failures.data?.gatewayErrors ?? false} onCheckedChange={(v) => setFailures.mutate({ gatewayErrors: v })} />
            </Field>
            <Field label="Xid storm on gx10-03" htmlFor="sim-xid">
              <Switch id="sim-xid" checked={failures.data?.xidStorm ?? false} onCheckedChange={(v) => setFailures.mutate({ xidStorm: v })} />
            </Field>
            <Field label="Fail API requests" htmlFor="sim-api">
              <Switch id="sim-api" checked={failures.data?.apiErrors ?? false} onCheckedChange={(v) => setFailures.mutate({ apiErrors: v })} />
            </Field>
          </CardContent>
        </Card>
      </PageBody>
    </>
  )
}
```

Replace `src/routes/settings.tsx`:
```tsx
import { createFileRoute } from '@tanstack/react-router'
import { SettingsPage } from '@/features/settings/settings-page'

export const Route = createFileRoute('/settings')({ component: SettingsPage })
```

- [ ] **Step 7: Run to verify, then commit**

Run: `pnpm test && pnpm e2e e2e/settings.spec.ts` — expected PASS.

```bash
git add src/lib/use-local-setting.ts src/lib/use-local-setting.test.tsx src/features/settings src/routes/settings.tsx e2e/settings.spec.ts
git commit -m "feat: settings with theme, gateway defaults and failure injection

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 21: Full-route smoke, screenshots, README, final verification

**Files:**
- Create: `e2e/all-routes.spec.ts`, `e2e/screenshots.spec.ts`, `README.md`, `docs/screenshots/*.png` (generated)
- Modify: `playwright.config.ts`, `package.json`

**Interfaces:**
- Consumes: every route.
- Produces: `pnpm shots` script writing `docs/screenshots/<page>-<theme>.png`.

- [ ] **Step 1: Every route renders cleanly in both themes** — `e2e/all-routes.spec.ts`

```ts
import { expect, test } from './fixtures'

const ROUTES: [string, string][] = [
  ['/', 'Overview'], ['/nodes', 'Nodes'], ['/nodes/spark-01', 'spark-01'], ['/gateway', 'Endpoint'], ['/deployments', 'Deployments'],
  ['/usage', 'Usage'], ['/keys', 'API Keys'], ['/logs', 'Logs'], ['/alerts', 'Alerts'], ['/updates', 'Updates'], ['/settings', 'Settings'],
]

for (const theme of ['dark', 'light'] as const) {
  for (const [path, heading] of ROUTES) {
    test(`${path} renders in ${theme}`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('sparkman-theme', t), theme)
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 1 })).toContainText(heading)
      await expect(page.getByText('Couldn’t load data')).toHaveCount(0)
      await page.waitForTimeout(2500)
    })
  }
}
```

The 2.5 s wait lets at least one live tick re-render each page, so errors that only appear on refresh still fail the console-error fixture.

- [ ] **Step 2: Screenshot generator** — `e2e/screenshots.spec.ts`

```ts
import { test } from '@playwright/test'

const PAGES: [string, string][] = [
  ['overview', '/'], ['nodes', '/nodes'], ['node-detail', '/nodes/spark-05'], ['logs', '/logs?range=24h'],
  ['gateway', '/gateway'], ['deployments', '/deployments'], ['usage', '/usage'], ['updates', '/updates'],
]

for (const theme of ['dark', 'light'] as const) {
  for (const [name, path] of PAGES) {
    test(`screenshot ${name} ${theme}`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('sparkman-theme', t), theme)
      await page.goto(path)
      await page.waitForTimeout(3000)
      await page.screenshot({ path: `docs/screenshots/${name}-${theme}.png`, fullPage: true })
    })
  }
}
```

In `playwright.config.ts`, add `testIgnore: process.env.SHOTS ? [] : ['**/screenshots.spec.ts'],` at the top level. In `package.json` scripts, add `"shots": "SHOTS=1 playwright test e2e/screenshots.spec.ts"`.

- [ ] **Step 3: README** — `README.md`

````markdown
# SparkMan

Fleet console for NVIDIA DGX Spark (GB10) / ASUS Ascent GX10 systems: one front door for AI coding agents, plus node telemetry, logs, alerts and staged updates.

**Phase 1 is a UI prototype.** All data comes from a deterministic in-browser simulator (`src/api/mock/`). The UI talks only to the `SparkManClient` interface (`src/api/client.tsx`). A future `HttpClient` backed by a Python control plane (the DGX Spark manageability tools over SSH, LiteLLM for the gateway) replaces `MockClient` in `src/main.tsx`.

## Run

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm test         # unit tests (Vitest)
pnpm e2e          # browser tests (Playwright; starts its own dev server on :5199)
pnpm shots        # regenerate docs/screenshots
pnpm build
```

## Simulator

- 12 nodes: `spark-01…08` (DGX Spark FE) and `gx10-01…04` (ASUS GX10), seeded (`1729`) and ticking every 2 s.
- `spark-05` runs hot (ongoing thermal incident). `spark-08` has a pending reboot.
- Settings → Simulator injects an offline node, gateway 5xx errors, or an Xid storm.
- State is in memory and resets on reload.

Design spec: `docs/superpowers/specs/2026-10-08-sparkman-ui-prototype-design.md`.
````

- [ ] **Step 4: Full verification**

Run each and confirm the output:

```bash
pnpm test        # all unit suites PASS
pnpm build       # ✓ built, no TS errors
pnpm e2e         # all e2e PASS (≈60 tests incl. 22 route×theme)
pnpm shots       # 16 PNGs in docs/screenshots/
```

- [ ] **Step 5: Visual review of screenshots**

Open each PNG in `docs/screenshots/` (use the Read tool to view images). Check for:
- clipped or overlapping text in table rows and headers
- charts rendering empty boxes
- any light-theme element that is invisible (white on white) or uses the dark-theme green
- the NVIDIA green used as a large fill anywhere (must not be)

Fix any issue found in the owning component, re-run `pnpm e2e` and `pnpm shots`, and note the fixes in the commit message.

- [ ] **Step 6: Commit**

```bash
git add e2e/all-routes.spec.ts e2e/screenshots.spec.ts playwright.config.ts package.json README.md docs/screenshots
git commit -m "test: route x theme smoke tests, screenshots and README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
