import type http from "node:http";

export const MEMBERS_USER: string;
export const MEMBERS_PASSWORD: string;
export const HERO_PNG_BYTES: number;
export function createDemoSiteServer(): http.Server;
export function startDemoSite(
  port?: number,
): Promise<{ port: number; url: string; close: () => Promise<void> }>;
