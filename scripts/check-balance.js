import Arweave from 'arweave';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const walletPath = path.join(__dirname, '..', 'wallet.json');

const arweave = Arweave.init({
  host: 'arweave.net',
  port: 443,
  protocol: 'https'
});

async function checkBalance() {
  if (!fs.existsSync(walletPath)) {
    console.error('Wallet not found. Run: npm run generate-wallet');
    process.exit(1);
  }

  const key = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
  const address = await arweave.wallets.jwkToAddress(key);
  const winston = await arweave.wallets.getBalance(address);
  const ar = arweave.ar.winstonToAr(winston);

  console.log('Address:', address);
  console.log('Balance:', ar, 'AR');
  console.log('Balance:', winston, 'winston');

  if (parseFloat(ar) === 0) {
    console.log('\nWallet is empty. Send AR to the address above.');
  }
}

checkBalance().catch(console.error);
