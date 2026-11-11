import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { embedUrl } from '../daemon/apps'
import { serveApi, serveWeb, type TestServer } from '../webTestServer'

const TASK = {
  id: 't1',
  title: 'Fix the banner',
  status: 'paced',
  createdAt: '2026-11-10T00:00:00.000Z',
  updatedAt: '2026-11-10T00:00:00.000Z',
  items: [],
  rides: [],
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

  beforeAll(async () => {
    api = await serveApi((path) =>
      path === '/api/proj/tasks/t1'
        ? Response.json(TASK)
        : path === '/api/proj/tasks/t1/app'
          ? Response.json({ app: { url: `${framingOrigin}/` } })
          : Response.json({ error: 'not found' }, { status: 404 }),
    )
    lander = await serveWeb(api.url, { entries: ['embed.html'] })
    const embed = embedUrl(lander.url.replace(/\/$/, ''), 'proj', 't1').replaceAll('&', '&amp;')
    app = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/html')
      // A page-wide overlay with a z-index in the range easel's overlays use.
      res.end(`<!doctype html>
        <body>
          <div style="position: fixed; inset: 0; z-index: 1000000000"></div>
          <script src="${lander.url}widget.js" data-embed-url="${embed}"></script>
        </body>`)
    })
    await new Promise<void>((listening) => app.listen(0, '127.0.0.1', listening))
    appOrigin = `http://127.0.0.1:${(app.address() as AddressInfo).port}`
    browser = await chromium.launch({ channel: 'chrome' })
  })

  beforeEach(() => {
    framingOrigin = appOrigin
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

  async function openApp(): Promise<Page> {
    const context = await browser.newContext()
    contexts.push(context)
    const page = await context.newPage()
    await page.goto(appOrigin)
    return page
  }

  const toggle = (page: Page) => page.getByRole('button', { name: 'lander' })
  const frame = (page: Page) => page.locator('lander-widget iframe')
  const embeddedTitle = (page: Page) =>
    page.frameLocator('lander-widget iframe').getByText('Fix the banner')

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

  it('is refused by the browser when the task’s app is somewhere else', async () => {
    framingOrigin = 'http://localhost:1'
    const page = await openApp()
    const refused = page.waitForEvent('console', (message) =>
      message.text().includes('frame-ancestors'),
    )
    await toggle(page).click()
    await refused
  })
})
