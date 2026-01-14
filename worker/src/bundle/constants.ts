/**
 * ANS-104 Signature Configuration Constants
 *
 * Vendored from arbundles - only includes Arweave signature type
 */

export enum SignatureConfig {
  ARWEAVE = 1,
}

export const SIG_CONFIG: Record<number, { sigLength: number; pubLength: number; sigName: string }> = {
  [SignatureConfig.ARWEAVE]: {
    sigLength: 512,
    pubLength: 512,
    sigName: "arweave",
  },
};
