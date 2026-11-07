import { expect, test } from './fixtures.ts'

test('stop a deployment, then deploy a new model on the freed node', async ({ page }) => {
  await page.goto('/deployments')
  await expect(page.getByTestId('deployment-row')).toHaveCount(7)
  await page.getByTestId('deployment-row').filter({ hasText: 'mistral-small-3.2-24b' }).getByRole('button', { name: 'Stop' }).click()
  await page.getByRole('button', { name: 'Stop deployment' }).click()
  await expect(page.getByTestId('deployment-row')).toHaveCount(6)

  await page.getByRole('button', { name: 'Deploy model' }).click()
  await page.getByRole('combobox', { name: 'Model' }).click()
  await page.getByRole('option', { name: /gpt-oss 20B/ }).click()
  await page.getByRole('combobox', { name: 'Engine' }).click()
  await page.getByRole('option', { name: 'vLLM' }).click()
  await page.getByRole('checkbox', { name: /dell-02/ }).check()
  await page.getByRole('button', { name: 'Deploy', exact: true }).click()

  const fresh = page.getByTestId('deployment-row').filter({ hasText: 'gpt-oss-20b' })
  await expect(fresh).toContainText(/pending|loading/i)
  await expect(fresh).toContainText(/serving/i, { timeout: 30_000 })
})

test('deploy form explains why a model does not fit', async ({ page }) => {
  await page.goto('/deployments')
  await page.getByTestId('deployment-row').filter({ hasText: 'qwen3-235b-a22b' }).getByRole('button', { name: 'Stop' }).click()
  await page.getByRole('button', { name: 'Stop deployment' }).click()
  await page.getByRole('button', { name: 'Deploy model' }).click()
  await page.getByRole('combobox', { name: 'Model' }).click()
  await page.getByRole('option', { name: /DeepSeek V3.1/ }).click()
  await page.getByRole('combobox', { name: 'Engine' }).click()
  await page.getByRole('option', { name: 'SGLang' }).click()
  await page.getByRole('checkbox', { name: /spark-01/ }).check()
  await expect(page.getByTestId('fit-problem')).toHaveText('DeepSeek V3.1 (380 GB) needs at least 4 nodes')
  await expect(page.getByRole('button', { name: 'Deploy', exact: true })).toBeDisabled()
})

test('add a launcher for a two-node ring, start it, read its log, stop it', async ({ page }) => {
  await page.goto('/deployments')
  // free a ConnectX-7 pair for the ring
  await page.getByTestId('deployment-row').filter({ hasText: 'qwen3-235b-a22b' }).getByRole('button', { name: 'Stop' }).click()
  await page.getByRole('button', { name: 'Stop deployment' }).click()
  await expect(page.getByTestId('deployment-row')).toHaveCount(6)

  await page.getByRole('button', { name: 'Add launcher' }).click()
  await page.getByLabel('Name').fill('GLM ring')
  await page.getByRole('combobox', { name: 'Head node' }).click()
  await page.getByRole('option', { name: 'spark-01' }).click()
  await page.getByRole('checkbox', { name: 'spark-02' }).check()
  await page.getByLabel('Folder on the head').fill('~/swap')
  await page.getByLabel('Start script').fill('up-glm.sh')
  await page.getByLabel('Stop script').fill('down-glm.sh')
  await page.getByRole('dialog').getByRole('button', { name: 'Add launcher' }).click()

  const row = page.getByTestId('launcher-row').filter({ hasText: 'GLM ring' })
  await expect(row).toContainText('idle')
  await expect(row).toContainText('~/swap/up-glm.sh')
  await row.getByRole('button', { name: 'Start' }).click()
  await expect(row).toContainText(/starting/i)
  // it holds both nodes as one deployment
  await expect(page.getByTestId('deployment-row').filter({ hasText: 'GLM ring' })).toContainText('spark-02')
  await expect(row).toContainText(/serving/i, { timeout: 30_000 })

  await row.getByRole('button', { name: 'GLM ring actions' }).click()
  await page.getByRole('menuitem', { name: 'Show log' }).click()
  await expect(page.getByTestId('launcher-log')).toContainText('[rank 1] connected from spark-02')
  await page.keyboard.press('Escape')

  await row.getByRole('button', { name: 'Stop' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(row).toContainText('idle')
  await expect(page.getByTestId('deployment-row').filter({ hasText: 'GLM ring' })).toHaveCount(0)
})
