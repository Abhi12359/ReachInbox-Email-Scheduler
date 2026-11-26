
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import dotenv from "dotenv";

dotenv.config();

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  throw new Error("REDIS_URL is missing in environment variables");
}

export const redisConnection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
});

export const emailQueue = new Queue("email-queue", {
  connection: redisConnection,
});

redisConnection.on("connect", () => {
  console.log("Redis connected successfully");
});

redisConnection.on("error", (error) => {
  console.error("Redis connection error:", error);
});

console.log("Email Queue initialized");
