/**
 * HTTPIngestor — Phase A: 開発・デバッグ用 HTTP 受信器
 *
 * POST /ingest  Content-Type: application/json
 *   → body を JSON パースして onReceive ハンドラに渡す
 *
 * Minecraft Bukkit Plugin はここに POST する。
 * ボトルネックになったら Phase B (UDSIngestor) に切り替える。
 *
 * 外部依存なし。Node.js 組み込み http モジュールのみ使用。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface HTTPIngestorOptions {
  /** 受信ポート。デフォルト: 3000 */
  port?: number;
  /** バインドするホスト。デフォルト: "127.0.0.1" (ローカルのみ) */
  host?: string;
  /** リクエストボディの最大サイズ (bytes)。デフォルト: 1MB */
  maxBodyBytes?: number;
}

export class HTTPIngestor {
  private readonly port: number;
  private readonly host: string;
  private readonly maxBodyBytes: number;
  private handler: ((raw: Record<string, unknown>) => void) | null = null;
  private server: Server | null = null;

  constructor(opts: HTTPIngestorOptions = {}) {
    this.port = opts.port ?? 3000;
    this.host = opts.host ?? "127.0.0.1";
    this.maxBodyBytes = opts.maxBodyBytes ?? 1_048_576; // 1MB
  }

  onReceive(handler: (raw: Record<string, unknown>) => void): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this.server) return; // already started

    this.server = createServer((req, res) => {
      this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, this.host, () => resolve());
      this.server!.once("error", reject);
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => (err ? reject(err) : resolve()));
    });
    this.server = null;
  }

  /** バインドされているアドレスを返す (テスト用: port=0 で動的割当後に確認) */
  address(): { host: string; port: number } | null {
    const addr = this.server?.address();
    if (!addr || typeof addr === "string") return null;
    return { host: addr.address, port: addr.port };
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // POST /ingest 以外は 404
    if (req.method !== "POST" || req.url !== "/ingest") {
      res.writeHead(404).end();
      return;
    }

    let body = "";
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > this.maxBodyBytes) {
        res.writeHead(413).end("payload too large");
        req.destroy();
        return;
      }
      body += chunk.toString("utf8");
    });

    req.on("end", () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400).end("invalid JSON");
        return;
      }

      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        res.writeHead(400).end("body must be a JSON object");
        return;
      }

      if (this.handler) {
        this.handler(parsed as Record<string, unknown>);
      }

      res.writeHead(202).end(); // 202 Accepted
    });

    req.on("error", () => {
      res.writeHead(400).end();
    });
  }
}
