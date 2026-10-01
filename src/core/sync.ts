import { emptyAnchor, makeAnchor, reanchor } from "./anchor.ts";
import { fail } from "./errors.ts";
import { ghJson, repoSlug } from "./gh.ts";
import { readStore, updateStore } from "./store.ts";
import type { Anchor, Message, Side, Store, Thread } from "./types.ts";

const QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          isResolved path line startLine diffSide
          comments(first: 50) { nodes { databaseId author { login } body url createdAt } }
        }
      }
    }
  }
}`;

export interface RemoteComment {
  databaseId: number;
  author: { login: string } | null;
  body: string;
  url: string;
  createdAt?: string;
}

export interface RemoteThread {
  isResolved: boolean;
  path: string;
  line: number | null;
  startLine: number | null;
  diffSide: "LEFT" | "RIGHT";
  comments: { nodes: RemoteComment[] };
}

interface GraphqlResponse {
  data: { repository: { pullRequest: { reviewThreads: { nodes: RemoteThread[] } } | null } | null };
}

export async function fetchReviewThreads(cwd: string, number: number): Promise<RemoteThread[]> {
  const [owner, name] = (await repoSlug(cwd)).split("/");
  const res = await ghJson<GraphqlResponse>(cwd, [
    "api", "graphql", "-f", `query=${QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`,
  ]);
  const pull = res.data.repository?.pullRequest ?? fail(`PR #${number} not found on GitHub`);
  return pull.reviewThreads.nodes;
}

function anchorFor(store: Store, path: string, side: Side, start: number, end: number): Anchor {
  try {
    return makeAnchor(store, path, side, start, end);
  } catch {
    return emptyAnchor(store);
  }
}

function toThread(store: Store, remote: RemoteThread): Thread {
  const side: Side = remote.diffSide === "LEFT" ? "old" : "new";
  const end = remote.line!;
  const start = remote.startLine ?? end;
  const first = remote.comments.nodes[0]!;
  const messages: Message[] = remote.comments.nodes.map((c) => ({
    author: "you",
    body: `@${c.author?.login ?? "ghost"}: ${c.body}`,
    at: c.createdAt ?? new Date().toISOString(),
  }));
  const at = new Date().toISOString();
  return {
    id: `t${store.nextThread++}`,
    path: remote.path,
    side,
    startLine: start,
    endLine: end,
    author: "you",
    state: "sent",
    publish: "published",
    messages,
    anchor: anchorFor(store, remote.path, side, start, end),
    commits: [],
    github: { commentId: first.databaseId, url: first.url },
    createdAt: at,
    updatedAt: at,
  };
}

export function importThreads(store: Store, remote: RemoteThread[]): number {
  const linked = new Set(store.threads.flatMap((t) => (t.github ? [t.github.commentId] : [])));
  let imported = 0;
  for (const thread of remote) {
    if (thread.isResolved || thread.line === null || thread.comments.nodes.length === 0) continue;
    if (thread.comments.nodes.some((c) => linked.has(c.databaseId))) continue;
    store.threads.push(toThread(store, thread));
    thread.comments.nodes.forEach((c) => linked.add(c.databaseId));
    imported++;
  }
  return imported;
}

export async function syncReview(storePath: string): Promise<{ imported: number }> {
  const store = readStore(storePath) ?? fail(`No review at ${storePath}`);
  if (!store.pr) fail("Local reviews have no GitHub threads to sync");
  const remote = await fetchReviewThreads(store.worktree, store.pr.number);
  const imported = updateStore(storePath, (s) => {
    const count = importThreads(s, remote);
    reanchor(s);
    return count;
  });
  return { imported };
}
