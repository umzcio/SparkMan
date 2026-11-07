import { expect, test } from './fixtures.ts'

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
