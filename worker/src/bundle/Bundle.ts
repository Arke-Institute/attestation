/**
 * ANS-104 Bundle
 *
 * Wraps multiple DataItems into a single L1 Arweave transaction.
 * Each DataItem maintains its own ID and is individually addressable.
 *
 * Vendored from arbundles.
 */

import base64url from "base64url";
import { byteArrayToLong } from "./utils";
import { DataItem } from "./DataItem";

const HEADER_START = 32;

export class Bundle {
  length: number;
  items: DataItem[];
  private binary: Buffer;

  constructor(binary: Buffer | Uint8Array) {
    this.binary = Buffer.from(binary);
    this.length = this.getDataItemCount();
    this.items = this.getItems();
  }

  /**
   * Get the raw bundle binary
   */
  getRaw(): Buffer {
    return this.binary;
  }

  /**
   * Get a DataItem by index or by txId
   */
  get(index: number | string): DataItem {
    if (typeof index === "number") {
      if (index >= this.length) {
        throw new RangeError("Index out of range");
      }
      return this.getByIndex(index);
    } else {
      return this.getById(index);
    }
  }

  /**
   * Get all DataItem sizes
   */
  getSizes(): number[] {
    const sizes: number[] = [];
    for (let i = HEADER_START; i < HEADER_START + 64 * this.length; i += 64) {
      sizes.push(byteArrayToLong(this.binary.subarray(i, i + 32)));
    }
    return sizes;
  }

  /**
   * Get all DataItem IDs
   */
  getIds(): string[] {
    const ids: string[] = [];
    for (let i = HEADER_START; i < HEADER_START + 64 * this.length; i += 64) {
      const bundleId = this.binary.subarray(i + 32, i + 64);
      if (bundleId.length === 0) {
        throw new Error("Invalid bundle, id specified in headers doesn't exist");
      }
      ids.push(base64url.encode(bundleId));
    }
    return ids;
  }

  /**
   * Get DataItem ID by index
   */
  getIdBy(index: number): string {
    if (index > this.length - 1) {
      throw new RangeError("Index of bundle out of range");
    }
    const start = 64 + 64 * index;
    return base64url.encode(this.binary.subarray(start, start + 32));
  }

  /**
   * Convert bundle to an Arweave transaction
   * @param attributes - Additional transaction attributes
   * @param arweave - Arweave client instance
   * @param jwk - JWK wallet for signing
   */
  async toTransaction(
    attributes: Record<string, unknown>,
    arweave: { createTransaction: (opts: unknown, jwk: unknown) => Promise<unknown> },
    jwk: unknown
  ): Promise<{ id: string; addTag: (name: string, value: string) => void }> {
    const tx = (await arweave.createTransaction({ data: this.binary, ...attributes }, jwk)) as {
      id: string;
      addTag: (name: string, value: string) => void;
    };
    tx.addTag("Bundle-Format", "binary");
    tx.addTag("Bundle-Version", "2.0.0");
    return tx;
  }

  /**
   * Verify all DataItems in the bundle
   */
  async verify(): Promise<boolean> {
    for (const item of this.items) {
      const valid = await DataItem.verify(item.getRaw());
      if (!valid) {
        return false;
      }
    }
    return true;
  }

  private getOffset(id: Buffer): { startOffset: number; size: number } {
    let offset = 0;
    for (let i = HEADER_START; i < HEADER_START + 64 * this.length; i += 64) {
      const _offset = byteArrayToLong(this.binary.subarray(i, i + 32));
      offset += _offset;
      const _id = this.binary.subarray(i + 32, i + 64);
      if (Buffer.compare(_id, id) === 0) {
        return { startOffset: offset, size: _offset };
      }
    }
    return { startOffset: -1, size: -1 };
  }

  private getByIndex(index: number): DataItem {
    let offset = 0;
    const bundleStart = this.getBundleStart();
    let counter = 0;
    let _offset = 0;
    let _id: Buffer = Buffer.alloc(0);

    for (let i = HEADER_START; i < HEADER_START + 64 * this.length; i += 64) {
      _offset = byteArrayToLong(this.binary.subarray(i, i + 32));
      if (counter++ === index) {
        _id = this.binary.subarray(i + 32, i + 64);
        break;
      }
      offset += _offset;
    }

    const dataItemStart = bundleStart + offset;
    const slice = this.binary.subarray(dataItemStart, dataItemStart + _offset);
    const item = new DataItem(slice);
    item.rawId = _id;
    return item;
  }

  private getById(id: string): DataItem {
    const _id = base64url.toBuffer(id);
    const offset = this.getOffset(_id);
    if (offset.startOffset === -1) {
      throw new Error("Transaction not found");
    }
    const bundleStart = this.getBundleStart();
    const dataItemStart = bundleStart + offset.startOffset;
    return new DataItem(this.binary.subarray(dataItemStart, dataItemStart + offset.size));
  }

  private getDataItemCount(): number {
    return byteArrayToLong(this.binary.subarray(0, 32));
  }

  private getBundleStart(): number {
    return 32 + 64 * this.length;
  }

  private getItems(): DataItem[] {
    const items: DataItem[] = new Array(this.length);
    let offset = 0;
    const bundleStart = this.getBundleStart();
    let counter = 0;

    for (let i = HEADER_START; i < HEADER_START + 64 * this.length; i += 64) {
      const _offset = byteArrayToLong(this.binary.subarray(i, i + 32));
      const _id = this.binary.subarray(i + 32, i + 64);
      if (_id.length === 0) {
        throw new Error("Invalid bundle, id specified in headers doesn't exist");
      }
      const dataItemStart = bundleStart + offset;
      const bytes = this.binary.subarray(dataItemStart, dataItemStart + _offset);
      offset += _offset;
      const item = new DataItem(bytes);
      item.rawId = _id;
      items[counter] = item;
      counter++;
    }

    return items;
  }
}

export default Bundle;
