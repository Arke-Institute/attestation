/**
 * Create DataItem binary
 *
 * Creates a single DataItem in binary format (Uint8Array)
 * ready to be signed and bundled.
 *
 * Vendored from arbundles.
 */

import base64url from "base64url";
import { longTo8ByteArray, shortTo2ByteArray } from "./utils";
import { DataItem, Signer } from "./DataItem";
import { serializeTags, Tag } from "./tags";

export interface CreateDataOptions {
  target?: string;
  anchor?: string;
  tags?: Tag[];
}

/**
 * Create a new DataItem
 *
 * @param data - The data to store (string or Uint8Array)
 * @param signer - The signer to use (determines signature type and owner)
 * @param opts - Optional target, anchor, and tags
 * @returns A new unsigned DataItem
 */
export function createData(
  data: string | Uint8Array,
  signer: Signer,
  opts?: CreateDataOptions
): DataItem {
  const _owner = signer.publicKey;
  const _target = opts?.target ? base64url.toBuffer(opts.target) : null;
  const target_length = 1 + (_target?.byteLength ?? 0);
  const _anchor = opts?.anchor ? Buffer.from(opts.anchor) : null;
  const anchor_length = 1 + (_anchor?.byteLength ?? 0);
  const _tags = (opts?.tags?.length ?? 0) > 0 ? serializeTags(opts?.tags) : null;
  const tags_length = 16 + (_tags ? _tags.byteLength : 0);
  const _data = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
  const data_length = _data.byteLength;

  // Calculate total length
  const length =
    2 + signer.signatureLength + signer.ownerLength + target_length + anchor_length + tags_length + data_length;

  // Create buffer
  const bytes = Buffer.alloc(length);

  // Signature type (2 bytes)
  bytes.set(shortTo2ByteArray(signer.signatureType), 0);

  // Signature placeholder (will be filled when signed)
  bytes.set(new Uint8Array(signer.signatureLength).fill(0), 2);

  // Owner (public key)
  if (_owner.byteLength !== signer.ownerLength)
    throw new Error(
      `Owner must be ${signer.ownerLength} bytes, but was incorrectly ${_owner.byteLength}`
    );
  bytes.set(_owner, 2 + signer.signatureLength);

  const position = 2 + signer.signatureLength + signer.ownerLength;

  // Target (presence byte + optional 32-byte target)
  bytes[position] = _target ? 1 : 0;
  if (_target) {
    if (_target.byteLength !== 32)
      throw new Error(`Target must be 32 bytes but was incorrectly ${_target.byteLength}`);
    bytes.set(_target, position + 1);
  }

  // Anchor (presence byte + optional 32-byte anchor)
  const anchor_start = position + target_length;
  let tags_start = anchor_start + 1;
  bytes[anchor_start] = _anchor ? 1 : 0;
  if (_anchor) {
    tags_start += _anchor.byteLength;
    if (_anchor.byteLength !== 32) throw new Error("Anchor must be 32 bytes");
    bytes.set(_anchor, anchor_start + 1);
  }

  // Tags (8-byte count + 8-byte length + serialized tags)
  bytes.set(longTo8ByteArray(opts?.tags?.length ?? 0), tags_start);
  const bytesCount = longTo8ByteArray(_tags?.byteLength ?? 0);
  bytes.set(bytesCount, tags_start + 8);
  if (_tags) {
    bytes.set(_tags, tags_start + 16);
  }

  // Data
  const data_start = tags_start + tags_length;
  bytes.set(_data, data_start);

  return new DataItem(bytes);
}
