import { expect, test } from './fixtures.ts'

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
