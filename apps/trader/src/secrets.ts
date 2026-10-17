import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// A secret in the store is never a plain value. It is a reference:
//   { env: "NAME" }    read from the service's environment (Railway secrets)
//   { vault: "v1:…" }  sealed with TRADER_VAULT_KEY (AES-256-GCM)
// docs/features/multi-user-ibkr.md, "Data model".

export type SecretRef = { env: string } | { vault: string };

export class Vault {
  private readonly key: Buffer;
  constructor(key: string) {
    // 32 random bytes, as base64 or hex.
    const bytes = /^[0-9a-f]{64}$/i.test(key)
      ? Buffer.from(key, "hex")
      : Buffer.from(key, "base64");
    if (bytes.length !== 32)
      throw new Error("TRADER_VAULT_KEY must be 32 bytes, base64 or hex");
    this.key = bytes;
  }

  seal(plain: string): SecretRef {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const sealed = Buffer.concat([iv, cipher.getAuthTag(), data]);
    return { vault: `v1:${sealed.toString("base64")}` };
  }

  open(value: string): string {
    if (!value.startsWith("v1:")) throw new Error("Unknown vault format");
    const sealed = Buffer.from(value.slice(3), "base64");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      sealed.subarray(0, 12),
    );
    decipher.setAuthTag(sealed.subarray(12, 28));
    return Buffer.concat([
      decipher.update(sealed.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  }
}

export interface SecretSource {
  env: Record<string, string | undefined>;
  vault?: Vault;
}

const isRef = (value: unknown): value is SecretRef =>
  !!value &&
  typeof value === "object" &&
  (typeof (value as { env?: unknown }).env === "string" ||
    typeof (value as { vault?: unknown }).vault === "string");

/** The value of a secret reference; throws when it cannot be read. */
export function readSecret(
  value: unknown,
  name: string,
  source: SecretSource,
): string {
  if (!isRef(value)) throw new Error(`${name} is not a secret reference`);
  if ("env" in value) {
    const found = source.env[value.env];
    if (!found) throw new Error(`${name}: ${value.env} is not set`);
    return found;
  }
  if (!source.vault)
    throw new Error(`${name} is sealed, but TRADER_VAULT_KEY is not set`);
  return source.vault.open(value.vault);
}
