#!/usr/bin/env node
// Node port of assets/cfnavs_icons.py -- gives CF-Navs bookmarks a real favicon.
//
// Why this step exists: the imported JSON sets icon_source=direct with an empty
// icon, so the frontend degrades to a letter tile. Here we probe each site for a
// usable favicon, write it back to the icon field, then call
// /api/bookmarks/:id/icon-cache/refresh so the Worker pulls the image into D1
// (icon_blob). After that the frontend serves same-origin /api/icon/:id and no
// longer depends on the remote site being reachable.
//
// Gotcha kept from the Python version: Google s2 favicons answers 301 to
// gstatic, so redirects must be followed. Without that you store a chunk of
// HTML, which renders as a broken image. Magic-byte sniffing drops fake images.

import { readFileSync } from 'node:fs'
import { setGlobalDispatcher, ProxyAgent, Agent, interceptors, request } from 'undici'

const BASE = (process.argv[2] || 'http://127.0.0.1:8788').replace(/\/+$/, '')
const CRED = process.env.CFNAVS_CRED || '/tmp/cfnavs-admin.txt'
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const CONCURRENCY = 10

// This undici build rejects per-request maxRedirections on a ProxyAgent, so
// redirect following is installed as an interceptor instead. Keeping redirects
// is required: Google s2 favicons answers 301 to gstatic.
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
const redirect = interceptors.redirect({ maxRedirections: 5 })
setGlobalDispatcher((proxy ? new ProxyAgent(proxy) : new Agent()).compose(redirect))

const MAGIC = [
  [[0x89, 0x50, 0x4e, 0x47], 'png'],
  [[0x47, 0x49, 0x46, 0x38], 'gif'],
  [[0xff, 0xd8, 0xff], 'jpeg'],
  [[0x00, 0x00, 0x01, 0x00], 'x-icon'],
  [[0x52, 0x49, 0x46, 0x46], 'webp'],
]

async function api(method, path, body, token) {
  const headers = {
    'Content-Type': 'application/json',
    Origin: BASE,
    'Sec-Fetch-Site': 'same-origin',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  try {
    const res = await request(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      headersTimeout: 60000,
      bodyTimeout: 60000,
    })
    const text = await res.body.text()
    try {
      return JSON.parse(text)
    } catch {
      return { code: -1, msg: 'unparseable', raw: text.slice(0, 300) }
    }
  } catch (err) {
    return { code: -1, msg: String(err).slice(0, 200) }
  }
}

// Redirects are followed via the global interceptor, mirroring curl -L.
async function fetchBinary(url, timeoutMs = 14000) {
  try {
    const res = await request(url, {
      method: 'GET',
      headers: { 'User-Agent': UA },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    })
    if (res.statusCode >= 400) return null
    const buf = Buffer.from(await res.body.arrayBuffer())
    return buf.length ? buf : null
  } catch {
    return null
  }
}

function sniff(data) {
  if (!data || data.length < 64) return null
  for (const [sig, kind] of MAGIC) {
    if (sig.every((b, i) => data[i] === b)) return kind
  }
  if (data.subarray(0, 400).toString('latin1').toLowerCase().includes('<svg')) return 'svg+xml'
  return null
}

async function candidates(pageUrl) {
  let parsed
  try {
    parsed = new URL(pageUrl)
  } catch {
    return []
  }
  const root = `${parsed.protocol}//${parsed.host}`
  const out = [`${root}/favicon.ico`, `${root}/apple-touch-icon.png`]

  const html = await fetchBinary(root, 12000)
  if (html) {
    const text = html.toString('utf8')
    for (const tag of text.match(/<link[^>]+>/gi) ?? []) {
      if (!/rel=["'][^"']*icon/i.test(tag)) continue
      const href = tag.match(/href=["']([^"']+)["']/i)
      if (href) {
        try {
          out.push(new URL(href[1], `${root}/`).href)
        } catch {
          // ignore unparseable href
        }
      }
    }
  }

  out.push(`https://www.google.com/s2/favicons?sz=64&domain=${parsed.host}`)
  return [...new Set(out)]
}

async function probe(bm) {
  for (const cand of await candidates(bm.url)) {
    const data = await fetchBinary(cand)
    if (sniff(data)) return { id: bm.id, icon: cand }
  }
  return { id: bm.id, icon: null }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index])
    }
  })
  await Promise.all(runners)
  return results
}

async function main() {
  const lines = readFileSync(CRED, 'utf8').trim().split(/\r?\n/)
  const [username, password] = lines.slice(0, 2).map((l) => l.trim())

  const login = await api('POST', '/api/login', { username, password })
  const token = login?.data?.token
  if (!token) {
    console.error('login failed:', JSON.stringify(login).slice(0, 200))
    return 1
  }

  const bookmarks = (await api('GET', '/api/bookmarks', undefined, token))?.data
  if (!Array.isArray(bookmarks)) {
    console.error('could not list bookmarks')
    return 1
  }
  console.log(`共 ${bookmarks.length} 个书签，开始探测 favicon`)

  const probed = await mapLimit(bookmarks, CONCURRENCY, probe)
  const found = new Map(probed.filter((p) => p.icon).map((p) => [p.id, p.icon]))
  console.log(`探测到 ${found.size}/${bookmarks.length}`)

  let written = 0
  let cached = 0
  for (const bm of bookmarks) {
    const icon = found.get(bm.id)
    if (!icon) continue

    const payload = {
      category_id: bm.category_id,
      title: bm.title,
      url: bm.url,
      icon,
      icon_source: 'custom',
      icon_background_color: bm.icon_background_color ?? null,
      description: bm.description ?? null,
      description_mode: bm.description_mode || 'always',
      open_method: bm.open_method || 1,
      sort: bm.sort || 0,
    }

    const put = await api('PUT', `/api/bookmarks/${bm.id}`, payload, token)
    if (put?.code !== 0) {
      console.log('  写入失败', bm.title, JSON.stringify(put).slice(0, 120))
      continue
    }
    written++

    const refresh = await api('POST', `/api/bookmarks/${bm.id}/icon-cache/refresh`, {}, token)
    if (refresh?.code === 0 && refresh?.data?.icon_blob) cached++
  }

  console.log(`写入 icon: ${written} | 服务端缓存成功: ${cached}`)
  return 0
}

main().then((code) => process.exit(code))