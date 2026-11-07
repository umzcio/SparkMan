import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'

async function newSession(page: Page) {
  await page.goto('/agent')
  await page.getByRole('button', { name: 'New session' }).first().click()
  await page.getByRole('button', { name: 'Start session' }).click()
  await expect(page).toHaveURL(/session=/)
  // the dialog's hidden native <select> lingers during its exit animation; wait it out
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Message Claude' })).toBeFocused()
}

async function send(page: Page, text: string) {
  const box = page.getByRole('textbox', { name: 'Message Claude' })
  await box.fill(text)
  await box.press('Enter')
}

test('chat streams, asks permission, runs the tool after approval and reports cost', async ({ page }) => {
  await newSession(page)
  await send(page, 'How full is the root disk?')
  await expect(page.getByTestId('user-message')).toHaveText('How full is the root disk?')
  await expect(page.getByTestId('assistant-message').first()).toContainText("I'll check that for you.")
  const perm = page.getByTestId('permission-card')
  await expect(perm).toContainText('Claude wants to use Bash')
  await expect(perm).toContainText('df -h /')
  await perm.getByRole('button', { name: 'Approve' }).click()
  await expect(perm).toContainText('Approved')
  await expect(page.getByTestId('assistant-message').last()).toContainText('Root filesystem is 42% full (2.1 TB free).')
  await expect(page.getByTestId('turn-end')).toContainText('$0.01')
  await page.getByTestId('tool-card').getByRole('button').click()
  await expect(page.getByTestId('tool-card')).toContainText('/dev/nvme0n1p2')
  await expect(page.getByTestId('session-item').filter({ hasText: 'How full is the root disk?' })).toBeVisible()
})

test('denying a tool call is reported back to Claude', async ({ page }) => {
  await newSession(page)
  await send(page, 'check the disk')
  const perm = page.getByTestId('permission-card')
  await perm.getByRole('button', { name: 'Deny' }).click()
  await expect(perm).toContainText('Denied')
  await expect(page.getByTestId('assistant-message').last()).toContainText("Okay — I won't run that.")
})

test('bypass mode needs confirmation and then skips prompts', async ({ page }) => {
  await newSession(page)
  await page.getByRole('combobox', { name: 'Permission mode' }).click()
  await page.getByRole('option', { name: /Bypass/ }).click()
  await expect(page.getByRole('heading', { name: 'Bypass all permission checks?' })).toBeVisible()
  await page.getByRole('button', { name: 'Enable bypass' }).click()
  await expect(page.getByRole('combobox', { name: 'Permission mode' })).toHaveText('Bypass')
  await send(page, 'check the disk')
  await expect(page.getByTestId('assistant-message').last()).toContainText('Root filesystem is 42% full')
  await expect(page.getByTestId('permission-card')).toHaveCount(0)
})

async function pickMode(page: Page, name: RegExp) {
  await page.getByRole('combobox', { name: 'Permission mode' }).click()
  await page.getByRole('option', { name }).click()
}

test('reloading the page replays the conversation', async ({ page }) => {
  await newSession(page)
  await pickMode(page, /Don't ask/)
  await send(page, 'check only please')
  await expect(page.getByTestId('turn-end')).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('user-message')).toHaveText('check only please')
  await expect(page.getByTestId('assistant-message').last()).toContainText("Okay — I won't run that.")
  await expect(page.getByRole('combobox', { name: 'Permission mode' })).toHaveText("Don't ask")
})

test('slash menu lists commands and skills, and command output lands in the chat', async ({ page }) => {
  await newSession(page)
  const box = page.getByRole('textbox', { name: 'Message Claude' })
  await box.fill('/')
  const menu = page.getByTestId('slash-menu')
  await expect(menu).toContainText('/compact')
  await expect(menu.getByRole('option', { name: /deploy-check/ })).toContainText('skill')
  await expect(menu).not.toContainText('/exit')
  await box.fill('/co')
  await expect(menu.getByRole('option').first()).toContainText('/compact')
  await box.press('ArrowDown')
  await box.press('Enter')
  await expect(box).toHaveValue('/cost ')
  await box.press('Enter')
  await expect(page.getByTestId('command-output')).toContainText('Total cost')
})

test('answers a question from Claude', async ({ page }) => {
  await newSession(page)
  await send(page, 'ask me which disk')
  const card = page.getByTestId('question-card')
  await expect(card).toContainText('Which disk should I check?')
  await card.getByRole('radio', { name: /Data/ }).click()
  await page.getByRole('button', { name: 'Submit answers' }).click()
  await expect(page.getByTestId('assistant-message').last()).toContainText('You picked Data.')
})

test('approves a plan and switches to auto-accept edits', async ({ page }) => {
  await newSession(page)
  await pickMode(page, /Plan/)
  await send(page, 'plan the disk check')
  await expect(page.getByTestId('plan-card')).toContainText('Report anything over 80%')
  await page.getByRole('button', { name: 'Approve & auto-accept edits' }).click()
  await expect(page.getByRole('combobox', { name: 'Permission mode' })).toHaveText('Accept edits')
  await expect(page.getByTestId('assistant-message').last()).toContainText('Plan approved')
})

test('shows an edit diff for approval, todos, thinking and a follow-up suggestion', async ({ page }) => {
  await newSession(page)
  await send(page, 'think, then edit the config')
  const perm = page.getByTestId('permission-card')
  await expect(perm.getByTestId('diff-view')).toContainText('replicas: 3')
  await perm.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByTestId('assistant-message').last()).toContainText('Replicas are now 3.')
  await page.getByTestId('thinking').getByRole('button').click()
  await expect(page.getByTestId('thinking')).toContainText('df is the quickest check')
  await page.getByTestId('suggestion').click()
  await expect(page.getByRole('textbox', { name: 'Message Claude' })).toHaveValue('Check /data too')

  await page.getByRole('switch', { name: 'Show thinking' }).click()
  await expect(page.getByTestId('thinking')).toHaveCount(0)
  await send(page, 'make a todo list')
  await expect(page.getByTestId('todo-list').first()).toContainText('Rotating old logs')
})

test('switches model, inspects context, and manages MCP, skills and tasks from the session panel', async ({ page }) => {
  await newSession(page)
  await page.getByRole('combobox', { name: 'Model' }).click()
  await page.getByRole('option', { name: /Sonnet/ }).click()
  await expect(page.getByRole('combobox', { name: 'Model' })).toHaveText('Sonnet')

  await page.getByTestId('context-meter').click()
  await expect(page.getByTestId('context-breakdown')).toContainText('System tools')
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Session details' }).click()
  await expect(page.getByTestId('plan-usage')).toContainText('34%')
  await page.getByRole('tab', { name: 'MCP' }).click()
  const mcp = page.getByTestId('mcp-list')
  await expect(mcp).toContainText('needs-auth')
  await mcp.getByRole('switch', { name: 'Enable github' }).click()
  await expect(mcp).toContainText('disabled')
  await page.getByRole('tab', { name: 'Skills' }).click()
  await expect(page.getByTestId('skills-list')).toContainText('/deploy-check')
  await expect(page.getByTestId('agents-list')).toContainText('Explore')
  await page.keyboard.press('Escape')

  await pickMode(page, /Bypass/)
  await page.getByRole('button', { name: 'Enable bypass' }).click()
  await send(page, 'run a background task')
  await page.getByRole('button', { name: 'Session details' }).click()
  await page.getByRole('tab', { name: /Tasks/ }).click()
  const tasks = page.getByTestId('tasks-list')
  await expect(tasks).toContainText('Survey GPU memory')
  await expect(tasks).toContainText(/completed|running/)
})

test('rewinds files after previewing, and forks a session from a finished turn', async ({ page }) => {
  await newSession(page)
  await pickMode(page, /Accept edits/)
  await send(page, 'edit the config')
  await expect(page.getByTestId('turn-end')).toBeVisible()

  await page.getByTestId('user-message').hover()
  await page.getByTestId('rewind-button').click()
  await expect(page.getByTestId('rewind-preview')).toContainText('/srv/sparkman/notes.md')
  await page.getByRole('button', { name: 'Rewind files' }).click()
  await expect(page.getByTestId('notice').last()).toContainText('Rewound 1 file')

  const before = page.url()
  await page.getByTestId('turn-end').hover()
  await page.getByTestId('fork-button').click()
  await expect(page).not.toHaveURL(before)
  await expect(page.getByTestId('session-item').filter({ hasText: '(fork)' })).toBeVisible()
  await expect(page.getByTestId('user-message')).toHaveText('edit the config')
  await send(page, 'check the disk')
  await expect(page.getByTestId('permission-card').last()).toContainText('df -h /')
})

test('attaches an image to a message', async ({ page }) => {
  await newSession(page)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  await page.locator('input[type=file]').setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png })
  await expect(page.getByTestId('attachments').getByRole('img')).toHaveCount(1)
  await send(page, 'what is this?')
  await expect(page.getByTestId('user-message')).toContainText('1 image')
  await expect(page.getByTestId('attachments')).toHaveCount(0)
})
