import type http from "node:http";

export function createDemoSiteServer(): http.Server;
export function startDemoSite(
  port?: number,
): Promise<{ port: number; url: string; close: () => Promise<void> }>;
