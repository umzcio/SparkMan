import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'

async function newSession(page: Page, mode?: RegExp) {
  await page.goto('/codex')
  await page.getByRole('button', { name: 'New session' }).first().click()
  if (mode) {
    await page.getByRole('combobox', { name: 'Permission mode' }).click()
    await page.getByRole('option', { name: mode }).click()
  }
  await page.getByRole('button', { name: 'Start session' }).click()
  await expect(page).toHaveURL(/session=/)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Message Codex' })).toBeFocused()
}

async function send(page: Page, text: string) {
  const box = page.getByRole('textbox', { name: 'Message Codex' })
  await box.fill(text)
  await box.press('Enter')
}

test('Codex runs a turn in Auto without asking and reports tokens, not dollars', async ({ page }) => {
  await newSession(page)
  await expect(page.getByRole('combobox', { name: 'Permission mode' })).toHaveText('Auto')
  await send(page, 'How full is the root disk?')
  await expect(page.getByTestId('assistant-message').last()).toContainText('Root filesystem is 42% full')
  await expect(page.getByTestId('permission-card')).toHaveCount(0)
  await expect(page.getByTestId('turn-end')).toContainText('2.4K tokens')
  await expect(page.getByTestId('session-spend')).toHaveText('2.4K tok')
  await page.getByTestId('tool-card').filter({ hasText: 'Shell' }).getByRole('button').click()
  await expect(page.getByTestId('tool-card').filter({ hasText: 'Shell' })).toContainText('/dev/nvme0n1p2')
})

test('Codex asks in "Ask every time", answers questions, and shows patches', async ({ page }) => {
  await newSession(page, /Ask every time/)
  await send(page, 'check the disk')
  const perm = page.getByTestId('permission-card')
  await expect(perm).toContainText('Codex wants to use Shell')
  await expect(perm).toContainText('df -h /')
  await perm.getByRole('button', { name: 'Always allow this session' }).click()
  await expect(perm).toContainText('Approved')
  await expect(page.getByTestId('assistant-message').last()).toContainText('42% full')

  await send(page, 'ask me which disk')
  await expect(page.getByTestId('question-card')).toContainText('Which disk should I check?')
  await page.getByTestId('question-card').getByRole('radio', { name: /Data/ }).click()
  await page.getByRole('button', { name: 'Submit answers' }).click()
  await expect(page.getByTestId('assistant-message').last()).toContainText('You picked Data.')

  await send(page, 'edit the config')
  const patch = page.getByTestId('permission-card').last()
  await expect(patch.getByTestId('diff-view')).toContainText('replicas: 3')
  await patch.getByRole('button', { name: 'Deny' }).click()
  await expect(page.getByTestId('assistant-message').last()).toContainText('won’t edit it')
})

test('Codex session panel lists models, plan limits, MCP and installs plugins; full access needs opt-in', async ({ page }) => {
  await newSession(page)
  await page.getByRole('combobox', { name: 'Model' }).click()
  await page.getByRole('option', { name: /GPT-6.1-Mini/ }).click()
  await expect(page.getByRole('combobox', { name: 'Model' })).toHaveText('GPT-6.1-Mini')

  await page.getByRole('combobox', { name: 'Permission mode' }).click()
  await page.getByRole('option', { name: /Full access/ }).click()
  await expect(page.getByRole('heading', { name: 'Give Codex full access?' })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()

  await page.getByRole('button', { name: 'Session details' }).click()
  await expect(page.getByTestId('plan-usage')).toContainText('21%')
  await page.getByRole('tab', { name: 'MCP' }).click()
  await expect(page.getByTestId('mcp-list')).toContainText('github')
  await page.getByRole('tab', { name: 'Plugins' }).click()
  const github = page.getByTestId('plugin-item').filter({ hasText: 'GitHub' })
  await github.getByRole('button', { name: 'Install GitHub' }).click()
  await expect(github).toContainText('installed')
  await github.getByRole('button', { name: 'Uninstall GitHub' }).click()
  await expect(github).not.toContainText('installed')
})

test('Codex plan updates replace the plan card instead of stacking', async ({ page }) => {
  await newSession(page)
  await send(page, 'make a plan')
  await expect(page.getByTestId('assistant-message').last()).toContainText('Plan is underway.')
  await expect(page.getByTestId('todo-list')).toHaveCount(1)
  await expect(page.getByTestId('todo-list')).toContainText('Report findings')
})
