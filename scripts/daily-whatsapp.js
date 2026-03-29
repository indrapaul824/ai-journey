/**
 * Daily WhatsApp Quiz — sends Indrashis a quiz question + AI insight each morning.
 *
 * Runs via GitHub Actions cron at 8:00 AM IST (Mon-Sun).
 * On Sundays the weekly-ai-scan.js handles everything, so this script skips Sunday
 * unless you want both (set SEND_ON_SUNDAY=1 to override).
 *
 * Uses Claude Code CLI (`claude -p`) for generation, giving Claude full tool access
 * including WebSearch.
 *
 * Required env vars:
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM,
 *   MY_WHATSAPP_NUMBER, ANTHROPIC_API_KEY
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ---------------------------------------------------------------------------
// Config & validation
// ---------------------------------------------------------------------------

const REQUIRED_ENV = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_WHATSAPP_FROM",
  "MY_WHATSAPP_NUMBER",
  "ANTHROPIC_API_KEY",
];

function validateEnv() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(", ")}`);
    console.error("Add them as GitHub Actions secrets or export locally.");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Claude CLI helper
// ---------------------------------------------------------------------------

function askClaude(prompt, maxTokens = 4096) {
  const escaped = prompt.replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const result = execSync(
    `claude -p "${escaped}" --output-format text --max-turns 10 --allowedTools "WebSearch,WebFetch"`,
    {
      encoding: "utf-8",
      timeout: 120000, // 2 min timeout
      env: { ...process.env, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
    }
  );
  return result.trim();
}

// ---------------------------------------------------------------------------
// Content validation
// ---------------------------------------------------------------------------

function validateMessage(message) {
  // Must have actual content (not error messages)
  if (
    message.includes("beyond my knowledge") ||
    message.includes("I cannot") ||
    message.includes("I don't have access")
  ) {
    console.log("VALIDATION FAILED: Claude returned an error/disclaimer instead of content");
    return false;
  }
  // Must be reasonable length (not too short)
  if (message.length < 50) {
    console.log("VALIDATION FAILED: Message too short");
    return false;
  }
  // WhatsApp has a ~1600 char limit per message
  if (message.length > 1600) {
    console.log("WARNING: Message exceeds WhatsApp limit, will be truncated");
    // Don't fail, just warn — truncation happens at send time
  }
  return true;
}

// ---------------------------------------------------------------------------
// Data loaders
// ---------------------------------------------------------------------------

/**
 * Load concept names and summaries from concepts-merged.json.
 * Returns an array of { name, summary, content } objects.
 */
function loadConcepts() {
  const conceptsPath = path.resolve(__dirname, "..", "concepts-merged.json");
  if (!fs.existsSync(conceptsPath)) {
    console.error(`concepts-merged.json not found at ${conceptsPath}`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(conceptsPath, "utf-8"));
  const conceptMap = raw.concepts || raw; // handle both { concepts: {...} } and flat

  return Object.entries(conceptMap).map(([name, data]) => ({
    name,
    summary: data.summary || "",
    content: data.content || "",
  }));
}

/**
 * Load user progress from progress.json (optional).
 * Returns { learnedConcepts: string[], streak: number, total: number }
 */
function loadProgress() {
  const progressPath = path.resolve(__dirname, "..", "progress.json");
  const defaults = { learnedConcepts: [], streak: 0, total: 0 };

  if (!fs.existsSync(progressPath)) {
    console.warn("progress.json not found — using defaults (no filtering by learned concepts).");
    return defaults;
  }

  try {
    const data = JSON.parse(fs.readFileSync(progressPath, "utf-8"));
    return {
      learnedConcepts: data.learnedConcepts || data.learned || [],
      streak: data.streak || 0,
      total: data.total || 0,
    };
  } catch (err) {
    console.warn(`Failed to parse progress.json: ${err.message} — using defaults.`);
    return defaults;
  }
}

// ---------------------------------------------------------------------------
// Random helpers
// ---------------------------------------------------------------------------

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function today() {
  return new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

// ---------------------------------------------------------------------------
// Claude CLI — combined quiz + insight generation
// ---------------------------------------------------------------------------

function generateQuizAndInsight(quizConcept, insightConcept) {
  const prompt = `Search the web for the latest AI news today. Then do two things:

1. Generate a multiple-choice quiz question about the AI/ML concept "${quizConcept.name}".
   Concept summary: ${quizConcept.summary}
   The question should test genuine understanding, not trivia. Exactly 4 options numbered 1-4, exactly one correct.

2. Extract one surprising, specific, and memorable "Did you know?" fact about the concept "${insightConcept.name}".
   It should be the kind of insight that makes someone stop and think.

Return ONLY valid JSON with this schema (no markdown fences, no extra text):
{
  "quiz": {
    "question": "...",
    "options": ["option 1", "option 2", "option 3", "option 4"],
    "correct": 2,
    "explanation": "Short 1-sentence explanation of why the correct answer is right."
  },
  "insight": "The surprising fact in 1-2 sentences. No labels or prefixes."
}`;

  const raw = askClaude(prompt);

  // Parse JSON — handle potential markdown fences from the model
  const jsonStr = raw.replace(/^```json?\n?/, "").replace(/\n?```$/, "");

  try {
    return JSON.parse(jsonStr);
  } catch (err) {
    console.error("Failed to parse quiz+insight JSON from Claude:", raw);
    throw new Error(`Quiz generation returned invalid JSON: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

function formatDailyMessage({ quiz, quizConcept, insight, progress, totalConcepts }) {
  const optionEmojis = ["1\uFE0F\u20E3", "2\uFE0F\u20E3", "3\uFE0F\u20E3", "4\uFE0F\u20E3"];

  const optionsStr = quiz.options
    .map((opt, i) => `${optionEmojis[i]} ${opt}`)
    .join("\n");

  const streakStr = progress.streak > 0 ? `${progress.streak} days` : "Start today!";
  const progressStr = progress.total > 0
    ? `${progress.learnedConcepts.length}/${totalConcepts}`
    : `0/${totalConcepts}`;

  return [
    `\uD83E\uDDE0 *Daily AI Quiz* \u2014 ${today()}`,
    "",
    `Based on: *${quizConcept}*`,
    "",
    quiz.question,
    "",
    optionsStr,
    "",
    "Reply with 1, 2, 3, or 4",
    "",
    "\u2014\u2014\u2014",
    `\uD83D\uDCA1 *AI Insight*: ${insight}`,
    "",
    `\uD83D\uDCCA Your streak: ${streakStr} | Concepts: ${progressStr}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Quiz validation
// ---------------------------------------------------------------------------

function validateQuiz(quiz) {
  if (!quiz || !quiz.question) {
    console.log("VALIDATION FAILED: No question in quiz");
    return false;
  }
  if (!quiz.question.includes("?")) {
    console.log("VALIDATION FAILED: Question missing question mark");
    return false;
  }
  if (!Array.isArray(quiz.options) || quiz.options.length !== 4) {
    console.log("VALIDATION FAILED: Quiz does not have exactly 4 options");
    return false;
  }
  if (typeof quiz.correct !== "number" || quiz.correct < 1 || quiz.correct > 4) {
    console.log("VALIDATION FAILED: Invalid correct answer index");
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Twilio WhatsApp sender
// ---------------------------------------------------------------------------

async function sendWhatsApp(body) {
  const twilio = require("twilio");
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

  const fromNumber = process.env.TWILIO_WHATSAPP_FROM.startsWith("whatsapp:")
    ? process.env.TWILIO_WHATSAPP_FROM
    : `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`;

  const toNumber = process.env.MY_WHATSAPP_NUMBER.startsWith("whatsapp:")
    ? process.env.MY_WHATSAPP_NUMBER
    : `whatsapp:${process.env.MY_WHATSAPP_NUMBER}`;

  // Truncate if over WhatsApp limit
  const truncated = body.length > 1600 ? body.slice(0, 1597) + "..." : body;

  const estCost = "$0.005";
  console.log(`Sending WhatsApp message (${truncated.length} chars, est. cost: ${estCost})...`);

  const message = await client.messages.create({
    from: fromNumber,
    to: toNumber,
    body: truncated,
  });

  console.log(`Message sent. SID: ${message.sid}, Status: ${message.status}`);
  return message;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Daily WhatsApp Quiz ===");
  console.log(`Date: ${today()}`);

  validateEnv();

  // Skip Sundays unless overridden (weekly scan handles Sundays)
  const dayOfWeek = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: "Asia/Kolkata",
  });
  if (dayOfWeek === "Sunday" && !process.env.SEND_ON_SUNDAY) {
    console.log("Sunday — skipping daily quiz (weekly scan runs today). Set SEND_ON_SUNDAY=1 to override.");
    return;
  }

  // Load data
  const concepts = loadConcepts();
  const progress = loadProgress();
  console.log(`Loaded ${concepts.length} concepts, ${progress.learnedConcepts.length} learned.`);

  // Skip if no progress yet
  if (!progress.learnedConcepts || progress.learnedConcepts.length === 0) {
    console.log("No progress yet — skipping daily quiz (learnedConcepts is empty).");
    return;
  }

  // Pick a concept for the quiz — prefer learned concepts, fall back to any
  let quizPool = concepts;
  if (progress.learnedConcepts.length > 0) {
    const learned = concepts.filter((c) =>
      progress.learnedConcepts.includes(c.name)
    );
    if (learned.length > 0) quizPool = learned;
  }
  const quizConcept = pickRandom(quizPool);
  console.log(`Quiz concept: "${quizConcept.name}"`);

  // Pick a different concept for the insight
  const insightPool = concepts.filter((c) => c.name !== quizConcept.name);
  const insightConcept = pickRandom(insightPool);
  console.log(`Insight concept: "${insightConcept.name}"`);

  // Generate quiz and insight in a single Claude CLI call (saves cost, combines into one message)
  console.log("Generating quiz question and insight via Claude Code CLI...");
  const result = generateQuizAndInsight(quizConcept, insightConcept);

  const quiz = result.quiz;
  const insight = result.insight;

  console.log(`Quiz generated: "${quiz.question.slice(0, 60)}..."`);
  console.log(`Insight generated: "${insight.slice(0, 60)}..."`);

  // Validate quiz structure
  if (!validateQuiz(quiz)) {
    console.log("Quiz validation failed — not sending. Saving Twilio credits.");
    return;
  }

  // Format the combined message (quiz + insight in ONE WhatsApp message)
  const message = formatDailyMessage({
    quiz,
    quizConcept: quizConcept.name,
    insight,
    progress,
    totalConcepts: concepts.length,
  });

  // Validate final message content
  if (!validateMessage(message)) {
    console.log("Message validation failed — not sending. Saving Twilio credits.");
    return;
  }

  console.log("\n--- Message Preview ---");
  console.log(message);
  console.log("--- End Preview ---\n");

  await sendWhatsApp(message);
  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
