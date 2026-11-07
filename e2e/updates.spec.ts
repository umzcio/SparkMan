import { expect, test } from './fixtures.ts'

test('plan button disabled during rollout; canary rollout completes', async ({ page }) => {
  await page.goto('/updates')
  await expect(page.getByTestId('update-row')).toHaveCount(12)
  await expect(page.getByTestId('update-row').filter({ hasText: 'gx10-01' })).toContainText('stage carefully')
  await page.getByRole('button', { name: 'Plan rollout' }).click()
  await page.getByRole('checkbox', { name: /Ring 1/ }).uncheck()
  await page.getByRole('checkbox', { name: /Ring 2/ }).uncheck()
  await page.getByRole('button', { name: 'Create rollout' }).click()

  const active = page.getByTestId('active-rollout')
  await expect(active).toContainText('Awaiting approval')
  await expect(page.getByRole('button', { name: 'Plan rollout' })).toBeDisabled()
  await active.getByRole('button', { name: 'Approve' }).click()
  await expect(active).toContainText('Running')
  await expect(page.getByTestId('rollout-node-dell-02')).toHaveAttribute('data-step', /precheck|apply|reboot|postcheck/)

  await expect(page.getByTestId('history-row').first()).toContainText('DGX OS 7.5.0', { timeout: 45_000 })
  await expect(page.getByRole('button', { name: 'Plan rollout' })).toBeEnabled()
  await expect(page.getByTestId('update-row').filter({ hasText: 'dell-02' })).toContainText('Up to date')
})

test('rejecting an awaiting rollout re-enables planning', async ({ page }) => {
  await page.goto('/updates')
  await page.getByRole('button', { name: 'Plan rollout' }).click()
  await page.getByRole('button', { name: 'Create rollout' }).click()
  const active = page.getByTestId('active-rollout')
  await expect(active).toContainText('Awaiting approval')
  await expect(page.getByRole('button', { name: 'Plan rollout' })).toBeDisabled()
  await active.getByRole('button', { name: 'Reject' }).click()
  await expect(active).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Plan rollout' })).toBeEnabled()
  await expect(page.getByTestId('history-row').first()).toContainText('rejected')
})
