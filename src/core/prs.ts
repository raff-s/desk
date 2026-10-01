import { existsSync } from "node:fs";
import { ghJson } from "./gh.ts";
import { commonDir, listWorktrees, repoRoot } from "./git.ts";
import { listStores, prKey } from "./store.ts";
import { isOpenThread } from "./threads.ts";
import type { PrListItem } from "./types.ts";

const FIELDS = "number,title,author,headRefName,updatedAt";
const LIMIT = 50;

interface RawListedPr {
  number: number;
  title: string;
  author: { login: string };
  headRefName: string;
  updatedAt: string;
}

type Group = PrListItem["group"];

const QUERIES: { group: Group; args: string[] }[] = [
  { group: "review-requested", args: ["--search", "review-requested:@me"] },
  { group: "mine", args: ["--author", "@me"] },
  { group: "other", args: [] },
];

export async function listPrs(repo: string): Promise<PrListItem[]> {
  const root = repoRoot(repo);
  const lists = await Promise.all(
    QUERIES.map(async ({ group, args }) => ({
      group,
      prs: await ghJson<RawListedPr[]>(root, ["pr", "list", "--json", FIELDS, "--limit", String(LIMIT), ...args]),
    })),
  );

  const stores = listStores(commonDir(root));
  const worktrees = listWorktrees(root);
  const seen = new Set<number>();
  const items: PrListItem[] = [];

  for (const { group, prs } of lists) {
    const sorted = [...prs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const pr of sorted) {
      if (seen.has(pr.number)) continue;
      seen.add(pr.number);
      const store = stores.find((s) => s.store.key === prKey(pr.number))?.store;
      const storedTree = store && existsSync(store.worktree) ? store.worktree : null;
      items.push({
        number: pr.number,
        title: pr.title,
        author: pr.author.login,
        headRef: pr.headRefName,
        updatedAt: pr.updatedAt,
        group,
        worktree: storedTree ?? worktrees.find((w) => w.branch === pr.headRefName)?.path ?? null,
        openThreads: store ? store.threads.filter(isOpenThread).length : 0,
      });
    }
  }
  return items.slice(0, LIMIT);
}
