import { z } from 'zod';
import { isbot } from 'isbot';
import { createToken, parseToken } from '@/lib/jwt';
import clickhouse from '@/lib/clickhouse';
import { parseRequest } from '@/lib/request';
import { badRequest, json, forbidden, serverError } from '@/lib/response';
import { fetchSession, fetchWebsite } from '@/lib/load';
import { getClientInfo, hasBlockedIp } from '@/lib/detect';
import { secret, uuid, visitSalt } from '@/lib/crypto';
import { COLLECTION_TYPE } from '@/lib/constants';
import { anyObjectParam, urlOrPathParam } from '@/lib/schema';
import { createSession, saveEvent, saveSessionData } from '@/queries';

const schema = z.object({
  type: z.enum(['event', 'identify']),
  payload: z.object({
    website: z.string().uuid(),
    data: anyObjectParam.optional(),
    hostname: z.string().max(100).optional(),
    language: z.string().max(35).optional(),
    referrer: urlOrPathParam.optional(),
    screen: z.string().max(11).optional(),
    title: z.string().optional(),
    url: urlOrPathParam.optional(),
    name: z.string().max(50).optional(),
    tag: z.string().max(50).optional(),
    ip: z.string().ip().optional(),
    userAgent: z.string().optional(),
    timestamp: z.coerce.number().int().optional(),
  }),
});

export async function POST(request: Request) {
  try {
    // Bot check
    if (!process.env.DISABLE_BOT_CHECK && isbot(request.headers.get('user-agent'))) {
      return json({ beep: 'boop' });
    }

    const { body, error } = await parseRequest(request, schema, { skipAuth: true });

    if (error) {
      return error();
    }

    const { type, payload } = body;

    const {
      website: websiteId,
      hostname,
      screen,
      language,
      url,
      referrer,
      name,
      data,
      title,
      tag,
      timestamp,
    } = payload;

    // Cache check
    let cache: { websiteId: string; sessionId: string; visitId: string; iat: number } | null = null;
    const cacheHeader = request.headers.get('x-umami-cache');

    if (cacheHeader) {
      const result = await parseToken(cacheHeader, secret());

      if (result) {
        cache = result;
      }
    }

    // Find website
    if (!cache?.websiteId) {
      const website = await fetchWebsite(websiteId);

      if (!website) {
        return badRequest('Website not found.');
      }
    }

    // Client info
    const { ip, userAgent, device, browser, os, country, subdivision1, subdivision2, city } =
      await getClientInfo(request, payload);

    // IP block
    if (hasBlockedIp(ip)) {
      return forbidden();
    }

    const sessionId = uuid(websiteId, ip, userAgent);
    const createdAt = timestamp ? new Date(timestamp * 1000) : new Date();

    // Find session
    if (!clickhouse.enabled && !cache?.sessionId) {
      const session = await fetchSession(websiteId, sessionId);

      // Create a session if not found
      if (!session) {
        try {
          await createSession({
            id: sessionId,
            websiteId,
            hostname,
            browser,
            os,
            device,
            screen,
            language,
            country,
            subdivision1,
            subdivision2,
            city,
          });
        } catch (e: any) {
          if (!e.message.toLowerCase().includes('unique constraint')) {
            return serverError(e);
          }
        }
      }
    }

    // Visit info
    const createdAt = Math.floor((reqCreatedAt || new Date()).getTime() / 1000);
    let visitId = cache?.visitId || uuid(sessionId, visitSalt());
    let iat = cache?.iat || createdAt;

    // Expire visit after 30 minutes
    if (createdAt - iat > 1800) {
      visitId = uuid(sessionId, visitSalt());
      iat = createdAt;
    }

    if (type === COLLECTION_TYPE.event) {
      const base = hostname ? `https://${hostname}` : 'https://localhost';
      const currentUrl = new URL(url, base);

      let urlPath = currentUrl.pathname;
      const urlQuery = currentUrl.search.substring(1);
      const urlDomain = currentUrl.hostname.replace(/^www./, '');

      if (process.env.REMOVE_TRAILING_SLASH) {
        urlPath = urlPath.replace(/(.+)\/$/, '$1');
      }

      let referrerPath: string;
      let referrerQuery: string;
      let referrerDomain: string;

      if (referrer) {
        const referrerUrl = new URL(referrer, base);

        referrerPath = referrerUrl.pathname;
        referrerQuery = referrerUrl.search.substring(1);

        if (referrerUrl.hostname !== 'localhost') {
          referrerDomain = referrerUrl.hostname.replace(/^www\./, '');
        }
      }

      await saveEvent({
        websiteId,
        sessionId,
        visitId,
        urlPath,
        urlQuery,
        referrerPath,
        referrerQuery,
        referrerDomain,
        pageTitle: title,
        eventName: name,
        eventData: data,
        hostname: hostname || urlDomain,
        browser,
        os,
        device,
        screen,
        language,
        country,
        subdivision1,
        subdivision2,
        city,
        tag,
        createdAt,
      });
    }

    if (type === COLLECTION_TYPE.identify) {
      if (!data) {
        return badRequest('Data required.');
      }

      await saveSessionData({
        websiteId,
        sessionId,
        sessionData: data,
        createdAt,
      });
    }

    const token = createToken({ websiteId, sessionId, visitId, iat }, secret());

    return json({ cache: token });
  } catch (e) {
    return serverError(e);
  }
}
