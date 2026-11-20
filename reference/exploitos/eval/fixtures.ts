// Golden test fixtures for the ZeroDayOS eval pipeline.
// Each fixture is a known-vulnerable code snippet with:
//   - The code to analyse (injected directly — no GitHub fetch in eval mode)
//   - Minimum expected outputs the system must produce to pass
//   - Per-dimension pass criteria used by the scorer

export type EvalFixture = {
  id: string;
  description: string;
  // Simulated recon output fed directly into the Analyst
  snippet: string;
  context: string;
  // Grading expectations — scorer checks these
  expected: {
    cwe_ids: string[];           // at least one must match
    min_cvss: number;            // analyst cvss_score must be >= this
    severity_floor: "High" | "Medium" | "Low" | "Info"; // must be >= this tier
    exploit_reachable: boolean;  // validator must agree
    patch_must_contain: string[]; // remediation patched_code must include all
    issue_must_contain: string[]; // reporter markdown must include all
  };
};

// Severity ordering for floor comparison
export const SEVERITY_ORDER: Record<string, number> = {
  Info: 0, Low: 1, Medium: 2, High: 3, Critical: 4,
};

export const FIXTURES: EvalFixture[] = [
  // ── 1. SQL Injection ─────────────────────────────────────────────────────
  {
    id: "sqli-001",
    description: "Classic SQL injection via string concatenation in a login handler",
    snippet: `// src/routes/login.js
const db = require('./db');

async function login(req, res) {
  const { username, password } = req.body;
  const query = "SELECT * FROM users WHERE username = '" + username +
                "' AND password = '" + password + "'";
  const rows = await db.raw(query);
  if (!rows.length) return res.status(401).send('Invalid credentials');
  req.session.user = rows[0];
  res.json({ ok: true });
}`,
    context: "Node.js Express login route using knex db.raw() against MySQL. Inputs come directly from req.body.",
    expected: {
      cwe_ids: ["CWE-89"],
      min_cvss: 8.0,
      severity_floor: "High",
      exploit_reachable: true,
      patch_must_contain: ["?", "parameterized", "where({"],  // at least one
      issue_must_contain: ["CWE-89", "CVSS", "## Remediation"],
    },
  },

  // ── 2. Hardcoded Secret ──────────────────────────────────────────────────
  {
    id: "hardcoded-secret-002",
    description: "Hardcoded JWT secret and AWS credentials in config file",
    snippet: `// config/secrets.js
module.exports = {
  jwtSecret: "super_secret_key_123",
  awsAccessKey: "AKIAIOSFODNN7EXAMPLE",
  awsSecretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  dbPassword: "prod_password_2024",
};`,
    context: "Node.js config file committed to a public repository. These values are used across the application for authentication and cloud access.",
    expected: {
      cwe_ids: ["CWE-798", "CWE-259"],
      min_cvss: 7.0,
      severity_floor: "High",
      exploit_reachable: true,
      patch_must_contain: ["process.env", "dotenv"],
      issue_must_contain: ["CWE-798", "## Remediation", "environment"],
    },
  },

  // ── 3. Path Traversal ────────────────────────────────────────────────────
  {
    id: "path-traversal-003",
    description: "Path traversal via unsanitized user input in file download endpoint",
    snippet: `// src/routes/files.js
const fs = require('fs');
const path = require('path');

app.get('/download', (req, res) => {
  const filename = req.query.file;
  const filePath = path.join(__dirname, 'uploads', filename);
  res.sendFile(filePath);
});`,
    context: "Express.js file download endpoint. The 'file' query parameter is taken directly from the request with no sanitization.",
    expected: {
      cwe_ids: ["CWE-22"],
      min_cvss: 7.0,
      severity_floor: "High",
      exploit_reachable: true,
      patch_must_contain: ["path.normalize", "path.resolve", "startsWith", "includes('../')"],
      issue_must_contain: ["CWE-22", "traversal", "## Remediation"],
    },
  },

  // ── 4. XSS ───────────────────────────────────────────────────────────────
  {
    id: "xss-004",
    description: "Stored XSS via unescaped user content rendered in a template",
    snippet: `// src/routes/comments.js
app.get('/post/:id', async (req, res) => {
  const post = await db.posts.findOne({ id: req.params.id });
  const comments = await db.comments.find({ postId: req.params.id });
  res.send(\`
    <h1>\${post.title}</h1>
    \${comments.map(c => \`<div class="comment">\${c.body}</div>\`).join('')}
  \`);
});`,
    context: "Express.js route rendering HTML directly from database content. Comment bodies are stored user input with no sanitization on insert or output encoding on render.",
    expected: {
      cwe_ids: ["CWE-79"],
      min_cvss: 6.0,
      severity_floor: "Medium",
      exploit_reachable: true,
      patch_must_contain: ["escapeHtml", "sanitize", "encode", "textContent", "innerText"],
      issue_must_contain: ["CWE-79", "XSS", "## Remediation"],
    },
  },
];
