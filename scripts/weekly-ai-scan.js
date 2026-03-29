/**
 * Weekly AI Scan — sends a WhatsApp digest of AI developments relevant to
 * the learning journey. Optionally creates GitHub Issues for high-relevance items.
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
// Claude API — AI news scan
// ---------------------------------------------------------------------------

async function scanAINews(projects, conceptNames) {
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const projectSummaries = projects
    .map((p) => `  Project ${p.number}: ${p.title} (${p.phase}) — ${p.status}`)
    .join("\n");

  const conceptList = conceptNames.slice(0, 50).join(", "); // limit to avoid token overflow

  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - 7);
  const weekRange = `${weekStart.toISOString().slice(0, 10)} to ${new Date().toISOString().slice(0, 10)}`;

  const prompt = `You are an AI research analyst tracking developments for a learner building an "AI from semiconductors to agentic architectures" curriculum.

The learner's projects:
${projectSummaries}

Key concepts already covered: ${conceptList}

Date range for this scan: ${weekRange}

Task: Identify the top 3 most significant AI/ML developments from the past week that are relevant to this learning journey. For each development:

1. What happened (1-2 sentences)
2. Which project(s) it relates to
3. A relevance score (1-10) based on these criteria:
   - Does it change how a concept should be taught? (high impact)
   - Is it a new tool/framework the learner should know about? (medium)
   - Is it just interesting news with no curriculum impact? (low)
4. A recommended action (add to resources, update build guide, note for future, or no action)

Return ONLY valid JSON (no markdown fences):
{
  "weekRange": "${weekRange}",
  "developments": [
    {
      "title": "...",
      "summary": "...",
      "relatedProjects": ["Project N: Title"],
      "relevanceScore": 8,
      "action": "...",
      "category": "tool_release" | "paper" | "model_release" | "framework_update" | "industry_news"
    }
  ],
  "overallAssessment": "One sentence on whether the curriculum needs any changes this week."
}`;

  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content[0].text.trim();
  const jsonStr = text.replace(/^```json?\n?/, "").replace(/\n?```$/, "");

  try {
    return JSON.parse(jsonStr);
  } catch (err) {
    console.error("Failed to parse AI scan JSON:", text);
    throw new Error(`AI scan returned invalid JSON: ${err.message}`);
  }
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
  console.log("=== Weekly AI Scan ===");
  console.log(`Date: ${new Date().toISOString().slice(0, 10)}`);

  validateEnv();

  // Load context
  const projects = loadProjects();
  const conceptNames = loadConcepts();
  const progress = loadProgress();
  console.log(`Loaded ${projects.length} projects, ${conceptNames.length} concepts.`);

  // Scan for AI developments
  console.log("Scanning for AI developments via Claude Haiku...");
  const scanResult = await scanAINews(projects, conceptNames);
  console.log(`Found ${scanResult.developments.length} developments.`);

  for (const dev of scanResult.developments) {
    console.log(`  [${dev.relevanceScore}/10] ${dev.title}`);
  }

  // Format and send WhatsApp digest
  const message = formatWeeklyMessage(scanResult, progress, conceptNames.length);

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
