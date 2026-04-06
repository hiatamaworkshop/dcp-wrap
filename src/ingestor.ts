/**
 * IngestorX<T> — ストリーム受信インターフェース
 *
 * 各プロトコル実装 (HTTP / UDS / UDP) はこのインターフェースを実装する。
 * Preprocessor 側はプロトコルを意識しない。
 *
 * 実装フェーズ:
 *   Phase A: HTTPIngestor  — 開発・デバッグ (POST /ingest)
 *   Phase B: UDSIngestor   — 同一VM本番 (Unix Domain Socket)
 *   Phase C: UDPIngestor   — 複数サーバー集約・欠落許容データのみ
 */

export interface IngestorX<T = unknown> {
  /**
   * ストリーム受付開始。ポートバインド / ソケット作成など。
   * 呼び出し後、onReceive で登録したハンドラが呼ばれ始める。
   */
  start(): Promise<void>;

  /**
   * グレースフルシャットダウン。
   * 進行中の受信処理を完了してからリソースを解放する。
   */
  stop(): Promise<void>;

  /**
   * 受信イベントハンドラを登録する。
   * start() 前に登録しておくこと。
   * 複数回呼ぶと最後に登録したハンドラが有効になる (上書き)。
   */
  onReceive(handler: (raw: T) => void): void;
}
