/**
 * Daily WhatsApp Quiz — sends Indrashis a quiz question + AI insight each morning.
 *
 * Runs via GitHub Actions cron at 8:00 AM IST (Mon-Sun).
 * On Sundays the weekly-ai-scan.js handles everything, so this script skips Sunday
 * unless you want both (set SEND_ON_SUNDAY=1 to override).
 *
 * Required env vars:
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM,
 *   MY_WHATSAPP_NUMBER, ANTHROPIC_API_KEY
 */

const fs = require("fs");
const path = require("path");

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

function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<code>/gi, "`")
    .replace(/<\/code>/gi, "`")
    .replace(/<strong>/gi, "*")
    .replace(/<\/strong>/gi, "*")
    .replace(/<em>/gi, "_")
    .replace(/<\/em>/gi, "_")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Claude API — quiz generation
// ---------------------------------------------------------------------------

async function generateQuiz(conceptName, conceptSummary) {
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `You are a quiz master for an AI/ML learning journey. Generate a single multiple-choice question about the concept "${conceptName}".

Concept summary: ${conceptSummary}

Rules:
- The question should test genuine understanding, not trivia.
- Exactly 4 answer options numbered 1-4.
- Exactly one correct answer.
- Return ONLY valid JSON with this schema (no markdown fences):
{
  "question": "...",
  "options": ["option 1", "option 2", "option 3", "option 4"],
  "correct": 2,
  "explanation": "Short 1-sentence explanation of why the correct answer is right."
}`;

  const response = await client.messages.create({
    model: "claude-haiku-4-20250414",
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content[0].text.trim();

  // Parse JSON — handle potential markdown fences from the model
  const jsonStr = text.replace(/^```json?\n?/, "").replace(/\n?```$/, "");

  try {
    return JSON.parse(jsonStr);
  } catch (err) {
    console.error("Failed to parse quiz JSON from Claude:", text);
    throw new Error(`Quiz generation returned invalid JSON: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Claude API — AI insight generation
// ---------------------------------------------------------------------------

async function generateInsight(conceptName, conceptContent) {
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Truncate content to avoid token bloat — 1500 chars is plenty for context
  const truncatedContent = stripHtml(conceptContent).slice(0, 1500);

  const prompt = `Extract one surprising, specific, and memorable "Did you know?" fact from this AI/ML concept.
It should be the kind of insight that makes someone stop and think.

Concept: ${conceptName}
Content: ${truncatedContent}

Return ONLY the insight text in 1-2 sentences. No labels, no "Did you know?" prefix — just the fact.`;

  const response = await client.messages.create({
    model: "claude-haiku-4-20250414",
    max_tokens: 200,
    messages: [{ role: "user", content: prompt }],
  });

  return response.content[0].text.trim();
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

  console.log(`Sending WhatsApp message (${body.length} chars)...`);

  const message = await client.messages.create({
    from: fromNumber,
    to: toNumber,
    body,
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

  // Generate quiz and insight in parallel
  console.log("Generating quiz question and insight via Claude Haiku...");
  const [quiz, insight] = await Promise.all([
    generateQuiz(quizConcept.name, quizConcept.summary),
    generateInsight(insightConcept.name, insightConcept.content),
  ]);

  console.log(`Quiz generated: "${quiz.question.slice(0, 60)}..."`);
  console.log(`Insight generated: "${insight.slice(0, 60)}..."`);

  // Format and send
  const message = formatDailyMessage({
    quiz,
    quizConcept: quizConcept.name,
    insight,
    progress,
    totalConcepts: concepts.length,
  });

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
