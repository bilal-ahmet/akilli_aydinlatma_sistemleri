import { defineConfig } from "drizzle-kit";

// .env.local'i drizzle-kit CLI için yükle (Next.js dışında çalışır).
import { config } from "dotenv";
config({ path: ".env.local" });

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
