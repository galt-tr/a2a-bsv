#!/usr/bin/env node
/**
 * bsv-agent-cli.mjs — CLI tool for BSV agent wallet operations.
 *
 * All output is JSON with a { success, data/error } wrapper for agent parsing.
 *
 * Environment variables:
 *   BSV_WALLET_DIR  — wallet storage directory (default: ~/.clawdbot/bsv-wallet)
 *   BSV_NETWORK     — 'testnet' or 'mainnet' (default: testnet)
 *
 * Commands:
 *   setup                                    — Create wallet, show identity key
 *   identity                                 — Show identity public key
 *   address                                  — Show testnet/mainnet P2PKH receive address
 *   balance                                  — Show balance in satoshis
 *   pay <pubkey> <satoshis> [description]    — Create payment → JSON PaymentResult
 *   verify <beef_base64>                     — Verify incoming BEEF → JSON VerifyResult
 *   accept <beef> <prefix> <suffix> <senderKey> [description] — Accept payment
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
const NETWORK = process.env.BSV_NETWORK || 'testnet';

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

async function cmdFund(rawTxHex, voutStr) {
  if (!rawTxHex) {
    return fail('Usage: fund <raw_tx_hex> [vout] — Import a raw P2PKH transaction paying to your root address');
  }
  const vout = parseInt(voutStr || '0', 10);

  // Import SDK for Transaction parsing
  let sdk;
  try {
    sdk = await import('@bsv/sdk');
  } catch {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const sdkPath = path.join(repoRoot, 'packages', 'core', 'node_modules', '@bsv', 'sdk', 'dist', 'esm', 'mod.js');
    sdk = await import(sdkPath);
  }
  const { Transaction } = sdk;

  // Parse the raw transaction
  const tx = Transaction.fromHex(rawTxHex);
  const txid = tx.id('hex');
  const output = tx.outputs[vout];
  if (!output) {
    return fail(`Output index ${vout} not found in transaction (has ${tx.outputs.length} outputs)`);
  }

  // For external funding (faucet, direct P2PKH), the BRC-100 wallet's
  // internalizeAction requires valid AtomicBEEF with merkle proofs.
  // Unconfirmed external txs don't have proofs yet, so we insert the UTXO
  // directly into the wallet's SQLite storage.
  let knexLib;
  try {
    knexLib = (await import('knex')).default;
  } catch {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    knexLib = (await import(path.join(repoRoot, 'packages', 'core', 'node_modules', 'knex', 'knex.mjs'))).default;
  }

  // Find the wallet SQLite database
  const dbFiles = fs.readdirSync(WALLET_DIR).filter(f => f.endsWith('.sqlite') && f !== 'wallet.sqlite');
  if (dbFiles.length === 0) {
    return fail('No wallet database found. Run setup first.');
  }
  const dbPath = path.join(WALLET_DIR, dbFiles[0]);

  const knex = knexLib({ client: 'sqlite3', connection: { filename: dbPath }, useNullAsDefault: true });

  try {
    // Get the user
    const user = await knex('users').first();
    if (!user) { await knex.destroy(); return fail('No user found in wallet database'); }

    // Get the default basket
    const basket = await knex('output_baskets').where({ userId: user.userId, name: 'default' }).first();
    if (!basket) { await knex.destroy(); return fail('No default basket found'); }

    // Check if this UTXO is already imported
    const existing = await knex('outputs').where({ txid, vout }).first();
    if (existing) {
      await knex.destroy();
      return ok({ txid, satoshis: output.satoshis, vout, alreadyImported: true });
    }

    // Insert a proven_txs record for the transaction (unconfirmed)
    const [provenTxId] = await knex('proven_txs').insert({
      txid,
      height: 0,
      index: 0,
      merklePath: '',
      rawTx: Buffer.from(rawTxHex, 'hex'),
      blockHash: '',
      merkleRoot: '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Insert a transactions record
    const [transactionId] = await knex('transactions').insert({
      userId: user.userId,
      provenTxId,
      status: 'unproven',
      reference: `fund-${txid.slice(0, 12)}`,
      isOutgoing: 0,
      satoshis: output.satoshis,
      description: 'External funding',
      txid,
      rawTx: Buffer.from(rawTxHex, 'hex'),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Insert the output record
    await knex('outputs').insert({
      userId: user.userId,
      transactionId,
      basketId: basket.basketId,
      spendable: 1,
      change: 0,
      vout,
      satoshis: output.satoshis,
      providedBy: 'external',
      purpose: 'funding',
      type: 'P2PKH',
      outputDescription: 'External funding',
      txid,
      lockingScript: output.lockingScript.toHex(),
      scriptLength: output.lockingScript.toHex().length / 2,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    await knex.destroy();
    ok({ txid, satoshis: output.satoshis, vout, imported: true });
  } catch (err) {
    await knex.destroy();
    fail(`Failed to import UTXO: ${err instanceof Error ? err.message : String(err)}`);
  }
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
    case 'fund':
      await cmdFund(args[0], args[1]);
      break;
    default:
      fail(`Unknown command: ${command || '(none)'}. Available: setup, identity, address, balance, pay, verify, accept, fund`);
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
