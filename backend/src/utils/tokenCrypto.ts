
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "crypto";

function getEncryptionKey(): Buffer {
  const secret = process.env.TOKEN_ENCRYPTION_KEY;

  if (!secret || !/^[0-9a-fA-F]{64}$/.test(secret)) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must be a valid 64-character hex key"
    );
  }

  return Buffer.from(secret, "hex");
}

export function encryptToken(token: string): string {
  if (!token) {
    throw new Error("Token is required for encryption");
  }

  const key = getEncryptionKey();
  const iv = randomBytes(12);

  const cipher = createCipheriv(
    "aes-256-gcm",
    key,
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64url"),
    authTag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

export function decryptToken(encryptedToken: string): string {
  if (!encryptedToken) {
    throw new Error("Encrypted token is required");
  }

  const parts = encryptedToken.split(".");

  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Invalid encrypted token format");
  }

  const [, ivPart, authTagPart, dataPart] = parts;

  const key = getEncryptionKey();
  const iv = Buffer.from(ivPart, "base64url");
  const authTag = Buffer.from(authTagPart, "base64url");
  const encrypted = Buffer.from(dataPart, "base64url");

  if (iv.length !== 12 || authTag.length !== 16) {
    throw new Error("Invalid encrypted token data");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    iv
  );

  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}
