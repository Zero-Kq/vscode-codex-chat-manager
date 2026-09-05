export type SearchRole = "user" | "assistant";

export interface ParsedSearchQuery {
  terms: string[];
  projects: string[];
  roles: SearchRole[];
  archived?: boolean;
  after?: Date;
  errors: string[];
}

export function parseSearchQuery(input: string): ParsedSearchQuery {
  const parsed: ParsedSearchQuery = {
    terms: [],
    projects: [],
    roles: [],
    errors: []
  };

  for (const token of tokenize(input.trim())) {
    const separator = token.indexOf(":");
    if (separator <= 0) {
      pushUnique(parsed.terms, token);
      continue;
    }

    const field = token.slice(0, separator).toLowerCase();
    const value = token.slice(separator + 1).trim();
    if (!value || !["project", "role", "is", "after"].includes(field)) {
      pushUnique(parsed.terms, token);
      continue;
    }

    if (field === "project") {
      pushUnique(parsed.projects, value);
      continue;
    }

    if (field === "role") {
      const roles = value
        .split(",")
        .map((role) => role.trim().toLowerCase())
        .filter(Boolean);
      for (const role of roles) {
        if (role === "user" || role === "assistant") {
          pushUnique(parsed.roles, role);
        } else {
          parsed.errors.push(`不支持的角色：${role}`);
        }
      }
      continue;
    }

    if (field === "is") {
      const flag = value.toLowerCase();
      if (flag === "archived") {
        parsed.archived = true;
      } else if (flag === "active" || flag === "unarchived") {
        parsed.archived = false;
      } else {
        parsed.errors.push(`不支持的状态：${value}`);
      }
      continue;
    }

    const date = parseLocalDate(value);
    if (date) {
      parsed.after = date;
    } else {
      parsed.errors.push(`日期格式无效：${value}，请使用 YYYY-MM-DD`);
    }
  }

  return parsed;
}

export function matchesSearchMetadata(
  parsed: ParsedSearchQuery,
  item: { archived: boolean; cwd?: string; project?: string; createdAt?: Date; updatedAt?: Date }
): boolean {
  if (parsed.archived !== undefined && item.archived !== parsed.archived) {
    return false;
  }

  if (parsed.projects.length > 0) {
    const haystack = `${item.cwd ?? ""}\n${item.project ?? ""}`.toLowerCase();
    if (!parsed.projects.every((project) => haystack.includes(project.toLowerCase()))) {
      return false;
    }
  }

  if (parsed.after) {
    const timestamp = (item.updatedAt ?? item.createdAt)?.getTime() ?? 0;
    if (timestamp < parsed.after.getTime()) {
      return false;
    }
  }

  return true;
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote = "";

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? "" : char;
      continue;
    }
    if (/\s/.test(char) && !quote) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function parseLocalDate(value: string): Date | undefined {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return undefined;
  }
  return date;
}

function pushUnique<T extends string>(target: T[], value: T): void {
  if (!target.some((item) => item.toLowerCase() === value.toLowerCase())) {
    target.push(value);
  }
}
