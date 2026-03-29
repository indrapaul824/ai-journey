# WhatsApp Notification Service — Setup Guide

This guide walks you through setting up daily AI quiz messages and weekly AI digest notifications via WhatsApp.

## Prerequisites

- A GitHub repository (this repo, pushed to GitHub)
- A Twilio account (free tier works for testing)
- An Anthropic API key (for Claude Haiku quiz generation)
- Your WhatsApp number

## Step 1: Create a Twilio Account

1. Go to [twilio.com/try-twilio](https://www.twilio.com/try-twilio) and sign up
2. Verify your phone number during signup

## Step 2: Activate WhatsApp Sandbox

1. In the Twilio Console, go to **Messaging > Try it out > Send a WhatsApp message**
   - Direct link: [console.twilio.com/us1/develop/sms/try-it-out/whatsapp-learn](https://console.twilio.com/us1/develop/sms/try-it-out/whatsapp-learn)
2. Follow the instructions to send the join code from your WhatsApp to the sandbox number
   - You will send something like `join <two-words>` to the Twilio sandbox number
3. Note down the sandbox number (e.g., `+14155238886`)

**Important**: The WhatsApp sandbox connection expires after 72 hours of inactivity. For production use, apply for a Twilio WhatsApp Business Profile.

## Step 3: Get Your Anthropic API Key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Create an API key
3. Ensure you have credits (Claude Haiku is very cheap — roughly $0.01/day for this use case)

## Step 4: Add GitHub Secrets

Go to your GitHub repo > **Settings** > **Secrets and variables** > **Actions** > **New repository secret**

Add these secrets:

| Secret Name | Value | Example |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | Your Twilio Account SID | `ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| `TWILIO_AUTH_TOKEN` | Your Twilio Auth Token | `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| `TWILIO_WHATSAPP_FROM` | Twilio sandbox number | `+14155238886` |
| `MY_WHATSAPP_NUMBER` | Your WhatsApp number with country code | `+919876543210` |
| `ANTHROPIC_API_KEY` | Your Anthropic API key | `sk-ant-xxxxx` |

## Step 5: Install Dependencies

```bash
cd /path/to/ai-journey
npm install
```

## Step 6: Test Locally

```bash
export TWILIO_ACCOUNT_SID="your_sid"
export TWILIO_AUTH_TOKEN="your_token"
export TWILIO_WHATSAPP_FROM="+14155238886"
export MY_WHATSAPP_NUMBER="+91XXXXXXXXXX"
export ANTHROPIC_API_KEY="sk-ant-xxxxx"

# Test daily quiz
npm run quiz

# Test weekly scan
npm run scan
```

## Step 7: Test via GitHub Actions

1. Go to your repo on GitHub
2. Click **Actions** tab
3. Select **Daily WhatsApp Quiz** from the left sidebar
4. Click **Run workflow** > **Run workflow**
5. Check the run logs and your WhatsApp for the message

## How It Works

### Daily Quiz (Mon-Sat, 8:00 AM IST)

- Picks a random concept from your learning journey
- Uses Claude Haiku to generate a multiple-choice question
- Picks a different concept for an "AI Insight of the Day"
- Sends both via WhatsApp

### Weekly AI Scan (Sunday, 8:30 AM IST)

- Uses Claude to identify the top 3 AI developments from the past week
- Scores each for relevance to your curriculum (1-10)
- Sends a digest via WhatsApp
- Creates GitHub Issues for items scoring 7 or higher (tagged `curriculum-update`)

### Progress Tracking

The quiz message shows your learning streak and concept count. To update these:

1. Open `scripts/progress-export.html` in your browser (from the same origin as your AI Journey app)
2. Click "Download progress.json"
3. Place the file in the repo root
4. Commit and push

Alternatively, manually create `progress.json` in the repo root:

```json
{
  "learnedConcepts": ["Matrix Multiplication", "Gradients", "Backpropagation"],
  "streak": 5,
  "total": 99
}
```

## Costs

- **Twilio**: Free tier includes trial credits (~$15). After that, WhatsApp messages cost ~$0.005 each. Monthly cost: ~$0.15.
- **Anthropic**: Claude Haiku is ~$0.25/M input tokens, $1.25/M output tokens. Daily cost: ~$0.01. Monthly: ~$0.30.
- **GitHub Actions**: Free for public repos. Private repos get 2,000 free minutes/month — this uses ~2 min/day.

**Total estimated cost: under $1/month.**

## Troubleshooting

### "Message could not be sent"
- Re-join the WhatsApp sandbox (the connection expires after 72 hours of inactivity)
- Check that your Twilio Account SID and Auth Token are correct

### "No concepts found"
- Make sure `concepts-merged.json` exists in the repo root

### GitHub Actions not triggering
- Scheduled workflows only run on the default branch (usually `main`)
- GitHub may delay cron jobs by up to 15 minutes
- Use `workflow_dispatch` for manual testing

### Quiz JSON parse error
- This is rare but can happen if the model returns malformed JSON
- The script will log the raw response for debugging
- The workflow will show as failed — it will retry on the next scheduled run
