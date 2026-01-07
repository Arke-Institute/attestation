import Arweave from 'arweave';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const walletPath = path.join(__dirname, '..', 'wallet.json');

async function generateWallet() {
  // Check if wallet already exists
  if (fs.existsSync(walletPath)) {
    console.log('Wallet already exists at wallet.json');
    console.log('Delete it first if you want to generate a new one.');
    process.exit(1);
  }

  const arweave = Arweave.init({
    host: 'arweave.net',
    port: 443,
    protocol: 'https'
  });

  console.log('Generating new Arweave wallet...\n');

  // Generate the wallet key
  const key = await arweave.wallets.generate();

  // Get the wallet address from the key
  const address = await arweave.wallets.jwkToAddress(key);

  // Save wallet to file
  fs.writeFileSync(walletPath, JSON.stringify(key, null, 2));

  console.log('Wallet generated successfully!\n');
  console.log('Address:', address);
  console.log('Saved to:', walletPath);
  console.log('\n--- IMPORTANT ---');
  console.log('1. Keep wallet.json secure - anyone with this file can access your funds');
  console.log('2. Back up wallet.json to multiple secure locations');
  console.log('3. Send AR tokens to the address above to fund uploads');
  console.log('4. Check balance at: https://viewblock.io/arweave/address/' + address);
}

generateWallet().catch(console.error);
