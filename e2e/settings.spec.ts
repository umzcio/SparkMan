import { expect, test } from './fixtures.ts'

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
  await page.goto('/settings?section=simulator')
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
  await page.goto('/settings?section=simulator')
  await page.getByRole('switch', { name: 'Fail API requests' }).click()
  await expect(page.getByRole('switch', { name: 'Fail API requests' })).toBeChecked()
  await page.getByRole('link', { name: 'Deployments', exact: true }).click()
  // the deployments table and the launchers each show their own error
  await expect(page.getByText('Couldn’t load data')).toHaveCount(2)
  await expect(page.getByText('Simulated API failure (Settings → Simulator)').first()).toBeVisible()
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await page.getByTestId('settings-nav-simulator').click()
  await expect(page.getByRole('switch', { name: 'Fail API requests' })).toBeChecked()
  await page.getByRole('switch', { name: 'Fail API requests' }).click()
  await expect(page.getByRole('switch', { name: 'Fail API requests' })).not.toBeChecked()
  await page.getByRole('link', { name: 'Deployments', exact: true }).click()
  await expect(page.getByTestId('deployment-row').first()).toBeVisible()
})

test('injected gateway errors show on the endpoint page', async ({ page }) => {
  await page.goto('/settings?section=simulator')
  await page.getByRole('switch', { name: 'Gateway 5xx errors' }).click()
  await page.getByRole('link', { name: 'Endpoint', exact: true }).click()
  await expect(page.getByTestId('tile-errors')).toContainText(/\D([5-9]|1\d)\.\d%/)
})

test('settings sections navigate and stay in the URL', async ({ page }) => {
  await page.goto('/settings')
  await expect(page.getByRole('heading', { level: 2, name: 'Appearance' })).toBeVisible()
  await page.getByTestId('settings-nav-fleet').click()
  await expect(page).toHaveURL(/section=fleet/)
  await expect(page.getByTestId('settings-hosts').getByRole('listitem')).toHaveCount(12)
  await page.getByTestId('settings-nav-agents').click()
  await expect(page.getByRole('heading', { level: 2, name: 'Host agents' })).toBeVisible()
  await expect(page.getByText('Claude Code', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('settings-nav-agents')).toHaveAttribute('aria-current', 'page')
})
