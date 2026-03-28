# PicoClaw DCP Hook 実装 — 引き継ぎ

## 前提
- dcp-wrap: npm パッケージ公開済み (github.com/hiatamaworkshop/dcp-wrap)
  - dcpEncode() — inline schema で1関数エンコード
  - SchemaGenerator — 未知JSON からスキーマ推定
  - 防御ガード: maxDepth=3, maxFields=20, minPresence=0.1
  - GitHub API ベンチマーク: 7fields=33%削減, 15fields=50%削減

- dcp-docs: 仕様サイト公開済み (dcp-docs.pages.dev)

- dcp-output-controller: GitHub公開済み、45テスト通過
  - コアロジック(decode/inject/intercept)はランタイム非依存

## OpenClaw 実験結果
- skill/prompt レベルの DCP 制約は効かない（内蔵 prompt が優先）
- hook レベルが必須だが OpenClaw は output hook 未実装 (#12914)
- OpenClaw Docker起動中(port 18789), Telegram bot接続済み
- API key: Anthropicクレジット$5投入済み、Haiku動作確認済み
- → PicoClaw after_tool で先行実証する方針に確定

## PicoClaw hook 設計 (notes/picoclaw-dcp-hook.md)
- after_tool (ToolInterceptor, modifiable) → 入力 DCP 化
- before_llm (LLMInterceptor, modifiable) → コントローラ注入
- after_llm (LLMInterceptor, modifiable) → Cap + Decode
- Out-of-process: JSON-RPC over stdio → Node.js/dcp-wrap 直結
- PicoClaw: Go製, 26K stars, MCP native, v0.2.4

## 次のステップ
1. PicoClaw ソースから JSON-RPC ペイロード形式を確認
2. after_tool hook で dcp-wrap を呼ぶ外部プロセスを実装
3. MCP ツール結果の DCP 変換を実証
4. before/after token 数の比較データを取得

## 関連リポジトリ
- github.com/hiatamaworkshop/dcp-wrap
- github.com/hiatamaworkshop/dcp-docs
- github.com/sipeed/picoclaw
- github.com/openclaw/openclaw (output hook #12914 未実装)
