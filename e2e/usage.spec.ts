import { expect, test } from './fixtures.ts'

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

test('token mix splits prompt tokens into cache hits and prefill, per model', async ({ page }) => {
  await page.goto('/usage')
  const mix = page.getByTestId('token-mix')
  await expect(mix.getByTestId('cache-hit-rate')).toHaveText(/^\d+%$/)
  await expect(mix.getByTestId('token-mix-bar').locator('[data-part]')).toHaveCount(3)
  const rows = mix.getByTestId('token-mix-row')
  await expect(rows.first()).toBeVisible()
  expect(await rows.count()).toBeGreaterThanOrEqual(3)
  await expect(rows.first()).toContainText(/\d+%/) // hit rate column
  await expect(mix.getByTestId('token-mix-total')).toContainText('Total')
  // the table's generated total is the same number as the Tokens out tile
  const tile = page.getByTestId('tile-tokens-out').getByTestId('stat-value')
  const total = mix.getByTestId('token-mix-total-generated')
  await expect.poll(async () => (await total.innerText()) === (await tile.innerText()), { timeout: 8000 }).toBe(true)
  await expect(page.getByTestId('status-line')).toContainText('cache hits')
})
