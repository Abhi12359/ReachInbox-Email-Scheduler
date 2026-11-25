
import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

const db = mysql.createPool({
  host: process.env.MYSQL_HOST || "localhost",
  port: Number(process.env.MYSQL_PORT) || 3306,
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "",
  database: process.env.MYSQL_DATABASE || "reachinbox",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

export const testDatabaseConnection = async (): Promise<void> => {
  try {
    const connection = await db.getConnection();

    console.log("MySQL Database Connected Successfully!");

    connection.release();
  } catch (error) {
    console.error("MySQL Connection Failed:", error);
    throw error;
  }
};

export default db;
