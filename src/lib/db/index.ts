import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getEnv } from "@/lib/env";
import * as schema from "./schema";

/**
 * Drizzle client — LAZY. Pool ve client ilk kullanımda (request anında)
 * oluşturulur; böylece `next build` import sırasında env/DB'ye dokunmaz.
 * globalThis ile cache'lenir (HMR'da tek pool).
 */
type Db = NodePgDatabase<typeof schema>;

const g = globalThis as unknown as { __fenerPool?: Pool; __fenerDb?: Db };

function getDb(): Db {
  if (g.__fenerDb) return g.__fenerDb;
  const pool =
    g.__fenerPool ?? new Pool({ connectionString: getEnv().DATABASE_URL });
  g.__fenerPool = pool;
  g.__fenerDb = drizzle(pool, { schema });
  return g.__fenerDb;
}

// db.select(...) gibi çağrılar ilk erişimde gerçek client'ı başlatır.
export const db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    const real = getDb();
    const value = Reflect.get(real as object, prop, receiver);
    return typeof value === "function" ? value.bind(real) : value;
  },
});

export { schema };
