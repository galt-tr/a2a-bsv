---
name: bsv-pay
description: Send and receive BSV payments between Clawdbot agents using the bsv-pay-v1 protocol
triggers:
  - payment
  - pay
  - BSV
  - satoshis
  - sats
  - bsv-pay-v1
  - PAYMENT_OFFER
  - PAYMENT_TERMS
  - PAYMENT_SENT
  - TASK_COMPLETE
---

# BSV-PAY: Agent-to-Agent BSV Payments

This skill lets you send and receive BSV (Bitcoin SV) payments to/from other Clawdbot agents. You can pay another agent to perform a task, or receive payment for performing tasks.

## Quick Reference

| Command | What it does |
|---------|-------------|
| `node scripts/bsv-agent-cli.mjs setup` | Create wallet (first run) |
| `node scripts/bsv-agent-cli.mjs identity` | Show your public identity key |
| `node scripts/bsv-agent-cli.mjs address` | Show P2PKH receive address (for funding) |
| `node scripts/bsv-agent-cli.mjs balance` | Check wallet balance |
| `node scripts/bsv-agent-cli.mjs pay <pubkey> <sats> [desc]` | Send payment |
| `node scripts/bsv-agent-cli.mjs verify <beef_base64>` | Verify incoming payment |
| `node scripts/bsv-agent-cli.mjs accept <beef> <prefix> <suffix> <senderKey> [desc]` | Accept payment |

All commands output JSON: `{"success": true, "data": {...}}` or `{"success": false, "error": "..."}`.

Set `BSV_WALLET_DIR` (default: `~/.clawdbot/bsv-wallet`) and `BSV_NETWORK` (default: `testnet`).

The CLI script is at: `skills/bsv-pay/scripts/bsv-agent-cli.mjs`

To resolve imports, run with `NODE_PATH` pointing to the repo root's node_modules:
```bash
NODE_PATH=/home/dylan/a2a-bsv/node_modules node skills/bsv-pay/scripts/bsv-agent-cli.mjs <command>
```

---

## First-Run Setup

If the wallet hasn't been set up yet, run:

```bash
bash skills/bsv-pay/scripts/setup.sh
```

This installs dependencies, builds the core library, creates the wallet, and shows your identity key. You only need to do this once.

To verify setup worked:
```bash
NODE_PATH=/home/dylan/a2a-bsv/node_modules node skills/bsv-pay/scripts/bsv-agent-cli.mjs identity
```

---

## Payment Protocol (bsv-pay-v1)

Agents exchange JSON messages with `"protocol": "bsv-pay-v1"` and an `action` field. Messages are sent via `sessions_send` (same gateway) or channel messages (cross-gateway).

### Message Types

1. **PAYMENT_OFFER** — Payer requests a service, states budget
2. **PAYMENT_TERMS** — Receiver states their price
3. **PAYMENT_SENT** — Payer sends BSV payment + task details
4. **TASK_COMPLETE** — Receiver delivers result + payment receipt
5. **PAYMENT_DECLINED** — Receiver declines the offer
6. **PAYMENT_ERROR** — Either side reports an error

For full field definitions, read: `references/protocol.md`

---

## As PAYER: Sending Payment to Another Agent

Use this flow when you (or your user) want to pay another agent to do something.

### Step 1: Get your identity key

```bash
NODE_PATH=/home/dylan/a2a-bsv/node_modules node skills/bsv-pay/scripts/bsv-agent-cli.mjs identity
```

Parse the JSON response to get `data.identityKey`.

### Step 2: Send PAYMENT_OFFER to the other agent

Send this message to the other agent (via sessions_send or channel message):

```json
{
  "protocol": "bsv-pay-v1",
  "action": "PAYMENT_OFFER",
  "task": "Description of what you want done",
  "maxBudgetSats": 1000,
  "payerIdentityKey": "<your identity key from step 1>"
}
```

### Step 3: Receive PAYMENT_TERMS

The other agent replies with their price:

```json
{
  "protocol": "bsv-pay-v1",
  "action": "PAYMENT_TERMS",
  "amountSats": 500,
  "recipientIdentityKey": "02...",
  "description": "Service description"
}
```

### Step 4: Check budget and get approval

- If `amountSats` ≤ `maxBudgetSats`, proceed.
- If `amountSats` > 1000, ask the user for approval before paying.
- If the user declines, inform the other agent.

### Step 5: Create the payment

```bash
NODE_PATH=/home/dylan/a2a-bsv/node_modules node skills/bsv-pay/scripts/bsv-agent-cli.mjs pay <recipientIdentityKey> <amountSats> "payment description"
```

Parse the JSON response. The `data` object is the PaymentResult containing `beef`, `txid`, `satoshis`, `derivationPrefix`, `derivationSuffix`, `senderIdentityKey`.

### Step 6: Send PAYMENT_SENT with task

Send this to the other agent:

```json
{
  "protocol": "bsv-pay-v1",
  "action": "PAYMENT_SENT",
  "task": "Full task description with all needed details",
  "payment": {
    "beef": "<from PaymentResult>",
    "txid": "<from PaymentResult>",
    "satoshis": 500,
    "derivationPrefix": "<from PaymentResult>",
    "derivationSuffix": "<from PaymentResult>",
    "senderIdentityKey": "<from PaymentResult>"
  }
}
```

**Include the complete `payment` object exactly as returned by the CLI.**

### Step 7: Receive TASK_COMPLETE

The other agent replies with:

```json
{
  "protocol": "bsv-pay-v1",
  "action": "TASK_COMPLETE",
  "result": "The task output...",
  "receipt": { "accepted": true, "txid": "..." }
}
```

Present the `result` to the user. Confirm the payment was accepted via `receipt.accepted`.

---

## As RECEIVER: Accepting Payment from Another Agent

Use this flow when you receive a `bsv-pay-v1` protocol message from another agent.

### When you receive PAYMENT_OFFER

1. Evaluate whether you can perform the requested `task`.
2. Determine your price in satoshis.
3. Get your identity key:

```bash
NODE_PATH=/home/dylan/a2a-bsv/node_modules node skills/bsv-pay/scripts/bsv-agent-cli.mjs identity
```

4. Reply with PAYMENT_TERMS:

```json
{
  "protocol": "bsv-pay-v1",
  "action": "PAYMENT_TERMS",
  "amountSats": 500,
  "recipientIdentityKey": "<your identity key>",
  "description": "Brief description of what you'll do"
}
```

If you can't or don't want to do the task, reply with:

```json
{
  "protocol": "bsv-pay-v1",
  "action": "PAYMENT_DECLINED",
  "reason": "Explanation of why"
}
```

### When you receive PAYMENT_SENT

This is the critical flow. The other agent has sent you BSV. You must verify, accept, do the task, and confirm.

#### Step A: Verify the payment

```bash
NODE_PATH=/home/dylan/a2a-bsv/node_modules node skills/bsv-pay/scripts/bsv-agent-cli.mjs verify "<payment.beef>"
```

Check that `data.valid` is `true`. If not, reply with PAYMENT_ERROR:

```json
{
  "protocol": "bsv-pay-v1",
  "action": "PAYMENT_ERROR",
  "error": "Payment verification failed: <errors>",
  "stage": "verify"
}
```

#### Step B: Accept the payment

```bash
NODE_PATH=/home/dylan/a2a-bsv/node_modules node skills/bsv-pay/scripts/bsv-agent-cli.mjs accept "<payment.beef>" "<payment.derivationPrefix>" "<payment.derivationSuffix>" "<payment.senderIdentityKey>" "payment description"
```

Check that `data.accepted` is `true`. If acceptance fails, reply with PAYMENT_ERROR with `stage: "accept"`.

#### Step C: Execute the task

Do whatever the `task` field describes. This is your normal agent capability — analyze code, summarize text, generate content, etc.

#### Step D: Reply with TASK_COMPLETE

```json
{
  "protocol": "bsv-pay-v1",
  "action": "TASK_COMPLETE",
  "result": "Here is the completed work: ...",
  "receipt": {
    "accepted": true,
    "txid": "<from the payment.txid>"
  }
}
```

---

## Detecting Protocol Messages

When you receive any message, check if it's a bsv-pay-v1 protocol message:

1. Try to parse the message as JSON
2. Look for `"protocol": "bsv-pay-v1"` 
3. Check the `action` field and follow the appropriate receiver flow above

If the message is mixed with natural language, look for a JSON block containing the protocol fields.

---

## Pricing Guidelines

When you're the receiver and need to set a price:

| Task Type | Suggested Range |
|-----------|----------------|
| Simple text response | 10–50 sats |
| Code review / analysis | 100–1000 sats |
| Content generation | 50–500 sats |
| Complex multi-step task | 500–5000 sats |

These are suggestions. Adjust based on task complexity.

---

## Spending Approval

When you're the payer:

| Amount | Action |
|--------|--------|
| ≤ 100 sats | Auto-approve |
| 101–1000 sats | Auto-approve if within stated budget |
| 1001–10000 sats | Ask user for confirmation |
| > 10000 sats | Always require explicit user approval |

---

## Error Handling

- If any CLI command returns `{"success": false, "error": "..."}`, handle the error gracefully.
- If wallet is not set up, run `bash skills/bsv-pay/scripts/setup.sh` first.
- If balance is insufficient for a payment, inform the user they need to fund the wallet.
- If the other agent doesn't respond with a protocol message, they may not have the bsv-pay skill installed.

---

## Checking Balance

```bash
NODE_PATH=/home/dylan/a2a-bsv/node_modules node skills/bsv-pay/scripts/bsv-agent-cli.mjs balance
```

Returns `{"success": true, "data": {"confirmed": 0, "unconfirmed": 0, "total": 0}}` (amounts in satoshis).
