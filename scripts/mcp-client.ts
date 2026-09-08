
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { loadServiceConfig, resolveShopifyAdminCredentials, z } from "@local/cli-utils";
import { PluginCache, TTL, createCacheKey } from "@local/plugin-cache";

const MCPConfigSchema = z.object({
  mcpServer: z.object({
    command: z.string().min(1),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()).optional(),
  }),
  storeDomain: z.string().min(1),
});

type MCPConfig = z.infer<typeof MCPConfigSchema>;

export type UpdateProductInput = {
  id: string;
  title?: string;
  descriptionHtml?: string;
  handle?: string;
  vendor?: string;
  productType?: string;
  tags?: string[];
  status?: "ACTIVE" | "DRAFT" | "ARCHIVED";
  seo?: {
    title?: string;
    description?: string;
  };
  metafields?: Array<{
    id?: string;
    namespace?: string;
    key?: string;
    value: string;
    type?: string;
  }>;
  collectionsToJoin?: string[];
  collectionsToLeave?: string[];
  redirectNewHandle?: boolean;
};

export type ReverseFulfillmentDispositionInput = {
  reverseFulfillmentOrderLineItemId: string;
  quantity: number;
  dispositionType: "MISSING" | "NOT_RESTOCKED" | "PROCESSING_REQUIRED" | "RESTOCKED";
  locationId?: string;
};

export type ShopifyFileUploadInput = {
  filePath: string;
  filename?: string;
  mimeType: string;
  contentType: "IMAGE" | "FILE" | "VIDEO" | "MODEL_3D";
  alt?: string;
  duplicateResolutionMode?: "APPEND_UUID" | "RAISE_ERROR" | "REPLACE";
  dryRun?: boolean;
  confirmation?: "UPLOAD_FILE_TO_SHOPIFY";
};

export type InventoryQuantitySetInput = {
  idempotencyKey: string;
  reason: string;
  name: "available" | "on_hand";
  referenceDocumentUri?: string;
  quantities: Array<{
    inventoryItemId: string;
    locationId: string;
    quantity: number;
    changeFromQuantity: number;
  }>;
};

export const INVENTORY_ITEMS_FORK_LIMIT = 100;
export const INVENTORY_LEVELS_FORK_LIMIT = 50;

export type InventoryQuantityEffect = {
  name: "available" | "on_hand";
  before: number;
  after: number;
  delta: number;
};

export type InventoryQuantityPreviewLine = {
  inventoryItemId: string;
  locationId: string;
  observedAt?: unknown;
  requestedName: "available" | "on_hand";
  changeFromQuantity: number;
  targetQuantity: number;
  effects: {
    available: InventoryQuantityEffect;
    on_hand: InventoryQuantityEffect;
  };
};

export type InventoryAdjustmentChange = {
  name?: unknown;
  delta?: unknown;
  quantityAfterChange?: unknown;
  item?: {
    id?: unknown;
    sku?: unknown;
  } | null;
  location?: {
    id?: unknown;
    name?: unknown;
  } | null;
};

export type InventoryAdjustmentGroup = {
  createdAt?: unknown;
  reason?: unknown;
  referenceDocumentUri?: unknown;
  changes?: InventoryAdjustmentChange[];
};

export type InventoryQuantitySetResult = {
  dryRun: boolean;
  idempotencyKey: string;
  previewToken: string;
  preview: {
    quantities: InventoryQuantityPreviewLine[];
  };
  adjustmentGroup?: InventoryAdjustmentGroup;
  verification?: {
    verified: true;
    quantities: InventoryQuantityPreviewLine[];
  };
};

export type ProductSortKey =
  | "CREATED_AT"
  | "ID"
  | "INVENTORY_TOTAL"
  | "PRODUCT_TYPE"
  | "PUBLISHED_AT"
  | "RELEVANCE"
  | "TITLE"
  | "UPDATED_AT"
  | "VENDOR";

export interface ShopifyToolResult {
  id?: unknown;
  status?: unknown;
  handle?: unknown;
  product?: ShopifyToolResult;
  shop?: ShopifyToolResult;
  events?: unknown[];
  pageInfo?: unknown;
  productTitle?: unknown;
  files?: unknown[];
  dryRun?: boolean;
  createdFiles?: Array<{ id?: unknown }>;
  scopeHandles?: unknown[];
  appInstallation?: unknown;
  webPixel?: {
    id?: unknown;
    settings?: unknown;
  };
  themes?: unknown[];
}

export interface ShopifyInventoryItem {
  id?: string | null;
  sku?: string | null;
  tracked?: boolean | null;
  requiresShipping?: boolean | null;
  unitCost?: {
    amount?: string | null;
    currencyCode?: string | null;
  } | null;
  countryCodeOfOrigin?: string | null;
  provinceCodeOfOrigin?: string | null;
  harmonizedSystemCode?: string | null;
  measurement?: {
    weight?: {
      unit?: string | null;
      value?: number | null;
    } | null;
  } | null;
  locationsCount?: { count?: number | null } | null;
}

export interface ShopifyProductInventoryVariant {
  variantId?: string | null;
  variantTitle?: string | null;
  variantSku?: string | null;
  inventoryItem?: ShopifyInventoryItem | null;
}

export interface ShopifyInventoryItemsResult {
  productId?: string | null;
  productTitle?: string | null;
  variantsCount?: number | null;
  variants?: ShopifyProductInventoryVariant[];
}

export interface ShopifyInventoryQuantity {
  name?: string | null;
  quantity?: number | null;
}

export interface ShopifyInventoryLevel {
  id?: string | null;
  location?: {
    id?: string | null;
    name?: string | null;
    isActive?: boolean | null;
  } | null;
  quantities?: ShopifyInventoryQuantity[];
  updatedAt?: string | null;
}

export interface ShopifyInventoryLevelsResult {
  inventoryItemId?: string | null;
  sku?: string | null;
  tracked?: boolean | null;
  levelsCount?: number | null;
  levels?: ShopifyInventoryLevel[];
}

export interface MinimalMcpClient {
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<{
    content: unknown;
    isError?: boolean;
  }>;
  listTools(): Promise<{ tools: unknown[] }>;
  close(): Promise<void>;
}

let productionCache: PluginCache | null = null;

function getProductionCache(): PluginCache {
  productionCache ??= new PluginCache({
    namespace: "shopify-order-manager",
    defaultTTL: TTL.FIVE_MINUTES,
  });
  return productionCache;
}

export type RestFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export function resolveShopifyMcpCommand(
  configuredCommand: string,
  managedOverride = process.env.SHOPIFY_MCP_COMMAND,
): string {
  const override = managedOverride?.trim();
  if (!override) return configuredCommand;
  if (!isAbsolute(override)) {
    throw new Error("SHOPIFY_MCP_COMMAND must be an absolute reviewed runtime path");
  }
  return override;
}

function normalizeProviderPrice(value: unknown): string | null {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) {
    return null;
  }
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

function shopifyResourceIdsEqual(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (left === right) return true;
  const leftTail = left.split("/").pop();
  const rightTail = right.split("/").pop();
  return Boolean(leftTail && rightTail && leftTail === rightTail);
}

function inventoryQuantityValue(
  quantities: ShopifyInventoryQuantity[],
  name: "available" | "on_hand",
  inventoryItemId: string,
  locationId: string,
): number {
  const row = quantities.find((quantity) => quantity?.name === name);
  if (!row || typeof row.quantity !== "number" || !Number.isInteger(row.quantity)) {
    throw new Error(
      `Inventory read did not return an integer ${name} quantity for ${inventoryItemId} at ${locationId}`
    );
  }
  return row.quantity;
}

function inventoryVerificationError(
  expected: InventoryQuantityPreviewLine,
  detail: string,
): Error {
  return new Error(
    `post-write verification failed for ${expected.inventoryItemId} ` +
    `at ${expected.locationId}: ${detail}`
  );
}

function inventoryOutcomeUncertainError(idempotencyKey: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `Shopify inventory mutation outcome is uncertain after dispatch: ${detail}. ` +
    `Reconcile fresh available and on_hand values before deciding what to do. ` +
    `If the requested target is already present, treat the original write as possibly landed and do not send another mutation. ` +
    `If the original changeFromQuantity state is still present and you retry the same logical write, reuse idempotency key ${idempotencyKey}; never create a new key for that retry.`
  );
}

function inventoryPreviewToken(
  input: InventoryQuantitySetInput,
  preview: InventoryQuantityPreviewLine[],
): string {
  const approvedState = {
    version: 1,
    idempotencyKey: input.idempotencyKey,
    reason: input.reason,
    name: input.name,
    referenceDocumentUri: input.referenceDocumentUri ?? null,
    quantities: preview.map((line) => ({
      inventoryItemId: line.inventoryItemId,
      locationId: line.locationId,
      observedAt: line.observedAt ?? null,
      requestedName: line.requestedName,
      changeFromQuantity: line.changeFromQuantity,
      targetQuantity: line.targetQuantity,
      effects: {
        available: line.effects.available,
        on_hand: line.effects.on_hand,
      },
    })),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(approvedState)).digest("hex")}`;
}

export class ShopifyMCPClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private config: MCPConfig;
  private connected: boolean = false;
  private cacheDisabled: boolean = false;
  private injectedClient: MinimalMcpClient | null;
  private injectedRestFetch: RestFetch | null;
  private readonly cache: PluginCache;

  constructor(opts?: {
    client?: MinimalMcpClient;
    config?: MCPConfig;
    restFetch?: RestFetch;
    cacheDir?: string;
  }) {
    this.injectedClient = opts?.client ?? null;
    this.injectedRestFetch = opts?.restFetch ?? null;
    this.cache = opts?.cacheDir
      ? new PluginCache({
          namespace: "shopify-order-manager",
          defaultTTL: TTL.FIVE_MINUTES,
          cacheDir: opts.cacheDir,
        })
      : getProductionCache();

    if (opts?.config) {
      this.config = opts.config;
    } else if (opts?.client) {
      this.config = { mcpServer: { command: "", args: [] }, storeDomain: "" } as MCPConfig;
    } else {
      this.config = loadServiceConfig("shopify-order-manager", {
        schema: MCPConfigSchema,
      });
    }
  }


  async connect(): Promise<void> {
    if (this.connected) return;

    if (this.injectedClient) {
      this.client = this.injectedClient as unknown as Client;
      this.connected = true;
      return;
    }

    const env = {
      ...process.env,
      ...this.config.mcpServer.env,
    };

    this.transport = new StdioClientTransport({
      command: resolveShopifyMcpCommand(this.config.mcpServer.command),
      args: this.config.mcpServer.args,
      env: env as Record<string, string>,
    });

    this.client = new Client(
      { name: "shopify-cli", version: "1.0.0" },
      { capabilities: {} }
    );

    await this.client.connect(this.transport);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }


  disableCache(): void {
    this.cacheDisabled = true;
    this.cache.disable();
  }

  enableCache(): void {
    this.cacheDisabled = false;
    this.cache.enable();
  }

  getCacheStats() {
    return this.cache.getStats();
  }

  clearCache(): number {
    return this.cache.clear();
  }

  invalidateCacheKey(key: string): boolean {
    return this.cache.invalidate(key);
  }

  private invalidateOrderLifecycleCaches(): void {
    this.cache.invalidatePattern(/^order/);
    this.cache.invalidatePattern(/^fulfillment-orders/);
  }


  async listTools(): Promise<any[]> {
    await this.connect();
    const result = await this.client!.listTools();
    return result.tools;
  }

  async callTool(name: string, args: Record<string, any>): Promise<any> {
    await this.connect();

    const result = await this.client!.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text?: string }>;

    if (result.isError) {
      const errorContent = content.find((c) => c.type === "text");
      throw new Error(errorContent?.text || "Tool call failed");
    }

    const textContent = content.find((c) => c.type === "text");
    if (textContent?.text) {
      try {
        return JSON.parse(textContent.text);
      } catch {
        return textContent.text;
      }
    }

    return content;
  }


  async getProducts(options?: {
    searchTitle?: string;
    limit?: number;
    since?: string;
    after?: string;
    status?: "active" | "draft" | "archived";
    sortKey?: ProductSortKey;
    reverse?: boolean;
    bypassCache?: boolean;
  }): Promise<any> {
    const cacheKey = createCacheKey("products", {
      search: options?.searchTitle,
      limit: options?.limit,
      since: options?.since,
      after: options?.after,
      status: options?.status,
      sortKey: options?.sortKey,
      reverse: options?.reverse,
    });

    return this.cache.getOrFetch(
      cacheKey,
      async () => {
        const sinceClause = options?.since ? `updated_at:>=${options.since}` : undefined;
        const statusClause = options?.status ? `status:${options.status}` : undefined;
        const mergedQuery = [sinceClause, statusClause].filter(Boolean).join(" ") || undefined;

        const args: Record<string, any> = {};
        if (options?.searchTitle) args.searchTitle = options.searchTitle;
        if (options?.limit) args.limit = options.limit;
        if (mergedQuery) args.query = mergedQuery;
        if (options?.after) args.after = options.after;
        if (options?.sortKey) args.sortKey = options.sortKey;
        if (options?.reverse !== undefined) args.reverse = options.reverse;
        return this.callTool("get-products", args);
      },
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled || options?.bypassCache === true }
    );
  }

  async getInventoryItems(productId: string): Promise<ShopifyInventoryItemsResult> {
    const cacheKey = createCacheKey("inventory-items", { productId });
    return this.cache.getOrFetch(
      cacheKey,
      () => this.callTool("get-inventory-items", { productId }),
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  async getInventoryLevels(
    inventoryItemId: string,
    options?: { bypassCache?: boolean },
  ): Promise<ShopifyInventoryLevelsResult> {
    const cacheKey = createCacheKey("inventory-levels", { inventoryItemId });
    return this.cache.getOrFetch(
      cacheKey,
      () => this.callTool("get-inventory-levels", { inventoryItemId }),
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled || options?.bypassCache === true }
    );
  }

  private invalidateInventoryCaches(): void {
    this.cache.invalidatePattern(/^inventory-/);
    this.cache.invalidatePattern(/^products/);
    this.cache.invalidatePattern(/^product/);
  }

  private async readInventoryLevelsFresh(
    inventoryItemIds: string[],
  ): Promise<Map<string, ShopifyInventoryLevelsResult>> {
    const results = new Map<string, ShopifyInventoryLevelsResult>();
    for (const inventoryItemId of [...new Set(inventoryItemIds)]) {
      results.set(
        inventoryItemId,
        await this.getInventoryLevels(inventoryItemId, { bypassCache: true }),
      );
    }
    return results;
  }

  private inventoryPreview(
    input: InventoryQuantitySetInput,
    levelsByInventoryItem: Map<string, ShopifyInventoryLevelsResult>,
  ): InventoryQuantityPreviewLine[] {
    return input.quantities.map((requested) => {
      const result = levelsByInventoryItem.get(requested.inventoryItemId);
      const levels = Array.isArray(result?.levels) ? result.levels : [];
      const level = levels.find((candidate) =>
        shopifyResourceIdsEqual(candidate?.location?.id, requested.locationId));
      if (!level) {
        const capWarning = levels.length >= INVENTORY_LEVELS_FORK_LIMIT
          ? ` The fork returned its ${INVENTORY_LEVELS_FORK_LIMIT}-location cap without pageInfo, so the target may be on an unavailable later page.`
          : "";
        throw new Error(
          `Inventory preflight could not find location ${requested.locationId} for item ${requested.inventoryItemId}.${capWarning}`
        );
      }

      const quantities = Array.isArray(level.quantities) ? level.quantities : [];
      const currentAvailable = inventoryQuantityValue(
        quantities,
        "available",
        requested.inventoryItemId,
        requested.locationId,
      );
      const currentOnHand = inventoryQuantityValue(
        quantities,
        "on_hand",
        requested.inventoryItemId,
        requested.locationId,
      );
      const currentRequested = input.name === "available" ? currentAvailable : currentOnHand;
      if (currentRequested !== requested.changeFromQuantity) {
        if (currentRequested === requested.quantity) {
          throw new Error(
            `Inventory preflight found ${requested.inventoryItemId} at ${requested.locationId} already at the requested ` +
            `${input.name} target ${requested.quantity}. A previous ambiguous attempt may have landed. No mutation was ` +
            `dispatched; reconcile both available and on_hand and do not issue another write or a new idempotency key from this stale approval.`
          );
        }
        throw new Error(
          `Inventory preflight compare-and-set mismatch for ${requested.inventoryItemId} at ${requested.locationId}: ` +
          `${input.name} is ${currentRequested}, not changeFromQuantity ${requested.changeFromQuantity}`
        );
      }

      const delta = requested.quantity - currentRequested;
      const availableAfter = input.name === "available"
        ? requested.quantity
        : currentAvailable + delta;
      const onHandAfter = input.name === "on_hand"
        ? requested.quantity
        : currentOnHand + delta;

      return {
        inventoryItemId: result?.inventoryItemId ?? requested.inventoryItemId,
        locationId: level?.location?.id ?? requested.locationId,
        observedAt: level?.updatedAt,
        requestedName: input.name,
        changeFromQuantity: requested.changeFromQuantity,
        targetQuantity: requested.quantity,
        effects: {
          available: {
            name: "available",
            before: currentAvailable,
            after: availableAfter,
            delta,
          },
          on_hand: {
            name: "on_hand",
            before: currentOnHand,
            after: onHandAfter,
            delta,
          },
        },
      };
    });
  }

  private verifyInventoryMutation(
    preview: InventoryQuantityPreviewLine[],
    adjustmentGroup: InventoryAdjustmentGroup | undefined,
    levelsByInventoryItem: Map<string, ShopifyInventoryLevelsResult>,
  ): InventoryQuantityPreviewLine[] {
    const changes = Array.isArray(adjustmentGroup?.changes) ? adjustmentGroup.changes : [];
    for (const expected of preview) {
      const result = levelsByInventoryItem.get(
        [...levelsByInventoryItem.keys()].find((key) =>
          shopifyResourceIdsEqual(key, expected.inventoryItemId)) ?? expected.inventoryItemId
      );
      const levels = Array.isArray(result?.levels) ? result.levels : [];
      const level = levels.find((candidate) =>
        shopifyResourceIdsEqual(candidate?.location?.id, expected.locationId));
      if (!level) {
        throw inventoryVerificationError(expected, "fresh readback omitted the target location");
      }
      const quantities = Array.isArray(level.quantities) ? level.quantities : [];

      for (const name of ["available", "on_hand"] as const) {
        const effect = expected.effects[name];
        const readback = inventoryQuantityValue(
          quantities,
          name,
          expected.inventoryItemId,
          expected.locationId,
        );
        if (readback !== effect.after) {
          throw inventoryVerificationError(
            expected,
            `${name} read back as ${readback}, expected ${effect.after}`,
          );
        }

        if (effect.delta !== 0) {
          const reported = changes.find((change) =>
            change?.name === name &&
            shopifyResourceIdsEqual(change?.item?.id, expected.inventoryItemId) &&
            shopifyResourceIdsEqual(change?.location?.id, expected.locationId));
          if (
            !reported ||
            reported.delta !== effect.delta ||
            (
              reported.quantityAfterChange != null &&
              reported.quantityAfterChange !== effect.after
            )
          ) {
            throw inventoryVerificationError(
              expected,
              `adjustment response did not prove the coupled ${name} delta ${effect.delta}`,
            );
          }
        }
      }
    }
    return preview.map((line) => ({
      ...line,
      effects: {
        available: { ...line.effects.available },
        on_hand: { ...line.effects.on_hand },
      },
    }));
  }

  async setInventoryQuantities(
    input: InventoryQuantitySetInput,
    options?: { dryRun?: boolean; previewToken?: string },
  ): Promise<InventoryQuantitySetResult> {
    this.invalidateInventoryCaches();
    const before = await this.readInventoryLevelsFresh(
      input.quantities.map((quantity) => quantity.inventoryItemId),
    );
    const preview = this.inventoryPreview(input, before);
    const freshPreviewToken = inventoryPreviewToken(input, preview);
    if (options?.dryRun === true) {
      return {
        dryRun: true,
        idempotencyKey: input.idempotencyKey,
        previewToken: freshPreviewToken,
        preview: { quantities: preview },
      };
    }
    if (!options?.previewToken) {
      throw new Error(
        "Inventory mutation requires the --preview-token returned by a fresh --dry-run; no mutation was dispatched"
      );
    }
    if (options.previewToken !== freshPreviewToken) {
      throw new Error(
        "Inventory confirmation preview token no longer matches the fresh coupled quantity state; no mutation was dispatched. " +
        "Run --dry-run again and obtain approval for the new available/on_hand preview."
      );
    }

    try {
      const result = await this.callTool("inventory-set-quantities", input);
      this.invalidateInventoryCaches();
      const after = await this.readInventoryLevelsFresh(
        input.quantities.map((quantity) => quantity.inventoryItemId),
      );
      const verified = this.verifyInventoryMutation(
        preview,
        result?.adjustmentGroup,
        after,
      );
      return {
        dryRun: false,
        idempotencyKey: result?.idempotencyKey ?? input.idempotencyKey,
        previewToken: freshPreviewToken,
        preview: { quantities: preview },
        adjustmentGroup: result?.adjustmentGroup,
        verification: { verified: true, quantities: verified },
      };
    } catch (error) {
      throw inventoryOutcomeUncertainError(input.idempotencyKey, error);
    } finally {
      this.invalidateInventoryCaches();
    }
  }

  async getProductById(productId: string): Promise<any> {
    const cacheKey = createCacheKey("product", { id: productId });

    return this.cache.getOrFetch(
      cacheKey,
      () => this.callTool("get-product-by-id", { productId }),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  async createProduct(product: {
    title: string;
    descriptionHtml?: string;
    vendor?: string;
    productType?: string;
    tags?: string[];
    status?: string;
    price: string;
  }): Promise<any> {
    const { price, ...createInput } = product;
    const result = await this.callTool("create-product", createInput);
    this.cache.invalidatePattern(/^products/);

    const createdProduct = result?.product ?? result;
    const productId = createdProduct?.id;
    if (typeof productId !== "string" || productId.length === 0) {
      throw new Error(
        `Shopify product creation returned no stable product ID, so price ${price} could not be assigned or verified. ` +
        "The create outcome may be ambiguous; do not retry automatically."
      );
    }

    try {
      const createdSnapshot = await this.callTool("get-product-by-id", { productId });
      const createdSnapshotProduct = createdSnapshot?.product ?? createdSnapshot;
      const variants = Array.isArray(createdSnapshotProduct?.variants)
        ? createdSnapshotProduct.variants
        : [];
      if (variants.length !== 1) {
        throw new Error(`expected exactly one default variant, received ${variants.length}`);
      }

      const variantId = variants[0]?.id;
      if (typeof variantId !== "string" || variantId.length === 0) {
        throw new Error("the default variant had no stable ID");
      }

      await this.callTool("manage-product-variants", {
        productId,
        variants: [{ id: variantId, price }],
      });
      this.cache.invalidatePattern(/^products?/);

      const verifiedSnapshot = await this.callTool("get-product-by-id", { productId });
      const verifiedProduct = verifiedSnapshot?.product ?? verifiedSnapshot;
      const verifiedVariants: Array<{ id?: unknown; price?: unknown }> = Array.isArray(verifiedProduct?.variants)
        ? verifiedProduct.variants
        : [];
      const verifiedVariant = verifiedVariants.find((variant) => variant?.id === variantId);
      const verifiedPrice = normalizeProviderPrice(verifiedVariant?.price);
      if (verifiedPrice !== price) {
        throw new Error(`read-back price was ${String(verifiedPrice)}, expected ${price}`);
      }

      return {
        ...result,
        priceAssignment: {
          productId,
          variantId,
          price,
          verified: true,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Shopify product ${productId} was created, but its ${price} price was not verified: ${message}. ` +
        "Do not retry automatically; inspect that exact product and variant first."
      );
    }
  }

  async updateProduct(product: UpdateProductInput): Promise<ShopifyToolResult> {
    const result = await this.callTool("update-product", product);
    this.cache.invalidatePattern(/^products?/);
    return result;
  }

  async getShopInfo(): Promise<ShopifyToolResult> {
    return this.callTool("get-shop-info", {});
  }

  async getProductEvents(
    productId: string,
    options?: { first?: number; after?: string; query?: string }
  ): Promise<ShopifyToolResult> {
    return this.callTool("get-product-events", {
      productId,
      ...(options?.first !== undefined ? { first: options.first } : {}),
      ...(options?.after ? { after: options.after } : {}),
      ...(options?.query ? { query: options.query } : {}),
    });
  }

  async getFiles(options?: {
    first?: number;
    after?: string;
    query?: string;
    reverse?: boolean;
  }): Promise<ShopifyToolResult> {
    return this.callTool("get-files", {
      ...(options?.first !== undefined ? { first: options.first } : {}),
      ...(options?.after ? { after: options.after } : {}),
      ...(options?.query ? { query: options.query } : {}),
      ...(options?.reverse !== undefined ? { reverse: options.reverse } : {}),
    });
  }

  async uploadFile(input: ShopifyFileUploadInput): Promise<ShopifyToolResult> {
    return this.callTool("file-upload", {
      filePath: input.filePath,
      ...(input.filename ? { filename: input.filename } : {}),
      mimeType: input.mimeType,
      contentType: input.contentType,
      ...(input.alt !== undefined ? { alt: input.alt } : {}),
      ...(input.duplicateResolutionMode
        ? { duplicateResolutionMode: input.duplicateResolutionMode }
        : {}),
      dryRun: input.dryRun ?? true,
      ...(input.confirmation ? { confirmation: input.confirmation } : {}),
    });
  }

  async getShopSettings(): Promise<ShopifyToolResult> {
    return this.callTool("get-shop-settings", {});
  }

  async getAppScopes(): Promise<ShopifyToolResult> {
    return this.callTool("get-app-scopes", {});
  }

  async getWebPixel(id?: string): Promise<ShopifyToolResult> {
    return this.callTool("get-web-pixel", id ? { id } : {});
  }

  async getThemes(options?: {
    first?: number;
    after?: string;
    roles?: Array<"MAIN" | "UNPUBLISHED" | "DEMO" | "DEVELOPMENT" | "ARCHIVED" | "LOCKED">;
    names?: string[];
    reverse?: boolean;
  }): Promise<ShopifyToolResult> {
    return this.callTool("get-themes", {
      ...(options?.first !== undefined ? { first: options.first } : {}),
      ...(options?.after ? { after: options.after } : {}),
      ...(options?.roles ? { roles: options.roles } : {}),
      ...(options?.names ? { names: options.names } : {}),
      ...(options?.reverse !== undefined ? { reverse: options.reverse } : {}),
    });
  }


  async getCustomers(options?: {
    searchQuery?: string;
    limit?: number;
    since?: string;
    after?: string;
  }): Promise<any> {
    const cacheKey = createCacheKey("customers", {
      search: options?.searchQuery,
      limit: options?.limit,
      since: options?.since,
      after: options?.after,
    });

    return this.cache.getOrFetch(
      cacheKey,
      async () => {
        const sinceFilter = options?.since ? `updated_at:>=${options.since}` : undefined;
        const mergedSearch = [options?.searchQuery, sinceFilter].filter(Boolean).join(" ") || undefined;
        const args: Record<string, any> = {};
        if (mergedSearch) args.searchQuery = mergedSearch;
        if (options?.limit) args.limit = options.limit;
        if (options?.after) args.after = options.after;
        return this.callTool("get-customers", args);
      },
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  async updateCustomer(customerId: string, updates: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    note?: string;
    tags?: string[];
    taxExempt?: boolean;
  }): Promise<any> {
    const result = await this.callTool("update-customer", { id: customerId, ...updates });
    this.cache.invalidatePattern(/^customer/);
    return result;
  }

  async getCustomerOrders(customerId: string, limit?: number): Promise<any> {
    const cacheKey = createCacheKey("customer_orders", { id: customerId, limit });

    return this.cache.getOrFetch(
      cacheKey,
      async () => {
        const args: Record<string, any> = { customerId };
        if (limit) args.limit = limit;
        return this.callTool("get-customer-orders", args);
      },
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }


  async getOrders(options?: {
    status?: "any" | "open" | "closed" | "cancelled";
    limit?: number;
    sortKey?: string;
    reverse?: boolean;
    after?: string;
    query?: string;
    since?: string;
  }): Promise<any> {
    const sinceClause = options?.since ? `updated_at:>=${options.since}` : undefined;
    const mergedQuery = [options?.query, sinceClause].filter(Boolean).join(" ") || undefined;

    const cacheKey = createCacheKey("orders", {
      status: options?.status,
      limit: options?.limit,
      sortKey: options?.sortKey,
      reverse: options?.reverse,
      after: options?.after,
      query: mergedQuery,
    });

    return this.cache.getOrFetch(
      cacheKey,
      async () => {
        const args: Record<string, any> = {};
        if (options?.status) args.status = options.status;
        if (options?.limit) args.limit = options.limit;
        if (options?.sortKey) args.sortKey = options.sortKey;
        if (options?.reverse !== undefined) args.reverse = options.reverse;
        if (options?.after) args.after = options.after;
        if (mergedQuery) args.query = mergedQuery;
        return this.callTool("get-orders", args);
      },
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  async getAllOrders(options?: {
    status?: "any" | "open" | "closed" | "cancelled";
    sortKey?: string;
    reverse?: boolean;
    query?: string;
    maxPages?: number;
  }): Promise<{ orders: any[]; totalFetched: number; hasMore: boolean }> {
    const allOrders: any[] = [];
    let cursor: string | undefined = undefined;
    let hasNextPage = true;
    let pageCount = 0;
    const maxPages = options?.maxPages ?? 10;

    while (hasNextPage && pageCount < maxPages) {
      const result = await this.getOrders({
        status: options?.status,
        limit: 250,
        sortKey: options?.sortKey ?? "CREATED_AT",
        reverse: options?.reverse ?? true,
        after: cursor,
        query: options?.query,
      });

      if (Array.isArray(result)) {
        allOrders.push(...result);
        hasNextPage = false;
      } else if (result.orders) {
        allOrders.push(...result.orders);
        hasNextPage = result.pageInfo?.hasNextPage ?? false;
        cursor = result.pageInfo?.endCursor;
      } else {
        allOrders.push(result);
        hasNextPage = false;
      }

      pageCount++;
    }

    return {
      orders: allOrders,
      totalFetched: allOrders.length,
      hasMore: hasNextPage,
    };
  }

  async getOrderById(orderId: string): Promise<any> {
    const cacheKey = createCacheKey("order", { id: orderId });

    return this.cache.getOrFetch(
      cacheKey,
      () => this.callTool("get-order-by-id", { orderId }),
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  async updateFulfillmentTracking(
    fulfillmentId: string,
    options: {
      trackingNumber?: string;
      trackingCompany?: string;
      trackingUrl?: string;
      notifyCustomer?: boolean;
      clear?: boolean;
    }
  ): Promise<any> {
    const result = await this.callTool("update-fulfillment-tracking", {
      fulfillmentId,
      ...options,
    });
    this.invalidateOrderLifecycleCaches();
    return result;
  }

  async closeReturn(returnId: string, dryRun: boolean): Promise<any> {
    const result = await this.callTool("close-return", { returnId, dryRun });
    this.invalidateOrderLifecycleCaches();
    return result;
  }

  async createFulfillment(
    orderNumber: string,
    trackingNumber?: string,
    options?: {
      trackingCompany?: string;
      trackingUrl?: string;
      notifyCustomer?: boolean;
      lineItems?: Array<{ lineItemId?: string; sku?: string; quantity: number }>;
    }
  ): Promise<any> {
    const result = await this.callTool("create-fulfillment", {
      orderNumber,
      ...(trackingNumber ? { trackingNumber } : {}),
      ...options,
    });
    this.invalidateOrderLifecycleCaches();
    return result;
  }

  async getFulfillmentOrders(orderIdOrGid: string): Promise<any> {
    const cacheKey = createCacheKey("fulfillment-orders", { id: orderIdOrGid });

    return this.cache.getOrFetch(
      cacheKey,
      () => this.callTool("get-fulfillment-orders", { orderId: orderIdOrGid }),
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  async releaseFulfillmentHold(fulfillmentOrderId: string): Promise<any> {
    const result = await this.callTool("release-fulfillment-hold", {
      fulfillmentOrderId,
    });
    this.invalidateOrderLifecycleCaches();
    return result;
  }

  async createReturn(
    orderNumber: string,
    options?: {
      lineItems?: Array<{ sku: string; quantity: number }>;
      returnReason?: string;
      notifyCustomer?: boolean;
    }
  ): Promise<any> {
    const result = await this.callTool("create-return", {
      orderNumber,
      ...options,
    });
    this.invalidateOrderLifecycleCaches();
    return result;
  }

  async createReverseDelivery(
    returnId: string,
    trackingNumber: string,
    options?: {
      trackingCompany?: string;
      trackingUrl?: string;
      labelUrl?: string;
    }
  ): Promise<any> {
    const result = await this.callTool("create-reverse-delivery", {
      returnId,
      trackingNumber,
      ...options,
    });
    this.invalidateOrderLifecycleCaches();
    return result;
  }

  async updateOrder(orderId: string, updates: {
    tags?: string;
    email?: string;
    note?: string;
    customAttributes?: any;
    metafields?: any;
    shippingAddress?: any;
  }): Promise<any> {
    const result = await this.callTool("update-order", { id: orderId, ...updates });
    this.cache.invalidatePattern(/^order/);
    return result;
  }


  async updateReverseDeliveryShipping(
    reverseDeliveryId: string,
    trackingNumber: string,
    options?: {
      trackingCompany?: string;
      trackingUrl?: string;
      labelUrl?: string;
      notifyCustomer?: boolean;
    }
  ): Promise<any> {
    const result = await this.callTool("update-reverse-delivery-shipping", {
      reverseDeliveryId,
      trackingNumber,
      ...options,
    });
    this.invalidateOrderLifecycleCaches();
    return result;
  }

  async disposeReverseFulfillmentOrder(
    dispositionInputs: ReverseFulfillmentDispositionInput[],
    options?: {
      dryRun?: boolean;
      confirmation?: "DISPOSE_REVERSE_FULFILLMENT_ORDER_ITEMS";
    }
  ): Promise<ShopifyToolResult> {
    const result = await this.callTool("reverse-fulfillment-order-dispose", {
      dispositionInputs,
      dryRun: options?.dryRun ?? true,
      ...(options?.confirmation ? { confirmation: options.confirmation } : {}),
    });
    if (result?.dryRun === false) {
      this.invalidateOrderLifecycleCaches();
    }
    return result;
  }

  getStoreDomain(): string {
    return this.config.storeDomain;
  }


  private static readonly REST_API_VERSION = "2026-04";

  private getAdminCredentials(): { accessToken: string; storeDomain: string } {
    const credentials = resolveShopifyAdminCredentials(this.config);
    return { accessToken: credentials.accessToken, storeDomain: credentials.storeDomain };
  }

  private getAdminAccessToken(): string {
    return this.getAdminCredentials().accessToken;
  }

  private getAdminRestBase(): string {
    const { storeDomain } = this.getAdminCredentials();
    return `https://${storeDomain}/admin/api/${ShopifyMCPClient.REST_API_VERSION}`;
  }

  private async adminRestGet(
    path: string,
    query?: Record<string, string | number | undefined>
  ): Promise<{ body: any; nextPageInfo: string | null }> {
    const token = this.getAdminAccessToken();
    const base = this.getAdminRestBase();
    const queryParams = new URLSearchParams();
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === "") continue;
        queryParams.set(key, String(value));
      }
    }
    const qs = queryParams.toString();
    const url = `${base}/${path}${qs ? `?${qs}` : ""}`;

    const fetchImpl: RestFetch = this.injectedRestFetch ?? (fetch as unknown as RestFetch);
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": token,
        "Accept": "application/json",
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Shopify Admin REST ${path} failed: ${response.status} ${response.statusText} ${text}`.trim());
    }

    const body = await response.json();
    const linkHeader = response.headers.get("Link") ?? response.headers.get("link");
    const nextPageInfo = extractNextPageInfo(linkHeader);
    return { body, nextPageInfo };
  }

  private async adminRestPut(
    path: string,
    payload: unknown
  ): Promise<{ body: any }> {
    const token = this.getAdminAccessToken();
    const base = this.getAdminRestBase();
    const url = `${base}/${path}`;

    const fetchImpl: RestFetch = this.injectedRestFetch ?? (fetch as unknown as RestFetch);
    const response = await fetchImpl(url, {
      method: "PUT",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Shopify Admin REST PUT ${path} failed: ${response.status} ${response.statusText} ${text}`.trim());
    }

    const body = await response.json();
    return { body };
  }

  async listBlogs(options?: { limit?: number; pageInfo?: string }): Promise<{
    blogs: any[];
    nextPageInfo: string | null;
  }> {
    const cacheKey = createCacheKey("blogs", {
      limit: options?.limit,
      pageInfo: options?.pageInfo,
    });

    return this.cache.getOrFetch(
      cacheKey,
      async () => {
        const query: Record<string, string | number | undefined> = {};
        if (options?.limit) query.limit = options.limit;
        if (options?.pageInfo) query.page_info = options.pageInfo;
        const { body, nextPageInfo } = await this.adminRestGet("blogs.json", query);
        const blogs = Array.isArray(body?.blogs) ? body.blogs : [];
        return { blogs, nextPageInfo };
      },
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  async listArticles(blogId: string, options?: {
    limit?: number;
    since?: string;
    pageInfo?: string;
  }): Promise<{ articles: any[]; nextPageInfo: string | null }> {
    const cacheKey = createCacheKey("articles", {
      blogId,
      limit: options?.limit,
      since: options?.since,
      pageInfo: options?.pageInfo,
    });

    return this.cache.getOrFetch(
      cacheKey,
      async () => {
        const query: Record<string, string | number | undefined> = {};
        if (options?.limit) query.limit = options.limit;
        if (options?.since) query.updated_at_min = options.since;
        if (options?.pageInfo) query.page_info = options.pageInfo;
        const { body, nextPageInfo } = await this.adminRestGet(`blogs/${blogId}/articles.json`, query);
        const articles = Array.isArray(body?.articles) ? body.articles : [];
        return { articles, nextPageInfo };
      },
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  async getArticleById(articleId: string): Promise<any> {
    const cacheKey = createCacheKey("article", { id: articleId });

    return this.cache.getOrFetch(
      cacheKey,
      async () => {
        const { body } = await this.adminRestGet(`articles/${articleId}.json`);
        return body?.article ?? body;
      },
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  async getArticleRawById(articleId: string): Promise<any> {
    const { body } = await this.adminRestGet(`articles/${articleId}.json`);
    return body?.article ?? body;
  }

  async updateArticle(articleId: string, updates: {
    bodyHtml?: string;
    title?: string;
    summaryHtml?: string;
  }): Promise<any> {
    const articlePayload: Record<string, unknown> = { id: Number(articleId) };
    if (updates.bodyHtml !== undefined) articlePayload.body_html = updates.bodyHtml;
    if (updates.title !== undefined) articlePayload.title = updates.title;
    if (updates.summaryHtml !== undefined) articlePayload.summary_html = updates.summaryHtml;

    const { body } = await this.adminRestPut(
      `articles/${articleId}.json`,
      { article: articlePayload }
    );
    this.cache.invalidatePattern(/^article/);
    this.cache.invalidatePattern(/^articles/);
    return body?.article ?? body;
  }

  async getCollectionRawById(collectionId: string): Promise<any> {
    const { body } = await this.adminRestGet(`collections/${collectionId}.json`);
    return body?.collection ?? body;
  }

  async updateCollectionDescription(
    collectionId: string,
    kind: "custom" | "smart",
    bodyHtml: string
  ): Promise<any> {
    const endpointKey = kind === "smart" ? "smart_collection" : "custom_collection";
    const path = kind === "smart"
      ? `smart_collections/${collectionId}.json`
      : `custom_collections/${collectionId}.json`;
    const payload = {
      [endpointKey]: { id: Number(collectionId), body_html: bodyHtml },
    };
    const { body } = await this.adminRestPut(path, payload);
    this.cache.invalidatePattern(/^collection/);
    return body?.[endpointKey] ?? body;
  }

}

function extractNextPageInfo(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const links = linkHeader.split(/,(?![^<]*>)/);
  for (const link of links) {
    const match = link.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (!match) continue;
    try {
      const url = new URL(match[1]!);
      const pageInfo = url.searchParams.get("page_info");
      if (pageInfo) return pageInfo;
    } catch {
    }
  }
  return null;
}

export default ShopifyMCPClient;
