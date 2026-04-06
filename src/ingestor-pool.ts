/**
 * IngestorPool<T> — ラウンドロビン負荷分散
 *
 * 複数の IngestorX インスタンスを束ねて、
 * onReceive ハンドラを全インスタンスに一括登録しつつ
 * next() でラウンドロビン選択を提供する。
 *
 * 典型的な使い方:
 *   const pool = new IngestorPool(() => new HTTPIngestor({ port: 0 }), 3);
 *   pool.onReceive((raw) => preprocessor.process(raw));
 *   await pool.start();
 *
 * Phase A では port=0 (OS任意割当) を3つ起動し、
 * Phase B では UDSIngestor を同数起動する。
 */

import type { IngestorX } from "./ingestor.js";

export interface IngestorPoolOptions {
  /** インスタンス数。デフォルト: 3 */
  size?: number;
}

export class IngestorPool<T = unknown> {
  private readonly instances: IngestorX<T>[];
  private readonly size: number;
  private index = 0;

  constructor(
    factory: () => IngestorX<T>,
    opts: IngestorPoolOptions = {},
  ) {
    this.size = opts.size ?? 3;
    this.instances = Array.from({ length: this.size }, factory);
  }

  /** 全インスタンスを起動する。 */
  async start(): Promise<void> {
    await Promise.all(this.instances.map((i) => i.start()));
  }

  /** 全インスタンスをグレースフルシャットダウンする。 */
  async stop(): Promise<void> {
    await Promise.all(this.instances.map((i) => i.stop()));
  }

  /**
   * 受信ハンドラを全インスタンスに登録する。
   * start() の前に呼ぶこと。
   */
  onReceive(handler: (raw: T) => void): void {
    for (const inst of this.instances) {
      inst.onReceive(handler);
    }
  }

  /**
   * ラウンドロビンで次の IngestorX を返す。
   * 外部から push する場合 (テスト・デバッグ) に使用。
   */
  next(): IngestorX<T> {
    return this.instances[this.index++ % this.size]!;
  }

  /** 全インスタンスの配列を返す (読み取り専用)。 */
  get all(): readonly IngestorX<T>[] {
    return this.instances;
  }
}
