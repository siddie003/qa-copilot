import "server-only";
import { EventEmitter } from "node:events";
import { errorFields, getConfig, getLogger } from "@qa/core";
import pg from "pg";

/**
 * One shared LISTEN connection per web process fans out `scan_events` notifications (payload =
 * scan id) to SSE streams. If it drops, it reconnects; clients also poll as a fallback.
 */
class ScanEventHub extends EventEmitter {
  private client: pg.Client | null = null;
  private connecting: Promise<void> | null = null;

  constructor() {
    super();
    this.setMaxListeners(1_000);
  }

  ensureConnected(): Promise<void> {
    if (this.client) return Promise.resolve();
    this.connecting ??= (async () => {
      const client = new pg.Client({
        connectionString: getConfig().DATABASE_URL,
        application_name: "qa-copilot-web-events",
      });
      client.on("notification", (msg) => msg.payload && this.emit(msg.payload));
      client.on("error", (err) => {
        getLogger().warn(errorFields(err), "scan event listener lost; reconnecting");
        this.client = null;
        setTimeout(() => void this.ensureConnected().catch(() => {}), 2_000);
      });
      await client.connect();
      await client.query("LISTEN scan_events");
      this.client = client;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }
}

const g = globalThis as unknown as { __qaScanEvents?: ScanEventHub };
export function scanEvents(): ScanEventHub {
  g.__qaScanEvents ??= new ScanEventHub();
  return g.__qaScanEvents;
}
