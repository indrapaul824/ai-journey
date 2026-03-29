/**
 * Weekly AI Scan — sends a WhatsApp digest of AI developments relevant to
 * the learning journey. Optionally creates GitHub Issues for high-relevance items.
 *
 * Uses Claude Code CLI (`claude -p`) for generation, giving Claude full tool access
 * including WebSearch for real-time AI news.
 *
 * Runs via GitHub Actions cron every Sunday at 8:30 AM IST.
 *
 * Required env vars:
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM,
 *   MY_WHATSAPP_NUMBER, ANTHROPIC_API_KEY
 * Optional:
 *   GITHUB_TOKEN — needed to create GitHub Issues for high-relevance items
 *   GITHUB_REPOSITORY — set automatically in GitHub Actions (owner/repo)
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RELEVANCE_THRESHOLD = 7; // create GitHub Issues for items scoring >= this

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
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Claude CLI helper
// ---------------------------------------------------------------------------

function askClaude(prompt, maxTokens = 4096) {
  const escaped = prompt.replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const result = execSync(
    `claude -p "${escaped}" --output-format text --max-turns 10`,
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

function loadProjects() {
  const projectsPath = path.resolve(__dirname, "..", "projects.json");
  if (!fs.existsSync(projectsPath)) {
    console.warn("projects.json not found — scan will proceed without project context.");
    return [];
  }

  try {
    const raw = JSON.parse(fs.readFileSync(projectsPath, "utf-8"));
    const projectMap = raw.projects || raw;
    return Object.entries(projectMap).map(([key, data]) => ({
      key,
      title: data.title || key,
      number: data.projectNumber || 0,
      phase: data.phase || "",
      status: data.status || "not-started",
      description: data.description || "",
    }));
  } catch (err) {
    console.warn(`Failed to parse projects.json: ${err.message}`);
    return [];
  }
}

function loadConcepts() {
  const conceptsPath = path.resolve(__dirname, "..", "concepts-merged.json");
  if (!fs.existsSync(conceptsPath)) return [];

  try {
    const raw = JSON.parse(fs.readFileSync(conceptsPath, "utf-8"));
    const conceptMap = raw.concepts || raw;
    return Object.keys(conceptMap);
  } catch {
    return [];
  }
}

function loadProgress() {
  const progressPath = path.resolve(__dirname, "..", "progress.json");
  if (!fs.existsSync(progressPath)) return { learnedConcepts: [], streak: 0 };

  try {
    const data = JSON.parse(fs.readFileSync(progressPath, "utf-8"));
    return {
      learnedConcepts: data.learnedConcepts || data.learned || [],
      streak: data.streak || 0,
    };
  } catch {
    return { learnedConcepts: [], streak: 0 };
  }
}

// ---------------------------------------------------------------------------
// Claude CLI — AI news scan (with WebSearch)
// ---------------------------------------------------------------------------

function scanAINews(projects, conceptNames) {
  const projectSummaries = projects
    .map((p) => `  Project ${p.number}: ${p.title} (${p.phase}) — ${p.status}`)
    .join("\\n");

  const conceptList = conceptNames.slice(0, 50).join(", "); // limit to avoid token overflow

  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - 7);
  const weekRange = `${weekStart.toISOString().slice(0, 10)} to ${new Date().toISOString().slice(0, 10)}`;

  const prompt = `Search the web for the most important AI developments from this past week (${weekRange}). Look at: arXiv AI papers, Hugging Face trending, major AI company announcements, new model releases.

For each development, evaluate its relevance to an AI learning curriculum that covers these topics: ${conceptList}

The learner's projects:
${projectSummaries}

For each of the top 3 developments:
1. What happened (1-2 sentences)
2. Which project(s) it relates to
3. A relevance score (1-10) based on:
   - Does it change how a concept should be taught? (high impact)
   - Is it a new tool/framework the learner should know about? (medium)
   - Is it just interesting news with no curriculum impact? (low)
4. A recommended action (add to resources, update build guide, note for future, or no action)

Return ONLY valid JSON (no markdown fences, no extra text):
{
  "weekRange": "${weekRange}",
  "developments": [
    {
      "title": "...",
      "summary": "...",
      "relatedProjects": ["Project N: Title"],
      "relevanceScore": 8,
      "action": "...",
      "category": "tool_release | paper | model_release | framework_update | industry_news"
    }
  ],
  "overallAssessment": "One sentence on whether the curriculum needs any changes this week."
}`;

  const raw = askClaude(prompt);
  const jsonStr = raw.replace(/^```json?\n?/, "").replace(/\n?```$/, "");

  try {
    return JSON.parse(jsonStr);
  } catch (err) {
    console.error("Failed to parse AI scan JSON:", raw);
    throw new Error(`AI scan returned invalid JSON: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Scan result validation
// ---------------------------------------------------------------------------

function validateScanResult(scanResult) {
  if (!scanResult || !scanResult.developments || !Array.isArray(scanResult.developments)) {
    console.log("VALIDATION FAILED: No developments array in scan result");
    return false;
  }

  if (scanResult.developments.length === 0) {
    console.log("VALIDATION FAILED: Empty developments array");
    return false;
  }

  // Check if all scores are 0 (no real data)
  const allZero = scanResult.developments.every((d) => d.relevanceScore === 0);
  if (allZero) {
    console.log("VALIDATION FAILED: All developments scored 0 — likely no real data");
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

function formatWeeklyMessage(scanResult, progress, totalConcepts) {
  const colorEmoji = (score) => {
    if (score >= 8) return "\uD83D\uDD35"; // blue — high relevance
    if (score >= 6) return "\uD83D\uDFE1"; // yellow — medium
    return "\uD83D\uDFE2"; // green — low
  };

  const devLines = scanResult.developments.map((d, i) => {
    const projects = d.relatedProjects.join(", ");
    return [
      `${i + 1}. ${colorEmoji(d.relevanceScore)} *${d.title}* \u2014 ${d.summary}`,
      `   Relevant to: ${projects}. Score: ${d.relevanceScore}/10.`,
      `   Action: ${d.action}`,
    ].join("\n");
  });

  const progressStr = progress.learnedConcepts.length > 0
    ? `\uD83D\uDCCA Progress: ${progress.learnedConcepts.length}/${totalConcepts} concepts | Streak: ${progress.streak} days`
    : "";

  const weekLabel = scanResult.weekRange || "this week";

  const parts = [
    `\uD83C\uDF0D *Weekly AI Digest* \u2014 Week of ${weekLabel}`,
    "",
    "*Top developments relevant to your journey:*",
    "",
    ...devLines,
    "",
    `*Assessment*: ${scanResult.overallAssessment}`,
  ];

  if (progressStr) {
    parts.push("", progressStr);
  }

  const highRelevance = scanResult.developments.filter(
    (d) => d.relevanceScore >= RELEVANCE_THRESHOLD
  );
  if (highRelevance.length > 0) {
    parts.push(
      "",
      `\u26A0\uFE0F ${highRelevance.length} item(s) scored \u2265${RELEVANCE_THRESHOLD} \u2014 GitHub Issues will be created.`
    );
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// GitHub Issue creation
// ---------------------------------------------------------------------------

async function createGitHubIssue(development) {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;

  if (!repo || !token) {
    console.warn("GITHUB_REPOSITORY or GITHUB_TOKEN not set — skipping issue creation.");
    return null;
  }

  const title = `[Curriculum Update] ${development.title}`;
  const body = [
    `## AI Development Alert`,
    "",
    `**Category:** ${development.category}`,
    `**Relevance Score:** ${development.relevanceScore}/10`,
    `**Related Projects:** ${development.relatedProjects.join(", ")}`,
    "",
    `### Summary`,
    development.summary,
    "",
    `### Recommended Action`,
    development.action,
    "",
    `---`,
    `_Auto-generated by Weekly AI Scan on ${new Date().toISOString().slice(0, 10)}_`,
  ].join("\n");

  try {
    // Use gh CLI if available (GitHub Actions always has it)
    const result = execSync(
      `gh issue create --repo "${repo}" --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}" --label "curriculum-update"`,
      { encoding: "utf-8", timeout: 30000 }
    ).trim();
    console.log(`GitHub Issue created: ${result}`);
    return result;
  } catch (err) {
    // Fallback: try the GitHub REST API directly
    console.warn(`gh CLI failed (${err.message}), trying REST API...`);
    try {
      const response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title,
          body,
          labels: ["curriculum-update"],
        }),
      });

      if (!response.ok) {
        const errBody = await response.text();
        console.error(`GitHub API error ${response.status}: ${errBody}`);
        return null;
      }

      const issue = await response.json();
      console.log(`GitHub Issue created via API: ${issue.html_url}`);
      return issue.html_url;
    } catch (apiErr) {
      console.error(`GitHub API fallback also failed: ${apiErr.message}`);
      return null;
    }
  }
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
  console.log("=== Weekly AI Scan ===");
  console.log(`Date: ${new Date().toISOString().slice(0, 10)}`);

  validateEnv();

  // Load context
  const projects = loadProjects();
  const conceptNames = loadConcepts();
  const progress = loadProgress();
  console.log(`Loaded ${projects.length} projects, ${conceptNames.length} concepts.`);

  // Scan for AI developments via Claude Code CLI (with WebSearch)
  console.log("Scanning for AI developments via Claude Code CLI (with WebSearch)...");
  const scanResult = scanAINews(projects, conceptNames);
  console.log(`Found ${scanResult.developments.length} developments.`);

  for (const dev of scanResult.developments) {
    console.log(`  [${dev.relevanceScore}/10] ${dev.title}`);
  }

  // Validate scan results before sending
  if (!validateScanResult(scanResult)) {
    console.log("Scan result validation failed — not sending. Saving Twilio credits.");
    return;
  }

  // Format and send WhatsApp digest
  const message = formatWeeklyMessage(scanResult, progress, conceptNames.length);

  // Validate final message content
  if (!validateMessage(message)) {
    console.log("Message validation failed — not sending. Saving Twilio credits.");
    return;
  }

  console.log("\n--- Message Preview ---");
  console.log(message);
  console.log("--- End Preview ---\n");

  await sendWhatsApp(message);

  // Create GitHub Issues for high-relevance items
  const highRelevance = scanResult.developments.filter(
    (d) => d.relevanceScore >= RELEVANCE_THRESHOLD
  );

  if (highRelevance.length > 0) {
    console.log(`\nCreating GitHub Issues for ${highRelevance.length} high-relevance items...`);
    for (const dev of highRelevance) {
      await createGitHubIssue(dev);
    }
  } else {
    console.log("No items scored high enough for GitHub Issues.");
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
