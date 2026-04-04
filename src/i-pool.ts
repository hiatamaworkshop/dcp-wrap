/**
 * IPool — fixed-capacity FIFO ring buffer for $I packets.
 *
 * Bots write here after L-LLM inference.
 * Brain AI reads at its own pace.
 *
 * When full, the oldest entry is overwritten (ring buffer semantics).
 * $I production never blocks — the pipeline and Bot are unaffected by
 * how fast Brain AI consumes.
 */

import type { IPacket } from "./types.js";

export interface IPoolOptions {
  /** Maximum number of $I packets to retain. Default: 256. */
  capacity?: number;
}

export class IPool {
  private readonly buf: (IPacket | undefined)[];
  private readonly capacity: number;
  private head = 0;   // next write position
  private tail = 0;   // next read position
  private size = 0;

  constructor(options: IPoolOptions = {}) {
    this.capacity = options.capacity ?? 256;
    this.buf = new Array(this.capacity);
  }

  /** Push a $I packet. If full, oldest entry is dropped. */
  push(packet: IPacket): void {
    this.buf[this.head] = packet;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) {
      this.size++;
    } else {
      // Full — advance tail to discard oldest
      this.tail = (this.tail + 1) % this.capacity;
    }
  }

  /** Pop the oldest $I packet, or undefined if empty. */
  shift(): IPacket | undefined {
    if (this.size === 0) return undefined;
    const packet = this.buf[this.tail];
    this.buf[this.tail] = undefined;
    this.tail = (this.tail + 1) % this.capacity;
    this.size--;
    return packet;
  }

  /** Peek at the oldest entry without removing it. */
  peek(): IPacket | undefined {
    if (this.size === 0) return undefined;
    return this.buf[this.tail];
  }

  /** Drain all packets in FIFO order. */
  drain(): IPacket[] {
    const out: IPacket[] = [];
    let p: IPacket | undefined;
    while ((p = this.shift()) !== undefined) out.push(p);
    return out;
  }

  get length(): number {
    return this.size;
  }

  get isFull(): boolean {
    return this.size === this.capacity;
  }

  get isEmpty(): boolean {
    return this.size === 0;
  }
}