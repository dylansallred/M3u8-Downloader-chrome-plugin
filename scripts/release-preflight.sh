#!/usr/bin/env bash
set -euo pipefail

# Release preflight checks for signed/notarized desktop releases.
#
# Usage:
#   ./scripts/release-preflight.sh
#   ./scripts/release-preflight.sh --target macos
#   ./scripts/release-preflight.sh --target windows
#   ./scripts/release-preflight.sh --target all --allow-missing-tools
#
# Environment:
#   REQUIRED secrets for macOS target:
#     APPLE_ID
#     APPLE_APP_SPECIFIC_PASSWORD
#     APPLE_TEAM_ID
#     CSC_LINK
#     CSC_KEY_PASSWORD
#
#   REQUIRED secrets for Windows target:
#     WIN_CSC_LINK
#     WIN_CSC_KEY_PASSWORD

TARGET=""
ALLOW_MISSING_TOOLS="0"

print_help() {
  cat <<'EOF'
release-preflight.sh

Validates release environment before creating/pushing a version tag.

Options:
  --target <auto|macos|windows|all>  Target checks to run (default: auto)
  --allow-missing-tools              Skip failures when local OS tools are unavailable
  -h, --help                         Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET="${2:-}"
      if [[ -z "$TARGET" ]]; then
        echo "Missing value for --target"
        exit 1
      fi
      shift 2
      ;;
    --allow-missing-tools)
      ALLOW_MISSING_TOOLS="1"
      shift
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
      print_help
      exit 1
      ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  case "$(uname -s)" in
    Darwin) TARGET="macos" ;;
    MINGW*|MSYS*|CYGWIN*) TARGET="windows" ;;
    *) TARGET="all" ;;
  esac
fi

if [[ ! "$TARGET" =~ ^(auto|macos|windows|all)$ ]]; then
  echo "Invalid --target value: $TARGET"
  exit 1
fi

if [[ "$TARGET" == "auto" ]]; then
  case "$(uname -s)" in
    Darwin) TARGET="macos" ;;
    MINGW*|MSYS*|CYGWIN*) TARGET="windows" ;;
    *) TARGET="all" ;;
  esac
fi

FAILURES=0

check_secret() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required env var: $name"
    FAILURES=$((FAILURES + 1))
  fi
}

check_tool() {
  local tool="$1"
  if ! command -v "$tool" >/dev/null 2>&1; then
    if [[ "$ALLOW_MISSING_TOOLS" == "1" ]]; then
      echo "Tool not found (allowed): $tool"
      return
    fi
    echo "Missing required tool: $tool"
    FAILURES=$((FAILURES + 1))
  fi
}

echo "Release preflight target: $TARGET"

if [[ "$TARGET" == "macos" || "$TARGET" == "all" ]]; then
  echo "Checking macOS release prerequisites..."
  check_secret "APPLE_ID"
  check_secret "APPLE_APP_SPECIFIC_PASSWORD"
  check_secret "APPLE_TEAM_ID"
  check_secret "CSC_LINK"
  check_secret "CSC_KEY_PASSWORD"

  # Local tool checks only make sense on macOS.
  if [[ "$(uname -s)" == "Darwin" ]]; then
    check_tool "xcrun"
  fi
fi

if [[ "$TARGET" == "windows" || "$TARGET" == "all" ]]; then
  echo "Checking Windows release prerequisites..."
  check_secret "WIN_CSC_LINK"
  check_secret "WIN_CSC_KEY_PASSWORD"

  # Best-effort local tool check on Windows shells.
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      check_tool "signtool.exe"
      ;;
  esac
fi

if [[ "$FAILURES" -gt 0 ]]; then
  echo "Preflight failed with $FAILURES issue(s)."
  exit 1
fi

echo "Preflight passed."
