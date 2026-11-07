import { expect, test } from './fixtures.ts'

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

test('incident opens from the keyboard', async ({ page }) => {
  await page.goto('/alerts')
  const row = page.getByTestId('incident-row').filter({ hasText: 'spark-05 thermal throttling' })
  await row.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByText('GPU temperature crossed 80 °C (sustained 5 min)')).toBeVisible()
})
