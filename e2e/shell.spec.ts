import { expect, test } from './fixtures.ts'

const PAGES: [string, string][] = [
  ['Nodes', 'Nodes'], ['Cooling', 'Cooling'], ['Endpoint', 'Endpoint'], ['Deployments', 'Deployments'], ['Benchmarks', 'Benchmarks'], ['Usage', 'Usage'], ['API Keys', 'API Keys'],
  ['Logs', 'Logs'], ['Alerts', 'Alerts'], ['Updates', 'Updates'], ['Settings', 'Settings'], ['Claude', 'Claude'], ['Codex', 'Codex'], ['Overview', 'Overview'],
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
  const input = page.getByPlaceholder('Search pages, nodes, models…')
  // The shortcut listener attaches after hydration, so retry until the dialog opens.
  await expect(async () => {
    await page.keyboard.press('ControlOrMeta+k')
    await expect(input).toBeVisible({ timeout: 500 })
  }).toPass()
  await input.fill('spark-04')
  await expect(page.getByRole('option', { name: /spark-04/ })).toHaveAttribute('aria-selected', 'true')
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
