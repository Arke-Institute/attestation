/**
 * ANS-104 Bundle Module
 *
 * Vendored implementation of Arweave bundling for cost-efficient uploads.
 * Based on arbundles but stripped to essentials for Arweave-only use.
 *
 * Usage:
 *   import { createData, bundleAndSignData, ArweaveSigner } from './bundle';
 *
 *   const signer = new ArweaveSigner(jwk);
 *   const item = createData(data, signer, { tags });
 *   await item.sign(signer);
 *   // item.id is now available
 *
 *   const bundle = await bundleAndSignData([item1, item2, ...], signer);
 *   const tx = await bundle.toTransaction({}, arweave, jwk);
 */

export { DataItem } from "./DataItem";
export type { Signer } from "./DataItem";
export { Bundle } from "./Bundle";
export { createData } from "./createData";
export type { CreateDataOptions } from "./createData";
export { bundleAndSignData, unbundleData } from "./bundleData";
export { ArweaveSigner } from "./ArweaveSigner";
export type { JWKInterface } from "./ArweaveSigner";
export { deepHash } from "./deepHash";
export type { Tag } from "./tags";
export { serializeTags, deserializeTags } from "./tags";
