/**
 * Arweave Deep Hash Algorithm
 *
 * Used to create signature data for DataItems.
 * Vendored from arbundles.
 */

import { createHash } from "crypto";

type DeepHashChunk = Uint8Array | DeepHashChunk[];

function stringToBuffer(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function concatBuffers(buffers: Uint8Array[]): Uint8Array {
  const totalLength = buffers.reduce((sum, buf) => sum + buf.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const buf of buffers) {
    result.set(buf, offset);
    offset += buf.byteLength;
  }
  return result;
}

async function hash(data: Uint8Array, algorithm: string = "SHA-256"): Promise<Uint8Array> {
  const alg = algorithm === "SHA-384" ? "sha384" : "sha256";
  return createHash(alg).update(data).digest();
}

export async function deepHash(data: DeepHashChunk): Promise<Uint8Array> {
  if (Array.isArray(data)) {
    const tag = concatBuffers([stringToBuffer("list"), stringToBuffer(data.length.toString())]);
    return await deepHashChunks(data, await hash(tag, "SHA-384"));
  }

  const _data = data as Uint8Array;
  const tag = concatBuffers([stringToBuffer("blob"), stringToBuffer(_data.byteLength.toString())]);
  const taggedHash = concatBuffers([await hash(tag, "SHA-384"), await hash(_data, "SHA-384")]);
  return await hash(taggedHash, "SHA-384");
}

async function deepHashChunks(chunks: DeepHashChunk[], acc: Uint8Array): Promise<Uint8Array> {
  if (chunks.length < 1) {
    return acc;
  }
  const hashPair = concatBuffers([acc, await deepHash(chunks[0])]);
  const newAcc = await hash(hashPair, "SHA-384");
  return await deepHashChunks(chunks.slice(1), newAcc);
}

export default deepHash;
