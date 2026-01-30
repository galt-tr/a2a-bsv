#!/usr/bin/env bash
# setup.sh — First-run setup for the bsv-pay Clawdbot skill.
#
# This script:
#   1. Verifies Node.js is available
#   2. Installs and builds the @a2a-bsv/core library if needed
#   3. Creates a symlink so the CLI can import @a2a-bsv/core
#   4. Creates the wallet and prints the identity key
#
# Usage:
#   bash scripts/setup.sh
#
# Environment:
#   BSV_WALLET_DIR  — wallet directory (default: ~/.clawdbot/bsv-wallet)
#   BSV_NETWORK     — testnet or mainnet (default: testnet)

set -euo pipefail

# ---------------------------------------------------------------------------
# Locate the repo root (this script lives in skills/bsv-pay/scripts/)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CORE_DIR="$REPO_ROOT/packages/core"

echo "=== bsv-pay skill setup ==="
echo "Repo root:  $REPO_ROOT"
echo "Core lib:   $CORE_DIR"
echo "Skill dir:  $SKILL_DIR"
echo ""

# ---------------------------------------------------------------------------
# 1. Check Node.js
# ---------------------------------------------------------------------------
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js is not installed. Please install Node.js >= 18."
  exit 1
fi
NODE_VER="$(node -v)"
echo "✓ Node.js $NODE_VER found"

# ---------------------------------------------------------------------------
# 2. Install dependencies for @a2a-bsv/core (if needed)
# ---------------------------------------------------------------------------
if [ ! -d "$CORE_DIR/node_modules" ]; then
  echo "→ Installing @a2a-bsv/core dependencies..."
  (cd "$CORE_DIR" && npm install --no-audit --no-fund)
else
  echo "✓ @a2a-bsv/core dependencies already installed"
fi

# ---------------------------------------------------------------------------
# 3. Build @a2a-bsv/core TypeScript (if needed)
# ---------------------------------------------------------------------------
if [ ! -f "$CORE_DIR/dist/index.js" ]; then
  echo "→ Building @a2a-bsv/core..."
  (cd "$CORE_DIR" && npm run build)
else
  echo "✓ @a2a-bsv/core already built"
fi

# ---------------------------------------------------------------------------
# 4. Create symlink so `import '@a2a-bsv/core'` works from the CLI
# ---------------------------------------------------------------------------
LINK_DIR="$REPO_ROOT/node_modules/@a2a-bsv"
LINK_TARGET="$LINK_DIR/core"

if [ ! -L "$LINK_TARGET" ] && [ ! -d "$LINK_TARGET" ]; then
  echo "→ Creating symlink for @a2a-bsv/core..."
  mkdir -p "$LINK_DIR"
  ln -sf "$CORE_DIR" "$LINK_TARGET"
  echo "  $LINK_TARGET -> $CORE_DIR"
else
  echo "✓ @a2a-bsv/core symlink exists"
fi

# ---------------------------------------------------------------------------
# 5. Create wallet
# ---------------------------------------------------------------------------
WALLET_DIR="${BSV_WALLET_DIR:-$HOME/.clawdbot/bsv-wallet}"
NETWORK="${BSV_NETWORK:-testnet}"

echo ""
echo "→ Setting up wallet (network=$NETWORK, dir=$WALLET_DIR)..."

# Run the CLI setup command
CLI="$SKILL_DIR/scripts/bsv-agent-cli.mjs"
RESULT="$(BSV_WALLET_DIR="$WALLET_DIR" BSV_NETWORK="$NETWORK" NODE_PATH="$REPO_ROOT/node_modules" node "$CLI" setup 2>&1)" || true

# Extract the JSON line (last line starting with {)
JSON_LINE="$(echo "$RESULT" | grep '^{' | tail -1)"

if [ -n "$JSON_LINE" ]; then
  echo "$JSON_LINE" | python3 -c "
import sys, json
data = json.loads(sys.stdin.read())
if data.get('success'):
    d = data['data']
    existed = 'loaded existing' if d.get('alreadyExisted') else 'created new'
    print(f'✓ Wallet {existed}')
    print(f'  Identity key: {d[\"identityKey\"]}')
    print(f'  Wallet dir:   {d[\"walletDir\"]}')
    print(f'  Network:      {d[\"network\"]}')
else:
    print(f'✗ Setup failed: {data.get(\"error\", \"unknown error\")}')
    sys.exit(1)
" 2>/dev/null || echo "$JSON_LINE"
else
  echo "✗ Setup command produced no JSON output:"
  echo "$RESULT"
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "You can now use the BSV wallet CLI:"
echo "  node $CLI identity     # Show your identity key"
echo "  node $CLI address      # Show your receive address"
echo "  node $CLI balance      # Check balance"
echo "  node $CLI pay <key> <sats>  # Send payment"
echo ""
echo "Next steps:"
echo "  1. Get your testnet address:  node $CLI address"
echo "  2. Fund it at:  https://witnessonchain.com/faucet/tbsv"
echo "  3. Track your address at:  https://test.whatsonchain.com/address/<your-address>"
echo "  4. Symlink skill into Clawdbot:  ln -s $(cd "$REPO_ROOT" && pwd)/skills/bsv-pay ~/clawd/skills/bsv-pay"
