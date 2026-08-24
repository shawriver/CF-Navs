// 首页小组件的数据源。
//
// 为什么必须放在这个 Worker 里，而不是让前端直接抓 NodeSeek RSS：
// worker/lib/assetHeaders.ts 的 CSP 写了 `connect-src 'self'`，自定义 JS 里
// 任何跨源 fetch 都会被浏览器拦掉。所以数据必须由同源接口代理出去。
//
// 这个文件是本地新增（不属于上游 CF-Navs），同步上游时保留即可。

import { Hono } from 'hono'
import { fail, ok } from '../lib/response'
import { ErrCode } from '../../shared/types'
import type { HonoEnv } from '../types'

const widgetRoutes = new Hono<HonoEnv>()

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

const FEEDS: { source: string; url: string }[] = [
  { source: 'NodeSeek', url: 'https://rss.nodeseek.com/' },
  { source: 'NodeLoc', url: 'https://www.nodeloc.com/latest.rss' },
]

interface HotItem {
  source: string
  title: string
  link: string
  category: string
  pub: string
}

function decodeEntities(input: string): string {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

function pick(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
  return m ? decodeEntities(m[1]) : ''
}

function parseItems(xml: string, source: string): HotItem[] {
  const out: HotItem[] = []
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) ?? []
  for (const block of blocks) {
    const title = pick(block, 'title')
    const link = pick(block, 'link')
    if (!title || !link) continue
    out.push({
      source,
      title,
      link,
      category: pick(block, 'category') || '-',
      pub: pick(block, 'pubDate'),
    })
  }
  return out
}

// 交易帖过滤：Shaw 明确不看（好鸡秒没，看运气）
const TRADE_RE = /^\s*[[【「（(]*\s*(已?出|已?收|转让|转手|接手)\b/

widgetRoutes.get('/widgets/hot', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 12) || 12, 30)

  try {
    const results = await Promise.allSettled(
      FEEDS.map(async (feed) => {
        const res = await fetch(feed.url, {
          headers: { 'User-Agent': UA, Accept: 'application/rss+xml,text/xml,*/*' },
          cf: { cacheTtl: 600, cacheEverything: true },
        })
        if (!res.ok) throw new Error(`${feed.source} ${res.status}`)
        return parseItems(await res.text(), feed.source)
      }),
    )

    let items: HotItem[] = []
    const errors: string[] = []
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') items.push(...r.value)
      else errors.push(`${FEEDS[i].source}: ${String(r.reason).slice(0, 80)}`)
    })

    items = items.filter(
      (it) => it.category.toLowerCase() !== 'trade' && !TRADE_RE.test(it.title),
    )
    items.sort((a, b) => {
      const ta = Date.parse(a.pub) || 0
      const tb = Date.parse(b.pub) || 0
      return tb - ta
    })

    const body = ok({ items: items.slice(0, limit), errors, fetched_at: Date.now() })
    const response = c.json(body)
    // 边缘缓存 10 分钟，避免每个访客都去打论坛
    response.headers.set('Cache-Control', 'public, max-age=600')
    return response
  } catch (err) {
    return c.json(fail(ErrCode.SERVER_ERROR, `feed fetch failed: ${String(err).slice(0, 120)}`))
  }
})

export default widgetRoutes
