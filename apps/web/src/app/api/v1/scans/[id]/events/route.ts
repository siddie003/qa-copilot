import { errorFields, getLogger } from "@qa/core";
import { authedHandler } from "@/server/api";
import { scanEvents } from "@/server/scan-events";
import { getScan, TERMINAL_SCAN_STATUSES } from "@/server/scans";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * Server-Sent Events: sends the scan snapshot (read from the database) now and whenever the
 * worker reports a change. The stream ends when the scan reaches a final state.
 */
export const GET = authedHandler<Params>(
  "GET /api/v1/scans/:id/events",
  async (req, { user, params }) => {
    const { id } = await params;
    const first = await getScan(user.id, id); // 404 for foreign/missing scans before streaming
    const hub = scanEvents();
    await hub
      .ensureConnected()
      .catch((err) => getLogger().warn(errorFields(err), "SSE without LISTEN; client will poll"));
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        let pending: NodeJS.Timeout | null = null;
        const send = (event: string, data: unknown) => {
          if (!closed)
            controller.enqueue(
              encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
            );
        };
        const push = async () => {
          try {
            const snapshot = await getScan(user.id, id);
            send("scan", snapshot);
            if (TERMINAL_SCAN_STATUSES.has(snapshot.status)) close();
          } catch (err) {
            send("error", { message: "Scan status could not be loaded" });
            getLogger().warn(errorFields(err), "SSE snapshot failed");
          }
        };
        // Coalesce bursts of notifications (several pages per second) into one snapshot.
        const onChange = () => {
          pending ??= setTimeout(() => {
            pending = null;
            void push();
          }, 300);
        };
        const keepAlive = setInterval(() => {
          if (!closed) controller.enqueue(encoder.encode(": keep-alive\n\n"));
        }, 15_000);
        const close = () => {
          if (closed) return;
          closed = true;
          hub.off(id, onChange);
          clearInterval(keepAlive);
          if (pending) clearTimeout(pending);
          try {
            controller.close();
          } catch {
            // already closed by the client
          }
        };
        hub.on(id, onChange);
        req.signal.addEventListener("abort", close);
        send("scan", first);
        if (TERMINAL_SCAN_STATUSES.has(first.status)) close();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
        "x-accel-buffering": "no",
      },
    });
  },
);
