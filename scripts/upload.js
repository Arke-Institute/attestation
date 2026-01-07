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

async function checkBalance(address) {
  const winston = await arweave.wallets.getBalance(address);
  const ar = arweave.ar.winstonToAr(winston);
  return { winston, ar };
}

async function uploadData(data, contentType, tags = []) {
  // Load wallet
  if (!fs.existsSync(walletPath)) {
    throw new Error('Wallet not found. Run: npm run generate-wallet');
  }
  const key = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
  const address = await arweave.wallets.jwkToAddress(key);

  // Check balance
  const balance = await checkBalance(address);
  console.log(`Wallet: ${address}`);
  console.log(`Balance: ${balance.ar} AR\n`);

  if (parseFloat(balance.ar) === 0) {
    throw new Error('Wallet has no AR tokens. Fund it first.');
  }

  // Create transaction
  const tx = await arweave.createTransaction({ data }, key);

  // Add content type
  tx.addTag('Content-Type', contentType);

  // Add custom tags
  for (const tag of tags) {
    tx.addTag(tag.name, tag.value);
  }

  // Get price estimate
  const price = await arweave.transactions.getPrice(Buffer.byteLength(data));
  console.log(`Estimated cost: ${arweave.ar.winstonToAr(price)} AR`);

  // Sign transaction
  await arweave.transactions.sign(tx, key);
  console.log(`Transaction ID: ${tx.id}`);

  // Upload with chunking
  console.log('Uploading...');
  const uploader = await arweave.transactions.getUploader(tx);

  while (!uploader.isComplete) {
    await uploader.uploadChunk();
    console.log(`${uploader.pctComplete}% complete`);
  }

  console.log('\nUpload complete!');
  console.log(`View at: https://arweave.net/${tx.id}`);

  return tx.id;
}

async function uploadFile(filePath, tags = []) {
  const data = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();

  // Simple content-type mapping
  const contentTypes = {
    '.json': 'application/json',
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.pdf': 'application/pdf',
    '.mp4': 'video/mp4',
  };

  const contentType = contentTypes[ext] || 'application/octet-stream';
  return uploadData(data, contentType, tags);
}

// CLI usage
const args = process.argv.slice(2);

if (args.length === 0) {
  // Demo: upload simple text
  console.log('No file specified. Running demo upload...\n');

  const demoData = JSON.stringify({
    message: 'Hello from Arweave!',
    timestamp: new Date().toISOString()
  }, null, 2);

  uploadData(demoData, 'application/json', [
    { name: 'App-Name', value: 'attestation' },
    { name: 'Type', value: 'test' }
  ]).catch(console.error);

} else {
  // Upload specified file
  const filePath = path.resolve(args[0]);

  if (!fs.existsSync(filePath)) {
    console.error('File not found:', filePath);
    process.exit(1);
  }

  uploadFile(filePath, [
    { name: 'App-Name', value: 'attestation' }
  ]).catch(console.error);
}
