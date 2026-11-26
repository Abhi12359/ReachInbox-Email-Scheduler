
import express from "express";
import type { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import "./worker.js";
import mysql from "mysql2/promise";
import {
  randomUUID,
  randomBytes,
  createCipheriv,
} from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { emailQueue } from "./queue.js";

dotenv.config();

// ----------------------------------------------------
// ENVIRONMENT VARIABLES
// ----------------------------------------------------

function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is missing in .env`);
  }

  return value;
}

// ----------------------------------------------------
// EXPRESS CONFIGURATION
// ----------------------------------------------------

const app = express();

app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ----------------------------------------------------
// MYSQL DATABASE
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
// GOOGLE OAUTH
// ----------------------------------------------------

const googleOAuthClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_CALLBACK_URL
);

const gmailOAuthClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_GMAIL_CALLBACK_URL
);

const oauthStates = new Map<string, number>();

interface GmailOAuthState {
  userId: number;
  createdAt: number;
}

const gmailOAuthStates = new Map<string, GmailOAuthState>();

interface AuthRequest extends Request {
  user?: {
    userId: number;
    email: string;
  };
}

interface GoogleUserInfo {
  id: string;
  email?: string;
  verified_email?: boolean;
  name?: string;
}

// ----------------------------------------------------
// ENCRYPTION
// ----------------------------------------------------

function getEncryptionKey(): Buffer {
  const key = Buffer.from(
    requiredEnv("TOKEN_ENCRYPTION_KEY"),
    "base64"
  );

  if (key.length !== 32) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes"
    );
  }

  return key;
}

function encryptRefreshToken(token: string) {
  const iv = randomBytes(12);

  const cipher = createCipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);

  return {
    encryptedToken: encrypted.toString("base64"),
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
  };
}

// ----------------------------------------------------
// SAVE USER GMAIL ACCOUNT
// ----------------------------------------------------

async function saveGmailAccount(
  userId: number,
  googleId: string,
  gmailEmail: string,
  refreshToken?: string
): Promise<void> {
  const [rows]: any = await db.execute(
    `SELECT google_id, gmail_email,
            refresh_token_encrypted, token_iv, token_tag
     FROM user_gmail_accounts
     WHERE user_id = ?
     LIMIT 1`,
    [userId]
  );

  let encryptedToken: string;
  let tokenIv: string;
  let tokenTag: string;

  if (refreshToken) {
    const encrypted = encryptRefreshToken(refreshToken);

    encryptedToken = encrypted.encryptedToken;
    tokenIv = encrypted.iv;
    tokenTag = encrypted.tag;
  } else if (
    rows.length > 0 &&
    rows[0].google_id === googleId &&
    rows[0].gmail_email === gmailEmail
  ) {
    encryptedToken = rows[0].refresh_token_encrypted;
    tokenIv = rows[0].token_iv;
    tokenTag = rows[0].token_tag;
  } else {
    throw new Error(
      "Gmail refresh token missing. Please authorize Gmail access again."
    );
  }

  await db.execute(
    `INSERT INTO user_gmail_accounts
     (user_id, google_id, gmail_email,
      refresh_token_encrypted, token_iv, token_tag)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       google_id = VALUES(google_id),
       gmail_email = VALUES(gmail_email),
       refresh_token_encrypted = VALUES(refresh_token_encrypted),
       token_iv = VALUES(token_iv),
       token_tag = VALUES(token_tag)`,
    [
      userId,
      googleId,
      gmailEmail,
      encryptedToken,
      tokenIv,
      tokenTag,
    ]
  );
}

// ----------------------------------------------------
// JWT
// ----------------------------------------------------

function getJwtSecret(): string {
  return requiredEnv("JWT_SECRET");
}

function createAuthToken(userId: number, email: string): string {
  return jwt.sign(
    { userId, email },
    getJwtSecret(),
    { expiresIn: "7d" }
  );
}

// ----------------------------------------------------
// AUTHENTICATION
// ----------------------------------------------------

function authenticateToken(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const authReq = req as AuthRequest;
  const authHeader = req.headers.authorization;

  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.split(" ")[1]
    : null;

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Authentication token is required",
    });
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret()) as {
      userId: number;
      email: string;
    };

    authReq.user = {
      userId: decoded.userId,
      email: decoded.email,
    };

    next();
  } catch {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
}

// ----------------------------------------------------
// HOME
// ----------------------------------------------------

app.get("/", (_req, res) => {
  res.json({
    success: true,
    message: "ReachInbox Backend is running!",
  });
});

// ----------------------------------------------------
// HEALTH CHECK
// ----------------------------------------------------

app.get("/api/health", async (_req, res) => {
  try {
    await db.query("SELECT 1");
    await emailQueue.waitUntilReady();

    res.json({
      status: "OK",
      message: "Backend, MySQL and Redis connected successfully",
    });
  } catch (error) {
    console.error("Health check error:", error);

    res.status(500).json({
      status: "ERROR",
      message: "Connection check failed",
    });
  }
});

// ----------------------------------------------------
// GOOGLE LOGIN
// ----------------------------------------------------

app.get("/api/auth/google", (_req, res) => {
  try {
    if (
      !process.env.GOOGLE_CLIENT_ID ||
      !process.env.GOOGLE_CLIENT_SECRET ||
      !process.env.GOOGLE_CALLBACK_URL
    ) {
      return res.status(500).json({
        success: false,
        message: "Google OAuth is not configured",
      });
    }

    const state = randomUUID();
    oauthStates.set(state, Date.now());

    for (const [savedState, createdAt] of oauthStates.entries()) {
      if (Date.now() - createdAt > 10 * 60 * 1000) {
        oauthStates.delete(savedState);
      }
    }

    const authorizationUrl =
      googleOAuthClient.generateAuthUrl({
        access_type: "offline",
        prompt: "consent select_account",
        include_granted_scopes: true,
        scope: [
          "openid",
          "email",
          "profile",
          "https://www.googleapis.com/auth/gmail.send",
        ],
        state,
      });

    return res.redirect(authorizationUrl);
  } catch (error) {
    console.error("Google login start error:", error);

    return res.status(500).json({
      success: false,
      message: "Could not start Google login",
    });
  }
});

// ----------------------------------------------------
// GOOGLE LOGIN CALLBACK
// ----------------------------------------------------

app.get("/api/auth/google/callback", async (req, res) => {
  const frontendUrl =
    process.env.FRONTEND_URL || "http://localhost:5173";

  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.redirect(
        `${frontendUrl}/#error=${encodeURIComponent(
          "Google login was cancelled"
        )}`
      );
    }

    if (
      typeof state !== "string" ||
      !oauthStates.has(state)
    ) {
      return res.redirect(
        `${frontendUrl}/#error=${encodeURIComponent(
          "Invalid or expired login session"
        )}`
      );
    }

    const createdAt = oauthStates.get(state)!;
    oauthStates.delete(state);

    if (Date.now() - createdAt > 10 * 60 * 1000) {
      return res.redirect(
        `${frontendUrl}/#error=${encodeURIComponent(
          "Login session expired"
        )}`
      );
    }

    if (typeof code !== "string") {
      return res.redirect(
        `${frontendUrl}/#error=${encodeURIComponent(
          "Authorization code missing"
        )}`
      );
    }

    const { tokens } = await googleOAuthClient.getToken(code);
    googleOAuthClient.setCredentials(tokens);

    const response =
      await googleOAuthClient.request<GoogleUserInfo>({
        url: "https://www.googleapis.com/oauth2/v2/userinfo",
      });

    const googleUser = response.data;

    const googleId = googleUser.id;
    const googleEmail = googleUser.email?.trim().toLowerCase();
    const googleName = googleUser.name?.trim() || "Google User";

    if (
      !googleId ||
      !googleEmail ||
      googleUser.verified_email !== true
    ) {
      return res.redirect(
        `${frontendUrl}/#error=${encodeURIComponent(
          "Google email could not be verified"
        )}`
      );
    }

    const [googleRows]: any = await db.execute(
      `SELECT id, name, email, google_id
       FROM users
       WHERE google_id = ?
       LIMIT 1`,
      [googleId]
    );

    let userId: number;
    let userName: string;
    let userEmail: string;

    if (googleRows.length > 0) {
      const existing = googleRows[0];

      userId = existing.id;
      userName = googleName;
      userEmail = existing.email;

      await db.execute(
        "UPDATE users SET name = ? WHERE id = ?",
        [userName, userId]
      );
    } else {
      const [emailRows]: any = await db.execute(
        `SELECT id, name, email, google_id
         FROM users
         WHERE email = ?
         LIMIT 1`,
        [googleEmail]
      );

      if (emailRows.length > 0) {
        const existing = emailRows[0];

        if (existing.google_id) {
          return res.redirect(
            `${frontendUrl}/#error=${encodeURIComponent(
              "This email is linked to another Google account"
            )}`
          );
        }

        userId = existing.id;
        userName = googleName;
        userEmail = existing.email;

        await db.execute(
          "UPDATE users SET google_id = ?, name = ? WHERE id = ?",
          [googleId, userName, userId]
        );
      } else {
        const [result]: any = await db.execute(
          `INSERT INTO users (google_id, name, email)
           VALUES (?, ?, ?)`,
          [googleId, googleName, googleEmail]
        );

        userId = result.insertId;
        userName = googleName;
        userEmail = googleEmail;
      }
    }

    await saveGmailAccount(
      userId,
      googleId,
      googleEmail,
      tokens.refresh_token || undefined
    );

    const token = createAuthToken(userId, userEmail);

    const user = {
      id: userId,
      name: userName,
      email: userEmail,
    };

    return res.redirect(
      `${frontendUrl}/#token=${encodeURIComponent(token)}` +
      `&user=${encodeURIComponent(JSON.stringify(user))}`
    );
  } catch (error) {
    console.error("Google login callback error:", error);

    return res.redirect(
      `${frontendUrl}/#error=${encodeURIComponent(
        "Google login failed. Please authorize Gmail access again."
      )}`
    );
  }
});

// ----------------------------------------------------
// CONNECT GMAIL - FOR EMAIL/PASSWORD USERS
// ----------------------------------------------------

app.get("/api/gmail/connect-url", authenticateToken, (req, res) => {
  try {
    if (
      !process.env.GOOGLE_CLIENT_ID ||
      !process.env.GOOGLE_CLIENT_SECRET ||
      !process.env.GOOGLE_GMAIL_CALLBACK_URL
    ) {
      return res.status(500).json({
        success: false,
        message: "Gmail OAuth is not configured",
      });
    }

    const authReq = req as AuthRequest;
    const userId = authReq.user!.userId;

    const state = randomUUID();

    gmailOAuthStates.set(state, {
      userId,
      createdAt: Date.now(),
    });

    for (const [savedState, value] of gmailOAuthStates.entries()) {
      if (Date.now() - value.createdAt > 10 * 60 * 1000) {
        gmailOAuthStates.delete(savedState);
      }
    }

    const authorizationUrl =
      gmailOAuthClient.generateAuthUrl({
        access_type: "offline",
        prompt: "consent select_account",
        include_granted_scopes: true,
        scope: [
          "openid",
          "email",
          "profile",
          "https://www.googleapis.com/auth/gmail.send",
        ],
        state,
      });

    return res.json({
      success: true,
      url: authorizationUrl,
    });
  } catch (error) {
    console.error("Gmail connect error:", error);

    return res.status(500).json({
      success: false,
      message: "Could not connect Gmail",
    });
  }
});

// ----------------------------------------------------
// GMAIL CALLBACK
// ----------------------------------------------------

app.get("/api/gmail/callback", async (req, res) => {
  const frontendUrl =
    process.env.FRONTEND_URL || "http://localhost:5173";

  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.redirect(
        `${frontendUrl}/#gmail_error=${encodeURIComponent(
          "Gmail connection cancelled"
        )}`
      );
    }

    if (
      typeof state !== "string" ||
      !gmailOAuthStates.has(state)
    ) {
      return res.redirect(
        `${frontendUrl}/#gmail_error=${encodeURIComponent(
          "Invalid Gmail connection session"
        )}`
      );
    }

    const stateData = gmailOAuthStates.get(state)!;
    gmailOAuthStates.delete(state);

    if (Date.now() - stateData.createdAt > 10 * 60 * 1000) {
      return res.redirect(
        `${frontendUrl}/#gmail_error=${encodeURIComponent(
          "Gmail connection expired"
        )}`
      );
    }

    if (typeof code !== "string") {
      return res.redirect(
        `${frontendUrl}/#gmail_error=${encodeURIComponent(
          "Gmail authorization code missing"
        )}`
      );
    }

    const { tokens } = await gmailOAuthClient.getToken(code);
    gmailOAuthClient.setCredentials(tokens);

    const response =
      await gmailOAuthClient.request<GoogleUserInfo>({
        url: "https://www.googleapis.com/oauth2/v2/userinfo",
      });

    const googleUser = response.data;

    const googleId = googleUser.id;
    const gmailEmail = googleUser.email?.trim().toLowerCase();

    if (
      !googleId ||
      !gmailEmail ||
      googleUser.verified_email !== true
    ) {
      return res.redirect(
        `${frontendUrl}/#gmail_error=${encodeURIComponent(
          "Gmail account verification failed"
        )}`
      );
    }

    await saveGmailAccount(
      stateData.userId,
      googleId,
      gmailEmail,
      tokens.refresh_token || undefined
    );

    return res.redirect(
      `${frontendUrl}/#gmail_connected=${encodeURIComponent(
        gmailEmail
      )}`
    );
  } catch (error) {
    console.error("Gmail callback error:", error);

    return res.redirect(
      `${frontendUrl}/#gmail_error=${encodeURIComponent(
        "Gmail connection failed"
      )}`
    );
  }
});

// ----------------------------------------------------
// GMAIL STATUS
// ----------------------------------------------------

app.get("/api/gmail/status", authenticateToken, async (req, res) => {
  try {
    const authReq = req as AuthRequest;

    const [rows]: any = await db.execute(
      `SELECT gmail_email, created_at
       FROM user_gmail_accounts
       WHERE user_id = ?
       LIMIT 1`,
      [authReq.user!.userId]
    );

    if (!rows.length) {
      return res.json({
        success: true,
        connected: false,
        gmailEmail: null,
      });
    }

    return res.json({
      success: true,
      connected: true,
      gmailEmail: rows[0].gmail_email,
      connectedAt: rows[0].created_at,
    });
  } catch (error) {
    console.error("Gmail status error:", error);

    return res.status(500).json({
      success: false,
      message: "Could not fetch Gmail status",
    });
  }
});

// ----------------------------------------------------
// DISCONNECT GMAIL
// ----------------------------------------------------

app.delete(
  "/api/gmail/disconnect",
  authenticateToken,
  async (req, res) => {
    try {
      const authReq = req as AuthRequest;

      const [result]: any = await db.execute(
        `DELETE FROM user_gmail_accounts
         WHERE user_id = ?`,
        [authReq.user!.userId]
      );

      return res.json({
        success: true,
        disconnected: result.affectedRows > 0,
        message: "Gmail disconnected successfully",
      });
    } catch (error) {
      console.error("Gmail disconnect error:", error);

      return res.status(500).json({
        success: false,
        message: "Could not disconnect Gmail",
      });
    }
  }
);

// ----------------------------------------------------
// REGISTER
// ----------------------------------------------------

app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Name, email and password are required",
      });
    }

    const cleanName = String(name).trim();
    const cleanEmail = String(email).trim().toLowerCase();

    if (
      !cleanName ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)
    ) {
      return res.status(400).json({
        success: false,
        message: "Please enter valid name and email",
      });
    }

    if (String(password).length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must contain at least 8 characters",
      });
    }

    const [existing]: any = await db.execute(
      "SELECT id FROM users WHERE email = ? LIMIT 1",
      [cleanEmail]
    );

    if (existing.length) {
      return res.status(409).json({
        success: false,
        message: "Account already exists",
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const [result]: any = await db.execute(
      `INSERT INTO users (name, email, password_hash)
       VALUES (?, ?, ?)`,
      [cleanName, cleanEmail, passwordHash]
    );

    const token = createAuthToken(result.insertId, cleanEmail);

    return res.status(201).json({
      success: true,
      message: "Registration successful",
      token,
      user: {
        id: result.insertId,
        name: cleanName,
        email: cleanEmail,
      },
    });
  } catch (error) {
    console.error("Register error:", error);

    return res.status(500).json({
      success: false,
      message: "Registration failed",
    });
  }
});

// ----------------------------------------------------
// LOGIN
// ----------------------------------------------------

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    const cleanEmail = String(email).trim().toLowerCase();

    const [rows]: any = await db.execute(
      `SELECT id, name, email, password_hash
       FROM users
       WHERE email = ?
       LIMIT 1`,
      [cleanEmail]
    );

    if (!rows.length || !rows[0].password_hash) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const user = rows[0];

    const matched = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!matched) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const token = createAuthToken(user.id, user.email);

    return res.json({
      success: true,
      message: "Login successful",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
    });
  } catch (error) {
    console.error("Login error:", error);

    return res.status(500).json({
      success: false,
      message: "Login failed",
    });
  }
});

// ----------------------------------------------------
// CURRENT USER
// ----------------------------------------------------

app.get("/api/auth/me", authenticateToken, async (req, res) => {
  try {
    const authReq = req as AuthRequest;

    const [rows]: any = await db.execute(
      "SELECT id, name, email FROM users WHERE id = ? LIMIT 1",
      [authReq.user!.userId]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.json({
      success: true,
      user: rows[0],
    });
  } catch (error) {
    console.error("Profile error:", error);

    return res.status(500).json({
      success: false,
      message: "Could not fetch profile",
    });
  }
});

// ----------------------------------------------------
// SCHEDULED EMAILS
// ----------------------------------------------------

app.get(
  "/api/emails/scheduled",
  authenticateToken,
  async (req, res) => {
    try {
      const authReq = req as AuthRequest;

      const [rows] = await db.execute(
        `SELECT * FROM emails
         WHERE user_id = ? AND status = 'scheduled'
         ORDER BY scheduled_at ASC`,
        [authReq.user!.userId]
      );

      return res.json(rows);
    } catch (error) {
      console.error("Scheduled email error:", error);

      return res.status(500).json({
        message: "Could not fetch scheduled emails",
      });
    }
  }
);

// ----------------------------------------------------
// SENT EMAILS
// ----------------------------------------------------

app.get(
  "/api/emails/sent",
  authenticateToken,
  async (req, res) => {
    try {
      const authReq = req as AuthRequest;

      const [rows] = await db.execute(
        `SELECT * FROM emails
         WHERE user_id = ? AND status = 'sent'
         ORDER BY sent_at DESC`,
        [authReq.user!.userId]
      );

      return res.json(rows);
    } catch (error) {
      console.error("Sent email error:", error);

      return res.status(500).json({
        message: "Could not fetch sent emails",
      });
    }
  }
);

// ----------------------------------------------------
// DELETE SENT EMAIL
// ----------------------------------------------------

app.delete(
  "/api/emails/sent/:id",
  authenticateToken,
  async (req, res) => {
    try {
      const authReq = req as AuthRequest;
      const emailId = Number(req.params.id);

      if (!Number.isInteger(emailId) || emailId <= 0) {
        return res.status(400).json({
          success: false,
          message: "Invalid email ID",
        });
      }

      const [result]: any = await db.execute(
        `DELETE FROM emails
         WHERE id = ? AND user_id = ? AND status = 'sent'`,
        [emailId, authReq.user!.userId]
      );

      if (!result.affectedRows) {
        return res.status(404).json({
          success: false,
          message: "Sent email not found",
        });
      }

      return res.json({
        success: true,
        message: "Sent email deleted",
      });
    } catch (error) {
      console.error("Delete sent email error:", error);

      return res.status(500).json({
        success: false,
        message: "Could not delete email",
      });
    }
  }
);

// ----------------------------------------------------
// DELETE SCHEDULED EMAIL - NEW FIX
// ----------------------------------------------------

app.delete(
  "/api/emails/:id",
  authenticateToken,
  async (req, res) => {
    try {
      const authReq = req as AuthRequest;
      const emailId = Number(req.params.id);
      const userId = authReq.user!.userId;

      if (!Number.isInteger(emailId) || emailId <= 0) {
        return res.status(400).json({
          success: false,
          message: "Invalid email ID",
        });
      }

      // Check that the scheduled email belongs to this user.
      const [rows]: any = await db.execute(
        `SELECT id FROM emails
         WHERE id = ?
           AND user_id = ?
           AND status = 'scheduled'
         LIMIT 1`,
        [emailId, userId]
      );

      if (!rows.length) {
        return res.status(404).json({
          success: false,
          message: "Scheduled email not found",
        });
      }

      // Find the corresponding BullMQ job.
      const job = await emailQueue.getJob(`email-${emailId}`);

      if (job) {
        const state = await job.getState();

        // Do not delete an email while the worker is sending it.
        if (state === "active") {
          return res.status(409).json({
            success: false,
            message: "Email is currently being processed. Please try again.",
          });
        }

        await job.remove();
      }

      // Delete the scheduled email from MySQL.
      const [result]: any = await db.execute(
        `DELETE FROM emails
         WHERE id = ?
           AND user_id = ?
           AND status = 'scheduled'`,
        [emailId, userId]
      );

      if (!result.affectedRows) {
        return res.status(404).json({
          success: false,
          message: "Scheduled email could not be deleted",
        });
      }

      return res.json({
        success: true,
        message: "Scheduled email deleted successfully",
      });
    } catch (error) {
      console.error("Delete scheduled email error:", error);

      return res.status(500).json({
        success: false,
        message: "Could not delete scheduled email",
      });
    }
  }
);

// ----------------------------------------------------
// SCHEDULE SINGLE EMAIL
// ----------------------------------------------------

app.post(
  "/api/emails/schedule",
  authenticateToken,
  async (req, res) => {
    try {
      const authReq = req as AuthRequest;
      const userId = authReq.user!.userId;

      const {
        senderId = null,
        recipientEmail,
        subject,
        body,
        scheduledAt,
      } = req.body;

      if (!recipientEmail || !subject || !body || !scheduledAt) {
        return res.status(400).json({
          success: false,
          message: "recipientEmail, subject, body and scheduledAt are required",
        });
      }

      const scheduleDate = new Date(scheduledAt);

      if (
        Number.isNaN(scheduleDate.getTime()) ||
        scheduleDate.getTime() <= Date.now()
      ) {
        return res.status(400).json({
          success: false,
          message: "scheduledAt must be a valid future date",
        });
      }

      const idempotencyKey = randomUUID();

      const [result]: any = await db.execute(
        `INSERT INTO emails
         (user_id, sender_id, recipient_email, subject, body,
          status, scheduled_at, idempotency_key)
         VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
        [
          userId,
          senderId,
          recipientEmail,
          subject,
          body,
          scheduleDate,
          idempotencyKey,
        ]
      );

      const emailId = result.insertId;

      await emailQueue.add(
        "send-email",
        {
          emailId,
          userId,
        },
        {
          jobId: `email-${emailId}`,
          delay: Math.max(
            0,
            scheduleDate.getTime() - Date.now()
          ),
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 5000,
          },
          removeOnComplete: false,
          removeOnFail: false,
        }
      );

      return res.status(201).json({
        success: true,
        message: "Email scheduled successfully",
        emailId,
        idempotencyKey,
      });
    } catch (error) {
      console.error("Schedule email error:", error);

      return res.status(500).json({
        success: false,
        message: "Could not schedule email",
      });
    }
  }
);

// ----------------------------------------------------
// BULK EMAIL SCHEDULING
// ----------------------------------------------------

app.post(
  "/api/emails/bulk-schedule",
  authenticateToken,
  async (req, res) => {
    let connection: mysql.PoolConnection | undefined;
    let emailIds: number[] = [];

    try {
      const authReq = req as AuthRequest;
      const userId = authReq.user!.userId;

      const {
        senderId = null,
        recipients,
        subject,
        body,
        scheduledAt,
        delaySeconds = 5,
        hourlyLimit = 100,
      } = req.body;

      if (
        !Array.isArray(recipients) ||
        recipients.length === 0 ||
        typeof subject !== "string" ||
        !subject.trim() ||
        typeof body !== "string" ||
        !body.trim() ||
        !scheduledAt
      ) {
        return res.status(400).json({
          success: false,
          message: "Recipients, subject, body and scheduledAt are required",
        });
      }

      if (recipients.length > 500) {
        return res.status(400).json({
          success: false,
          message: "Maximum 500 recipients allowed",
        });
      }

      if (
        !Number.isInteger(delaySeconds) ||
        delaySeconds < 1 ||
        delaySeconds > 3600 ||
        !Number.isInteger(hourlyLimit) ||
        hourlyLimit < 1 ||
        hourlyLimit > 500
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid delaySeconds or hourlyLimit",
        });
      }

      const cleanRecipients = [
        ...new Set(
          recipients
            .map((email: unknown) =>
              typeof email === "string"
                ? email.trim().toLowerCase()
                : ""
            )
            .filter((email: string) =>
              /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
            )
        ),
      ];

      if (!cleanRecipients.length) {
        return res.status(400).json({
          success: false,
          message: "No valid recipients found",
        });
      }

      const scheduleDate = new Date(scheduledAt);

      if (
        Number.isNaN(scheduleDate.getTime()) ||
        scheduleDate.getTime() <= Date.now()
      ) {
        return res.status(400).json({
          success: false,
          message: "scheduledAt must be a valid future date",
        });
      }

      await emailQueue.waitUntilReady();

      connection = await db.getConnection();
      await connection.beginTransaction();

      for (const recipient of cleanRecipients) {
        const idempotencyKey = randomUUID();

        const [result]: any = await connection.execute(
          `INSERT INTO emails
           (user_id, sender_id, recipient_email, subject, body,
            status, scheduled_at, idempotency_key)
           VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
          [
            userId,
            senderId,
            recipient,
            subject.trim(),
            body,
            scheduleDate,
            idempotencyKey,
          ]
        );

        emailIds.push(Number(result.insertId));
      }

      await connection.commit();

      const baseDelay = Math.max(
        0,
        scheduleDate.getTime() - Date.now()
      );

      const jobs = emailIds.map((emailId, index) => ({
        name: "send-email",
        data: { emailId, userId },
        opts: {
          jobId: `email-${emailId}`,
          delay: baseDelay + index * delaySeconds * 1000,
          attempts: 3,
          backoff: {
            type: "exponential" as const,
            delay: 5000,
          },
          removeOnComplete: false,
          removeOnFail: false,
        },
      }));

      try {
        await emailQueue.addBulk(jobs);
      } catch (queueError) {
        console.error("Bulk queue error:", queueError);

        await db.execute(
          `UPDATE emails SET status = 'failed'
           WHERE id IN (${emailIds.map(() => "?").join(",")})
           AND user_id = ? AND status = 'scheduled'`,
          [...emailIds, userId]
        );

        throw queueError;
      }

      return res.status(201).json({
        success: true,
        message: "Bulk emails scheduled successfully",
        totalScheduled: emailIds.length,
        emailIds,
        delaySeconds,
        hourlyLimit,
      });
    } catch (error) {
      if (connection) {
        try {
          await connection.rollback();
        } catch {
          // Transaction may already be committed.
        }
      }

      console.error("Bulk scheduling error:", error);

      return res.status(500).json({
        success: false,
        message: "Could not schedule bulk emails",
      });
    } finally {
      connection?.release();
    }
  }
);

// ----------------------------------------------------
// LOGOUT
// ----------------------------------------------------

app.post("/api/auth/logout", authenticateToken, (_req, res) => {
  res.json({
    success: true,
    message: "Logged out successfully",
  });
});

// ----------------------------------------------------
// START SERVER
// ----------------------------------------------------

const PORT = Number(process.env.PORT || 4000);

async function startServer() {
  try {
    getJwtSecret();
    getEncryptionKey();

    await db.query("SELECT 1");
    console.log("MySQL connected successfully!");

    await emailQueue.waitUntilReady();
    console.log("Redis and BullMQ connected successfully!");

    app.listen(PORT, () => {
      console.log(`Backend running at http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Backend startup failed:", error);
    process.exit(1);
  }
}

startServer();
