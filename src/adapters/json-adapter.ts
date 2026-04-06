/**
 * JSONAdapter — SourceAdapter<Record<string, unknown>>
 *
 * 既存 Preprocessor の後方互換ラッパー。
 * JSON パース後の plain object を受け取り、schema.fields 順に positional array を生成する。
 *
 * schemaId の解決は record[schemaField] から行う (デフォルト: "$schema")。
 * Bukkit Plugin など外部ソースが JSON POST する場合はこれをそのまま使う。
 */

import type { SourceAdapter } from "../adapter.js";
import type { DcpSchema } from "../schema.js";

export class JSONAdapter implements SourceAdapter<Record<string, unknown>> {
  constructor(private readonly schemaField = "$schema") {}

  schemaId(raw: Record<string, unknown>): string | null {
    const id = raw[this.schemaField];
    return typeof id === "string" && id.trim() !== "" ? id : null;
  }

  /**
   * schema.fields 順に positional array を構築する。
   * フィールドが存在しない場合は null を詰める。
   */
  decode(raw: Record<string, unknown>, schema: DcpSchema): unknown[] | null {
    return schema.fields.map((f) => raw[f] ?? null);
  }
}
