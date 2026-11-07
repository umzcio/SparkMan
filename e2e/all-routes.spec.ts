import { expect, test } from './fixtures.ts'

const ROUTES: [string, string][] = [
  ['/', 'Overview'], ['/nodes', 'Nodes'], ['/nodes/spark-01', 'spark-01'], ['/cooling', 'Cooling'], ['/gateway', 'Endpoint'], ['/deployments', 'Deployments'], ['/benchmarks', 'Benchmarks'],
  ['/network', 'Network'], ['/usage', 'Usage'], ['/keys', 'API Keys'], ['/logs', 'Logs'], ['/alerts', 'Alerts'], ['/updates', 'Updates'], ['/settings', 'Settings'], ['/agent', 'Claude'], ['/codex', 'Codex'],
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
