import { pathToFileURL } from "node:url";

import { ShopifyServiceConfigSchema, loadServiceConfig, resolveShopifyAdminCredentials } from "@local/cli-utils";
import type { ShopifyServiceConfig } from "@local/cli-utils";

const ADMIN_API_VERSION = "2026-04";

const ConfigSchema = ShopifyServiceConfigSchema;
type Config = ShopifyServiceConfig;

function resolveCreds(): { domain: string; token: string } {
  const config = loadServiceConfig("shopify-order-manager", { schema: ConfigSchema }) as Config;
  const credentials = resolveShopifyAdminCredentials(config);
  return { domain: credentials.storeDomain, token: credentials.accessToken };
}


interface GqlResult {
  data?: {
    menus?: {
      nodes?: MenuNode[];
    };
    menu?: MenuNode | null;
    menuUpdate?: {
      userErrors?: Array<{ field: string[] | null; message: string }>;
    };
  };
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  extensions?: { cost?: unknown };
}

async function gql(
  creds: { domain: string; token: string },
  query: string,
  variables?: Record<string, unknown>,
): Promise<GqlResult> {
  const url = `https://${creds.domain}/admin/api/${ADMIN_API_VERSION}/graphql.json`;
  const maxAttempts = 6;
  let attempt = 0;
  let delay = 1500;
  for (;;) {
    attempt += 1;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": creds.token,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query, variables: variables ?? {} }),
    });

    if (response.status === 429 || response.status === 502 || response.status === 503) {
      if (attempt >= maxAttempts) {
        const text = await response.text().catch(() => "");
        throw new Error(`GraphQL ${response.status} after ${attempt} attempts: ${text}`);
      }
      const retryAfter = Number(response.headers.get("Retry-After"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : delay;
      await new Promise((r) => setTimeout(r, waitMs));
      delay = Math.min(delay * 2, 20000);
      continue;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`GraphQL HTTP ${response.status} ${response.statusText}: ${text}`);
    }

    const body = (await response.json()) as GqlResult;

    const throttled = body.errors?.some(
      (e) => (e.extensions?.code ?? "").toString().toUpperCase() === "THROTTLED",
    );
    if (throttled && attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 20000);
      continue;
    }

    return body;
  }
}


interface MenuItemNode {
  id: string;
  title: string;
  type: string;
  url: string | null;
  resourceId: string | null;
  tags: string[];
  items: MenuItemNode[];
}

interface MenuNode {
  id: string;
  handle: string;
  title: string;
  items: MenuItemNode[];
}

interface MenuItemUpdateInput {
  id: string;
  title: string;
  type: string;
  url?: string | null;
  resourceId?: string | null;
  tags?: string[];
  items?: MenuItemUpdateInput[];
}

const MENU_QUERY =   `
  query MenusForCutover($first: Int!) {
    menus(first: $first) {
      nodes {
        id
        handle
        title
        items {
          ...ItemFields
          items {
            ...ItemFields
            items {
              ...ItemFields
              items {
                ...ItemFields
              }
            }
          }
        }
      }
    }
  }
  fragment ItemFields on MenuItem {
    id
    title
    type
    url
    resourceId
    tags
  }
`;

const SINGLE_MENU_QUERY =   `
  query OneMenu($id: ID!) {
    menu(id: $id) {
      id
      handle
      title
      items {
        ...ItemFields
        items {
          ...ItemFields
          items {
            ...ItemFields
            items {
              ...ItemFields
            }
          }
        }
      }
    }
  }
  fragment ItemFields on MenuItem {
    id
    title
    type
    url
    resourceId
    tags
  }
`;

const MENU_UPDATE_MUTATION =   `
  mutation UpdateMenu($id: ID!, $title: String!, $handle: String!, $items: [MenuItemUpdateInput!]!) {
    menuUpdate(id: $id, title: $title, handle: $handle, items: $items) {
      menu {
        id
        handle
        title
      }
      userErrors {
        field
        message
      }
    }
  }
`;


let legacyHosts: string[] = [];
let targetHost = "";

function parseHostname(value: string): string {
  const host = value.trim().toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(host)) {
    throw new Error("Supply plain domain names without schemes, paths, or ports");
  }
  return host;
}

export function configureMigrationHosts(legacy: string, target: string): void {
  const parsedLegacy = legacy.split(",").map(parseHostname);
  const parsedTarget = parseHostname(target);
  if (parsedLegacy.some((host) => parsedTarget === host || parsedTarget.endsWith(`.${host}`))) {
    throw new Error("The target host must be outside the legacy domains");
  }
  legacyHosts = parsedLegacy;
  targetHost = parsedTarget;
}

export function classifyUrl(url: string | null): {
  isOldAbsolute: boolean;
  relativePath: string | null;
  YOUR_COMPANYUrl: string | null;
  host: string | null;
} {
  if (!url) return { isOldAbsolute: false, relativePath: null, YOUR_COMPANYUrl: null, host: null };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { isOldAbsolute: false, relativePath: null, YOUR_COMPANYUrl: null, host: null };
  }
  const host = parsed.hostname;
  const matchesOld = legacyHosts.some((oldHost) => host === oldHost || host.endsWith(`.${oldHost}`));
  if (!matchesOld) {
    return { isOldAbsolute: false, relativePath: null, YOUR_COMPANYUrl: null, host };
  }
  const relativePath = `${parsed.pathname}${parsed.search}${parsed.hash}` || "/";
  const YOUR_COMPANYUrl = `https://${targetHost}${relativePath}`;
  return { isOldAbsolute: true, relativePath, YOUR_COMPANYUrl, host };
}

interface Change {
  itemId: string;
  title: string;
  type: string;
  oldUrl: string;
  newUrl: string;
  via: "relative" | "YOUR_COMPANY";
}

const REWRITABLE_TYPES = new Set(["HTTP"]);

function buildUpdateTree(
  items: MenuItemNode[],
  preferRelative: boolean,
  changes: Change[],
): MenuItemUpdateInput[] {
  return items.map((item) => {
    const cls = classifyUrl(item.url);
    let url = item.url ?? undefined;
    const isRewritable = REWRITABLE_TYPES.has(item.type) && !item.resourceId;
    if (cls.isOldAbsolute && isRewritable) {
      const newUrl = preferRelative ? cls.relativePath! : cls.YOUR_COMPANYUrl!;
      changes.push({
        itemId: item.id,
        title: item.title,
        type: item.type,
        oldUrl: item.url!,
        newUrl,
        via: preferRelative ? "relative" : "YOUR_COMPANY",
      });
      url = newUrl;
    }
    const node: MenuItemUpdateInput = {
      id: item.id,
      title: item.title,
      type: item.type,
      tags: item.tags ?? [],
    };
    if (item.resourceId) node.resourceId = item.resourceId;
    if (url !== undefined && url !== null) node.url = url;
    if (item.items && item.items.length > 0) {
      node.items = buildUpdateTree(item.items, preferRelative, changes);
    }
    return node;
  });
}

function toUpdateInputVerbatim(items: MenuItemNode[]): MenuItemUpdateInput[] {
  return items.map((item) => {
    const node: MenuItemUpdateInput = {
      id: item.id,
      title: item.title,
      type: item.type,
      tags: item.tags ?? [],
    };
    if (item.resourceId) node.resourceId = item.resourceId;
    if (item.url !== undefined && item.url !== null) node.url = item.url;
    if (item.items && item.items.length > 0) {
      node.items = toUpdateInputVerbatim(item.items);
    }
    return node;
  });
}


function countItems(items: MenuItemNode[]): number {
  let n = 0;
  for (const it of items) {
    n += 1;
    if (it.items?.length) n += countItems(it.items);
  }
  return n;
}

function structureSig(items: MenuItemNode[]): string {
  const parts: string[] = [];
  const walk = (list: MenuItemNode[], depth: number) => {
    for (const it of list) {
      parts.push(`${depth}|${it.title}|${it.type}|${it.resourceId ?? ""}`);
      if (it.items?.length) walk(it.items, depth + 1);
    }
  };
  walk(items, 0);
  return parts.join("\n");
}

interface Flag {
  id: string;
  title: string;
  type: string;
  url: string;
  host: string;
  rewritable: boolean;
}

function flagAll(items: MenuItemNode[]): Flag[] {
  const out: Flag[] = [];
  const walk = (list: MenuItemNode[]) => {
    for (const it of list) {
      const cls = classifyUrl(it.url);
      if (cls.isOldAbsolute) {
        const rewritable = REWRITABLE_TYPES.has(it.type) && !it.resourceId;
        out.push({ id: it.id, title: it.title, type: it.type, url: it.url!, host: cls.host!, rewritable });
      }
      if (it.items?.length) walk(it.items);
    }
  };
  walk(items);
  return out;
}


async function fetchAllMenus(creds: { domain: string; token: string }): Promise<MenuNode[]> {
  const res = await gql(creds, MENU_QUERY, { first: 50 });
  if (res.errors?.length) {
    throw new Error(`menus query errors: ${JSON.stringify(res.errors)}`);
  }
  return (res.data?.menus?.nodes ?? []) as MenuNode[];
}

async function fetchOneMenu(creds: { domain: string; token: string }, id: string): Promise<MenuNode | null> {
  const res = await gql(creds, SINGLE_MENU_QUERY, { id });
  if (res.errors?.length) {
    throw new Error(`menu query errors: ${JSON.stringify(res.errors)}`);
  }
  return (res.data?.menu ?? null) as MenuNode | null;
}

interface ApplyResult {
  id: string;
  handle: string;
  title: string;
  changed: Change[];
  preCount: number;
  postCount: number;
  countMatch: boolean;
  structureMatch: boolean;
  noOldRemain: boolean;
  status: "PASS" | "FAIL" | "UNCHANGED" | "SKIPPED";
  note?: string;
  userErrors?: Array<{ field: string[] | null; message: string }>;
  before: MenuNode;
  after?: MenuNode;
}

async function applyMenu(
  creds: { domain: string; token: string },
  menu: MenuNode,
): Promise<ApplyResult> {
  const preCount = countItems(menu.items);
  const preSig = structureSig(menu.items);
  const flagged = flagAll(menu.items);
  const rewritableFlags = flagged.filter((f) => f.rewritable);
  const nonRewritableFlags = flagged.filter((f) => !f.rewritable);
  const nonRewritableNote =
    nonRewritableFlags.length > 0
      ? ` ${nonRewritableFlags.length} resource-backed old-host item(s) left untouched by design: ` +
        nonRewritableFlags.map((f) => `${f.title}[${f.type}]=${f.url}`).join(", ")
      : "";

  if (rewritableFlags.length === 0) {
    return {
      id: menu.id,
      handle: menu.handle,
      title: menu.title,
      changed: [],
      preCount,
      postCount: preCount,
      countMatch: true,
      structureMatch: true,
      noOldRemain: true,
      status: "UNCHANGED",
      note: `No rewritable old-domain absolute URLs (HTTP type) in this menu.${nonRewritableNote}`,
      before: menu,
    };
  }

  const changesRel: Change[] = [];
  const itemsRel = buildUpdateTree(menu.items, true, changesRel);

  let usedVia: "relative" | "YOUR_COMPANY" = "relative";
  let appliedChanges = changesRel;
  let mutation = await gql(creds, MENU_UPDATE_MUTATION, {
    id: menu.id,
    title: menu.title,
    handle: menu.handle,
    items: itemsRel,
  });

  let userErrors = mutation.data?.menuUpdate?.userErrors ?? [];
  const topErrors = mutation.errors ?? [];

  const relRejected =
    (userErrors.length > 0 || topErrors.length > 0) &&
    JSON.stringify([...userErrors, ...topErrors]).toLowerCase().match(/url|link|relative|format|invalid/);

  if (relRejected) {
    const changesAbs: Change[] = [];
    const itemsAbs = buildUpdateTree(menu.items, false, changesAbs);
    const retry = await gql(creds, MENU_UPDATE_MUTATION, {
      id: menu.id,
      title: menu.title,
      handle: menu.handle,
      items: itemsAbs,
    });
    const retryUserErrors = retry.data?.menuUpdate?.userErrors ?? [];
    const retryTopErrors = retry.errors ?? [];
    if (retryUserErrors.length === 0 && retryTopErrors.length === 0) {
      usedVia = "YOUR_COMPANY";
      appliedChanges = changesAbs;
      mutation = retry;
      userErrors = retryUserErrors;
    } else {
      return {
        id: menu.id,
        handle: menu.handle,
        title: menu.title,
        changed: [],
        preCount,
        postCount: preCount,
        countMatch: true,
        structureMatch: true,
        noOldRemain: false,
        status: "SKIPPED",
        note: `Both relative and YOUR_COMPANY forms rejected. relErrors=${JSON.stringify([...userErrors, ...topErrors])} absErrors=${JSON.stringify([...retryUserErrors, ...retryTopErrors])}`,
        userErrors: [...retryUserErrors],
        before: menu,
      };
    }
  } else if (userErrors.length > 0 || topErrors.length > 0) {
    return {
      id: menu.id,
      handle: menu.handle,
      title: menu.title,
      changed: [],
      preCount,
      postCount: preCount,
      countMatch: true,
      structureMatch: true,
      noOldRemain: false,
      status: "SKIPPED",
      note: `menuUpdate rejected (non-url): ${JSON.stringify([...userErrors, ...topErrors])}`,
      userErrors: [...userErrors],
      before: menu,
    };
  }

  const after = await fetchOneMenu(creds, menu.id);
  if (!after) {
    return {
      id: menu.id,
      handle: menu.handle,
      title: menu.title,
      changed: appliedChanges,
      preCount,
      postCount: 0,
      countMatch: false,
      structureMatch: false,
      noOldRemain: false,
      status: "FAIL",
      note: "Re-query returned no menu after update.",
      before: menu,
    };
  }

  const postCount = countItems(after.items);
  const postSig = structureSig(after.items);
  const countMatch = postCount === preCount;
  const structureMatch = postSig === preSig;
  const remaining = flagAll(after.items);
  const remainingRewritable = remaining.filter((f) => f.rewritable);
  const noOldRemain = remainingRewritable.length === 0;

  if (!countMatch || !structureMatch) {
    const restoreChanges: Change[] = [];
    const restoreItems = toUpdateInputVerbatim(menu.items);
    const restore = await gql(creds, MENU_UPDATE_MUTATION, {
      id: menu.id,
      title: menu.title,
      handle: menu.handle,
      items: restoreItems,
    });
    const restoreErrors = [
      ...(restore.data?.menuUpdate?.userErrors ?? []),
      ...(restore.errors ?? []),
    ];
    const afterRestore = await fetchOneMenu(creds, menu.id);
    const restoredCount = afterRestore ? countItems(afterRestore.items) : -1;
    const restoredSig = afterRestore ? structureSig(afterRestore.items) : "";
    const restoredOk =
      restoredCount === preCount && restoredSig === preSig && restoreErrors.length === 0;
    void restoreChanges;
    return {
      id: menu.id,
      handle: menu.handle,
      title: menu.title,
      changed: appliedChanges,
      preCount,
      postCount,
      countMatch,
      structureMatch,
      noOldRemain,
      status: "FAIL",
      note:
        `STRUCTURE BREAK via ${usedVia} (countMatch=${countMatch} structureMatch=${structureMatch}). ` +
        `Auto-restore ${restoredOk ? "SUCCEEDED — menu returned to original state" : "FAILED — MANUAL INTERVENTION NEEDED"}. ` +
        `restoredCount=${restoredCount} restoreErrors=${JSON.stringify(restoreErrors)}`,
      before: menu,
      after: afterRestore ?? after,
    };
  }

  const status: ApplyResult["status"] =
    countMatch && structureMatch && noOldRemain ? "PASS" : "FAIL";

  return {
    id: menu.id,
    handle: menu.handle,
    title: menu.title,
    changed: appliedChanges,
    preCount,
    postCount,
    countMatch,
    structureMatch,
    noOldRemain,
    status,
    note:
      status === "PASS"
        ? `Applied via ${usedVia}.${nonRewritableNote}`
        : `REMAIN CHECK FAILED via ${usedVia}. remainingRewritable=${remainingRewritable.length}`,
    before: menu,
    after,
  };
}


function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args["legacy-hosts"] !== "string" || typeof args["target-host"] !== "string") {
    throw new Error("Supply --legacy-hosts old.example.com,older.example.com --target-host shop.example.com");
  }
  configureMigrationHosts(args["legacy-hosts"], args["target-host"]);
  const creds = resolveCreds();

  if (args.scan) {
    const menus = await fetchAllMenus(creds);
    const report = menus.map((m) => ({
      id: m.id,
      handle: m.handle,
      title: m.title,
      itemCount: countItems(m.items),
      flagged: flagAll(m.items),
      tree: m.items,
    }));
    console.log(JSON.stringify({ mode: "scan", menuCount: menus.length, menus: report }, null, 2));
    return;
  }

  if (args.apply) {
    let targets: MenuNode[];
    if (args.all) {
      targets = await fetchAllMenus(creds);
    } else if (typeof args.id === "string") {
      const one = await fetchOneMenu(creds, args.id);
      if (!one) throw new Error(`Menu not found: ${args.id}`);
      targets = [one];
    } else {
      throw new Error("apply requires --all or --id <gid>");
    }

    const results: ApplyResult[] = [];
    for (const menu of targets) {
      const r = await applyMenu(creds, menu);
      results.push(r);
      await new Promise((res) => setTimeout(res, 800));
    }

    const overall = results.every(
      (r) => r.status === "PASS" || r.status === "UNCHANGED",
    )
      ? "PASS"
      : "FAIL";

    console.log(JSON.stringify({ mode: "apply", overall, results }, null, 2));
    return;
  }

  if (args.verify) {
    if (typeof args.id !== "string") throw new Error("verify requires --id <gid>");
    const menu = await fetchOneMenu(creds, args.id);
    if (!menu) throw new Error(`Menu not found: ${args.id}`);
    console.log(
      JSON.stringify(
        {
          mode: "verify",
          id: menu.id,
          handle: menu.handle,
          title: menu.title,
          itemCount: countItems(menu.items),
          flagged: flagAll(menu.items),
          tree: menu.items,
        },
        null,
        2,
      ),
    );
    return;
  }

  throw new Error("Specify --scan, --apply, or --verify");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(JSON.stringify({ error: true, message: String(err?.message ?? err) }, null, 2));
    process.exit(1);
  });
}
