import { fail } from "./errors.ts";
import { commonDir, currentBranch, repoRoot } from "./git.ts";
import { prepare } from "./prepare.ts";
import { listStores, localKey, prKey, readStore, storePathFor } from "./store.ts";
import type { Store } from "./types.ts";

export interface Located {
  storePath: string;
  store: Store;
}

export async function locateReview(repo: string, pr?: number): Promise<Located> {
  const root = repoRoot(repo);
  const common = commonDir(root);

  if (pr !== undefined) {
    const storePath = storePathFor(common, prKey(pr));
    const store = readStore(storePath) ?? fail(`No review for PR #${pr}; run: desk prepare ${pr}`);
    return { storePath, store };
  }

  const here = listStores(common).filter((s) => s.store.worktree === root);
  const branch = currentBranch(root);
  const preferred =
    here.find((s) => s.store.key.startsWith("pr-")) ??
    here.find((s) => branch && s.store.key === localKey(branch)) ??
    here[0];
  if (preferred) return { storePath: preferred.file, store: preferred.store };

  const review = await prepare(root, ".");
  return { storePath: review.storePath, store: readStore(review.storePath) ?? fail("Could not create a local review") };
}
