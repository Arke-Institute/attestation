/**
 * ANS-104 DataItem
 *
 * Represents an individual data item that can be bundled.
 * Each DataItem has its own permanent TX ID derived from its signature.
 *
 * Vendored from arbundles.
 */

import { createHash } from "crypto";
import base64url from "base64url";
import { byteArrayToLong } from "./utils";
import { SIG_CONFIG, SignatureConfig } from "./constants";
import { deserializeTags, MAX_TAG_BYTES, Tag } from "./tags";
import { deepHash } from "./deepHash";

export const MIN_BINARY_SIZE = 80;

export interface Signer {
  signatureType: number;
  signatureLength: number;
  ownerLength: number;
  publicKey: Uint8Array;
  sign(message: Uint8Array): Promise<Uint8Array> | Uint8Array;
}

/**
 * Get signature data for a DataItem (used for signing)
 */
async function getSignatureData(item: DataItem): Promise<Uint8Array> {
  return deepHash([
    Buffer.from("dataitem"),
    Buffer.from("1"),
    Buffer.from(item.signatureType.toString()),
    item.rawOwner,
    item.rawTarget,
    item.rawAnchor,
    item.rawTags,
    item.rawData,
  ]);
}

export class DataItem {
  private binary: Buffer;
  private _id?: Buffer;

  constructor(binary: Buffer | Uint8Array) {
    this.binary = Buffer.from(binary);
  }

  static isDataItem(obj: unknown): obj is DataItem {
    return obj instanceof DataItem && obj.binary !== undefined;
  }

  get signatureType(): number {
    const signatureTypeVal = byteArrayToLong(this.binary.subarray(0, 2));
    if (SIG_CONFIG[signatureTypeVal] !== undefined) {
      return signatureTypeVal;
    }
    throw new Error("Unknown signature type: " + signatureTypeVal);
  }

  get id(): string {
    return base64url.encode(this.rawId);
  }

  set id(id: string) {
    this._id = base64url.toBuffer(id);
  }

  get rawId(): Buffer {
    return createHash("sha256").update(this.rawSignature).digest();
  }

  set rawId(id: Buffer) {
    this._id = id;
  }

  get rawSignature(): Buffer {
    return this.binary.subarray(2, 2 + this.signatureLength);
  }

  get signature(): string {
    return base64url.encode(this.rawSignature);
  }

  get signatureLength(): number {
    return SIG_CONFIG[this.signatureType].sigLength;
  }

  set rawOwner(pubkey: Buffer) {
    if (pubkey.byteLength !== this.ownerLength)
      throw new Error(
        `Expected raw owner (pubkey) to be ${this.ownerLength} bytes, got ${pubkey.byteLength} bytes.`
      );
    this.binary.set(pubkey, 2 + this.signatureLength);
  }

  get rawOwner(): Buffer {
    return this.binary.subarray(
      2 + this.signatureLength,
      2 + this.signatureLength + this.ownerLength
    );
  }

  get owner(): string {
    return base64url.encode(this.rawOwner);
  }

  get ownerLength(): number {
    return SIG_CONFIG[this.signatureType].pubLength;
  }

  get rawTarget(): Buffer {
    const targetStart = this.getTargetStart();
    const isPresent = this.binary[targetStart] === 1;
    return isPresent ? this.binary.subarray(targetStart + 1, targetStart + 33) : Buffer.alloc(0);
  }

  get target(): string {
    return base64url.encode(this.rawTarget);
  }

  get rawAnchor(): Buffer {
    const anchorStart = this.getAnchorStart();
    const isPresent = this.binary[anchorStart] === 1;
    return isPresent ? this.binary.subarray(anchorStart + 1, anchorStart + 33) : Buffer.alloc(0);
  }

  get anchor(): string {
    return base64url.encode(this.rawAnchor);
  }

  get rawTags(): Buffer {
    const tagsStart = this.getTagsStart();
    const tagsSize = byteArrayToLong(this.binary.subarray(tagsStart + 8, tagsStart + 16));
    return this.binary.subarray(tagsStart + 16, tagsStart + 16 + tagsSize);
  }

  get tags(): Tag[] {
    const tagsStart = this.getTagsStart();
    const tagsCount = byteArrayToLong(this.binary.subarray(tagsStart, tagsStart + 8));
    if (tagsCount === 0) {
      return [];
    }
    const tagsSize = byteArrayToLong(this.binary.subarray(tagsStart + 8, tagsStart + 16));
    return deserializeTags(Buffer.from(this.binary.subarray(tagsStart + 16, tagsStart + 16 + tagsSize)));
  }

  getStartOfData(): number {
    const tagsStart = this.getTagsStart();
    const numberOfTagBytesArray = this.binary.subarray(tagsStart + 8, tagsStart + 16);
    const numberOfTagBytes = byteArrayToLong(numberOfTagBytesArray);
    return tagsStart + 16 + numberOfTagBytes;
  }

  get rawData(): Buffer {
    const dataStart = this.getStartOfData();
    return this.binary.subarray(dataStart, this.binary.length);
  }

  get data(): string {
    return base64url.encode(this.rawData);
  }

  /**
   * Get the raw binary buffer
   * WARNING: Do not mutate this buffer directly
   */
  getRaw(): Buffer {
    return this.binary;
  }

  /**
   * Sign this DataItem with the given signer
   * After signing, the id property will be populated
   */
  async sign(signer: Signer): Promise<Buffer> {
    const signatureData = await getSignatureData(this);
    const signatureBytes = await signer.sign(signatureData);
    this.binary.set(signatureBytes, 2);
    this._id = createHash("sha256").update(Buffer.from(signatureBytes)).digest();
    return this._id;
  }

  /**
   * Check if this DataItem has been signed
   */
  isSigned(): boolean {
    return (this._id?.length ?? 0) > 0;
  }

  /**
   * Verify this DataItem's signature
   */
  static async verify(buffer: Buffer): Promise<boolean> {
    if (buffer.byteLength < MIN_BINARY_SIZE) {
      return false;
    }
    const item = new DataItem(buffer);
    const tagsStart = item.getTagsStart();
    const numberOfTags = byteArrayToLong(buffer.subarray(tagsStart, tagsStart + 8));
    const numberOfTagBytesArray = buffer.subarray(tagsStart + 8, tagsStart + 16);
    const numberOfTagBytes = byteArrayToLong(numberOfTagBytesArray);
    if (numberOfTagBytes > MAX_TAG_BYTES) return false;
    if (numberOfTags > 0) {
      try {
        const tags = deserializeTags(
          Buffer.from(buffer.subarray(tagsStart + 16, tagsStart + 16 + numberOfTagBytes))
        );
        if (tags.length !== numberOfTags) {
          return false;
        }
      } catch {
        return false;
      }
    }
    return true;
  }

  private getTagsStart(): number {
    const targetStart = this.getTargetStart();
    const targetPresent = this.binary[targetStart] === 1;
    let tagsStart = targetStart + (targetPresent ? 33 : 1);
    const anchorPresent = this.binary[tagsStart] === 1;
    tagsStart += anchorPresent ? 33 : 1;
    return tagsStart;
  }

  private getTargetStart(): number {
    return 2 + this.signatureLength + this.ownerLength;
  }

  private getAnchorStart(): number {
    let anchorStart = this.getTargetStart() + 1;
    const targetPresent = this.binary[this.getTargetStart()] === 1;
    anchorStart += targetPresent ? 32 : 0;
    return anchorStart;
  }
}

export default DataItem;
