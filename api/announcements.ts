import type { IncomingMessage, ServerResponse } from 'node:http'
import { neon } from '@neondatabase/serverless'

type ApiRequest = IncomingMessage & { body?: unknown }
type ApiResponse = ServerResponse
type AnnouncementKind = 'info' | 'promo' | 'warning'

function json(res: ApiResponse, status: number, data: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(data))
}

async function readBody(req: ApiRequest): Promise<unknown> {
  if (req.body !== undefined) return req.body
  let body = ''
  for await (const chunk of req) {
    body += chunk.toString()
    if (body.length > 8_192) throw new Error('Request body too large')
  }
  return body ? JSON.parse(body) : {}
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) return json(res, 503, { error: 'Announcement storage is not configured.' })

  try {
    const sql = neon(databaseUrl)
    await sql`CREATE TABLE IF NOT EXISTS linqa_announcements (
      id bigserial PRIMARY KEY,
      kind text NOT NULL CHECK (kind IN ('info', 'promo', 'warning')),
      message text NOT NULL,
      link_url text,
      starts_at timestamptz NOT NULL DEFAULT now(),
      ends_at timestamptz,
      enabled boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    )`
    await sql`CREATE INDEX IF NOT EXISTS linqa_announcements_active_idx ON linqa_announcements (enabled, starts_at, ends_at)`
    await sql`DELETE FROM linqa_announcements WHERE ends_at < now() - interval '90 days'`

    if (req.method === 'GET') {
      const authorization = req.headers.authorization ?? ''
      const expectedToken = process.env.LINQA_ADMIN_TOKEN
      const isAdmin = !!expectedToken && authorization === `Bearer ${expectedToken}`
      if (isAdmin) {
        const allMessages = await sql`SELECT id, kind, message, link_url AS "linkUrl", starts_at AS "startsAt", ends_at AS "endsAt", enabled, created_at AS "createdAt"
          FROM linqa_announcements ORDER BY created_at DESC LIMIT 100`
        return json(res, 200, { announcements: allMessages })
      }
      const messages = await sql`SELECT id, kind, message, link_url AS "linkUrl", starts_at AS "startsAt", ends_at AS "endsAt"
        FROM linqa_announcements
        WHERE enabled = true AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())
        ORDER BY starts_at DESC LIMIT 10`
      return json(res, 200, { announcements: messages })
    }

    if (req.method === 'POST') {
      const expectedToken = process.env.LINQA_ADMIN_TOKEN
      if (!expectedToken) return json(res, 503, { error: 'Announcement management is not configured.' })
      const authorization = req.headers.authorization ?? ''
      const providedToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
      if (!providedToken || providedToken !== expectedToken) return json(res, 401, { error: 'Unauthorized.' })

      const body = await readBody(req) as {
        message?: unknown
        kind?: unknown
        linkUrl?: unknown
        startsAt?: unknown
        endsAt?: unknown
      }
      const message = typeof body.message === 'string' ? body.message.trim() : ''
      const kind = body.kind
      if (!message || message.length > 240) return json(res, 400, { error: 'Message must contain 1–240 characters.' })
      if (kind !== 'info' && kind !== 'promo' && kind !== 'warning') return json(res, 400, { error: 'Kind must be info, promo, or warning.' })

      let linkUrl: string | null = null
      if (body.linkUrl !== undefined && body.linkUrl !== null && body.linkUrl !== '') {
        if (typeof body.linkUrl !== 'string') return json(res, 400, { error: 'Link must be an HTTPS URL.' })
        try {
          const parsed = new URL(body.linkUrl)
          if (parsed.protocol !== 'https:') throw new Error('invalid link')
          linkUrl = parsed.toString()
        } catch {
          return json(res, 400, { error: 'Link must be an HTTPS URL.' })
        }
      }
      const startsAt = body.startsAt ? new Date(String(body.startsAt)) : new Date()
      const endsAt = body.endsAt ? new Date(String(body.endsAt)) : null
      if (Number.isNaN(startsAt.getTime()) || (endsAt && Number.isNaN(endsAt.getTime())) || (endsAt && endsAt <= startsAt)) {
        return json(res, 400, { error: 'Announcement dates are invalid.' })
      }

      const [announcement] = await sql`INSERT INTO linqa_announcements (kind, message, link_url, starts_at, ends_at)
        VALUES (${kind as AnnouncementKind}, ${message}, ${linkUrl}, ${startsAt.toISOString()}, ${endsAt?.toISOString() ?? null})
        RETURNING id, kind, message, link_url AS "linkUrl", starts_at AS "startsAt", ends_at AS "endsAt"`
      return json(res, 201, { announcement })
    }

    if (req.method === 'DELETE') {
      const expectedToken = process.env.LINQA_ADMIN_TOKEN
      if (!expectedToken) return json(res, 503, { error: 'Announcement management is not configured.' })
      const authorization = req.headers.authorization ?? ''
      const providedToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
      if (!providedToken || providedToken !== expectedToken) return json(res, 401, { error: 'Unauthorized.' })
      const url = new URL(req.url ?? '/', 'http://localhost')
      const id = url.searchParams.get('id')
      if (!id || !/^\d+$/.test(id)) return json(res, 400, { error: 'A valid announcement ID is required.' })
      const result = await sql`UPDATE linqa_announcements SET enabled = false WHERE id = ${id} RETURNING id`
      if (result.length === 0) return json(res, 404, { error: 'Announcement not found.' })
      return json(res, 200, { disabled: true })
    }

    res.setHeader('Allow', 'GET, POST, DELETE')
    return json(res, 405, { error: 'Method not allowed.' })
  } catch (error) {
    console.error('Announcement API request failed:', error instanceof Error ? error.message : 'Unknown error')
    return json(res, 500, { error: 'Announcement service is temporarily unavailable.' })
  }
}
