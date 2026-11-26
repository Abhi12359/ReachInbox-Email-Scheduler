
import dotenv from "dotenv";
dotenv.config();

import { Worker, type Job } from "bullmq";
import mysql from "mysql2/promise";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { createDecipheriv } from "crypto";
import { redisConnection } from "./queue.js";

// ----------------------------------------------------
// ENVIRONMENT VARIABLES
// ----------------------------------------------------

const requiredEnv = (name: string): string => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
};

const REQUIRED_GMAIL_SCOPE =
  "https://www.googleapis.com/auth/gmail.send";

// ----------------------------------------------------
// MYSQL CONNECTION - TiDB TLS ENABLED
// ----------------------------------------------------

const db = mysql.createPool({
  host: requiredEnv("MYSQL_HOST"),
  port: Number(process.env.MYSQL_PORT || 4000),
  user: requiredEnv("MYSQL_USER"),
  password: requiredEnv("MYSQL_PASSWORD"),
  database: requiredEnv("MYSQL_DATABASE"),

  ssl: {
    minVersion: "TLSv1.2",
  },

  waitForConnections: true,
  connectionLimit: 10,
});

// ----------------------------------------------------
// TYPES
// ----------------------------------------------------

type EmailRecord = {
  id: number;
  user_id: number;
  recipient_email: string;
  subject: string;
  body: string;
  status: string;
};

type GmailAccount = {
  google_id: string;
  gmail_email: string;
  refresh_token_encrypted: string;
  token_iv: string;
  token_tag: string;
};

// ----------------------------------------------------
// DECRYPT REFRESH TOKEN
// ----------------------------------------------------

function decryptRefreshToken(
  encryptedToken: string,
  ivHex: string,
  tagHex: string
): string {
  const key = Buffer.from(
    requiredEnv("TOKEN_ENCRYPTION_KEY"),
    "base64"
  );

  if (key.length !== 32) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes"
    );
  }

  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    iv
  );

  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(
      Buffer.from(encryptedToken, "base64")
    ),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

// ----------------------------------------------------
// GOOGLE OAUTH CLIENT AND SCOPE VERIFICATION
// ----------------------------------------------------

async function createAuthorizedGmailClient(
  refreshToken: string
): Promise<OAuth2Client> {
  const oauthClient = new OAuth2Client(
    requiredEnv("GOOGLE_CLIENT_ID"),
    requiredEnv("GOOGLE_CLIENT_SECRET")
  );

  oauthClient.setCredentials({
    refresh_token: refreshToken,
  });

  const { token } = await oauthClient.getAccessToken();

  if (!token) {
    throw new Error(
      "Could not obtain Google access token. Reconnect Gmail."
    );
  }

  const tokenInfo = await oauthClient.getTokenInfo(token);
  const grantedScopes = tokenInfo.scopes || [];

  if (!grantedScopes.includes(REQUIRED_GMAIL_SCOPE)) {
    throw new Error(
      "GMAIL_SCOPE_MISSING: Gmail send permission is missing. Reconnect Gmail with send permission."
    );
  }

  console.log("Gmail send permission verified.");

  return oauthClient;
}

// ----------------------------------------------------
// SEND EMAIL USING CONNECTED GMAIL
// ----------------------------------------------------

async function sendUsingGmail(
  email: EmailRecord
): Promise<void> {
  const [rows] = await db.execute(
    `SELECT
       google_id,
       gmail_email,
       refresh_token_encrypted,
       token_iv,
       token_tag
     FROM user_gmail_accounts
     WHERE user_id = ?
     LIMIT 1`,
    [email.user_id]
  );

  const accounts = rows as GmailAccount[];

  if (accounts.length === 0) {
    throw new Error(
      `Gmail is not connected for user ${email.user_id}.`
    );
  }

  const account = accounts[0];

  const refreshToken = decryptRefreshToken(
    account.refresh_token_encrypted,
    account.token_iv,
    account.token_tag
  );

  const oauthClient =
    await createAuthorizedGmailClient(refreshToken);

  const gmail = google.gmail({
    version: "v1",
    auth: oauthClient,
  });

  const safeTo = String(email.recipient_email).replace(
    /[\r\n]/g,
    ""
  );

  const safeFrom = String(account.gmail_email).replace(
    /[\r\n]/g,
    ""
  );

  const safeSubject = String(email.subject || "").replace(
    /[\r\n]+/g,
    " "
  );

  const encodedSubject =
    `=?UTF-8?B?${Buffer.from(
      safeSubject,
      "utf8"
    ).toString("base64")}?=`;

  const encodedBody = Buffer.from(
    String(email.body || ""),
    "utf8"
  ).toString("base64");

  const mimeMessage = [
    `To: ${safeTo}`,
    `From: ${safeFrom}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodedBody,
  ].join("\r\n");

  const raw = Buffer.from(
    mimeMessage,
    "utf8"
  ).toString("base64url");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw,
    },
  });

  console.log(
    `Email ${email.id} sent from ${account.gmail_email} to ${safeTo}`
  );
}

// ----------------------------------------------------
// PROCESS QUEUE JOB
// ----------------------------------------------------

async function processEmail(job: Job): Promise<void> {
  const emailId = Number(job.data.emailId);

  if (!Number.isInteger(emailId) || emailId <= 0) {
    throw new Error("Invalid emailId in queue job");
  }

  const [rows] = await db.execute(
    `SELECT
       id,
       user_id,
       recipient_email,
       subject,
       body,
       status
     FROM emails
     WHERE id = ?
     LIMIT 1`,
    [emailId]
  );

  const emails = rows as EmailRecord[];

  if (emails.length === 0) {
    throw new Error(`Email ${emailId} not found`);
  }

  const email = emails[0];

  if (email.status !== "scheduled") {
    console.log(
      `Skipping email ${emailId}: status is ${email.status}`
    );
    return;
  }

  if (
    job.data.userId !== undefined &&
    Number(job.data.userId) !== Number(email.user_id)
  ) {
    throw new Error(
      "Queue userId does not match email owner"
    );
  }

  await sendUsingGmail(email);

  const [updateResult]: any = await db.execute(
    `UPDATE emails
     SET status = 'sent',
         sent_at = NOW()
     WHERE id = ?
       AND status = 'scheduled'`,
    [emailId]
  );

  if (updateResult.affectedRows > 0) {
    console.log(
      `Email ${emailId} marked as sent in database`
    );
  }
}

// ----------------------------------------------------
// BULLMQ WORKER
// ----------------------------------------------------

const worker = new Worker(
  "email-queue",
  processEmail,
  {
    connection: redisConnection,
    concurrency: Number(
      process.env.WORKER_CONCURRENCY || 5
    ),
  }
);

// ----------------------------------------------------
// WORKER EVENTS
// ----------------------------------------------------

worker.on("completed", (job) => {
  console.log(`Job ${job.id} completed`);
});

worker.on("failed", async (job, error) => {
  console.error(
    `Job ${job?.id} failed:`,
    error.message
  );

  if (!job) return;

  const attempts = Number(job.opts.attempts || 1);

  if (job.attemptsMade >= attempts) {
    const emailId = Number(job.data.emailId);

    if (Number.isInteger(emailId) && emailId > 0) {
      try {
        await db.execute(
          `UPDATE emails
           SET status = 'failed'
           WHERE id = ?
             AND status = 'scheduled'`,
          [emailId]
        );

        console.log(
          `Email ${emailId} marked as failed`
        );
      } catch (dbError) {
        console.error(
          "Failed to update email status:",
          dbError
        );
      }
    }
  }
});

worker.on("error", (error) => {
  console.error("Worker error:", error);
});

// ----------------------------------------------------
// START WORKER
// ----------------------------------------------------

console.log("ReachInbox Gmail worker started");
