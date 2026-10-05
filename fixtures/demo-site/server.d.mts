import type http from "node:http";

export type DemoSiteVariant = "v1" | "v2";

export const MEMBERS_USER: string;
export const MEMBERS_PASSWORD: string;
export const HERO_PNG_BYTES: number;
export const VARIANTS: DemoSiteVariant[];
export function createDemoSiteServer(state?: { variant: DemoSiteVariant }): http.Server;
export function startDemoSite(
  port?: number,
  options?: { variant?: DemoSiteVariant },
): Promise<{
  port: number;
  url: string;
  variant: () => DemoSiteVariant;
  setVariant: (variant: DemoSiteVariant) => void;
  close: () => Promise<void>;
}>;
