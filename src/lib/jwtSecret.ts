import { createHash } from "crypto";

let cachedSecret: string | null | undefined;
let cachedSource: string | null | undefined;

function deriveFrom(value: string, source: string) {
  const digest = createHash("sha256").update(value).digest("hex");
  console.warn(
    `[auth] Using derived JWT secret from ${source}. Set JWT_SECRET to silence this warning.`
  );
  cachedSecret = digest;
  cachedSource = source;
  return digest;
}

export function resolveJwtSecret(): string | null {
  if (cachedSecret !== undefined) return cachedSecret;

  const explicit = process.env.JWT_SECRET;
  if (explicit && explicit.trim()) {
    cachedSecret = explicit.trim();
    cachedSource = "JWT_SECRET";
    return cachedSecret;
  }

  const fallbackEnv = process.env.JWT_SECRET_FALLBACK;
  if (fallbackEnv && fallbackEnv.trim()) {
    return deriveFrom(fallbackEnv.trim(), "JWT_SECRET_FALLBACK");
  }

  const bootstrap = process.env.ADMIN_BOOTSTRAP_TOKEN;
  if (bootstrap && bootstrap.trim()) {
    return deriveFrom(bootstrap.trim(), "ADMIN_BOOTSTRAP_TOKEN");
  }

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminPassword && adminPassword.trim()) {
    return deriveFrom(adminPassword.trim(), "ADMIN_PASSWORD");
  }

  cachedSecret = null;
  cachedSource = null;
  return null;
}

export function getJwtSecretSource() {
  return cachedSource || null;
}
