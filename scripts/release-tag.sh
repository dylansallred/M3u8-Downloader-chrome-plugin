#!/usr/bin/env bash
set -euo pipefail

# One-command release tag flow:
#   ./scripts/release-tag.sh 1.2.3
# This creates/pushes annotated tag v1.2.3 which triggers release workflow.

VERSION_INPUT="${1:-}"
if [[ -z "$VERSION_INPUT" ]]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 1.2.3"
  exit 1
fi

if [[ "$VERSION_INPUT" =~ ^v ]]; then
  TAG="$VERSION_INPUT"
else
  TAG="v$VERSION_INPUT"
fi

if ! [[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid tag format: $TAG (expected vX.Y.Z)"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit/stash changes before tagging."
  exit 1
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Tag already exists locally: $TAG"
  exit 1
fi

if git ls-remote --tags origin "$TAG" | grep -q "$TAG"; then
  echo "Tag already exists on origin: $TAG"
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "Warning: current branch is '$CURRENT_BRANCH' (recommended: main)"
fi

git fetch --tags origin
git tag -a "$TAG" -m "Release $TAG"
git push origin "$TAG"

echo "Pushed release tag $TAG"
echo "GitHub Actions release workflow should start automatically."
