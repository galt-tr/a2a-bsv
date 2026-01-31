#!/usr/bin/env node
/**
 * bsv-agent-cli.mjs — CLI tool for BSV agent wallet operations.
 *
 * All output is JSON with a { success, data/error } wrapper for agent parsing.
 *
 * Environment variables:
 *   BSV_WALLET_DIR  — wallet storage directory (default: ~/.clawdbot/bsv-wallet)
 *   BSV_NETWORK     — 'mainnet' or 'testnet' (default: mainnet)
 *
 * Commands:
 *   setup                                    — Create wallet, show identity key
 *   identity                                 — Show identity public key
 *   address                                  — Show P2PKH receive address
 *   balance                                  — Show balance in satoshis
 *   pay <pubkey> <satoshis> [description]    — Create payment → JSON PaymentResult
 *   verify <beef_base64>                     — Verify incoming BEEF → JSON VerifyResult
 *   accept <beef> <prefix> <suffix> <senderKey> [description] — Accept payment
 *   import <txid> [vout]                     — Import external UTXO with merkle proof
 *   refund <address>                         — Sweep all on-chain UTXOs to address
 */

// Suppress dotenv noise — it logs to console.log by default.
// Capture the original and restore after import.
const _origLog = console.log;
console.log = () => {};

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Resolve the core library. setup.sh creates a symlink at the repo's
// node_modules/@a2a-bsv/core pointing to packages/core so normal resolution
// works. If that fails, try the absolute path.
// ---------------------------------------------------------------------------
let core;
try {
  core = await import('@a2a-bsv/core');
} catch {
  // Fallback: resolve relative to the a2a-bsv repo root
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const coreDist = path.join(repoRoot, 'packages', 'core', 'dist', 'index.js');
  core = await import(coreDist);
}
const { BSVAgentWallet } = core;

// Restore console.log now that imports are done
console.log = _origLog;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const WALLET_DIR = process.env.BSV_WALLET_DIR
  || path.join(os.homedir(), '.clawdbot', 'bsv-wallet');
const NETWORK = process.env.BSV_NETWORK || 'mainnet';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function ok(data) {
  console.log(JSON.stringify({ success: true, data }));
  process.exit(0);
}
function fail(error) {
  console.log(JSON.stringify({ success: false, error: String(error) }));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
async function cmdSetup() {
  if (fs.existsSync(path.join(WALLET_DIR, 'wallet-identity.json'))) {
    // Wallet already exists — just load and return identity
    const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
    const identityKey = await wallet.getIdentityKey();
    await wallet.destroy();
    return ok({
      identityKey,
      walletDir: WALLET_DIR,
      network: NETWORK,
      alreadyExisted: true,
    });
  }
  fs.mkdirSync(WALLET_DIR, { recursive: true });
  const wallet = await BSVAgentWallet.create({ network: NETWORK, storageDir: WALLET_DIR });
  const identityKey = await wallet.getIdentityKey();
  await wallet.destroy();
  ok({
    identityKey,
    walletDir: WALLET_DIR,
    network: NETWORK,
    alreadyExisted: false,
  });
}

async function cmdIdentity() {
  const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
  const identityKey = await wallet.getIdentityKey();
  await wallet.destroy();
  ok({ identityKey });
}

async function cmdAddress() {
  // Derive a P2PKH address from the root key for receiving funds (e.g. from faucet).
  const identityPath = path.join(WALLET_DIR, 'wallet-identity.json');
  if (!fs.existsSync(identityPath)) {
    return fail('Wallet not initialized. Run: setup');
  }
  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));

  // Import SDK — resolve from the same place the core library lives
  let sdk;
  try {
    sdk = await import('@bsv/sdk');
  } catch {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    // SDK is in packages/core/node_modules
    const sdkPath = path.join(repoRoot, 'packages', 'core', 'node_modules', '@bsv', 'sdk', 'dist', 'esm', 'mod.js');
    sdk = await import(sdkPath);
  }

  const { PrivateKey, Hash, Utils } = sdk;
  const privKey = PrivateKey.fromHex(identity.rootKeyHex);
  const pubKey = privKey.toPublicKey();

  // Derive P2PKH address: HASH160(compressed pubkey) → base58check
  // BSV mainnet prefix: 0x00 (starts with '1')
  // BSV testnet prefix: 0x6f (starts with 'm' or 'n')
  const pubKeyBytes = pubKey.encode(true); // compressed
  const hash160 = Hash.hash160(pubKeyBytes);

  const prefix = NETWORK === 'mainnet' ? 0x00 : 0x6f;
  const payload = new Uint8Array([prefix, ...hash160]);
  const checksum = Hash.hash256(Array.from(payload)).slice(0, 4);
  const addressBytes = new Uint8Array([...payload, ...checksum]);
  const address = Utils.toBase58(Array.from(addressBytes));

  ok({
    address,
    network: NETWORK,
    identityKey: identity.identityKey,
    note: NETWORK === 'testnet'
      ? `Fund this address at https://witnessonchain.com/faucet/tbsv — View on explorer: https://test.whatsonchain.com/address/${address}`
      : `This is a mainnet address — View on explorer: https://whatsonchain.com/address/${address}`,
  });
}

async function cmdBalance() {
  const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
  const total = await wallet.getBalance();
  await wallet.destroy();
  // The wallet.balance() returns a single number (spendable sats).
  // Wrap it for clarity.
  ok({ confirmed: total, unconfirmed: 0, total });
}

async function cmdPay(pubkey, satoshis, description) {
  if (!pubkey || !satoshis) {
    return fail('Usage: pay <pubkey> <satoshis> [description]');
  }
  const sats = parseInt(satoshis, 10);
  if (isNaN(sats) || sats <= 0) {
    return fail('satoshis must be a positive integer');
  }
  const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
  const payment = await wallet.createPayment({
    to: pubkey,
    satoshis: sats,
    description: description || undefined,
  });
  await wallet.destroy();
  ok(payment);
}

async function cmdVerify(beefBase64) {
  if (!beefBase64) {
    return fail('Usage: verify <beef_base64>');
  }
  const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
  const result = wallet.verifyPayment({ beef: beefBase64 });
  await wallet.destroy();
  ok(result);
}

async function cmdAccept(beef, derivationPrefix, derivationSuffix, senderIdentityKey, description) {
  if (!beef || !derivationPrefix || !derivationSuffix || !senderIdentityKey) {
    return fail('Usage: accept <beef> <derivationPrefix> <derivationSuffix> <senderIdentityKey> [description]');
  }
  const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
  const receipt = await wallet.acceptPayment({
    beef,
    derivationPrefix,
    derivationSuffix,
    senderIdentityKey,
    description: description || undefined,
  });
  await wallet.destroy();
  ok(receipt);
}

async function cmdImport(txidArg, voutStr) {
  if (!txidArg) {
    return fail('Usage: import <txid> [vout] — Import a confirmed external UTXO with merkle proof');
  }
  const vout = parseInt(voutStr || '0', 10);
  const txid = txidArg.toLowerCase();

  // Validate txid format
  if (!/^[0-9a-f]{64}$/.test(txid)) {
    return fail('Invalid txid — must be 64 hex characters');
  }

  // Import SDK
  let sdk;
  try {
    sdk = await import('@bsv/sdk');
  } catch {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const sdkPath = path.join(repoRoot, 'packages', 'core', 'node_modules', '@bsv', 'sdk', 'dist', 'esm', 'mod.js');
    sdk = await import(sdkPath);
  }
  const { Transaction, MerklePath, Beef } = sdk;

  const wocNet = NETWORK === 'mainnet' ? 'main' : 'test';
  const wocBase = `https://api.whatsonchain.com/v1/bsv/${wocNet}`;

  // 1. Check if the transaction is confirmed
  const txInfoResp = await fetch(`${wocBase}/tx/${txid}`);
  if (!txInfoResp.ok) {
    return fail(`Failed to fetch tx info: ${txInfoResp.status} ${await txInfoResp.text()}`);
  }
  const txInfo = await txInfoResp.json();

  if (!txInfo.confirmations || txInfo.confirmations < 1) {
    return fail(`Transaction ${txid} is unconfirmed (${txInfo.confirmations || 0} confirmations). Wait for at least 1 confirmation before importing.`);
  }
  const blockHeight = txInfo.blockheight;

  // 2. Fetch the raw tx hex
  const rawTxResp = await fetch(`${wocBase}/tx/${txid}/hex`);
  if (!rawTxResp.ok) {
    return fail(`Failed to fetch raw tx: ${rawTxResp.status} ${await rawTxResp.text()}`);
  }
  const rawTxHex = await rawTxResp.text();

  // 3. Parse the transaction and validate the output
  const sourceTx = Transaction.fromHex(rawTxHex);
  const output = sourceTx.outputs[vout];
  if (!output) {
    return fail(`Output index ${vout} not found in transaction (has ${sourceTx.outputs.length} outputs)`);
  }

  // 4. Fetch the TSC merkle proof
  //    WhatsonChain's /proof/tsc endpoint returns the TSC standard format:
  //    [{ index: number, txOrId: string, target: blockHash, nodes: string[] }]
  //    where index is the tx's position in the block and nodes are the sibling
  //    hashes needed to compute up to the merkle root (bottom-up, "*" = duplicate).
  const proofResp = await fetch(`${wocBase}/tx/${txid}/proof/tsc`);
  if (!proofResp.ok) {
    return fail(`Failed to fetch merkle proof: ${proofResp.status} ${await proofResp.text()}`);
  }
  const proofData = await proofResp.json();

  if (!Array.isArray(proofData) || proofData.length === 0) {
    return fail('No merkle proof available for this transaction');
  }
  const proof = proofData[0];
  const txIndex = proof.index;
  const nodes = proof.nodes; // array of sibling hashes (bottom-up), "*" means duplicate

  // 5. Convert TSC proof to SDK MerklePath
  //
  // MerklePath.path is an array of levels. Level 0 is the leaves (bottom).
  // Each level is an array of {offset, hash, txid?, duplicate?} objects.
  // At level 0: our txid (with txid:true) + its sibling.
  // At level 1+: sibling hashes needed to compute up to the root.

  const treeHeight = nodes.length;
  const mpPath = [];

  // Level 0: the txid leaf and its sibling
  const level0 = [];
  level0.push({ offset: txIndex, hash: txid, txid: true });
  if (nodes[0] === '*') {
    // Duplicate: sibling is same as our node
    const siblingOffset0 = txIndex ^ 1;
    level0.push({ offset: siblingOffset0, duplicate: true });
  } else {
    const siblingOffset0 = txIndex ^ 1;
    level0.push({ offset: siblingOffset0, hash: nodes[0] });
  }
  level0.sort((a, b) => a.offset - b.offset);
  mpPath.push(level0);

  // Higher levels: each node gives us the sibling at that level
  for (let i = 1; i < treeHeight; i++) {
    const nodeOffset = txIndex >> i;
    const siblingOffset = nodeOffset ^ 1;
    if (nodes[i] === '*') {
      mpPath.push([{ offset: siblingOffset, duplicate: true }]);
    } else {
      mpPath.push([{ offset: siblingOffset, hash: nodes[i] }]);
    }
  }

  // Construct the MerklePath
  const merklePath = new MerklePath(blockHeight, mpPath);

  // 6. Build AtomicBEEF using the SDK's Beef class
  sourceTx.merklePath = merklePath;

  const beef = new Beef();
  beef.mergeTransaction(sourceTx);

  // Serialize as AtomicBEEF (prefix with ATOMIC_BEEF marker + txid)
  const atomicBeefBytes = beef.toBinaryAtomic(txid);

  // 7. Load wallet and import via storage.internalizeAction
  //    We bypass the signer's internalizeAction (which enforces BRC-29 key derivation)
  //    and call storage directly — external UTXOs (faucet, exchange) won't match a
  //    BRC-29 derived key, but the output is still ours and the merkle proof is valid.
  const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
  const identityKey = await wallet.getIdentityKey();

  try {
    await wallet._setup.wallet.storage.internalizeAction({
      tx: atomicBeefBytes,
      outputs: [{
        outputIndex: vout,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix: 'imported',
          derivationSuffix: txid.slice(0, 16),
          senderIdentityKey: identityKey,
        },
      }],
      description: 'External funding import',
    });

    // Check the new balance
    const balance = await wallet.getBalance();
    await wallet.destroy();

    const explorerBase = NETWORK === 'mainnet'
      ? 'https://whatsonchain.com'
      : 'https://test.whatsonchain.com';

    ok({
      txid,
      vout,
      satoshis: output.satoshis,
      blockHeight,
      confirmations: txInfo.confirmations,
      imported: true,
      balance,
      explorer: `${explorerBase}/tx/${txid}`,
    });
  } catch (err) {
    await wallet.destroy();
    fail(`Failed to import UTXO: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function cmdRefund(targetAddress) {
  if (!targetAddress) {
    return fail('Usage: refund <address> — Sweep all on-chain UTXOs to the given address');
  }

  // Load wallet identity to get the root key
  const identityPath = path.join(WALLET_DIR, 'wallet-identity.json');
  if (!fs.existsSync(identityPath)) {
    return fail('Wallet not initialized. Run: setup');
  }
  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));

  // Import SDK
  let sdk;
  try {
    sdk = await import('@bsv/sdk');
  } catch {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const sdkPath = path.join(repoRoot, 'packages', 'core', 'node_modules', '@bsv', 'sdk', 'dist', 'esm', 'mod.js');
    sdk = await import(sdkPath);
  }

  const { PrivateKey, PublicKey, Hash, Utils, Transaction, P2PKH } = sdk;
  const privKey = PrivateKey.fromHex(identity.rootKeyHex);
  const pubKey = privKey.toPublicKey();

  // Derive source address (same as cmdAddress)
  const pubKeyBytes = pubKey.encode(true);
  const hash160 = Hash.hash160(pubKeyBytes);
  const prefix = NETWORK === 'mainnet' ? 0x00 : 0x6f;
  const payload = new Uint8Array([prefix, ...hash160]);
  const checksum = Hash.hash256(Array.from(payload)).slice(0, 4);
  const addressBytes = new Uint8Array([...payload, ...checksum]);
  const sourceAddress = Utils.toBase58(Array.from(addressBytes));

  const wocNet = NETWORK === 'mainnet' ? 'main' : 'test';
  const wocBase = `https://api.whatsonchain.com/v1/bsv/${wocNet}`;

  // 1. Fetch UTXOs
  const utxoResp = await fetch(`${wocBase}/address/${sourceAddress}/unspent`);
  if (!utxoResp.ok) {
    return fail(`Failed to fetch UTXOs: ${utxoResp.status} ${await utxoResp.text()}`);
  }
  const utxos = await utxoResp.json();
  if (!utxos || utxos.length === 0) {
    return fail(`No UTXOs found for ${sourceAddress} on ${NETWORK}`);
  }

  // 2. Fetch raw source transactions for each UTXO
  const sourceTxCache = {};
  for (const utxo of utxos) {
    if (!sourceTxCache[utxo.tx_hash]) {
      const txResp = await fetch(`${wocBase}/tx/${utxo.tx_hash}/hex`);
      if (!txResp.ok) {
        return fail(`Failed to fetch source tx ${utxo.tx_hash}: ${txResp.status}`);
      }
      sourceTxCache[utxo.tx_hash] = await txResp.text();
    }
  }

  // 3. Build the sweep transaction
  const tx = new Transaction();
  let totalInput = 0;

  for (const utxo of utxos) {
    const sourceTx = Transaction.fromHex(sourceTxCache[utxo.tx_hash]);
    const sourceOutput = sourceTx.outputs[utxo.tx_pos];

    tx.addInput({
      sourceTransaction: sourceTx,
      sourceOutputIndex: utxo.tx_pos,
      unlockingScriptTemplate: new P2PKH().unlock(privKey),
    });

    totalInput += utxo.value;
  }

  // Decode target address to get its hash160
  const targetDecoded = Utils.fromBase58(targetAddress);
  const targetHash160 = targetDecoded.slice(1, 21); // skip version byte, take 20 bytes

  // Add output with placeholder amount (will adjust after fee calc)
  tx.addOutput({
    lockingScript: new P2PKH().lock(targetHash160),
    satoshis: totalInput, // placeholder
  });

  // Calculate fee: 1 sat/kB, minimum 100 sats
  // Estimate size: ~148 bytes per input + 34 bytes per output + 10 overhead
  const estimatedSize = utxos.length * 148 + 34 + 10;
  const calculatedFee = Math.ceil(estimatedSize / 1000); // 1 sat/kB
  const fee = Math.max(calculatedFee, 100);

  if (totalInput <= fee) {
    return fail(`Total UTXO value (${totalInput} sats) is not enough to cover fee (${fee} sats)`);
  }

  // Set actual output amount
  tx.outputs[0].satoshis = totalInput - fee;

  // Sign and serialize
  await tx.sign();
  const rawTxHex = tx.toHex();
  const txid = tx.id('hex');

  // 4. Broadcast
  const broadcastResp = await fetch(`${wocBase}/tx/raw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txhex: rawTxHex }),
  });

  if (!broadcastResp.ok) {
    const errText = await broadcastResp.text();
    return fail(`Broadcast failed: ${broadcastResp.status} — ${errText}`);
  }
  const broadcastResult = await broadcastResp.text();

  const explorerBase = NETWORK === 'mainnet'
    ? 'https://whatsonchain.com'
    : 'https://test.whatsonchain.com';

  ok({
    txid: broadcastResult.replace(/"/g, '').trim(),
    satoshisSent: totalInput - fee,
    fee,
    inputCount: utxos.length,
    totalInput,
    from: sourceAddress,
    to: targetAddress,
    network: NETWORK,
    explorer: `${explorerBase}/tx/${txid}`,
  });
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------
const [,, command, ...args] = process.argv;

try {
  switch (command) {
    case 'setup':
      await cmdSetup();
      break;
    case 'identity':
      await cmdIdentity();
      break;
    case 'address':
      await cmdAddress();
      break;
    case 'balance':
      await cmdBalance();
      break;
    case 'pay':
      await cmdPay(args[0], args[1], args.slice(2).join(' ') || undefined);
      break;
    case 'verify':
      await cmdVerify(args[0]);
      break;
    case 'accept':
      await cmdAccept(args[0], args[1], args[2], args[3], args.slice(4).join(' ') || undefined);
      break;
    case 'import':
      await cmdImport(args[0], args[1]);
      break;
    case 'refund':
      await cmdRefund(args[0]);
      break;
    default:
      fail(`Unknown command: ${command || '(none)'}. Available: setup, identity, address, balance, pay, verify, accept, import, refund`);
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
