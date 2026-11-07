import { test, type Page } from '@playwright/test'

// README screenshots: `pnpm shots` (runs only with SHOTS=1). Desktop-sized, both themes.
test.use({ viewport: { width: 1440, height: 900 } })

const settle = (page: Page, ms = 2500) => page.waitForTimeout(ms)

const SHOTS: { name: string; run: (page: Page) => Promise<void> }[] = [
  { name: 'overview', run: async (p) => { await p.goto('/'); await settle(p) } },
  {
    name: 'overview-grid',
    run: async (p) => {
      await p.goto('/')
      await p.getByRole('radio', { name: 'Grid view' }).click()
      await settle(p)
    },
  },
  { name: 'nodes', run: async (p) => { await p.goto('/nodes'); await settle(p) } },
  { name: 'node-detail', run: async (p) => { await p.goto('/nodes/spark-05'); await settle(p) } },
  { name: 'cooling', run: async (p) => { await p.goto('/cooling'); await settle(p) } },
  { name: 'network', run: async (p) => { await p.goto('/network'); await settle(p) } },
  { name: 'gateway', run: async (p) => { await p.goto('/gateway'); await settle(p) } },
  { name: 'deployments', run: async (p) => { await p.goto('/deployments'); await settle(p) } },
  {
    name: 'benchmarks',
    run: async (p) => {
      await p.goto('/benchmarks?node=spark-01')
      await p.getByTestId('bench-run-button').click()
      await p.getByTestId('bench-run').and(p.locator('[data-status=completed]')).waitFor({ timeout: 20_000 })
      await settle(p, 1200)
      // the run view scrolls into view; frame the whole page
      await p.evaluate(() => document.querySelectorAll('*').forEach((el) => el.scrollTop > 0 && (el.scrollTop = 0)))
      await settle(p, 300)
    },
  },
  { name: 'usage', run: async (p) => { await p.goto('/usage'); await settle(p) } },
  { name: 'logs', run: async (p) => { await p.goto('/logs?range=24h'); await settle(p) } },
  {
    name: 'alerts',
    run: async (p) => {
      await p.goto('/alerts')
      await p.getByText('spark-05 thermal throttling').first().click()
      await settle(p, 1200)
    },
  },
  { name: 'updates', run: async (p) => { await p.goto('/updates'); await settle(p) } },
  {
    name: 'claude',
    run: async (p) => {
      await p.goto('/agent')
      await p.getByRole('button', { name: 'New session' }).first().click()
      await p.getByRole('button', { name: 'Start session' }).click()
      const box = p.getByRole('textbox', { name: 'Message Claude' })
      await box.fill('Edit the replica count in the config')
      await box.press('Enter')
      await p.getByTestId('permission-card').getByTestId('diff-view').waitFor()
      await settle(p, 800)
    },
  },
  {
    name: 'codex',
    run: async (p) => {
      await p.goto('/codex')
      await p.getByRole('button', { name: 'New session' }).first().click()
      await p.getByRole('button', { name: 'Start session' }).click()
      const box = p.getByRole('textbox', { name: 'Message Codex' })
      await box.fill('Make a plan, then check the disk')
      await box.press('Enter')
      await p.getByTestId('turn-end').waitFor()
      await settle(p, 800)
    },
  },
  { name: 'settings', run: async (p) => { await p.goto('/settings?section=fleet'); await settle(p, 1500) } },
]

for (const theme of ['dark', 'light'] as const) {
  for (const shot of SHOTS) {
    test(`screenshot ${shot.name} ${theme}`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('sparkman-theme', t), theme)
      await shot.run(page)
      await page.screenshot({ path: `docs/screenshots/${shot.name}-${theme}.png` })
    })
  }
}
