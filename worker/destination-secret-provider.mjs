import { lstat, realpath, readFile, stat } from "node:fs/promises";
import path from "node:path";

const MAX_SECRET_BYTES = 16 * 1024;

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validateSecretRef(secretRef) {
  return typeof secretRef === "string" &&
    secretRef.length >= 1 &&
    secretRef.length <= 128 &&
    /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(secretRef);
}

/**
 * Read a JSON secret from a mounted secret directory.
 * The secret reference is an opaque logical path such as live/youtube/primary.
 * Secret values are returned only to the in-process adapter and are never logged.
 */
export function createDestinationSecretProvider({
  rootDir = process.env.AI_LIVE_SECRET_ROOT,
} = {}) {
  if (typeof rootDir !== "string" || !rootDir.trim()) {
    throw new Error("destination_secret_provider_not_configured");
  }

  return {
    async read(secretRef) {
      if (!validateSecretRef(secretRef)) {
        throw new Error("destination_secret_reference_invalid");
      }

      let root;
      let candidate;
      try {
        root = await realpath(rootDir);
        const unresolved = path.resolve(root, secretRef + ".json");
        if (!isWithin(root, unresolved)) {
          throw new Error("destination_secret_path_invalid");
        }
        const linkInfo = await lstat(unresolved);
        if (linkInfo.isSymbolicLink()) {
          throw new Error("destination_secret_symlink_rejected");
        }
        candidate = await realpath(unresolved);
        if (!isWithin(root, candidate)) {
          throw new Error("destination_secret_path_invalid");
        }
        const info = await stat(candidate);
        if (!info.isFile()) throw new Error("destination_secret_not_regular_file");
        if (info.size < 2 || info.size > MAX_SECRET_BYTES) {
          throw new Error("destination_secret_size_out_of_bounds");
        }
      } catch (error) {
        if (error?.message?.startsWith("destination_secret_")) throw error;
        if (error?.code === "ENOENT") throw new Error("destination_secret_not_found");
        throw new Error("destination_secret_unavailable");
      }

      let parsed;
      try {
        parsed = JSON.parse(await readFile(candidate, "utf8"));
      } catch {
        throw new Error("destination_secret_invalid_json");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("destination_secret_invalid_shape");
      }
      return Object.freeze(parsed);
    },
  };
}
