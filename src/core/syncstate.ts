import { countCommits, hasObject, headOid, isAncestor, isDirty, shortOid } from "./git.ts";
import type { Store, SyncState } from "./types.ts";

export interface SyncInfo {
  sync: SyncState;
  detail: string;
  canFastForward: boolean;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function inspectSync(worktree: string, prHeadOid: string | null): SyncInfo {
  const dirty = isDirty(worktree);
  if (!prHeadOid) {
    return dirty
      ? { sync: "dirty", detail: "Uncommitted changes", canFastForward: false }
      : { sync: "in-sync", detail: "Local review of the working tree", canFastForward: false };
  }
  if (!hasObject(worktree, prHeadOid)) {
    const missing = `PR head ${shortOid(prHeadOid)} not fetched locally`;
    return { sync: dirty ? "dirty" : "in-sync", detail: dirty ? `Uncommitted changes; ${missing}` : missing, canFastForward: false };
  }

  const head = headOid(worktree);
  if (head === prHeadOid) {
    return dirty
      ? { sync: "dirty", detail: "Uncommitted changes on top of the PR head", canFastForward: false }
      : { sync: "in-sync", detail: `At PR head ${shortOid(head)}`, canFastForward: false };
  }
  if (isAncestor(worktree, head, prHeadOid)) {
    const behind = countCommits(worktree, `${head}..${prHeadOid}`);
    if (dirty) {
      return { sync: "dirty", detail: `Uncommitted changes; PR head is ${plural(behind, "commit")} ahead (not updated)`, canFastForward: false };
    }
    return { sync: "updated", detail: `PR head is ${plural(behind, "commit")} ahead`, canFastForward: true };
  }
  if (isAncestor(worktree, prHeadOid, head)) {
    const ahead = countCommits(worktree, `${prHeadOid}..${head}`);
    return dirty
      ? { sync: "dirty", detail: `Uncommitted changes; ${plural(ahead, "unpushed commit")} on top of the PR head`, canFastForward: false }
      : { sync: "ahead", detail: `${plural(ahead, "unpushed commit")} on top of the PR head`, canFastForward: false };
  }
  const local = countCommits(worktree, `${prHeadOid}..${head}`);
  const remote = countCommits(worktree, `${head}..${prHeadOid}`);
  const note = dirty ? "; uncommitted changes" : "";
  return {
    sync: "diverged",
    detail: `Local (${plural(local, "commit")}) and PR head (${plural(remote, "commit")}) have diverged${note}`,
    canFastForward: false,
  };
}

export function canMakeChanges(store: Store): boolean {
  if (store.mode === "teammate") return false;
  if (!store.pr || !store.worktree) return true;
  return inspectSync(store.worktree, store.pr.headOid).sync !== "diverged";
}
