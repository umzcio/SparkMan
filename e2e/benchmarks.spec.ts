import { expect, test } from './fixtures.ts'

test('decode bench runs to completion with live progress and results', async ({ page }) => {
  await page.goto('/benchmarks?node=spark-03')
  await expect(page.getByRole('heading', { level: 1, name: 'Benchmarks' })).toBeVisible()
  await expect(page.getByTestId('bench-target')).toContainText('gpt-oss 120B')
  await expect(page.getByText('No decode runs yet')).toBeVisible()

  // trim the sweep to 1, 2, 4 streams
  const levels = page.getByRole('toolbar', { name: 'Concurrency levels' })
  for (const off of ['3', '6', '8']) await levels.getByRole('button', { name: `${off} concurrent`, exact: true }).click()
  await expect(levels.getByRole('button', { name: '4 concurrent' })).toHaveAttribute('aria-pressed', 'true')

  await page.getByTestId('bench-run-button').click()
  const run = page.getByTestId('bench-run')
  await expect(run).toHaveAttribute('data-status', 'running')
  await expect(page.getByTestId('bench-progress')).toBeVisible()
  await expect(page.getByTestId('bench-run-button')).toBeDisabled()
  await expect(page.getByTestId('bench-busy')).toContainText('one bench per node')

  await expect(run).toHaveAttribute('data-status', 'completed', { timeout: 15_000 })
  await expect(page.getByTestId('bench-progress')).toHaveCount(0)
  await expect(page.getByTestId('decode-row')).toHaveCount(3)
  await expect(page.getByTestId('decode-chart')).toBeVisible()
  await expect(page.getByTestId('tile-peak')).toContainText('tok/s')
  await expect(page.getByTestId('bench-history-row')).toHaveCount(1)
  await expect(page.getByTestId('bench-run-button')).toBeEnabled()

  await run.getByRole('button', { name: 'Copy results' }).click()
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip).toContain('SparkMan Decode bench — gpt-oss-120b (vLLM, MXFP4) on spark-03')
  expect(clip).toMatch(/Concurrency\s+Aggregate tok\/s/)
})

test('two quality runs compare with an exact McNemar test', async ({ page }) => {
  await page.goto('/benchmarks?node=dell-01&kind=quality')
  await expect(page.getByTestId('bench-tab-quality')).toHaveAttribute('aria-selected', 'true')
  // a smaller suite keeps the test quick: QA + GSM8K + MMLU
  for (const label of ['Reasoning', 'Arithmetic chain', 'State tracking']) await page.getByRole('checkbox', { name: label }).uncheck()

  const run = page.getByTestId('bench-run')
  for (let i = 1; i <= 2; i++) {
    await page.getByTestId('bench-run-button').click()
    await expect(page.getByTestId('bench-history-row')).toHaveCount(i)
    await expect(run).toHaveAttribute('data-status', 'completed', { timeout: 15_000 })
  }
  await expect(page.getByTestId('quality-row')).toHaveCount(3)
  await expect(page.getByTestId('tile-overall')).toContainText('%')

  const compare = page.getByTestId('quality-compare')
  await compare.getByRole('combobox', { name: 'Compare with' }).click()
  await page.getByRole('option', { name: /dell-01 · qwen3\.6-35b-a3b/ }).click()
  await expect(compare.getByTestId('compare-result')).toBeVisible()
  await expect(compare.getByTestId('compare-p')).toContainText(/p [=<] /)
  await expect(compare.getByTestId('compare-verdict')).toContainText(/Difference within noise|Significant/)
  await expect(compare.getByTestId('compare-only-a')).toHaveText(/\d+/)

  // re-open the first run from history; the compare picker resets
  await page.getByTestId('bench-history-row').nth(1).getByRole('button').first().click()
  await expect(compare.getByTestId('compare-result')).toHaveCount(0)
})

test('cancel a running bench, keep its partial results, then delete it', async ({ page }) => {
  await page.goto('/benchmarks?node=spark-04&kind=tool-eval')
  await page.getByTestId('bench-run-button').click()
  const run = page.getByTestId('bench-run')
  await expect(run).toHaveAttribute('data-status', 'running')
  await expect(page.getByTestId('tool-eval-row').first()).toBeVisible()
  await page.getByTestId('bench-cancel').click()
  await expect(run).toHaveAttribute('data-status', 'cancelled')
  await expect(page.getByText('Cancelled. Steps that finished before the cancel are kept.')).toBeVisible()
  await expect(page.getByTestId('bench-history-row').first()).toHaveAttribute('data-status', 'cancelled')
  await expect(page.getByTestId('bench-run-button')).toBeEnabled()

  await page.getByTestId('bench-delete').first().click()
  await expect(page.getByTestId('bench-history-row')).toHaveCount(0)
  await expect(page.getByText('No tool eval runs yet')).toBeVisible()
})

test('switching node and bench type updates the URL', async ({ page }) => {
  await page.goto('/benchmarks')
  await page.getByTestId('bench-node').click()
  await page.getByRole('option', { name: /dell-02/ }).click()
  await expect(page).toHaveURL(/node=dell-02/)
  await expect(page.getByTestId('bench-target')).toContainText('Mistral Small')
  await page.getByTestId('bench-tab-prefill').click()
  await expect(page).toHaveURL(/kind=prefill/)
  await expect(page.getByRole('toolbar', { name: 'Context sizes' }).getByRole('button', { name: '256k tokens' })).toBeDisabled()
})

test('a worker resolves to its group and benches through the head', async ({ page }) => {
  await page.goto('/benchmarks?node=spark-02')
  await expect(page.getByTestId('bench-node')).toContainText('spark-01 + 1')
  await expect(page.getByTestId('bench-target')).toContainText('Tensor-parallel over spark-01 + spark-02')
  const levels = page.getByRole('toolbar', { name: 'Concurrency levels' })
  for (const off of ['2', '3', '4', '6', '8']) await levels.getByRole('button', { name: `${off} concurrent`, exact: true }).click()
  await page.getByTestId('bench-run-button').click()
  const run = page.getByTestId('bench-run')
  await expect(run).toHaveAttribute('data-status', 'completed', { timeout: 15_000 })
  await expect(run).toContainText('spark-01 (group: spark-01 + spark-02)')
})

test('the gateway benches every copy of a model and breaks the result down per copy', async ({ page }) => {
  await page.goto('/benchmarks')
  await page.getByTestId('bench-node').click()
  await page.getByRole('option', { name: /gpt-oss-120b.*2 copies/ }).click()
  await expect(page).toHaveURL(/node=gateway%3Adep-gptoss120|node=gateway:dep-gptoss120/)
  await expect(page.getByTestId('bench-target')).toContainText('Through the gateway to all 2 copies')
  await expect(page.getByTestId('bench-tab-quality')).toBeDisabled()
  const levels = page.getByRole('toolbar', { name: 'Concurrency levels' })
  for (const off of ['1', '2', '3', '6', '8']) await levels.getByRole('button', { name: `${off} concurrent`, exact: true }).click()
  await page.getByTestId('bench-run-button').click()
  const run = page.getByTestId('bench-run')
  await expect(run).toHaveAttribute('data-status', 'completed', { timeout: 15_000 })
  await expect(run).toContainText('gateway → 2 nodes')
  const breakdown = page.getByTestId('copy-breakdown')
  await expect(breakdown).toContainText('Per copy at 4 streams')
  await expect(breakdown).toContainText('spark-03')
  await expect(breakdown).toContainText('spark-06')
})
