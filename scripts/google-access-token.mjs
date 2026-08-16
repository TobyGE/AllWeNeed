import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";

const gcloudCandidates = [
  "/usr/local/bin/gcloud",
  "/opt/homebrew/bin/gcloud",
  "/usr/local/share/google-cloud-sdk/bin/gcloud",
  "/opt/homebrew/share/google-cloud-sdk/bin/gcloud",
];

async function firstAccessible(paths) {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // Try the next supported installation location.
    }
  }
  return null;
}

export async function googleAccessToken({ envNames = [] } = {}) {
  for (const envName of envNames) {
    const token = process.env[envName]?.trim();
    if (token) return token;
  }

  const sharedToken = process.env.GOOGLE_ACCESS_TOKEN?.trim();
  if (sharedToken) return sharedToken;

  const gcloud = await firstAccessible(gcloudCandidates);
  if (!gcloud) {
    throw new Error(
      "Google API access requires GOOGLE_ACCESS_TOKEN or Google Cloud CLI.",
    );
  }

  const result = spawnSync(
    gcloud,
    ["auth", "application-default", "print-access-token"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(
      `Unable to obtain a renewable Google access token: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

