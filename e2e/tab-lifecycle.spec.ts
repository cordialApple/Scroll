import { test, expect, type Page } from '@playwright/test'
import type * as Y from 'yjs'
import type { FakeTranscriber } from '../src/voice/fakeTranscriber'
import type { EditorApi } from '../src/editor/Editor'

interface ScrollTestWindow {
  __scroll: { doc: Y.Doc; api: { current: EditorApi }; voice: { transcriber: FakeTranscriber } }
}

async function openTabs(page: Page) {
  await page.goto('/?voice=fake')
  await expect(page.locator('.block').first()).toBeVisible()
  await page.getByRole('button', { name: 'Show tabs & outlines' }).click()
}

test('undo and redo survive leaving and returning to a tab', async ({ page }) => {
  await openTabs(page)
  await page.locator('.block').first().fill('Main content')
  await page.getByRole('button', { name: 'Add tab', exact: true }).click()
  await page.locator('.block').first().fill('Second content')
  await page.getByRole('button', { name: 'Tab 1', exact: true }).click()
  await page.getByRole('button', { name: 'Tab 2', exact: true }).click()
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(page.locator('.block').first()).toHaveText('')
  await page.getByRole('button', { name: 'Tab 1', exact: true }).click()
  await expect(page.locator('.block').first()).toHaveText('Main content')
  await page.getByRole('button', { name: 'Tab 2', exact: true }).click()
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  await expect(page.locator('.block').first()).toHaveText('Second content')
})

test('dictation waits for a new caret after switching tabs', async ({ page }) => {
  await openTabs(page)
  await page.locator('.block').first().fill('Main content')
  await page.locator('.block').first().press('End')
  await expect.poll(() => page.evaluate(() => (window as unknown as ScrollTestWindow).__scroll.api.current.dictationTarget()?.blocksKey)).toBe('blocks')
  await page.evaluate(() => {
    const transcriber = (window as unknown as ScrollTestWindow).__scroll.voice.transcriber
    transcriber.start()
    transcriber.emitFinal(' first')
  })
  await expect(page.locator('.block').first()).toHaveText('Main content first')
  await page.getByRole('button', { name: 'Add tab', exact: true }).click()
  await expect(page.locator('.block').first()).toHaveText('')
  await page.evaluate(() => (window as unknown as ScrollTestWindow).__scroll.voice.transcriber.emitFinal(' hidden'))
  await page.getByRole('button', { name: 'Tab 1', exact: true }).click()
  await expect(page.locator('.block').first()).toHaveText('Main content first')
  await page.getByRole('button', { name: 'Tab 2', exact: true }).click()
  await page.locator('.block').first().click()
  await expect.poll(() => page.evaluate(() => (window as unknown as ScrollTestWindow).__scroll.api.current.dictationTarget()?.blocksKey)).not.toBe('blocks')
  await page.evaluate(() => (window as unknown as ScrollTestWindow).__scroll.voice.transcriber.emitFinal('New tab speech'))
  await expect(page.locator('.block').first()).toHaveText('New tab speech')
})

test('remote tab removal moves editing back to a live tab', async ({ page }) => {
  await openTabs(page)
  await page.locator('.block').first().fill('Main content')
  await page.getByRole('button', { name: 'Add tab', exact: true }).click()
  await page.locator('.block').first().fill('Removed tab content')
  await page.evaluate(async () => {
    const modelUrl = '/src/doc/model.ts'
    const source = await (await fetch(modelUrl)).text()
    const yjsUrl = source.match(/import \* as Y from "([^"]+)"/)?.[1]
    if (!yjsUrl) throw new Error('Missing Yjs import in served model')
    const yjs: typeof import('yjs') = await import(yjsUrl)
    const model: typeof import('../src/doc/model') = await import(modelUrl)
    const { doc } = (window as unknown as ScrollTestWindow).__scroll
    const remote = new yjs.Doc()
    yjs.applyUpdate(remote, yjs.encodeStateAsUpdate(doc))
    const active = model.getActiveTabId(remote)
    model.removeTab(remote, active)
    yjs.applyUpdate(doc, yjs.encodeStateAsUpdate(remote, yjs.encodeStateVector(doc)), 'remote-test')
    remote.destroy()
  })
  await expect(page.getByRole('button', { name: 'Tab 2', exact: true })).toHaveCount(0)
  await expect(page.locator('.block').first()).toHaveText('Main content')
  await page.locator('.block').first().fill('Edited live tab')
  await expect(page.locator('.nav-tab-active')).toContainText('Tab 1')
})

test('invalid tab URL opens an existing editable tab', async ({ page }) => {
  await page.goto('/?tab=missing-tab')
  await expect(page.locator('.boot')).toHaveCount(0)
  await expect(page.locator('.block').first()).toBeVisible()
  await page.locator('.block').first().fill('Valid tab content')
  await page.getByRole('button', { name: 'Show tabs & outlines' }).click()
  await expect(page.locator('.nav-tab-active')).toContainText('Tab 1')
})
