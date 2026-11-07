import { expect, test } from './fixtures.ts'

test('cooling shows three fans with live status', async ({ page }) => {
  await page.goto('/cooling')
  await expect(page.getByRole('heading', { level: 1, name: 'Cooling' })).toBeVisible()
  await expect(page.getByTestId('fan-card')).toHaveCount(3)
  await expect(page.getByTestId('status-line')).toContainText('Pico connected')
  await expect(page.getByTestId('controller-card')).toContainText('/dev/ttyACM0')
})

test('pin a fan by hand, then hand it back to the curve', async ({ page }) => {
  await page.goto('/cooling')
  const card = page.locator('[data-testid=fan-card][data-fan=fan-2]')
  const thumb = card.getByRole('slider', { name: 'Fan 2 speed' })
  await thumb.focus()
  await page.keyboard.press('End') // 100 %
  await expect(card.getByTestId('fan-reason')).toHaveText('Manual')
  await expect(card.getByTestId('fan-duty')).toHaveText('100%')
  await expect(page.getByTestId('status-line')).toContainText('1 manual')
  await card.getByTestId('fan-auto').click()
  await expect(card.getByTestId('fan-reason')).not.toHaveText('Manual')
})

test('the shelf shows every top-shelf box under its fan', async ({ page }) => {
  await page.goto('/cooling')
  const hero = page.getByTestId('shelf-hero')
  await expect(hero.getByTestId('hero-box')).toHaveCount(7)
  await expect(hero.getByTestId('hero-fan')).toHaveCount(3)
  await expect(hero.locator('[data-testid=hero-box][data-node=spark-02] [data-testid=hero-temp]')).toHaveText(/\d+ °C/)
  await expect(hero.locator('[data-testid=hero-fan][data-fan=fan-2]')).toHaveAttribute('data-spinning', 'true')
})

test('drag a curve point, save, and the fans follow the new curve', async ({ page }) => {
  await page.goto('/cooling')
  const editor = page.getByTestId('curve-editor')
  const point = editor.locator('[data-testid=curve-point][data-index="1"]')
  await point.focus()
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowUp') // 40 % → 50 %
  await expect(point).toHaveAttribute('aria-valuetext', '60 °C, 50%')
  await editor.getByTestId('curve-save').click()
  await expect(page.getByText('Fan curve saved')).toBeVisible()
  // the saved policy comes back from the simulator: same point, nothing left to save
  await expect(point).toHaveAttribute('aria-valuetext', '60 °C, 50%')
  await expect(editor.getByTestId('curve-save')).toBeDisabled()
})

test('a curve that slows down when hotter cannot be saved', async ({ page }) => {
  await page.goto('/cooling')
  const editor = page.getByTestId('curve-editor')
  const point = editor.locator('[data-testid=curve-point][data-index="1"]')
  await point.focus()
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowDown') // 40 % → 20 %, below point 0 (25 %)
  await expect(editor.getByTestId('curve-error')).toHaveText('A hotter point can’t run the fans slower')
  await expect(editor.getByTestId('curve-save')).toBeDisabled()
  await editor.getByTestId('curve-reset').click()
  await expect(editor.getByTestId('curve-error')).toHaveCount(0)
})

test('unplugging the Pico fails safe and raises an alert', async ({ page }) => {
  await page.goto('/settings?section=simulator')
  await page.getByRole('switch', { name: 'Disconnect the Pico' }).click()
  // client-side navigation keeps the in-memory simulator
  await page.getByRole('link', { name: 'Cooling', exact: true }).click()
  // the Pico holds the last speeds until its 10 s watchdog fires
  await expect(page.getByTestId('controller-state')).toHaveText('Failsafe — all fans 100%', { timeout: 15_000 })
  await expect(page.getByTestId('status-line')).toContainText('Pico offline — failsafe 100%')
  await expect(page.locator('[data-testid=fan-card] [data-testid=fan-duty]')).toHaveText(['100%', '100%', '100%'])
  await expect(page.locator('[data-testid=fan-card][data-fan=fan-1]').getByRole('slider')).toHaveAttribute('data-disabled', '')
  await expect(page.getByTestId('alert-count')).toHaveText('2')
})

test('move a box to another fan', async ({ page }) => {
  await page.goto('/cooling')
  await page.getByRole('button', { name: 'Edit zones' }).click()
  const dialog = page.getByTestId('zones-dialog')
  await dialog.getByRole('radio', { name: 'spark-01 on Fan 2' }).click()
  await dialog.getByTestId('zone-save').click()
  await expect(page.locator('[data-testid=fan-card][data-fan=fan-2]')).toContainText('spark-01')
})

test('history chart renders', async ({ page }) => {
  await page.goto('/cooling')
  // three fan lines and the hottest-box temperature
  await expect(page.getByTestId('cooling-history').locator('.recharts-line')).toHaveCount(4)
})

test('the shelf keeps the fans in place after a zone edit', async ({ page }) => {
  await page.goto('/cooling')
  await page.getByRole('button', { name: 'Edit zones' }).click()
  await page.getByTestId('zones-dialog').getByRole('radio', { name: 'dell-02 on Fan 1' }).click()
  await page.getByTestId('zones-dialog').getByRole('radio', { name: 'spark-02 on no fan' }).click()
  await page.getByTestId('zone-save').click()
  const hero = page.getByTestId('shelf-hero')
  await expect(hero.locator('[data-testid=hero-box][data-node=dell-02]')).toHaveAttribute('data-fan', 'fan-1')
  await expect(hero.locator('[data-testid=hero-box][data-node=spark-02]')).toHaveAttribute('data-fan', 'none')
  // three fans, side by side, never on top of each other
  const boxes = await hero.getByTestId('hero-fan').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => [r.left, r.right]))
  expect(boxes).toHaveLength(3)
  for (let i = 1; i < boxes.length; i++) expect(boxes[i][0]).toBeGreaterThanOrEqual(boxes[i - 1][1])
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  test('curve points are big enough to drag with a finger', async ({ page }) => {
    await page.goto('/cooling')
    const hit = page.getByTestId('curve-hit').first()
    await hit.scrollIntoViewIfNeeded()
    const box = (await hit.boundingBox())!
    expect(box.width).toBeGreaterThanOrEqual(24)
  })
})

test('a cleared number field blocks saving instead of becoming 0', async ({ page }) => {
  await page.goto('/cooling')
  const editor = page.getByTestId('curve-editor')
  await editor.getByLabel('Never below').fill('')
  await expect(editor.getByLabel('Never below')).toHaveValue('')
  await expect(editor.getByTestId('curve-error')).toHaveText('Minimum speed must be 0–100 %')
  await expect(editor.getByTestId('curve-save')).toBeDisabled()
})

test('only the curve points capture touch; the rest of the chart scrolls the page', async ({ page }) => {
  await page.goto('/cooling')
  const editor = page.getByTestId('curve-editor')
  expect(await editor.locator('svg').first().evaluate((e) => getComputedStyle(e).touchAction)).toBe('auto')
  expect(await editor.getByTestId('curve-hit').first().evaluate((e) => getComputedStyle(e).touchAction)).toBe('none')
})

test('zone choices move with the arrow keys', async ({ page }) => {
  await page.goto('/cooling')
  await page.getByRole('button', { name: 'Edit zones' }).click()
  const dialog = page.getByTestId('zones-dialog')
  await dialog.getByRole('radio', { name: 'spark-01 on Fan 1' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(dialog.getByRole('radio', { name: 'spark-01 on Fan 2' })).toBeFocused()
})

test('history tooltip shows whole numbers with units', async ({ page }) => {
  await page.goto('/cooling')
  const chart = page.getByTestId('cooling-history').locator('.recharts-wrapper')
  await chart.scrollIntoViewIfNeeded()
  const box = (await chart.boundingBox())!
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5)
  const tip = page.locator('.recharts-tooltip-wrapper')
  await expect(tip).toContainText('%')
  await expect(tip).toContainText('°C')
  expect(await tip.innerText()).not.toMatch(/\d\.\d{2,}/)
})

test('fan blades change speed without restarting their spin', async ({ page }) => {
  await page.goto('/cooling')
  const timing = await page.locator('[data-testid=hero-fan][data-fan=fan-2] svg').evaluate((svg) => {
    const a = svg.getAnimations({ subtree: true })[0]
    return { duration: a?.effect?.getTiming().duration, rate: a?.playbackRate }
  })
  // one fixed-length turn; speed comes from playbackRate, which keeps the blade's angle when it changes
  expect(timing.duration).toBe(1000)
  expect(timing.rate).toBeGreaterThan(0)
})
