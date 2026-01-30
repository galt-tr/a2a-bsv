# BSV AP2 Integration PRD — Review Notes

**Reviewer**: Expert payment systems / x402 review  
**Date**: 2026-01-30  
**Document**: `BSV_AP2_INTEGRATION_PRD.md` v1.0.0  

---

## Summary

The PRD is well-structured and covers the right topics. The core value proposition (BSV's UTXO model + SPV + micropayment economics for agent payments) is sound. However, the document had several substantive issues that would cause problems during x402 scheme review or actual implementation. All material issues have been addressed in-place.

---

## Changes Made (Material Issues Only)

### 1. BEEF Size Claims — Fixed (Multiple Locations)

**Problem**: The document repeatedly claimed BEEF payloads are "~200 bytes". This is the size of a raw P2PKH *transaction*, not a BEEF package. BEEF includes ancestor transactions with Merkle proofs on top of the new transaction. Realistic size: 500–2000 bytes depending on ancestry depth.

**Impact**: Misleading benchmarks, incorrect comparison tables, unrealistic payload size expectations.

**Fix**: Changed all references to "~500–2000 bytes" with explanatory notes. Updated the BEEF structure documentation in §5.2 with a detailed binary format diagram and realistic size estimates.

### 2. SPV Verification Ordering — Fixed (§4.2)

**Problem**: The verification steps showed script evaluation before Merkle proof validation. Logically, you must validate ancestors (via Merkle proofs) *before* evaluating the new transaction's scripts against those ancestors. The wrong ordering would let an attacker submit a transaction spending fabricated ancestor outputs.

**Fix**: Reordered to: parse BEEF → verify ancestor Merkle proofs → evaluate scripts → check fees → verify expected output. Updated both the sequence diagram annotation and the Step 6 narrative.

### 3. PaymentPayload Transport — Fixed (§6.3)

**Problem**: Section 6.3 sent the PaymentPayload as a message `data` part with `mimeType: "application/x-x402-payment"`. The x402 spec requires PaymentPayload to be sent in **task metadata** under the `x402.payment.payload` key. This would cause interop failures with any x402-conformant implementation.

**Fix**: Rewrote §6.3 to place the payload in metadata. Added explanatory note about the x402 spec requirement.

### 4. Metadata Key Format — Fixed (§6.1–6.5, §5.4, Appendix A)

**Problem**: All message examples used `"x402.payment": { nested object }` as a single metadata key with nested values. The x402 spec uses dot-notation keys: `x402.payment.state`, `x402.payment.required`, `x402.payment.payload`, `x402.payment.receipts`, `x402.payment.error`. This is not just a naming convention — x402-aware middleware may filter or route based on these specific keys.

**Fix**: Rewrote all message examples and TypeScript interfaces to use the correct dot-notation keys. Updated Appendix A metadata types with documentation explaining the key structure.

### 5. Agent Card Declaration — Added (§4.1.1)

**Problem**: The document never showed how the BSV scheme appears in the A2A Agent Card's `extensions` array. This is how clients *discover* that a merchant supports BSV payments. Without this, the scheme is undiscoverable.

**Fix**: Added new §4.1.1 with a complete Agent Card JSON example showing the x402 extension with BSV `paymentRequirements`.

### 6. UTXO Management — Added (§4.5)

**Problem**: The document completely omitted UTXO management — the most operationally critical difference between UTXO and account-based payment models for agents. Questions like "what happens to change?", "how do agents pay in parallel?", "what about dust limits?" were unanswered.

**Fix**: Added new §4.5 covering: change output handling (automatic via BRC-100), UTXO fragmentation, pre-splitting for parallelism, dust limit constraints, and a code example for UTXO pool preparation.

### 7. Error Code Registry — Added (§4.4)

**Problem**: The facilitator API defined two error examples but lacked a comprehensive error taxonomy. Missing: BEEF parse errors, network partition handling, mempool rejection, dust limit violations, timeout expiry, scheme/network mismatch. An implementer would have to guess error codes.

**Fix**: Added a complete error code registry table (20+ codes across Validation, Verification, Broadcast, Network, Settlement, and Protocol categories) with recovery guidance for each. Added `FacilitatorError` TypeScript interface.

### 8. Concurrency and Rate Limiting — Added (§4.4)

**Problem**: No guidance on how the facilitator handles concurrent requests. Critical for production deployment.

**Fix**: Added section covering: stateless verification, broadcast deduplication, idempotent settlement, per-agent rate limiting, and request timeouts.

### 9. Key Derivation Made Explicit — Fixed (§4.3)

**Problem**: The `createAction` code example hid the entire BRC-29/BRC-42 key derivation process behind a magic `buildP2PKHScript(paymentRequirements.payTo)` helper. An implementer wouldn't know that `payTo` (an identity key) requires ECDH key derivation using the invoice number format `"2-3241645161d8-{prefix} {suffix}"` to produce the actual payment address. This is the core of authenticated payments and it was invisible.

**Fix**: Rewrote the `createAction` example with explicit key derivation steps: generate derivation suffix, construct BRC-29 invoice number, derive payment key via `getPublicKey` with BRC-42 parameters, then build the P2PKH script. Also documented change output handling.

### 10. internalizeAction API — Fixed (§4.3, Appendix A)

**Problem**: The `internalizeAction` example used `outputMap` within `tx`, which doesn't match the BRC-100 API. BRC-100 uses `outputs` as a separate parameter with `protocol: 'basket insertion'` and `insertionRemittance` for basket assignment.

**Fix**: Corrected the API call and TypeScript types to match BRC-100's actual interface.

### 11. 0-Conf Security Caveats — Added (§7.2)

**Problem**: The 0-conf risk assessment was presented as purely economic ("cost of attack exceeds value"), which is technically accurate for individual payments but incomplete. It didn't mention that the first-seen rule is miner *policy* not consensus, that automated attack tooling exists, or that network propagation has a non-zero window.

**Fix**: Added explicit caveats about: first-seen as policy (not consensus), automated attack scaling risks, propagation window, and price volatility affecting USD thresholds. Recommended rate-limiting per identity key as mitigation.

### 12. Timeout and Failure Handling — Added (§4.2)

**Problem**: The payment flow described the happy path but said nothing about what happens when things go wrong: timeout expiry, verification failure, broadcast failure, post-broadcast double-spend, network partition. An implementer needs to know the expected behavior for each failure mode.

**Fix**: Added "Timeout and Failure Handling" subsection covering all five failure scenarios with expected state transitions, error codes, and recovery guidance.

### 13. SettleResponse Conformance — Clarified (§5.3)

**Problem**: `BSVSettleResponse` added `bsvDetails` as a top-level field alongside the standard x402 fields, but didn't clearly indicate which fields are standard x402 and which are BSV scheme extensions. A reviewer would flag this as potentially breaking the base interface.

**Fix**: Added clear comments separating "Standard x402 SettleResponse fields" from "BSV scheme-specific extension" with a JSDoc block explaining the relationship.

### 14. State Machine Alignment — Clarified (§5.4)

**Problem**: The document added `PAYMENT_BROADCAST` to the x402 state machine without explaining how it maps back to standard states for non-BSV-aware consumers.

**Fix**: Rewrote the note to explicitly state that `PAYMENT_BROADCAST` is a scheme-specific sub-state that maps to standard `PAYMENT_VERIFIED` from the perspective of x402 consumers, and clarified the transition timing for micropayments.

### 15. Implementation Timeline — Adjusted (§8)

**Problem**: The original timeline (12 weeks total including upstream submission) was unrealistic. Building a BEEF parser + SPV engine + script evaluator in 3 weeks is aggressive even with existing libraries. Upstream review typically takes longer than 4 weeks for a new scheme.

**Fix**: Extended to 20 weeks: Phase 1 (1–4), Phase 2 (4–9), Phase 3 (8–12), Phase 4 (11–15), Phase 5 (14–20). Added implementation complexity note about BEEF parser and script evaluation engine being the highest-risk items. Adjusted upstream acceptance milestones to match.

### 16. Glossary Accuracy — Fixed (Appendix C)

**Problem**: Several glossary mappings were misleading:
- "P2PKH → ERC-20 transfer" (P2PKH is a script type, not analogous to a token contract call)
- "BEEF → EIP-712 signed typed data" (BEEF is a transaction format with proofs, not a signing standard)
- "createAction → eth_sendTransaction" (createAction builds locally, doesn't broadcast)
- "BRC-3 → EIP-712 signature" (BRC-3 is general ECDSA, EIP-712 is typed structured data)
- "OP_RETURN → Event log" (different layers entirely)

**Fix**: Corrected each mapping with accurate analogies and explanatory notes about why the direct comparison breaks down.

### 17. BRC-29 Invoice Number Format — Documented (§4.1)

**Problem**: The document mentioned `derivationPrefix` and `derivationSuffix` but never showed how they combine into the BRC-29 invoice number format `"2-3241645161d8-{prefix} {suffix}"`. Without this, an implementer can't construct the correct key derivation path.

**Fix**: Added the invoice number format to §4.1 Key Design Decision #1 and made it explicit in the createAction code example.

### 18. Scheme Spec Appendix B — Enhanced

**Problem**: The scheme spec was missing Agent Card declaration guidance, error codes, and UTXO management notes — all of which would be expected in an x402 scheme submission.

**Fix**: Added Agent Card Declaration, Error Codes, and UTXO Management sections to Appendix B.

---

## Issues NOT Fixed (Deliberate)

These are real observations that didn't warrant changes:

- **Style/voice**: The document has a slightly promotional tone ("uniquely suited", "overwhelmingly appropriate"). This is fine for a PRD; a scheme submission would need more neutral language, but that's a future-phase concern.
- **BSV price assumptions**: The USD cost comparisons depend on BSV's market price. The document acknowledges this implicitly by using satoshi-denominated amounts. No change needed.
- **Python library API**: The Python examples are illustrative and will be refined during Phase 3 implementation. No point bikeshedding async/await syntax now.
- **BRC-46 basket naming**: The basket names ("x402-revenue", "x402-payments-sent") are illustrative conventions, not protocol requirements. No change needed.
- **OP_RETURN metadata format**: The document doesn't specify the exact serialization format for OP_RETURN metadata (JSON? CBOR? Custom binary?). This is a Phase 1 task and appropriately deferred.

---

## Overall Assessment

**Before review**: Solid structure, correct high-level architecture, but would fail x402 scheme review due to spec conformance issues (metadata format, payload transport, missing Agent Card), implementability gaps (no error codes, no UTXO management, hidden key derivation), and inaccurate claims (BEEF size).

**After review**: Ready for internal team review and Phase 1 kickoff. The data structures are correct, the flows handle failure cases, the x402 mapping is faithful to the spec, and an implementer can build from this document. The scheme spec appendix is close to submission-ready with one more pass for formal language.
