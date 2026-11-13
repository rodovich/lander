import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { embedUrl } from '../daemon/apps'
import { READ_DWELL_MS } from '../src/useReadMarker'
import { serveApi, serveWeb, type TestServer } from '../webTestServer'

const TASK = {
  id: 't1',
  title: 'Fix the banner',
  status: 'paced',
  createdAt: '2026-11-10T00:00:00.000Z',
  updatedAt: '2026-11-10T00:00:00.000Z',
  items: [
    {
      id: 'm1',
      at: '2026-11-10T00:00:00.000Z',
      kind: 'message',
      role: 'user',
      text: 'The banner overlaps the toolbar.',
    },
  ],
  rides: [],
}

// TASK after a turn the viewer hasn't read yet.
const UNREAD_TASK = {
  ...TASK,
  readThrough: '2026-11-10T00:00:00.000Z',
  items: [
    ...TASK.items,
    {
      id: 'f1',
      at: '2026-11-10T00:00:30.000Z',
      rideId: 'r1',
      kind: 'message',
      role: 'flow',
      text: 'Moved the banner below the toolbar.',
    },
  ],
  rides: [{ id: 'r1', startedAt: '2026-11-10T00:00:10.000Z', endedAt: '2026-11-10T00:01:00.000Z' }],
}

const ATTACHMENT_TASK = {
  ...TASK,
  items: [
    {
      ...TASK.items[0],
      attachments: [{ id: 'a1', name: 'notes.txt', mime: 'text/plain', size: 17 }],
    },
  ],
}

// UNREAD_TASK between enough earlier and later messages to fill the panel
// several times over on each side.
const ownMessages = (name: string, at: string) =>
  Array.from({ length: 30 }, (_, i) => ({
    id: `${name}${i}`,
    at,
    kind: 'message',
    role: 'user',
    text: `${name} message ${i}.`,
  }))
const LONG_UNREAD_TASK = {
  ...UNREAD_TASK,
  items: [
    ...ownMessages('Earlier', '2026-11-10T00:00:00.000Z'),
    ...UNREAD_TASK.items,
    ...ownMessages('Later', '2026-11-10T00:02:00.000Z'),
  ],
}

describe('the widget in an app’s page', () => {
  let api: TestServer
  let lander: TestServer
  let app: http.Server
  let appOrigin: string
  let browser: Browser
  let contexts: BrowserContext[] = []
  // The app the API names as the task's, which may frame the embed page.
  let framingOrigin: string
  // The task as the API serves it. Marking it seen reads it through the end.
  let task: Record<string, unknown>
  let seen: number

  beforeAll(async () => {
    api = await serveApi((path) => {
      if (path === '/api/proj/tasks/t1') return Response.json(task)
      if (path === '/api/proj/attachments/a1')
        return new Response('The attached notes', { headers: { 'content-type': 'text/plain' } })
      if (path === '/api/proj/tasks/t1/app')
        return Response.json({ app: { url: `${framingOrigin}/` } })
      if (path === '/api/proj/tasks/t1/seen') {
        seen++
        task = { ...task, readThrough: '2026-11-10T00:01:00.000Z' }
        return Response.json(task)
      }
      return Response.json({ error: 'not found' }, { status: 404 })
    })
    lander = await serveWeb(api.url, { entries: ['embed.html'] })
    const embed = embedUrl(lander.url.replace(/\/$/, ''), 'proj', 't1').replaceAll('&', '&amp;')
    app = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/html')
      // A page-wide overlay with a z-index in the range easel's overlays use.
      res.end(`<!doctype html>
        <body>
          <div style="position: fixed; inset: 0; z-index: 1000000000"
            onclick="window.appClicks = (window.appClicks ?? 0) + 1"></div>
          <script src="${lander.url}widget.js" data-embed-url="${embed}"></script>
        </body>`)
    })
    await new Promise<void>((listening) => app.listen(0, '127.0.0.1', listening))
    appOrigin = `http://127.0.0.1:${(app.address() as AddressInfo).port}`
    browser = await chromium.launch({ channel: 'chrome' })
  })

  beforeEach(() => {
    framingOrigin = appOrigin
    task = TASK
    seen = 0
  })

  afterEach(async () => {
    await Promise.all(contexts.map((context) => context.close()))
    contexts = []
  })

  afterAll(async () => {
    await browser?.close()
    await lander?.close()
    await api?.close()
    if (app) await new Promise<void>((closed) => app.close(() => closed()))
  })

  async function openApp(beforeLoad?: (page: Page) => void): Promise<Page> {
    const context = await browser.newContext()
    contexts.push(context)
    const page = await context.newPage()
    beforeLoad?.(page)
    await page.goto(appOrigin)
    return page
  }

  const toggle = (page: Page) => page.getByRole('button', { name: 'lander' })
  const frame = (page: Page) => page.locator('lander-widget iframe')
  const embedded = (page: Page) => page.frameLocator('lander-widget iframe')
  const embeddedTitle = (page: Page) => embedded(page).getByText('Fix the banner')

  async function openWidget(): Promise<Page> {
    const page = await openApp()
    await toggle(page).click()
    await embeddedTitle(page).waitFor()
    return page
  }

  it('opens the task’s conversation over the page when clicked', async () => {
    const page = await openWidget()
    expect(await toggle(page).getAttribute('aria-expanded')).toBe('true')
  })

  it('stays open, showing the task, across a reload of the page', async () => {
    const page = await openWidget()
    await page.reload()
    await embeddedTitle(page).waitFor()
  })

  it('closes and reopens without reloading the conversation', async () => {
    const page = await openWidget()
    await frame(page).evaluate((el) => el.setAttribute('data-mark', 'first'))
    await toggle(page).click()
    await frame(page).waitFor({ state: 'hidden' })
    await toggle(page).click()
    await embeddedTitle(page).waitFor()
    expect(await frame(page).getAttribute('data-mark')).toBe('first')
  })

  it('closes when the page is clicked outside it, and the page still gets the click', async () => {
    const page = await openWidget()
    await embeddedTitle(page).click()
    expect(await toggle(page).getAttribute('aria-expanded')).toBe('true')
    await page.mouse.click(1000, 100)
    await frame(page).waitFor({ state: 'hidden' })
    expect(await page.evaluate(() => (window as { appClicks?: number }).appClicks)).toBe(1)
  })

  it('previews an attachment over the whole page, and closes the preview with Escape', async () => {
    task = ATTACHMENT_TASK
    const page = await openWidget()
    await embedded(page).getByRole('button', { name: /notes\.txt/ }).click()
    const preview = page.locator('lander-widget iframe.preview')
    await page.frameLocator('lander-widget iframe.preview').getByText('The attached notes').waitFor()
    expect(await preview.boundingBox()).toEqual({ x: 0, y: 0, ...page.viewportSize() })
    await page.keyboard.press('Escape')
    await preview.waitFor({ state: 'hidden' })
    expect(await toggle(page).getAttribute('aria-expanded')).toBe('true')
  })

  it('fits three lines of a reply without scrolling', async () => {
    const page = await openWidget()
    const reply = embedded(page).getByPlaceholder('Reply…')
    await reply.fill('One\nTwo\nThree')
    const [scrollHeight, clientHeight] = await reply.evaluate((el) => [
      el.scrollHeight,
      el.clientHeight,
    ])
    expect(scrollHeight).toBeLessThanOrEqual(clientHeight)
  })

  it('resizes the reply box from its handle, following a drag past the panel', async () => {
    const page = await openWidget()
    const reply = embedded(page).getByPlaceholder('Reply…')
    const handle = embedded(page).getByRole('separator', { name: 'Resize reply area' })
    const start = (await reply.boundingBox())!.height
    const box = (await handle.boundingBox())!
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x, y - 60, { steps: 4 })
    await expect.poll(async () => (await reply.boundingBox())!.height).toBe(start + 60)
    // Below the panel, outside the frame, the drag still shrinks the box.
    await page.mouse.move(x, page.viewportSize()!.height - 2, { steps: 4 })
    await page.mouse.up()
    await expect.poll(async () => (await reply.boundingBox())!.height).toBeLessThan(start)
  })

  it('copies a message’s text from inside the frame', async () => {
    const page = await openWidget()
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    const clipboard = () => page.evaluate(() => navigator.clipboard.readText())
    await page.evaluate(() => navigator.clipboard.writeText(''))
    await embedded(page).getByText('The banner overlaps the toolbar.').hover()
    await embedded(page).getByRole('button', { name: 'Copy message text' }).click()
    await expect.poll(clipboard).toBe('The banner overlaps the toolbar.')
  })

  const WAIT = { timeout: 10_000 }
  const buttonClasses = (page: Page) => toggle(page).evaluate((el) => [...el.classList])

  it('rings the button while the task is unread, and marks it read only once the panel shows it', async () => {
    task = UNREAD_TASK
    const page = await openApp()
    await expect.poll(() => buttonClasses(page), WAIT).toContain('unread')
    const ring = await toggle(page).evaluate((el) => getComputedStyle(el, '::after').borderColor)
    expect(ring).toBe('rgb(102, 68, 238)')
    await page.waitForTimeout(READ_DWELL_MS + 1500)
    expect(seen).toBe(0)

    await toggle(page).click()
    await expect.poll(() => seen, WAIT).toBeGreaterThan(0)
    await expect.poll(() => buttonClasses(page), WAIT).not.toContain('unread')
  })

  it('opens the panel at the first unread message', async () => {
    task = LONG_UNREAD_TASK
    const page = await openApp()
    await expect.poll(() => buttonClasses(page), WAIT).toContain('unread')
    await toggle(page).click()
    const inView = (text: string) =>
      embedded(page)
        .getByText(text, { exact: true })
        .evaluate((el) => {
          const box = el.getBoundingClientRect()
          return box.bottom > 0 && box.top < window.innerHeight
        })
    await expect.poll(() => inView('Moved the banner below the toolbar.'), WAIT).toBe(true)
    expect(await inView('Earlier message 0.')).toBe(false)
    expect(await inView('Later message 29.')).toBe(false)
  })

  it('never shows the conversation scrolled to the top on the way to the first unread message', async () => {
    task = LONG_UNREAD_TASK
    const page = await openApp()
    await expect.poll(() => buttonClasses(page), WAIT).toContain('unread')
    type Sampled = { scrolls: number[] }
    const content = embedded(page).locator('html')
    await content.evaluate(() => {
      const samples: number[] = []
      ;(window as unknown as Sampled).scrolls = samples
      const sample = () => {
        const pane = document.querySelector('.messages')
        if (pane) samples.push(pane.scrollTop)
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
    await toggle(page).click()
    const scrolls = () => content.evaluate(() => (window as unknown as Sampled).scrolls)
    await expect.poll(async () => (await scrolls()).length, WAIT).toBeGreaterThan(10)
    expect(await scrolls()).not.toContain(0)
  })

  it('turns an arc around the button while the task rides', async () => {
    task = { ...TASK, status: 'riding' }
    const page = await openApp()
    await expect.poll(() => buttonClasses(page), WAIT).toContain('riding')
    task = TASK
    await expect.poll(() => buttonClasses(page), WAIT).not.toContain('riding')
  })

  it('is refused by the browser when the task’s app is somewhere else', async () => {
    framingOrigin = 'http://localhost:1'
    let refused: Promise<unknown> | undefined
    await openApp((page) => {
      refused = page.waitForEvent('console', (message) =>
        message.text().includes('frame-ancestors'),
      )
    })
    await refused
  })
})
