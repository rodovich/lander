import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { taskRefFromQuery } from '../src/taskRef'
import { appStatus, appUrl, embedUrl, isListening } from './apps'

const hasIpv6Loopback = Object.values(networkInterfaces())
  .flat()
  .some((i) => i?.address === '::1')

describe('embedUrl', () => {
  it('names the task in a form the embed page reads back', () => {
    const url = new URL(embedUrl('https://localhost:41414', 'proj', 't1'))
    expect(url.origin + url.pathname).toBe('https://localhost:41414/embed.html')
    expect(taskRefFromQuery(url.search)).toEqual({ projectSlug: 'proj', id: 't1' })
  })
})

describe('appUrl', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lander-apps-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns a literal URL as written', () => {
    expect(appUrl({ url: 'http://localhost:5173' }, dir)).toBe('http://localhost:5173')
  })

  it('fills variables from the env file in the checkout', () => {
    writeFileSync(
      path.join(dir, '.env.local'),
      '# generated\nEASEL_PORT=3860 # dev\nexport HOST="localhost"\n',
    )
    expect(
      appUrl({ url: 'http://${HOST}:${EASEL_PORT}', envFile: '.env.local' }, dir),
    ).toBe('http://localhost:3860')
  })

  it('has no URL until the env file supplies every variable', () => {
    const app = { url: 'http://localhost:${EASEL_PORT}', envFile: '.env.local' }
    expect(appUrl(app, dir)).toBeUndefined()
    writeFileSync(path.join(dir, '.env.local'), 'OTHER=1\n')
    expect(appUrl(app, dir)).toBeUndefined()
  })

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'not a url'])(
    'refuses %s',
    (url) => {
      expect(appUrl({ url }, dir)).toBeUndefined()
    },
  )

  it('refuses a scheme an agent writes into the env file', () => {
    writeFileSync(path.join(dir, '.env.local'), 'TARGET=javascript:alert(1)\n')
    expect(appUrl({ url: '${TARGET}', envFile: '.env.local' }, dir)).toBeUndefined()
  })
})

describe('isListening', () => {
  let server: net.Server | undefined
  afterEach(() => new Promise((done) => (server ? server.close(done) : done(undefined))))

  const listen = (host: string) =>
    new Promise<number>((resolve) => {
      server = net.createServer().listen(0, host, () => {
        resolve((server!.address() as net.AddressInfo).port)
      })
    })

  it('finds a server bound to 127.0.0.1 through localhost', async () => {
    const port = await listen('127.0.0.1')
    expect(await isListening(`http://localhost:${port}`)).toBe(true)
  })

  it.skipIf(!hasIpv6Loopback)('finds a server bound to ::1 through localhost', async () => {
    const port = await listen('::1')
    expect(await isListening(`http://localhost:${port}`)).toBe(true)
  })

  it('reports a closed port', async () => {
    expect(await isListening('http://127.0.0.1:1')).toBe(false)
  })

  it('reports nothing listening when there is no URL yet', async () => {
    expect(await appStatus({ url: 'http://localhost:${P}' }, '/nowhere')).toEqual({
      listening: false,
    })
  })
})
