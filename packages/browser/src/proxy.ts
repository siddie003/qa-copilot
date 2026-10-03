import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import {
  BlockedTargetError,
  resolvePublicTarget,
  type Resolver,
  type TargetPolicy,
} from "@qa/security";

export interface GuardProxy {
  /** e.g. http://127.0.0.1:53211 — pass to Chromium as its proxy server. */
  url: string;
  blocked: Array<{ url: string; reason: string }>;
  close(): Promise<void>;
}

/**
 * Local forward proxy that every browser request goes through. Chromium sends host names to the
 * proxy instead of resolving them itself; the proxy resolves with the scan's policy and connects
 * to exactly the address it validated. This closes the DNS-rebinding gap between the route-level
 * check and Chromium's own connection. Bound to 127.0.0.1 only.
 */
export async function startGuardProxy(
  policy: TargetPolicy,
  resolve?: Resolver,
): Promise<GuardProxy> {
  const blocked: GuardProxy["blocked"] = [];
  const sockets = new Set<net.Socket>();

  const pick = async (url: string) => {
    const addresses = await resolvePublicTarget(url, policy, resolve);
    return addresses.find((a) => a.family === 4) ?? addresses[0]!;
  };
  const reasonOf = (err: unknown) =>
    err instanceof BlockedTargetError ? err.message : `Proxy error: ${(err as Error).message}`;

  const server = http.createServer(async (req, res) => {
    // Plain HTTP: the request line carries the absolute URL.
    const target = req.url ?? "";
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      res.writeHead(400).end();
      return;
    }
    let address;
    try {
      address = await pick(url.toString());
    } catch (err) {
      blocked.push({ url: url.toString(), reason: reasonOf(err) });
      // Drop the connection so the browser sees a network error, not a fake HTTP response.
      req.socket.destroy();
      return;
    }
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const upstream = http.request(
      {
        host: address.address,
        family: address.family,
        port: url.port || 80,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
        setHost: false,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.rawHeaders);
        up.pipe(res);
      },
    );
    upstream.on("error", () => req.socket.destroy());
    req.pipe(upstream);
  });

  // HTTPS and WebSockets: CONNECT host:port, then a raw TCP tunnel to the validated address.
  server.on("connect", async (req, client: net.Socket, head: Buffer) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    const [host, port = "443"] = splitHostPort(req.url ?? "");
    const scheme = port === "80" ? "http" : "https";
    const display = `${scheme}://${host}:${port}`;
    let address;
    try {
      address = await pick(`${scheme}://${host.includes(":") ? `[${host}]` : host}:${port}/`);
    } catch (err) {
      blocked.push({ url: display, reason: reasonOf(err) });
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = net.connect({
      host: address.address,
      port: Number(port),
      family: address.family,
    });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    blocked,
    close: () =>
      new Promise<void>((done) => {
        for (const s of sockets) s.destroy();
        server.close(() => done());
      }),
  };
}

function splitHostPort(value: string): [string, string] {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(value) ?? /^([^:]+):(\d+)$/.exec(value);
  return m ? [m[1]!, m[2]!] : [value, "443"];
}
