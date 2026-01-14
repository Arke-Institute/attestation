/**
 * Bundle DataItems together
 *
 * Creates an ANS-104 bundle from multiple DataItems.
 * Vendored from arbundles.
 */

import { longTo32ByteArray } from "./utils";
import { Bundle } from "./Bundle";
import { DataItem, Signer } from "./DataItem";

/**
 * Sign a DataItem and return its ID
 */
async function signDataItem(item: DataItem, signer: Signer): Promise<Buffer> {
  return item.sign(signer);
}

/**
 * Bundle multiple DataItems into a single bundle
 *
 * @param dataItems - Array of DataItems to bundle (can be pre-signed or unsigned)
 * @param signer - Signer to use for any unsigned items
 * @returns A Bundle containing all DataItems
 */
export async function bundleAndSignData(dataItems: DataItem[], signer: Signer): Promise<Bundle> {
  const headers = new Uint8Array(64 * dataItems.length);

  const binaries = await Promise.all(
    dataItems.map(async (d, index) => {
      // Sign DataItem if not already signed
      const id = d.isSigned() ? d.rawId : await signDataItem(d, signer);

      // Create 64-byte header: [32 bytes: size][32 bytes: id]
      const header = new Uint8Array(64);
      header.set(longTo32ByteArray(d.getRaw().byteLength), 0);
      header.set(id, 32);

      // Add header to headers array
      headers.set(header, 64 * index);

      return d.getRaw();
    })
  ).then((buffers) => Buffer.concat(buffers));

  // Bundle format: [32 bytes: count][headers][data items]
  const buffer = Buffer.concat([
    Buffer.from(longTo32ByteArray(dataItems.length)),
    Buffer.from(headers),
    binaries,
  ]);

  return new Bundle(buffer);
}

/**
 * Parse an existing bundle
 */
export function unbundleData(txData: Buffer): Bundle {
  return new Bundle(txData);
}
