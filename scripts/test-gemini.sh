#!/bin/bash
# Quick test of Gemini API with search grounding
# Usage: GOOGLE_AI_API_KEY=your_key bash scripts/test-gemini.sh

if [ -z "$GOOGLE_AI_API_KEY" ]; then
  echo "Set GOOGLE_AI_API_KEY first: export GOOGLE_AI_API_KEY=your_key"
  exit 1
fi

echo "=== Testing model: gemini-2.0-flash ==="
curl -s "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=$GOOGLE_AI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "contents": [{"parts": [{"text": "What are the top 3 AI developments this week (March 22-29, 2026)? Be specific with names and dates. Return as JSON array with title and summary fields."}]}],
    "tools": [{"googleSearch": {}}]
  }' | python3 -m json.tool 2>/dev/null | head -40

echo ""
echo "=== Done ==="
