import { expect, test } from './fixtures.ts'

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
