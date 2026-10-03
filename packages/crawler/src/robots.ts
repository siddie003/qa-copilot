import robotsParser from "robots-parser";
import { guardedFetch, type FetchOptions } from "./fetcher";

export interface RobotsRules {
  url: string;
  /** found: rules parsed; missing: 4xx (everything allowed); error: could not be fetched. */
  status: "found" | "missing" | "error";
  httpStatus: number | null;
  sitemaps: string[];
  isAllowed(url: string): boolean;
  body: string | null;
}

/**
 * Fetches and parses robots.txt for the site's origin. Per RFC 9309: a 4xx means no
 * restrictions; an unreachable robots.txt (5xx/network) means "assume full disallow".
 */
export async function loadRobots(siteUrl: string, fetchOpts: FetchOptions): Promise<RobotsRules> {
  const robotsUrl = new URL("/robots.txt", siteUrl).toString();
  const res = await guardedFetch(robotsUrl, { ...fetchOpts, maxBodyBytes: 500_000 });
  const ua = fetchOpts.userAgent;
  if (res.status !== null && res.status >= 200 && res.status < 300 && res.body !== null) {
    const parser = robotsParser(robotsUrl, res.body);
    return {
      url: robotsUrl,
      status: "found",
      httpStatus: res.status,
      sitemaps: parser.getSitemaps(),
      isAllowed: (u) => parser.isAllowed(u, ua) !== false,
      body: res.body,
    };
  }
  if (res.status !== null && res.status >= 400 && res.status < 500) {
    return {
      url: robotsUrl,
      status: "missing",
      httpStatus: res.status,
      sitemaps: [],
      isAllowed: () => true,
      body: null,
    };
  }
  return {
    url: robotsUrl,
    status: "error",
    httpStatus: res.status,
    sitemaps: [],
    isAllowed: () => false,
    body: null,
  };
}
