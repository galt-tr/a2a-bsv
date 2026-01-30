# BSV-PAY v1 Protocol Reference

## Overview

The `bsv-pay-v1` protocol enables Clawdbot agents to negotiate and complete BSV payments for services. Two agents exchange structured JSON messages to agree on terms, transfer payment, and confirm task completion.

## Transport

Messages are JSON objects exchanged via:
- **Same gateway**: `sessions_send(sessionKey, JSON.stringify(message))`
- **Cross gateway**: Channel messages (Telegram, Signal, etc.) via the `message` tool

When sending via channel, embed the protocol message as a JSON code block or as the raw message body. The receiving agent parses any message containing `"protocol": "bsv-pay-v1"`.

## Message Types

All messages share these common fields:

| Field      | Type   | Required | Description                              |
|------------|--------|----------|------------------------------------------|
| `protocol` | string | yes      | Always `"bsv-pay-v1"`                    |
| `action`   | string | yes      | One of the defined action types below     |

---

### 1. PAYMENT_OFFER

**Direction**: Payer → Receiver
**Purpose**: Request a service and signal willingness to pay.

| Field              | Type   | Required | Description                                |
|--------------------|--------|----------|--------------------------------------------|
| `action`           | string | yes      | `"PAYMENT_OFFER"`                          |
| `task`             | string | yes      | Description of the requested service/task  |
| `maxBudgetSats`    | number | yes      | Maximum satoshis the payer is willing to spend |
| `payerIdentityKey` | string | yes      | Payer's compressed public key (hex)        |

```json
{
  "protocol": "bsv-pay-v1",
  "action": "PAYMENT_OFFER",
  "task": "Summarize this 5-page document",
  "maxBudgetSats": 1000,
  "payerIdentityKey": "03a1b2c3..."
}
```

---

### 2. PAYMENT_TERMS

**Direction**: Receiver → Payer
**Purpose**: Communicate the price and receiver's identity key.

| Field                 | Type   | Required | Description                              |
|-----------------------|--------|----------|------------------------------------------|
| `action`              | string | yes      | `"PAYMENT_TERMS"`                        |
| `amountSats`          | number | yes      | Price in satoshis                        |
| `recipientIdentityKey`| string | yes      | Receiver's compressed public key (hex)   |
| `description`         | string | yes      | Brief service description                |

```json
{
  "protocol": "bsv-pay-v1",
  "action": "PAYMENT_TERMS",
  "amountSats": 500,
  "recipientIdentityKey": "02d4e5f6...",
  "description": "Document summarization"
}
```

---

### 3. PAYMENT_SENT

**Direction**: Payer → Receiver
**Purpose**: Deliver the BSV payment and task details.

| Field     | Type   | Required | Description                                |
|-----------|--------|----------|--------------------------------------------|
| `action`  | string | yes      | `"PAYMENT_SENT"`                           |
| `task`    | string | yes      | Full task description / input data         |
| `payment` | object | yes      | PaymentResult from the CLI `pay` command   |

The `payment` object contains:

| Field               | Type   | Description                                      |
|---------------------|--------|--------------------------------------------------|
| `beef`              | string | Base64-encoded Atomic BEEF transaction data      |
| `txid`              | string | Transaction ID (hex)                             |
| `satoshis`          | number | Amount paid                                      |
| `derivationPrefix`  | string | BRC-29 derivation prefix (base64)                |
| `derivationSuffix`  | string | BRC-29 derivation suffix (base64)                |
| `senderIdentityKey` | string | Payer's compressed public key (hex)              |

```json
{
  "protocol": "bsv-pay-v1",
  "action": "PAYMENT_SENT",
  "task": "Summarize this document: [content here]",
  "payment": {
    "beef": "AQC+7wAA...",
    "txid": "a1b2c3d4e5f6...",
    "satoshis": 500,
    "derivationPrefix": "abc123==",
    "derivationSuffix": "def456==",
    "senderIdentityKey": "03a1b2c3..."
  }
}
```

---

### 4. TASK_COMPLETE

**Direction**: Receiver → Payer
**Purpose**: Deliver the task result and confirm payment acceptance.

| Field     | Type   | Required | Description                              |
|-----------|--------|----------|------------------------------------------|
| `action`  | string | yes      | `"TASK_COMPLETE"`                        |
| `result`  | string | yes      | The task output / deliverable            |
| `receipt` | object | yes      | Payment acceptance confirmation          |

The `receipt` object contains:

| Field      | Type    | Description                        |
|------------|---------|-------------------------------------|
| `accepted` | boolean | Whether payment was accepted        |
| `txid`     | string  | Transaction ID of the payment       |

```json
{
  "protocol": "bsv-pay-v1",
  "action": "TASK_COMPLETE",
  "result": "Here is the document summary: ...",
  "receipt": {
    "accepted": true,
    "txid": "a1b2c3d4e5f6..."
  }
}
```

---

### 5. PAYMENT_DECLINED

**Direction**: Receiver → Payer
**Purpose**: Decline a payment offer (budget too low, task not supported, etc.)

| Field    | Type   | Required | Description                   |
|----------|--------|----------|-------------------------------|
| `action` | string | yes      | `"PAYMENT_DECLINED"`          |
| `reason` | string | yes      | Why the offer was declined    |

```json
{
  "protocol": "bsv-pay-v1",
  "action": "PAYMENT_DECLINED",
  "reason": "Requested task is outside my capabilities"
}
```

---

### 6. PAYMENT_ERROR

**Direction**: Either → Either
**Purpose**: Report an error during any stage of the protocol.

| Field    | Type   | Required | Description                    |
|----------|--------|----------|--------------------------------|
| `action` | string | yes      | `"PAYMENT_ERROR"`              |
| `error`  | string | yes      | Error description              |
| `stage`  | string | no       | Which step failed (e.g. "verify", "accept", "task") |

```json
{
  "protocol": "bsv-pay-v1",
  "action": "PAYMENT_ERROR",
  "error": "BEEF verification failed: invalid transaction structure",
  "stage": "verify"
}
```

---

## Complete Flow Example

### Scenario: Agent A wants Agent B to review code for security issues

```
Agent A (Payer)                          Agent B (Receiver)
─────────────                           ──────────────────

1. Run: identity
   → My key: 03aaa...

2. Send PAYMENT_OFFER:
   {
     "protocol": "bsv-pay-v1",
     "action": "PAYMENT_OFFER",
     "task": "Review this code for
              security vulnerabilities",
     "maxBudgetSats": 2000,
     "payerIdentityKey": "03aaa..."
   }
                                        3. Receive PAYMENT_OFFER
                                           Evaluate: can I do this task?
                                           Determine price: 800 sats

                                        4. Run: identity
                                           → My key: 02bbb...

                                        5. Send PAYMENT_TERMS:
                                           {
                                             "protocol": "bsv-pay-v1",
                                             "action": "PAYMENT_TERMS",
                                             "amountSats": 800,
                                             "recipientIdentityKey": "02bbb...",
                                             "description": "Code security review"
                                           }

6. Receive PAYMENT_TERMS
   Check: 800 ≤ 2000 budget ✓
   (If user approval needed, ask user)

7. Run: pay 02bbb... 800 "code review"
   → PaymentResult JSON

8. Send PAYMENT_SENT:
   {
     "protocol": "bsv-pay-v1",
     "action": "PAYMENT_SENT",
     "task": "Review this code: function
              validateInput(x) { eval(x); }",
     "payment": { ...PaymentResult... }
   }
                                        9. Receive PAYMENT_SENT
                                           Extract payment object

                                        10. Run: verify <beef>
                                            → { valid: true, ... }

                                        11. Run: accept <beef> <prefix>
                                                 <suffix> <senderKey>
                                                 "code review payment"
                                            → { accepted: true }

                                        12. Execute the task:
                                            Review the code for security issues

                                        13. Send TASK_COMPLETE:
                                            {
                                              "protocol": "bsv-pay-v1",
                                              "action": "TASK_COMPLETE",
                                              "result": "CRITICAL: eval() allows
                                                         arbitrary code execution...",
                                              "receipt": {
                                                "accepted": true,
                                                "txid": "a1b2c3..."
                                              }
                                            }

14. Receive TASK_COMPLETE
    Present result to user
    Payment confirmed ✓
```

---

## Error Handling

### Payment verification fails

If `verify` returns `valid: false`, the receiver should:
1. NOT accept the payment
2. NOT execute the task
3. Send a `PAYMENT_ERROR` with `stage: "verify"` and the error details

### Payment acceptance fails

If `accept` throws an error, the receiver should:
1. Send a `PAYMENT_ERROR` with `stage: "accept"`
2. The payment transaction may or may not have been broadcast — the payer should check their balance

### Task execution fails

If the receiver cannot complete the task after accepting payment:
1. Send a `TASK_COMPLETE` with the partial result and an explanation
2. The payment is already accepted — refund is a separate transaction if needed
3. To refund: receiver uses `pay <payerKey> <amount>` to send sats back

### Budget exceeded

If `PAYMENT_TERMS.amountSats > PAYMENT_OFFER.maxBudgetSats`:
- The payer should ask the user for approval before proceeding
- Or send a new `PAYMENT_OFFER` with a higher budget
- Or decline and inform the user

---

## Budget & Approval Guidelines

| Amount Range    | Recommended Action                              |
|-----------------|--------------------------------------------------|
| 0–100 sats      | Auto-approve (trivial amounts)                  |
| 101–1000 sats   | Auto-approve if within stated budget             |
| 1001–10000 sats | Ask user for confirmation before paying          |
| 10000+ sats     | Always require explicit user approval            |

These are defaults. The agent should respect any user-configured spending limits.

---

## Protocol Detection

To detect if an incoming message is a bsv-pay-v1 protocol message:
1. Try to parse the message as JSON
2. Check if it has `"protocol": "bsv-pay-v1"`
3. Check the `action` field to determine the message type

If the message is embedded in natural language, look for a JSON code block containing the protocol fields.

---

## Security Notes

- **Identity keys are public keys** — safe to share.
- **BEEF data contains the transaction** — treat it as sensitive during transit.
- **Wallet storage directory contains private keys** — never share or expose.
- **Always verify before accepting** — run `verify` before `accept`.
- **The `senderIdentityKey` in PaymentResult must match the `payerIdentityKey`** from the offer — verify this to prevent impersonation.
