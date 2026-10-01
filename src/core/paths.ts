import { fileURLToPath } from "node:url";

export const deskRoot = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
export const deskBin = `${deskRoot}/bin/desk.ts`;
export const extensionDir = `${deskRoot}/hunk-extension`;
