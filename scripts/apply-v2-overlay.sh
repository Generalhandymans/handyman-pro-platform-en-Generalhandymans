#!/usr/bin/env bash
set -euo pipefail

echo "General Handyman Solutions V2 overlay"
echo "This script is intended to be run from the ROOT of the cloned target repository."
echo
echo "Before continuing, confirm you are on branch: v2-production-upgrade"
git branch --show-current
echo
echo "Copy the V2 package files into this repository root, then:"
echo "  npm install pg helmet pino @aws-sdk/client-s3 @aws-sdk/s3-request-presigner"
echo "  git add ."
echo '  git commit -m "feat: add General Handyman Production V2 upgrade"'
echo "  git push origin v2-production-upgrade"
