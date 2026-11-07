import { expect, test } from './fixtures.ts'

test('overview shows the rack: units in their slots with hover quick stats', async ({ page }) => {
  await page.goto('/')
  const units = page.getByTestId('rack-unit')
  await expect(units).toHaveCount(12)
  await expect(page.getByRole('region', { name: 'Shelf 1' }).getByTestId('rack-unit-label')).toHaveText(['gx10-01', 'spark-01', 'spark-02', 'spark-03', 'spark-04', 'dell-01', 'dell-02'])
  await units.filter({ hasText: 'dell-02' }).hover()
  const stats = page.getByTestId('rack-quick-stats')
  await expect(stats).toContainText('Dell Pro Max GB10 · shelf 1, slot 7')
  await expect(stats).toContainText('GPU')
  // keyboard focus opens the same card
  await page.mouse.move(0, 0)
  await expect(stats).toHaveCount(0)
  await units.filter({ hasText: 'gx10-01' }).focus()
  await expect(page.getByTestId('rack-quick-stats')).toContainText('ASUS Ascent GX10')
  await units.filter({ hasText: 'spark-03' }).click()
  await expect(page).toHaveURL(/\/nodes\/spark-03$/)
})

test('overview shows fleet tiles, 12 node cards and the active incident', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('tile-online')).toContainText('12 / 12')
  await page.getByRole('radio', { name: 'Grid view' }).click()
  await expect(page.getByTestId('node-card')).toHaveCount(12)
  await expect(page.getByText('spark-05 thermal throttling', { exact: true })).toBeVisible()
  await expect(page.getByTestId('activity-item').first()).toBeVisible()
  await page.getByTestId('node-card').filter({ hasText: 'spark-03' }).click()
  await expect(page).toHaveURL(/\/nodes\/spark-03$/)
})

test('page subtitles are live status lines that react to the fleet', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('status-line')).toContainText('Hottest spark-05')
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await page.getByTestId('settings-nav-simulator').click()
  await page.getByRole('combobox', { name: 'Take a node offline' }).click()
  await page.getByRole('option', { name: 'spark-03' }).click()
  await page.getByRole('link', { name: 'Nodes', exact: true }).click()
  await expect(page.getByTestId('status-line')).toContainText('1 offline')
})
