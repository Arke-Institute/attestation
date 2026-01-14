/**
 * Byte array utilities for ANS-104 binary format
 *
 * Vendored from arbundles
 */

export function longToNByteArray(N: number, long: number): Uint8Array {
  const byteArray = new Uint8Array(N);
  if (long < 0) throw new Error("Array is unsigned, cannot represent -ve numbers");
  if (long > 2 ** (N * 8) - 1)
    throw new Error(`Number ${long} is too large for an array of ${N} bytes`);
  for (let index = 0; index < byteArray.length; index++) {
    const byte = long & 0xff;
    byteArray[index] = byte;
    long = (long - byte) / 256;
  }
  return byteArray;
}

export function longTo8ByteArray(long: number): Uint8Array {
  return longToNByteArray(8, long);
}

export function shortTo2ByteArray(short: number): Uint8Array {
  return longToNByteArray(2, short);
}

export function longTo32ByteArray(long: number): Uint8Array {
  return longToNByteArray(32, long);
}

export function byteArrayToLong(byteArray: Uint8Array): number {
  let value = 0;
  for (let i = byteArray.length - 1; i >= 0; i--) {
    value = value * 256 + byteArray[i];
  }
  return value;
}
