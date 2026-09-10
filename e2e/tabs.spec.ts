import { test, expect } from '@playwright/test'

test('tab editing, undo, and fake dictation stay on selected tab', async ({ page }) => {
  await page.goto('/?voice=fake')
  await expect(page.locator('.block').first()).toBeVisible()
  await page.locator('.block').first().fill('Main content')
  await page.getByRole('button', { name: 'Show tabs & outlines' }).click()
  await page.getByRole('button', { name: 'Add tab', exact: true }).click()
  await expect(page.locator('.block').first()).toHaveText('')
  await page.locator('.block').first().fill('Second content')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(page.locator('.block').first()).toHaveText('')
  await page.getByRole('button', { name: 'Tab 1', exact: true }).click()
  await expect(page.locator('.block').first()).toHaveText('Main content')
  await page.getByRole('button', { name: 'Tab 2', exact: true }).click()
  await page.locator('.block').first().click()
  await page.evaluate(() => {
    const voice = (window as unknown as {
      __scroll: { voice: { transcriber: { start(): void; emitFinal(text: string): void } } }
    }).__scroll.voice
    voice.transcriber.start()
    voice.transcriber.emitFinal('Spoken on second tab')
  })
  await page.getByRole('button', { name: 'Tab 1', exact: true }).click()
  await expect(page.locator('.block').first()).toHaveText('Main content')
  await page.getByRole('button', { name: 'Tab 2', exact: true }).click()
  await expect(page.locator('.block').first()).toHaveText('Spoken on second tab')
})
