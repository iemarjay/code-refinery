#!/usr/bin/env bash
# Code Refinery — install Claude Code slash commands into your project
# Usage: curl -fsSL https://raw.githubusercontent.com/iemarjay/code-refinery/main/install-commands.sh | bash

set -euo pipefail

REPO="iemarjay/code-refinery"
BRANCH="main"
BASE_URL="https://raw.githubusercontent.com/${REPO}/${BRANCH}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo "Code Refinery — installing Claude Code slash commands"
echo "─────────────────────────────────────────────────────"
echo ""

# Detect download tool
if command -v curl &>/dev/null; then
  download() { curl -fsSL "$1" -o "$2"; }
elif command -v wget &>/dev/null; then
  download() { wget -qO "$2" "$1"; }
else
  echo "Error: curl or wget is required." >&2
  exit 1
fi

# Create directories
mkdir -p .claude/commands .claude/agents

# Files to install
declare -A FILES=(
  [".claude/commands/review-changes.md"]=".claude/commands/review-changes.md"
  [".claude/commands/review-project.md"]=".claude/commands/review-project.md"
  [".claude/agents/security-reviewer.md"]=".claude/agents/security-reviewer.md"
  [".claude/agents/code-quality-reviewer.md"]=".claude/agents/code-quality-reviewer.md"
)

for dest in "${!FILES[@]}"; do
  src="${FILES[$dest]}"
  download "${BASE_URL}/${src}" "${dest}"
  echo "  ✓ ${dest}"
done

# Update .gitignore if it exists and doesn't already have the entries
if [[ -f .gitignore ]]; then
  if ! grep -q '\.claude/\*' .gitignore; then
    echo "" >> .gitignore
    echo "# Claude Code — ignore local settings, track shared commands" >> .gitignore
    echo ".claude/*" >> .gitignore
    echo "!.claude/commands/" >> .gitignore
    echo "!.claude/agents/" >> .gitignore
    echo "  ✓ .gitignore updated"
  else
    echo "  ✓ .gitignore already configured"
  fi
fi

echo ""
echo -e "${GREEN}Done!${NC} Commands installed into .claude/"
echo ""
echo "Usage:"
echo -e "  ${YELLOW}claude /review-changes${NC}          — review pending branch changes"
echo -e "  ${YELLOW}claude /review-project${NC}           — scan the entire project"
echo -e "  ${YELLOW}claude /review-project src/auth/${NC} — scan a specific subdirectory"
echo ""
echo "Prerequisites: Claude Code CLI (https://docs.anthropic.com/claude-code)"
echo "  npm install -g @anthropic-ai/claude-code"
echo "  claude login"
echo ""
