#!/usr/bin/env bash
set -euo pipefail

RPC_URL="https://rpc.testnet.arc.io"
OLD_V3_CONTRACT="0x1A7DE2Aa478A48aa75Ad39099B323E8B113A9A93"
FOUNDRY_ACCOUNT="linqa-testnet-deployer"
EXPECTED_CHAIN_ID="5042002"

actual_chain_id="$(cast chain-id --rpc-url "$RPC_URL")"
if [[ "$actual_chain_id" != "$EXPECTED_CHAIN_ID" ]]; then
  echo "Refusing to continue: RPC chain ID is $actual_chain_id, expected $EXPECTED_CHAIN_ID." >&2
  exit 1
fi

version="$(cast call "$OLD_V3_CONTRACT" "gameVersion()(uint256)" --rpc-url "$RPC_URL")"
if [[ "$version" != "3" ]]; then
  echo "Refusing to continue: $OLD_V3_CONTRACT reports game version $version, expected v3." >&2
  exit 1
fi

contract_owner="$(cast call "$OLD_V3_CONTRACT" "owner()(address)" --rpc-url "$RPC_URL")"
echo "Old contract owner: $contract_owner"
echo "Before continuing, compare this with the owner address printed when you deployed V3."

call_data="$(cast calldata "getAvailableLiquidity()")"
raw_result="$(cast rpc eth_call "{\"to\":\"$OLD_V3_CONTRACT\",\"data\":\"$call_data\"}" latest --rpc-url "$RPC_URL")"
raw_result="${raw_result//\"/}"
raw_result="${raw_result//[[:space:]]/}"
if [[ ! "$raw_result" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
  echo "Could not read raw getAvailableLiquidity result: $raw_result" >&2
  exit 1
fi
available_raw="$(cast to-dec "$raw_result")"
if [[ ! "$available_raw" =~ ^[0-9]+$ ]]; then
  echo "Could not decode available liquidity as an integer." >&2
  exit 1
fi
if [[ "$available_raw" == "0" ]]; then
  echo "There is no unreserved liquidity available to withdraw. Active rounds may still have reserved funds."
  exit 0
fi

if (( ${#available_raw} > 6 )); then
  whole_usdc="${available_raw:0:${#available_raw}-6}"
  fraction_usdc="${available_raw: -6}"
else
  whole_usdc="0"
  fraction_usdc="$available_raw"
  while (( ${#fraction_usdc} < 6 )); do fraction_usdc="0$fraction_usdc"; done
fi
echo "Withdrawable amount: $whole_usdc.$fraction_usdc USDC ($available_raw raw units)."
echo "This withdraws only unreserved liquidity to the contract owner. Reserved active-round funds remain in the old contract."
read -r -p "Confirm $FOUNDRY_ACCOUNT is the contract owner, then type WITHDRAW: " confirmation
if [[ "$confirmation" != "WITHDRAW" ]]; then
  echo "Cancelled; no transaction was sent."
  exit 0
fi

cast send "$OLD_V3_CONTRACT" "removeLiquidity(uint256)" "$available_raw" \
  --rpc-url "$RPC_URL" \
  --account "$FOUNDRY_ACCOUNT"
