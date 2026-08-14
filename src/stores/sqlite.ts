import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export async function querySqlite<T extends Record<string, unknown>>(
  dbPath: string,
  sql: string,
  readonly = true
): Promise<T[]> {
  try {
    return await queryWithSqlite3<T>(dbPath, sql, readonly);
  } catch {
    return queryWithPython<T>(dbPath, sql, readonly);
  }
}

async function queryWithSqlite3<T>(dbPath: string, sql: string, readonly: boolean): Promise<T[]> {
  const isQuery = /^\s*select\b/i.test(sql);
  const args = isQuery ? ["-json"] : [];
  if (readonly) {
    args.push("-readonly");
  }
  args.push(dbPath, sql);
  const { stdout } = await execFileAsync("sqlite3", args, {
    timeout: 15000,
    maxBuffer: 20 * 1024 * 1024
  });
  return isQuery ? parseJsonRows<T>(stdout) : [];
}

async function queryWithPython<T>(dbPath: string, sql: string, readonly: boolean): Promise<T[]> {
  const script = `
import json, sqlite3, sys
db, sql, readonly = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
uri = f"file:{db}?mode={'ro' if readonly else 'rw'}"
con = sqlite3.connect(uri, uri=True, timeout=8)
con.row_factory = sqlite3.Row
con.execute("PRAGMA busy_timeout=8000")
try:
    rows = con.execute(sql).fetchall()
    if not readonly:
        con.commit()
    print(json.dumps([dict(row) for row in rows], default=str))
finally:
    con.close()
`;
  const { stdout } = await execFileAsync("python3", ["-c", script, dbPath, sql, readonly ? "1" : "0"], {
    timeout: 15000,
    maxBuffer: 20 * 1024 * 1024
  });
  return parseJsonRows<T>(stdout);
}

function parseJsonRows<T>(stdout: string): T[] {
  const text = stdout.trim();
  if (!text) {
    return [];
  }
  const parsed = JSON.parse(text) as T | T[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
