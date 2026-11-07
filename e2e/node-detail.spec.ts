import { expect, test } from './fixtures.ts'

test('degraded node shows status, charts and every tab', async ({ page }) => {
  await page.goto('/nodes/spark-05')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('spark-05')
  await expect(page.getByTestId('node-status')).toHaveText('Degraded')
  await expect(page.getByTestId('chart-Temperature')).toBeVisible()
  await expect(page.getByTestId('chart-Unified memory')).toContainText('/ 128 GB')
  await page.getByRole('tab', { name: 'Processes' }).click()
  await expect(page.getByText('nim_llm')).toBeVisible()
  await page.getByRole('tab', { name: 'Inventory' }).click()
  await expect(page.getByText('source: firmware_reporter.py')).toBeVisible()
  await page.getByRole('tab', { name: 'Health' }).click()
  await expect(page.getByText('GPU temperature', { exact: true })).toBeVisible()
  await expect(page.getByText('spark_diagctl.py')).toBeVisible()
  await page.getByRole('tab', { name: 'Logs' }).click()
  await expect(page.getByText('host:spark-05', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/tab=logs/)
})

test('only clustered nodes show the ConnectX-7 chart', async ({ page }) => {
  await page.goto('/nodes/spark-01')
  await expect(page.getByTestId('chart-ConnectX-7 (200 GbE)')).toBeVisible()
  await page.goto('/nodes/spark-04')
  await expect(page.getByTestId('chart-GPU utilization')).toBeVisible()
  await expect(page.getByTestId('chart-ConnectX-7 (200 GbE)')).toHaveCount(0)
})

test('reboot cycles the node through rebooting back to online', async ({ page }) => {
  await page.goto('/nodes/dell-01')
  await page.getByRole('button', { name: 'Actions' }).click()
  await page.getByRole('menuitem', { name: 'Reboot' }).click()
  await page.getByRole('button', { name: 'Reboot node' }).click()
  await expect(page.getByTestId('node-status')).toHaveText('Rebooting')
  await expect(page.getByTestId('chart-GPU utilization')).toContainText('—')
  await expect(page.getByTestId('node-status')).toHaveText('Online', { timeout: 35_000 })
})

test('unknown node shows not found', async ({ page }) => {
  await page.goto('/nodes/does-not-exist')
  await expect(page.getByRole('heading', { level: 1, name: 'Node not found' })).toBeVisible()
  await page.getByRole('link', { name: 'Back to nodes' }).click()
  await expect(page).toHaveURL(/\/nodes$/)
})
