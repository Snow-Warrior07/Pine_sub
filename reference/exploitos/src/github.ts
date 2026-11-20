// GitHub Issues API integration.
// Posts the Reporter markdown as a live issue on the target repo.
import "dotenv/config";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN!;

export type CreatedIssue = {
  number: number;
  html_url: string;
  title: string;
};

export async function postIssue(opts: {
  owner: string;
  repo: string;
  title: string;
  body: string;
  labels?: string[];
}): Promise<CreatedIssue> {
  const url = `https://api.github.com/repos/${opts.owner}/${opts.repo}/issues`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      "User-Agent": "TriageBot/1.0",
    },
    body: JSON.stringify({
      title: opts.title,
      body: opts.body,
      // labels omitted — requires write access to the label list on public repos
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub Issues API ${res.status}: ${body}`);
  }

  const data: any = await res.json();
  return {
    number: data.number,
    html_url: data.html_url,
    title: data.title,
  };
}

// Parse "owner/repo" or full github URL into { owner, repo }
export function parseGitHubRepo(input: string): { owner: string; repo: string } {
  const match = input
    .replace(/\/$/, "")
    .match(/(?:github\.com\/)?([^/]+)\/([^/]+)/);
  if (!match) throw new Error(`Cannot parse GitHub repo from: ${input}`);
  return { owner: match[1], repo: match[2] };
}
