#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PRIVATE_KEY_PATH = path.join(__dirname, '.dev-private-key.json');

function base64url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function handleKeygen() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });

  const privJwk = privateKey.export({ format: 'jwk' });
  const pubJwk = publicKey.export({ format: 'jwk' });

  fs.writeFileSync(PRIVATE_KEY_PATH, JSON.stringify(privJwk, null, 2), 'utf-8');
  console.log('✅ Generated new ECDSA P-256 keypair.');
  console.log(`📁 Private key saved to: ${PRIVATE_KEY_PATH}`);
  console.log('\n🔑 Public Key JWK (replace in src/config/licensePublicKey.ts):');
  console.log(JSON.stringify(pubJwk, null, 2));
}

function handleSign(args) {
  if (!fs.existsSync(PRIVATE_KEY_PATH)) {
    console.error(`❌ Private key not found at ${PRIVATE_KEY_PATH}. Run "node tools/dev-license.mjs keygen" first.`);
    process.exit(1);
  }

  // Parse arguments
  let deviceId = '';
  let days = 365;
  let mode = 'offline';
  let plan = 'سوبر ماركت - باقة احترافية كاملة';
  let orgId = 'org-elkhair-egypt';
  let branchId = 'main-branch';
  let graceDays = 7;
  let maxOfflineDays = 30;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--deviceId' && args[i + 1]) {
      deviceId = args[++i];
    } else if (arg === '--days' && args[i + 1]) {
      days = parseInt(args[++i], 10);
    } else if (arg === '--mode' && args[i + 1]) {
      mode = args[++i];
    } else if (arg === '--plan' && args[i + 1]) {
      plan = args[++i];
    } else if (arg === '--orgId' && args[i + 1]) {
      orgId = args[++i];
    } else if (arg === '--branchId' && args[i + 1]) {
      branchId = args[++i];
    } else if (arg === '--graceDays' && args[i + 1]) {
      graceDays = parseInt(args[++i], 10);
    } else if (arg === '--maxOfflineDays' && args[i + 1]) {
      maxOfflineDays = parseInt(args[++i], 10);
    } else if (!arg.startsWith('--') && !deviceId) {
      deviceId = arg;
    } else if (!arg.startsWith('--') && deviceId && !isNaN(parseInt(arg, 10))) {
      days = parseInt(arg, 10);
    }
  }

  if (!deviceId) {
    console.error('❌ Missing deviceId.');
    console.error('Usage: node tools/dev-license.mjs sign <deviceId> [days]');
    console.error('   or: node tools/dev-license.mjs sign --deviceId <deviceId> --days 365 --mode offline');
    process.exit(1);
  }

  const privJwk = JSON.parse(fs.readFileSync(PRIVATE_KEY_PATH, 'utf-8'));
  const privateKey = crypto.createPrivateKey({ key: privJwk, format: 'jwk' });

  const now = new Date();
  const validUntil = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const payload = {
    v: 1,
    orgId,
    branchId,
    deviceId,
    mode,
    plan,
    issuedAt: now.toISOString(),
    validUntil: validUntil.toISOString(),
    graceDays,
    maxOfflineDays,
  };

  const payloadJson = JSON.stringify(payload);
  const payloadB64 = base64url(Buffer.from(payloadJson, 'utf-8'));

  // Sign using ECDSA P-256 + SHA-256 with IEEE-P1363 (64-byte raw signature)
  const signature = crypto.sign('SHA256', Buffer.from(payloadB64, 'utf-8'), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });

  const signatureB64 = base64url(signature);
  const token = `${payloadB64}.${signatureB64}`;

  console.log('\n📄 License Payload:');
  console.log(JSON.stringify(payload, null, 2));
  console.log('\n🎟️ Generated License Token:');
  console.log(token);
  console.log('\n✅ Token generated successfully.');
  return token;
}

const command = process.argv[2];
const remainingArgs = process.argv.slice(3);

if (command === 'keygen') {
  handleKeygen();
} else if (command === 'sign') {
  handleSign(remainingArgs);
} else {
  console.log('Dev License Tool:');
  console.log('  node tools/dev-license.mjs keygen');
  console.log('  node tools/dev-license.mjs sign --deviceId <id> [--days 365] [--mode offline]');
}
