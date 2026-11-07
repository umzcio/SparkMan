import { expect, test } from './fixtures.ts'

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

const PAGES = ['/', '/nodes', '/nodes/spark-05', '/cooling', '/network', '/gateway', '/deployments', '/benchmarks', '/usage', '/keys', '/logs', '/alerts', '/updates', '/settings', '/agent', '/codex']

test('the menu reaches every page on a phone', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('mobile-topbar')).toBeVisible()
  await page.getByRole('button', { name: 'Open menu' }).click()
  await page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'Benchmarks' }).click()
  await expect(page).toHaveURL(/\/benchmarks/)
  await expect(page.getByRole('heading', { level: 1, name: 'Benchmarks' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Pages' })).toHaveCount(0)
})

test('no page scrolls sideways on a phone', async ({ page }) => {
  for (const path of PAGES) {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    // anything past the right edge must be inside a horizontal scroller (tables, code)
    const escaped = await page.evaluate(() =>
      [...document.querySelectorAll('body *')]
        .filter((el) => {
          if (el.getBoundingClientRect().right <= window.innerWidth + 1) return false
          for (let a = el.parentElement; a; a = a.parentElement) if (/(auto|scroll|hidden)/.test(getComputedStyle(a).overflowX)) return false
          return true
        })
        .map((el) => el.tagName),
    )
    expect(escaped, path).toEqual([])
  }
})

test('the agent page shows one pane at a time on a phone', async ({ page }) => {
  await page.goto('/agent')
  await page.getByRole('button', { name: 'New session' }).first().click()
  await page.getByRole('button', { name: 'Start session' }).click()
  const box = page.getByRole('textbox', { name: 'Message Claude' })
  await expect(box).toBeInViewport()
  await expect(page.getByTestId('session-item').first()).toBeHidden()
  await page.getByTestId('back-to-sessions').click()
  await expect(page.getByTestId('session-item').first()).toBeVisible()
})
