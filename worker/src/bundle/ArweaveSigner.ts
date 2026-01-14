/**
 * Arweave Signer for ANS-104 DataItems
 *
 * Uses Web Crypto API for RSA-PSS signing (compatible with Cloudflare Workers).
 * Vendored/adapted from arbundles.
 */

import base64url from "base64url";
import { SIG_CONFIG, SignatureConfig } from "./constants";
import type { Signer } from "./DataItem";

export interface JWKInterface {
  kty: string;
  n: string;
  e: string;
  d?: string;
  p?: string;
  q?: string;
  dp?: string;
  dq?: string;
  qi?: string;
}

export class ArweaveSigner implements Signer {
  private pk: string;
  private cryptoKey: CryptoKey | null = null;
  readonly signatureType = SignatureConfig.ARWEAVE;
  readonly ownerLength = SIG_CONFIG[SignatureConfig.ARWEAVE].pubLength;
  readonly signatureLength = SIG_CONFIG[SignatureConfig.ARWEAVE].sigLength;
  readonly jwk: JWKInterface;

  constructor(jwk: JWKInterface) {
    this.pk = jwk.n;
    this.jwk = jwk;
  }

  get publicKey(): Uint8Array {
    if (!this.pk) throw new Error("ArweaveSigner - pk is undefined");
    return base64url.toBuffer(this.pk);
  }

  /**
   * Import the JWK as a CryptoKey (lazily, once)
   */
  private async getKey(): Promise<CryptoKey> {
    if (this.cryptoKey) return this.cryptoKey;

    this.cryptoKey = await crypto.subtle.importKey(
      "jwk",
      this.jwk,
      {
        name: "RSA-PSS",
        hash: "SHA-256",
      },
      false,
      ["sign"]
    );

    return this.cryptoKey;
  }

  /**
   * Sign a message using RSA-PSS with SHA-256
   * Note: This is async because Web Crypto API is async
   */
  async sign(message: Uint8Array): Promise<Uint8Array> {
    const key = await this.getKey();

    const signature = await crypto.subtle.sign(
      {
        name: "RSA-PSS",
        saltLength: 32, // Arweave uses salt length of 32
      },
      key,
      message
    );

    return new Uint8Array(signature);
  }
}

export default ArweaveSigner;
