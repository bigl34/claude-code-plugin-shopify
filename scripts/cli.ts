#!/usr/bin/env npx tsx

import { z, createCommand, runCli, cacheCommands, cliTypes, wrapUntrustedField, buildSafeOutput } from "@local/cli-utils";
import {
  INVENTORY_ITEMS_FORK_LIMIT,
  INVENTORY_LEVELS_FORK_LIMIT,
  ShopifyMCPClient,
  type InventoryQuantitySetInput,
  type ReverseFulfillmentDispositionInput,
  type ShopifyFileUploadInput,
  type UpdateProductInput,
} from "./mcp-client.js";
import { exportProductCatalogue } from "./catalogue-export.js";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

function normalizeCustomerId(customerId: string): string {
  if (customerId.includes("gid://")) {
    return customerId.split("/").pop() || customerId;
  }

  return customerId;
}

type FulfillmentHoldPayload = {
  reason?: string;
  reasonNotes?: string | null;
  [key: string]: unknown;
};

type FulfillmentOrderPayload = {
  fulfillmentHolds?: unknown;
  [key: string]: unknown;
};

const ORDER_STATUSES = ["any", "open", "closed", "cancelled"] as const;
const PRODUCT_STATUSES = ["ACTIVE", "DRAFT", "ARCHIVED"] as const;
const PositiveShopifyPriceSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)\.\d{2}$/, "Use a positive decimal amount with exactly two decimal places, for example 25.00")
  .refine((value) => value !== "0.00", "Price must be greater than 0.00");
const REVERSE_DISPOSITION_TYPES = [
  "MISSING",
  "NOT_RESTOCKED",
  "PROCESSING_REQUIRED",
  "RESTOCKED",
] as const;
const THEME_ROLES = [
  "MAIN",
  "UNPUBLISHED",
  "DEMO",
  "DEVELOPMENT",
  "ARCHIVED",
  "LOCKED",
] as const;
const REVERSE_DISPOSAL_CONFIRMATION = "DISPOSE_REVERSE_FULFILLMENT_ORDER_ITEMS" as const;
const FILE_UPLOAD_CONFIRMATION = "UPLOAD_FILE_TO_SHOPIFY" as const;

const InventoryQuantityInputsSchema = z.array(z.object({
  inventoryItemId: z.string().min(1),
  locationId: z.string().min(1),
  quantity: z.number().int(),
  changeFromQuantity: z.number().int(),
})).min(1).max(250);

function cappedForkCompleteness(returned: number, hardLimit: number, reportedCount?: number) {
  const countMismatch = reportedCount !== undefined && reportedCount !== returned;
  const limitReached = returned >= hardLimit || countMismatch;
  return {
    complete: !limitReached,
    truncated: limitReached,
    returned,
    forkHardLimit: hardLimit,
    reason: countMismatch ? "reported_count_mismatch" : limitReached
      ? "fork_hard_limit_reached_without_page_info"
      : "returned_fewer_than_fork_hard_limit",
  };
}

const ProductSeoSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
});

const ProductMetafieldsSchema = z.array(z.object({
  id: z.string().optional(),
  namespace: z.string().optional(),
  key: z.string().optional(),
  value: z.string(),
  type: z.string().optional(),
}));

const ReverseDispositionInputsSchema = z.array(z.object({
  reverseFulfillmentOrderLineItemId: z.string().min(1),
  quantity: z.number().int().positive(),
  dispositionType: z.enum(REVERSE_DISPOSITION_TYPES),
  locationId: z.string().min(1).optional(),
})).min(1);

const InventoryItemResponseSchema = z.object({
  productId: z.string().min(1),
  productTitle: z.string().nullable().optional(),
  variantsCount: z.number().int().nonnegative().optional(),
  variants: z.array(z.object({
    variantId: z.string().min(1),
    variantTitle: z.string().nullable().optional(),
    variantSku: z.string().nullable().optional(),
    inventoryItem: z.object({
      id: z.string().min(1),
      sku: z.string().nullable().optional(),
      tracked: z.boolean().nullable().optional(),
      requiresShipping: z.boolean().nullable().optional(),
      unitCost: z.object({
        amount: z.string().nullable().optional(),
        currencyCode: z.string().nullable().optional(),
      }).nullable().optional(),
      countryCodeOfOrigin: z.string().nullable().optional(),
      provinceCodeOfOrigin: z.string().nullable().optional(),
      harmonizedSystemCode: z.string().nullable().optional(),
      measurement: z.object({
        weight: z.object({
          unit: z.string().nullable().optional(),
          value: z.number().nullable().optional(),
        }).nullable().optional(),
      }).nullable().optional(),
      locationsCount: z.object({
        count: z.number().int().nonnegative().nullable().optional(),
      }).nullable().optional(),
    }),
  })),
});

const InventoryLevelsResponseSchema = z.object({
  inventoryItemId: z.string().min(1),
  sku: z.string().nullable().optional(),
  tracked: z.boolean().nullable().optional(),
  levelsCount: z.number().int().nonnegative().optional(),
  levels: z.array(z.object({
    id: z.string().min(1),
    location: z.object({
      id: z.string().min(1),
      name: z.string().nullable().optional(),
      isActive: z.boolean().nullable().optional(),
    }),
    quantities: z.array(z.object({
      name: z.string().min(1),
      quantity: z.number().int(),
    })),
    updatedAt: z.string().min(1),
  })),
});

function parseJsonArg<T>(
  command: string,
  flag: string,
  value: string,
  schema: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: unknown } }
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${command}: --${flag} must be valid JSON`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${command}: --${flag} does not match the required shape`);
  }
  return result.data;
}

function commaSeparatedValues(value?: string): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function themeRoles(value?: string): typeof THEME_ROLES[number][] | undefined {
  const roles = commaSeparatedValues(value);
  if (!roles) return undefined;
  const allowedRoles = new Set<string>(THEME_ROLES);
  const invalidRoles = roles.filter((role) => !allowedRoles.has(role));
  if (invalidRoles.length > 0) {
    throw new Error(
      `get-themes: invalid --roles value(s): ${invalidRoles.join(", ")}; ` +
      `expected ${THEME_ROLES.join(", ")}`
    );
  }
  return roles as typeof THEME_ROLES[number][];
}

function wrapShippingAddress(address: unknown): Record<string, unknown> | null {
  if (!address || typeof address !== "object") return null;
  const fields = address as Record<string, unknown>;
  return {
    name: wrapUntrustedField("shippingAddress.name", fields.name, { maxChars: 200 }),
    address1: wrapUntrustedField("shippingAddress.address1", fields.address1, { maxChars: 200 }),
    address2: wrapUntrustedField("shippingAddress.address2", fields.address2, { maxChars: 200 }),
    city: wrapUntrustedField("shippingAddress.city", fields.city, { maxChars: 200 }),
    company: wrapUntrustedField("shippingAddress.company", fields.company, { maxChars: 200 }),
    province: fields.province || fields.provinceCode,
    zip: fields.zip,
    country: fields.country,
    countryCode: fields.countryCodeV2 || fields.countryCode,
    phone: fields.phone,
  };
}

export const commands = {
  "list-tools": createCommand(
    z.object({}),
    async (_args, client: ShopifyMCPClient) => {
      const tools = await client.listTools();
      return tools.map((t: { name: string; description?: string }) => ({
        name: t.name,
        description: t.description,
      }));
    },
    "List all available MCP tools",
    { sideEffect: "read" }
  ),

  "get-products": createCommand(
    z.object({
      search: z.string().optional().describe("Search products by title"),
      limit: cliTypes.limit(50, 250),
      since: z.string().optional().describe("ISO date — restrict to products with updated_at >= since (incremental sync)"),
      pageInfo: z.string().optional().describe("GraphQL cursor for forward pagination (use pageInfo.endCursor from a previous response)"),
      status: z.enum(["active", "draft", "archived"]).optional().describe("Filter products by status (server-side, passed to Shopify Admin API as `status:<status>`)"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { search, limit, since, pageInfo, status } = args as {
        search?: string; limit: number; since?: string; pageInfo?: string; status?: "active" | "draft" | "archived";
      };
      const result = await client.getProducts({
        searchTitle: search,
        limit,
        since,
        after: pageInfo,
        status,
      });

      const products = (result?.products || result?.data || result || []);
      const wrappedProducts = (Array.isArray(products) ? products : []).map((p: any) => ({
        metadata: {
          id: p.id,
          status: p.status,
          productType: p.productType,
          tags: p.tags,
          variants: p.variants,
          updatedAt: p.updatedAt ?? p.updated_at,
        },
        content: {
          title: wrapUntrustedField("title", p.title, { maxChars: 500 }),
          description: wrapUntrustedField("description", p.description || p.descriptionHtml, { maxChars: 8000, convertHtml: !!p.descriptionHtml && !p.description }),
          vendor: wrapUntrustedField("vendor", p.vendor, { maxChars: 200 }),
        },
      }));

      return buildSafeOutput(
        {
          command: "get-products",
          count: wrappedProducts.length,
          hasNextPage: result?.pageInfo?.hasNextPage,
          endCursor: result?.pageInfo?.endCursor,
        },
        { products: wrappedProducts }
      );
    },
    "List products with optional search, incremental --since, --status server-side filter, and --page-info cursor",
    { sideEffect: "read" }
  ),

  "export-product-catalogue": createCommand(
    z.object({
      outputFile: z.string().min(1).describe("Path for the complete streamed catalogue JSON"),
      pageSize: cliTypes.int(1, 250).default(250).describe("Products fetched per provider page"),
      maxPages: cliTypes.int(1, 100000).default(10000).describe("Hard pagination safety ceiling; exceeding it publishes no output"),
      maxPageAttempts: cliTypes.int(1, 10).default(4).describe("Bounded attempts per page for Shopify rate-limit/THROTTLED errors"),
      overwrite: cliTypes.bool().default(false).describe("Replace an existing target; requires --confirm"),
    }),
    async (args, client: ShopifyMCPClient, globals) => {
      if (globals.dryRun === true) {
        throw new Error("export-product-catalogue does not support --dry-run; no file or provider call was made");
      }
      const { outputFile, pageSize, maxPages, maxPageAttempts, overwrite } = args as {
        outputFile: string;
        pageSize: number;
        maxPages: number;
        maxPageAttempts: number;
        overwrite: boolean;
      };
      const result = await exportProductCatalogue(client, {
        outputFile,
        pageSize,
        maxPages,
        maxPageAttempts,
        overwrite,
        confirmed: globals.confirm === true,
      });
      return buildSafeOutput(
        {
          command: "export-product-catalogue",
          ...result,
        },
        {},
      );
    },
    "Stream every Shopify product page to an atomic JSON artifact with completeness metadata",
    { sideEffect: "write", requiresConfirmation: false, requiresSafeOutput: true }
  ),

  "inventory-set-quantities": createCommand(
    z.object({
      idempotencyKey: z.string().min(1).max(255).describe("Unique key for this logical write; reuse it for retries"),
      reason: z.string().min(1).describe("Shopify inventory adjustment reason"),
      name: z.enum(["available", "on_hand"]).describe("Absolute quantity name to set"),
      referenceDocumentUri: z.string().url().optional(),
      previewToken: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional()
        .describe("Exact token returned by the approved dry-run preview; required for mutation"),
      quantities: z.string().min(1).describe("JSON array of {inventoryItemId,locationId,quantity,changeFromQuantity}"),
    }),
    async (args, client: ShopifyMCPClient, globals) => {
      const dryRun = globals.dryRun === true;
      if (!dryRun && globals.confirm !== true) {
        throw new Error(
          "inventory-set-quantities requires --dry-run for a fresh coupled-quantity preview or global --confirm for mutation"
        );
      }
      const { idempotencyKey, reason, name, referenceDocumentUri, previewToken, quantities } = args as {
        idempotencyKey: string;
        reason: string;
        name: "available" | "on_hand";
        referenceDocumentUri?: string;
        previewToken?: string;
        quantities: string;
      };
      if (!dryRun && !previewToken) {
        throw new Error(
          "inventory-set-quantities requires --preview-token from the approved --dry-run as well as global --confirm"
        );
      }
      const parsedQuantities = parseJsonArg(
        "inventory-set-quantities",
        "quantities",
        quantities,
        InventoryQuantityInputsSchema,
      );
      const input: InventoryQuantitySetInput = {
        idempotencyKey,
        reason,
        name,
        ...(referenceDocumentUri ? { referenceDocumentUri } : {}),
        quantities: parsedQuantities,
      };
      const result = await client.setInventoryQuantities(input, { dryRun, previewToken });
      const changes = Array.isArray(result?.adjustmentGroup?.changes)
        ? result.adjustmentGroup.changes
        : [];
      return buildSafeOutput(
        {
          command: "inventory-set-quantities",
          idempotencyKey: result?.idempotencyKey ?? idempotencyKey,
          previewToken: result?.previewToken,
          dryRun: result?.dryRun ?? dryRun,
          createdAt: result?.adjustmentGroup?.createdAt,
          reason: result?.adjustmentGroup?.reason,
          referenceDocumentUri: result?.adjustmentGroup?.referenceDocumentUri,
          changesCount: changes.length,
          verified: result?.verification?.verified ?? false,
        },
        {
          preview: result?.preview,
          verification: result?.verification,
          changes: changes.map((change, index: number) => ({
            metadata: {
              name: change?.name,
              delta: change?.delta,
              quantityAfterChange: change?.quantityAfterChange,
              inventoryItemId: change?.item?.id,
              locationId: change?.location?.id,
            },
            content: {
              sku: wrapUntrustedField(`changes[${index}].item.sku`, change?.item?.sku, { maxChars: 500 }),
              locationName: wrapUntrustedField(`changes[${index}].location.name`, change?.location?.name, { maxChars: 500 }),
            },
          })),
        }
      );
    },
    "Preview or set absolute Shopify inventory quantities with coupled available/on_hand verification",
    {
      sideEffect: "write",
      requiresConfirmation: true,
      dryRunSupported: true,
      idempotent: true,
      requiresSafeOutput: true,
    }
  ),

  "get-product": createCommand(
    z.object({
      id: z.string().min(1).describe("Product ID (GraphQL GID format)"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { id } = args as { id: string };
      const result = await client.getProductById(id);

      const p = result?.product || result;
      return buildSafeOutput(
        {
          command: "get-product",
          id: p.id,
          status: p.status,
          productType: p.productType,
          tags: p.tags,
          variants: p.variants,
        },
        {
          title: wrapUntrustedField("title", p.title, { maxChars: 500 }),
          description: wrapUntrustedField("description", p.description || p.descriptionHtml, { maxChars: 8000, convertHtml: !!p.descriptionHtml && !p.description }),
          vendor: wrapUntrustedField("vendor", p.vendor, { maxChars: 200 }),
        }
      );
    },
    "Get a product by ID",
    { sideEffect: "read" }
  ),

  "get-inventory-items": createCommand(
    z.object({
      productId: z.string().min(1).describe("Product ID (GraphQL GID or numeric ID)"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { productId } = args as { productId: string };
      const rawResult = await client.getInventoryItems(productId);
      const parsedResult = InventoryItemResponseSchema.safeParse(rawResult);
      if (!parsedResult.success) {
        throw new Error("get-inventory-items: Shopify MCP returned a malformed successful response");
      }
      const result = parsedResult.data;
      const variants = result.variants;
      const reportedCountMismatch =
        typeof result?.variantsCount === "number" &&
        Number.isFinite(result.variantsCount) &&
        result.variantsCount !== variants.length;
      const possiblyTruncated = variants.length >= 100 || reportedCountMismatch;

      const wrappedVariants = variants.map((variant) => {
        const inventoryItem = variant.inventoryItem;
        return {
          metadata: {
            variantId: variant.variantId,
            inventoryItemId: inventoryItem.id,
            tracked: inventoryItem.tracked,
            requiresShipping: inventoryItem.requiresShipping,
            unitCost: inventoryItem.unitCost,
            countryCodeOfOrigin: inventoryItem.countryCodeOfOrigin,
            provinceCodeOfOrigin: inventoryItem.provinceCodeOfOrigin,
            harmonizedSystemCode: inventoryItem.harmonizedSystemCode,
            measurement: inventoryItem.measurement,
            locationsCount: inventoryItem.locationsCount,
            inventoryItem: {
              id: inventoryItem.id,
              tracked: inventoryItem.tracked,
              requiresShipping: inventoryItem.requiresShipping,
              unitCost: inventoryItem.unitCost,
              countryCodeOfOrigin: inventoryItem.countryCodeOfOrigin,
              provinceCodeOfOrigin: inventoryItem.provinceCodeOfOrigin,
              harmonizedSystemCode: inventoryItem.harmonizedSystemCode,
              measurement: inventoryItem.measurement,
              locationsCount: inventoryItem.locationsCount,
            },
          },
          content: {
            variantTitle: wrapUntrustedField("variant.title", variant.variantTitle, { maxChars: 500 }),
            variantSku: wrapUntrustedField("variant.sku", variant.variantSku, { maxChars: 200 }),
            inventoryItemSku: wrapUntrustedField("inventoryItem.sku", inventoryItem.sku, { maxChars: 200 }),
          },
        };
      });

      return buildSafeOutput(
        {
          command: "get-inventory-items",
          productId: result?.productId,
          variantsCount: variants.length,
          completeness: cappedForkCompleteness(variants.length, INVENTORY_ITEMS_FORK_LIMIT, result.variantsCount),
          count: variants.length,
          reportedCount: result?.variantsCount,
          complete: !possiblyTruncated,
          possiblyTruncated,
          hardCap: 100,
        },
        {
          productTitle: wrapUntrustedField("product.title", result?.productTitle, { maxChars: 500 }),
          variants: wrappedVariants,
        },
        reportedCountMismatch
          ? [`The provider reported ${result.variantsCount} variants but returned ${variants.length}; treat this as a partial inventory-item view.`]
          : possiblyTruncated
          ? ["The upstream tool returns at most 100 variants and exposes no pagination; treat this as a partial inventory-item view."]
          : undefined,
      );
    },
    "Get inventory-item metadata for a product (fixed upstream cap of 100 variants)",
    { sideEffect: "read" }
  ),

  "get-inventory-levels": createCommand(
    z.object({
      inventoryItemId: z.string().min(1).describe("Inventory item ID (GraphQL GID or numeric ID)"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { inventoryItemId } = args as { inventoryItemId: string };
      const rawResult = await client.getInventoryLevels(inventoryItemId, { bypassCache: true });
      const parsedResult = InventoryLevelsResponseSchema.safeParse(rawResult);
      if (!parsedResult.success) {
        throw new Error("get-inventory-levels: Shopify MCP returned a malformed successful response");
      }
      const result = parsedResult.data;
      const levels = result.levels;
      const reportedCountMismatch =
        typeof result?.levelsCount === "number" &&
        Number.isFinite(result.levelsCount) &&
        result.levelsCount !== levels.length;
      const possiblyTruncated = levels.length >= 50 || reportedCountMismatch;

      const wrappedLevels = levels.map((level) => ({
        metadata: {
          id: level.id,
          locationId: level.location?.id,
          locationIsActive: level.location?.isActive,
          quantities: level.quantities,
          updatedAt: level.updatedAt,
        },
        content: {
          locationName: wrapUntrustedField("location.name", level.location?.name, { maxChars: 500 }),
        },
      }));

      return buildSafeOutput(
        {
          command: "get-inventory-levels",
          inventoryItemId: result?.inventoryItemId,
          tracked: result?.tracked,
          levelsCount: result.levelsCount ?? levels.length,
          completeness: cappedForkCompleteness(levels.length, INVENTORY_LEVELS_FORK_LIMIT, result.levelsCount),
          count: levels.length,
          reportedCount: result?.levelsCount,
          complete: !possiblyTruncated,
          possiblyTruncated,
          hardCap: 50,
          cached: false,
        },
        {
          sku: wrapUntrustedField("inventoryItem.sku", result?.sku, { maxChars: 200 }),
          levels: wrappedLevels,
        },
        reportedCountMismatch
          ? [`The provider reported ${result.levelsCount} inventory levels but returned ${levels.length}; treat this as a partial location view.`]
          : possiblyTruncated
          ? ["The upstream tool returns at most 50 inventory levels and exposes no pagination; treat this as a partial location view."]
          : undefined,
      );
    },
    "Get current inventory quantities by location (uncached; fixed upstream cap of 50 levels)",
    { sideEffect: "read" }
  ),

  "create-product": createCommand(
    z.object({
      title: z.string().min(1).describe("Product title"),
      description: z.string().optional().describe("Product description HTML"),
      vendor: z.string().optional().describe("Product vendor"),
      type: z.string().optional().describe("Product type"),
      tags: z.string().optional().describe("Tags (comma-separated)"),
      status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]).optional().describe("Product status"),
      price: PositiveShopifyPriceSchema.describe("Required default variant price in the shop currency, for example 25.00"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { title, description, vendor, type, tags, status, price } = args as {
        title: string;
        description?: string;
        vendor?: string;
        type?: string;
        tags?: string;
        status?: "ACTIVE" | "DRAFT" | "ARCHIVED";
        price: string;
      };
      return client.createProduct({
        title,
        descriptionHtml: description,
        vendor,
        productType: type,
        tags: commaSeparatedValues(tags),
        status,
        price,
      });
    },
    "Create a new product and set and verify its required default variant price",
    { sideEffect: "write", requiresConfirmation: true }
  ),

  "update-product": createCommand(
    z.object({
      id: z.string().min(1).describe("Product GID (gid://shopify/Product/...)"),
      title: z.string().optional(),
      description: z.string().optional().describe("Product description HTML"),
      handle: z.string().optional().describe("URL slug"),
      vendor: z.string().optional(),
      type: z.string().optional().describe("Product type"),
      tags: z.string().optional().describe("Comma-separated tags"),
      status: z.enum(PRODUCT_STATUSES).optional(),
      seo: z.string().optional().describe("SEO JSON: {\"title\":\"...\",\"description\":\"...\"}"),
      metafields: z.string().optional().describe("Metafields JSON array"),
      collectionsToJoin: z.string().optional().describe("Comma-separated collection GIDs to join"),
      collectionsToLeave: z.string().optional().describe("Comma-separated collection GIDs to leave"),
      redirectNewHandle: cliTypes.bool().optional().describe("Redirect the old handle after a handle change"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const {
        id,
        title,
        description,
        handle,
        vendor,
        type,
        tags,
        status,
        seo,
        metafields,
        collectionsToJoin,
        collectionsToLeave,
        redirectNewHandle,
      } = args as {
        id: string;
        title?: string;
        description?: string;
        handle?: string;
        vendor?: string;
        type?: string;
        tags?: string;
        status?: typeof PRODUCT_STATUSES[number];
        seo?: string;
        metafields?: string;
        collectionsToJoin?: string;
        collectionsToLeave?: string;
        redirectNewHandle?: boolean;
      };

      const optionalFields = {
        title,
        descriptionHtml: description,
        handle,
        vendor,
        productType: type,
        tags: commaSeparatedValues(tags),
        status,
        seo: seo ? parseJsonArg("update-product", "seo", seo, ProductSeoSchema) : undefined,
        metafields: metafields
          ? parseJsonArg("update-product", "metafields", metafields, ProductMetafieldsSchema)
          : undefined,
        collectionsToJoin: commaSeparatedValues(collectionsToJoin),
        collectionsToLeave: commaSeparatedValues(collectionsToLeave),
        redirectNewHandle,
      };
      const suppliedFields = Object.fromEntries(
        Object.entries(optionalFields).filter(([, value]) => value !== undefined)
      );
      if (Object.keys(suppliedFields).length === 0) {
        throw new Error("update-product: provide at least one product field to update");
      }

      const result = await client.updateProduct({ id, ...suppliedFields } as UpdateProductInput);
      const product = result?.product ?? result;
      return buildSafeOutput(
        {
          command: "update-product",
          id: product?.id ?? id,
          status: product?.status,
          handle: product?.handle,
        },
        { product }
      );
    },
    "Update an existing product; requires global --confirm",
    { sideEffect: "write", requiresConfirmation: true, requiresSafeOutput: true }
  ),

  "get-shop-info": createCommand(
    z.object({}),
    async (_args, client: ShopifyMCPClient) => {
      const result = await client.getShopInfo();
      const shop = result?.shop ?? result;
      return buildSafeOutput(
        { command: "get-shop-info", id: shop?.id },
        { shop }
      );
    },
    "Get the fork's current read-only shop configuration summary",
    { sideEffect: "read", requiresSafeOutput: true }
  ),

  "get-product-events": createCommand(
    z.object({
      productId: z.string().min(1).describe("Product GID"),
      first: cliTypes.limit(50, 100),
      after: z.string().optional().describe("GraphQL cursor"),
      query: z.string().optional().describe("Shopify event query filter"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { productId, first, after, query } = args as {
        productId: string;
        first: number;
        after?: string;
        query?: string;
      };
      const result = await client.getProductEvents(productId, { first, after, query });
      return buildSafeOutput(
        {
          command: "get-product-events",
          productId,
          count: Array.isArray(result?.events) ? result.events.length : 0,
          pageInfo: result?.pageInfo,
        },
        {
          productTitle: wrapUntrustedField("productTitle", result?.productTitle, { maxChars: 500 }),
          events: result?.events ?? [],
        }
      );
    },
    "List product events with cursor pagination",
    { sideEffect: "read", requiresSafeOutput: true }
  ),

  "get-files": createCommand(
    z.object({
      first: cliTypes.limit(50, 100),
      after: z.string().optional().describe("GraphQL cursor"),
      query: z.string().optional().describe("Shopify Files query filter"),
      reverse: cliTypes.bool().optional(),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { first, after, query, reverse } = args as {
        first: number;
        after?: string;
        query?: string;
        reverse?: boolean;
      };
      const result = await client.getFiles({ first, after, query, reverse });
      return buildSafeOutput(
        {
          command: "get-files",
          count: Array.isArray(result?.files) ? result.files.length : 0,
          pageInfo: result?.pageInfo,
        },
        { files: result?.files ?? [] }
      );
    },
    "List Shopify Files metadata read-only; does not upload or alter files",
    { sideEffect: "read", requiresSafeOutput: true }
  ),

  "file-upload": createCommand(
    z.object({
      filePath: z.string().min(1).refine(isAbsolute, "filePath must be absolute"),
      filename: z.string().min(1).optional(),
      mimeType: z.string().min(1),
      contentType: z.enum(["IMAGE", "FILE", "VIDEO", "MODEL_3D"]),
      alt: z.string().max(512).optional(),
      duplicateResolutionMode: z.enum(["APPEND_UUID", "RAISE_ERROR", "REPLACE"])
        .default("RAISE_ERROR"),
      confirmation: z.string().optional().describe(
        `To upload, repeat the exact phrase ${FILE_UPLOAD_CONFIRMATION}; otherwise the command dry-runs`
      ),
    }),
    async (args, client: ShopifyMCPClient, globals) => {
      const {
        filePath,
        filename,
        mimeType,
        contentType,
        alt,
        duplicateResolutionMode,
        confirmation,
      } = args as {
        filePath: string;
        filename?: string;
        mimeType: string;
        contentType: ShopifyFileUploadInput["contentType"];
        alt?: string;
        duplicateResolutionMode: NonNullable<ShopifyFileUploadInput["duplicateResolutionMode"]>;
        confirmation?: string;
      };
      if (confirmation !== undefined && confirmation !== FILE_UPLOAD_CONFIRMATION) {
        throw new Error(
          `file-upload: --confirmation must exactly equal ${FILE_UPLOAD_CONFIRMATION}`
        );
      }

      const confirmed = confirmation === FILE_UPLOAD_CONFIRMATION && !globals.dryRun;
      const result = await client.uploadFile({
        filePath,
        filename,
        mimeType,
        contentType,
        alt,
        duplicateResolutionMode,
        dryRun: !confirmed,
        confirmation: confirmed ? FILE_UPLOAD_CONFIRMATION : undefined,
      });
      return buildSafeOutput(
        {
          command: "file-upload",
          dryRun: result?.dryRun ?? !confirmed,
          createdFileIds: Array.isArray(result?.createdFiles)
            ? result.createdFiles.map((file) => file.id)
            : [],
        },
        { result }
      );
    },
    "Stage and upload one local file to Shopify Files; dry-runs unless exactly confirmed",
    {
      sideEffect: "external_send",
      requiresConfirmation: false,
      dryRunSupported: true,
      requiresSafeOutput: true,
    }
  ),

  "get-shop-settings": createCommand(
    z.object({}),
    async (_args, client: ShopifyMCPClient) => {
      const result = await client.getShopSettings();
      const shop = result?.shop ?? result;
      return buildSafeOutput(
        { command: "get-shop-settings", id: shop?.id },
        { shop }
      );
    },
    "Get read-only shop, checkout, payment, tax, address, and feature settings",
    { sideEffect: "read", requiresSafeOutput: true }
  ),

  "get-app-scopes": createCommand(
    z.object({}),
    async (_args, client: ShopifyMCPClient) => {
      const result = await client.getAppScopes();
      return buildSafeOutput(
        {
          command: "get-app-scopes",
          scopeHandles: result?.scopeHandles ?? [],
          count: Array.isArray(result?.scopeHandles) ? result.scopeHandles.length : 0,
        },
        { appInstallation: result?.appInstallation }
      );
    },
    "Get the current app installation and granted access scopes read-only",
    { sideEffect: "read", requiresSafeOutput: true }
  ),

  "get-web-pixel": createCommand(
    z.object({
      id: z.string().min(1).optional().describe("Optional WebPixel GID"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { id } = args as { id?: string };
      const result = await client.getWebPixel(id);
      return buildSafeOutput(
        { command: "get-web-pixel", id: result?.webPixel?.id ?? id ?? null },
        { settings: result?.webPixel?.settings ?? null }
      );
    },
    "Get web pixel metadata/settings read-only",
    { sideEffect: "read", requiresSafeOutput: true }
  ),

  "get-themes": createCommand(
    z.object({
      first: cliTypes.limit(50, 100),
      after: z.string().optional().describe("GraphQL cursor"),
      roles: z.string().optional().describe("Comma-separated theme roles"),
      names: z.string().optional().describe("Comma-separated exact theme names"),
      reverse: cliTypes.bool().optional(),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { first, after, roles, names, reverse } = args as {
        first: number;
        after?: string;
        roles?: string;
        names?: string;
        reverse?: boolean;
      };
      const result = await client.getThemes({
        first,
        after,
        roles: themeRoles(roles),
        names: commaSeparatedValues(names),
        reverse,
      });
      return buildSafeOutput(
        {
          command: "get-themes",
          count: Array.isArray(result?.themes) ? result.themes.length : 0,
          pageInfo: result?.pageInfo,
        },
        { themes: result?.themes ?? [] }
      );
    },
    "List theme metadata read-only; never reads or mutates theme assets",
    { sideEffect: "read", requiresSafeOutput: true }
  ),

  "get-customers": createCommand(
    z.object({
      search: z.string().optional().describe("Search customers by name/email (raw Shopify query syntax allowed)"),
      limit: cliTypes.limit(50, 250),
      since: z.string().optional().describe("ISO date — restrict to customers with updated_at >= since (incremental sync)"),
      pageInfo: z.string().optional().describe("GraphQL cursor for forward pagination (use pageInfo.endCursor from a previous response)"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { search, limit, since, pageInfo } = args as {
        search?: string; limit: number; since?: string; pageInfo?: string;
      };
      const result = await client.getCustomers({
        searchQuery: search,
        limit,
        since,
        after: pageInfo,
      });

      const customers = (result?.customers || result?.data || result || []);
      const wrappedCustomers = (Array.isArray(customers) ? customers : []).map((c: any) => ({
        metadata: {
          id: c.id,
          ordersCount: c.ordersCount || c.numberOfOrders,
          tags: c.tags,
          createdAt: c.createdAt,
          state: c.state,
          totalSpent: c.totalSpent ?? c.total_spent,
          acceptsMarketing: c.acceptsMarketing ?? c.accepts_marketing,
          taxExempt: c.taxExempt ?? c.tax_exempt,
        },
        content: {
          displayName: wrapUntrustedField("displayName", c.displayName, { maxChars: 200 }),
          email: wrapUntrustedField("email", c.email, { maxChars: 200 }),
          firstName: wrapUntrustedField("firstName", c.firstName, { maxChars: 200 }),
          lastName: wrapUntrustedField("lastName", c.lastName, { maxChars: 200 }),
          note: wrapUntrustedField("note", c.note, { maxChars: 500 }),
          defaultAddress: c.defaultAddress ? {
            address1: wrapUntrustedField("address.address1", c.defaultAddress.address1, { maxChars: 200 }),
            address2: wrapUntrustedField("address.address2", c.defaultAddress.address2, { maxChars: 200 }),
            city: wrapUntrustedField("address.city", c.defaultAddress.city, { maxChars: 200 }),
            company: wrapUntrustedField("address.company", c.defaultAddress.company, { maxChars: 200 }),
            country: c.defaultAddress.country ?? c.defaultAddress.countryCodeV2 ?? c.defaultAddress.countryCode,
          } : null,
        },
      }));

      return buildSafeOutput(
        {
          command: "get-customers",
          count: wrappedCustomers.length,
          hasNextPage: result?.pageInfo?.hasNextPage,
          endCursor: result?.pageInfo?.endCursor,
        },
        { customers: wrappedCustomers }
      );
    },
    "List customers with optional search, incremental --since, and --page-info cursor",
    { sideEffect: "read" }
  ),

  "update-customer": createCommand(
    z.object({
      id: z.string().min(1).describe("Customer ID (GraphQL GID format)"),
      firstName: z.string().optional().describe("First name"),
      lastName: z.string().optional().describe("Last name"),
      email: z.string().email().optional().describe("Email address"),
      phone: z.string().optional().describe("Phone number"),
      note: z.string().optional().describe("Customer note"),
      tags: z.string().optional().describe("Tags (comma-separated)"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { id, firstName, lastName, email, phone, note, tags } = args as {
        id: string;
        firstName?: string;
        lastName?: string;
        email?: string;
        phone?: string;
        note?: string;
        tags?: string;
      };
      return client.updateCustomer(id, {
        firstName,
        lastName,
        email,
        phone,
        note,
        tags: tags?.split(",").map((t) => t.trim()),
      });
    },
    "Update a customer",
    { sideEffect: "write" }
  ),

  "get-customer-orders": createCommand(
    z.object({
      id: z.string().min(1).describe("Customer ID (GraphQL GID or numeric)"),
      limit: cliTypes.limit(50, 250),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { id, limit } = args as { id: string; limit: number };
      const customerId = normalizeCustomerId(id);
      const result = await client.getCustomerOrders(customerId, limit);

      const orders = (result?.orders || result?.data || result || []);
      const wrappedOrders = (Array.isArray(orders) ? orders : []).map((o: any) => ({
        metadata: {
          id: o.id,
          name: o.name,
          orderNumber: o.orderNumber,
          status: o.displayFulfillmentStatus || o.fulfillmentStatus,
          financialStatus: o.displayFinancialStatus || o.financialStatus,
          createdAt: o.createdAt,
          totalPrice: o.totalPriceSet?.shopMoney?.amount || o.totalPrice,
          currency: o.totalPriceSet?.shopMoney?.currencyCode || o.currency,
          tags: o.tags,
        },
        content: {
          customerName: wrapUntrustedField("customer.displayName", o.customer?.displayName, { maxChars: 200 }),
          customerEmail: wrapUntrustedField("customer.email", o.customer?.email || o.email, { maxChars: 200 }),
          note: wrapUntrustedField("note", o.note, { maxChars: 500 }),
          lineItems: (o.lineItems?.nodes || o.lineItems || []).map((li: any) => ({
            metadata: { lineItemId: li.id, quantity: li.quantity, sku: li.sku },
            content: {
              title: wrapUntrustedField("lineItem.title", li.title || li.name, { maxChars: 500 }),
            },
          })),
        },
      }));

      return buildSafeOutput(
        { command: "get-customer-orders", customerId, count: wrappedOrders.length },
        { orders: wrappedOrders }
      );
    },
    "Get orders for a customer",
    { sideEffect: "read" }
  ),

  "get-orders": createCommand(
    z.object({
      status: z.enum(ORDER_STATUSES).optional().describe("Order status filter"),
      limit: cliTypes.limit(50, 250),
      sortKey: z.string().optional().describe("Sort key (e.g., CREATED_AT)"),
      reverse: cliTypes.bool().optional().describe("Reverse sort order"),
      after: z.string().optional().describe("Pagination cursor (GraphQL endCursor)"),
      query: z.string().optional().describe("Query filter (e.g., created_at:>2025-06-01)"),
      since: z.string().optional().describe(
        "ISO date — convenience shortcut, appended to --query as `updated_at:>=since` " +
        "(use --query directly for finer-grained created_at filters etc.)"
      ),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { status, limit, sortKey, reverse, after, query, since } = args as {
        status?: typeof ORDER_STATUSES[number]; limit: number; sortKey?: string; reverse?: boolean; after?: string; query?: string; since?: string;
      };
      const result = await client.getOrders({ status, limit, sortKey, reverse, after, query, since });

      const orders = (result?.orders || result?.data || result || []);
      const wrappedOrders = (Array.isArray(orders) ? orders : []).map((o: any) => ({
        metadata: {
          id: o.id,
          name: o.name,
          orderNumber: o.orderNumber,
          status: o.displayFulfillmentStatus || o.fulfillmentStatus,
          financialStatus: o.displayFinancialStatus || o.financialStatus,
          createdAt: o.createdAt,
          updatedAt: o.updatedAt,
          totalPrice: o.totalPriceSet?.shopMoney?.amount || o.totalPrice,
          totalDiscounts: o.totalDiscountsSet?.shopMoney?.amount || o.totalDiscounts,
          currency: o.totalPriceSet?.shopMoney?.currencyCode || o.currency,
          discountCodes: o.discountCodes,
          tags: o.tags,
          fulfillments: o.fulfillments,
          refunds: o.refunds,
          returns: o.returns,
          transactions: o.transactions,
        },
        content: {
          customerName: wrapUntrustedField("customer.displayName", o.customer?.displayName, { maxChars: 200 }),
          customerEmail: wrapUntrustedField("customer.email", o.customer?.email || o.email, { maxChars: 200 }),
          note: wrapUntrustedField("note", o.note, { maxChars: 500 }),
          lineItems: (o.lineItems?.nodes || o.lineItems || []).map((li: any) => ({
            metadata: {
              lineItemId: li.id,
              quantity: li.quantity,
              sku: li.sku ?? li.variant?.sku,
              variantId: li.variant?.id,
            },
            content: {
              title: wrapUntrustedField("lineItem.title", li.title || li.name, { maxChars: 500 }),
            },
          })),
          shippingAddress: wrapShippingAddress(o.shippingAddress),
        },
      }));

      const pageInfo = {
        hasNextPage: result?.pageInfo?.hasNextPage ?? false,
        hasPreviousPage: result?.pageInfo?.hasPreviousPage ?? false,
        endCursor: result?.pageInfo?.endCursor ?? null,
        startCursor: result?.pageInfo?.startCursor ?? null,
      };

      const truncated = pageInfo.hasNextPage;
      if (truncated) {
        process.stderr.write(
          `[get-orders] WARNING: truncated — returned ${wrappedOrders.length} order(s) and more remain. ` +
            `This is a PARTIAL result; do not treat it as the full set. ` +
            `Page on with --page-info ${pageInfo.endCursor ?? "<endCursor>"}, or raise --limit.\n`
        );
      }

      return buildSafeOutput(
        { command: "get-orders", count: wrappedOrders.length, truncated, pageInfo },
        { orders: wrappedOrders }
      );
    },
    "List orders with filters",
    { sideEffect: "read" }
  ),

  "get-all-orders": createCommand(
    z.object({
      status: z.enum(ORDER_STATUSES).optional().describe("Order status filter"),
      sortKey: z.string().optional().describe("Sort key (e.g., CREATED_AT)"),
      reverse: cliTypes.bool().optional().describe("Reverse sort order"),
      query: z.string().optional().describe("Query filter (e.g., created_at:>2025-06-01)"),
      maxPages: cliTypes.int(1, 50).default(10).describe("Max pages to fetch"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { status, sortKey, reverse, query, maxPages } = args as {
        status?: typeof ORDER_STATUSES[number]; sortKey?: string; reverse?: boolean; query?: string; maxPages: number;
      };
      const result = await client.getAllOrders({ status, sortKey, reverse, query, maxPages });

      const orders = result.orders;
      const wrappedOrders = (Array.isArray(orders) ? orders : []).map((o: any) => ({
        metadata: {
          id: o.id,
          name: o.name,
          orderNumber: o.orderNumber,
          status: o.displayFulfillmentStatus || o.fulfillmentStatus,
          financialStatus: o.displayFinancialStatus || o.financialStatus,
          createdAt: o.createdAt,
          totalPrice: o.totalPriceSet?.shopMoney?.amount || o.totalPrice,
          totalDiscounts: o.totalDiscountsSet?.shopMoney?.amount || o.totalDiscounts,
          currency: o.totalPriceSet?.shopMoney?.currencyCode || o.currency,
          tags: o.tags,
          refunds: o.refunds,
          returns: o.returns,
          transactions: o.transactions,
        },
        content: {
          customerName: wrapUntrustedField("customer.displayName", o.customer?.displayName, { maxChars: 200 }),
          customerEmail: wrapUntrustedField("customer.email", o.customer?.email || o.email, { maxChars: 200 }),
          note: wrapUntrustedField("note", o.note, { maxChars: 500 }),
          lineItems: (o.lineItems?.nodes || o.lineItems || []).map((li: any) => ({
            metadata: {
              lineItemId: li.id,
              quantity: li.quantity,
              sku: li.sku ?? li.variant?.sku,
              variantId: li.variant?.id,
            },
            content: {
              title: wrapUntrustedField("lineItem.title", li.title || li.name, { maxChars: 500 }),
            },
          })),
          shippingAddress: wrapShippingAddress(o.shippingAddress),
        },
      }));

      return buildSafeOutput(
        { command: "get-all-orders", count: wrappedOrders.length, totalFetched: result.totalFetched, hasMore: result.hasMore },
        { orders: wrappedOrders }
      );
    },
    "Get all orders with automatic pagination",
    { sideEffect: "read" }
  ),

  "get-order": createCommand(
    z.object({
      id: z.string().min(1).describe("Order ID (GraphQL GID format)"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { id } = args as { id: string };
      const result = await client.getOrderById(id);

      const o = result?.order || result;
      return buildSafeOutput(
        {
          command: "get-order",
          id: o.id,
          name: o.name,
          orderNumber: o.orderNumber,
          status: o.displayFulfillmentStatus || o.fulfillmentStatus,
          financialStatus: o.displayFinancialStatus || o.financialStatus,
          createdAt: o.createdAt,
          updatedAt: o.updatedAt,
          closedAt: o.closedAt,
          cancelledAt: o.cancelledAt,
          totalPrice: o.totalPriceSet?.shopMoney?.amount || o.totalPrice,
          subtotalPrice: o.subtotalPriceSet?.shopMoney?.amount || o.subtotalPrice,
          totalDiscounts: o.totalDiscountsSet?.shopMoney?.amount || o.totalDiscounts,
          currency: o.totalPriceSet?.shopMoney?.currencyCode || o.currency,
          discountCodes: o.discountCodes,
          tags: o.tags,
          fulfillments: o.fulfillments,
          returns: o.returns,
          refunds: o.refunds,
          transactions: o.transactions,
        },
        {
          customerName: wrapUntrustedField("customer.displayName", o.customer?.displayName, { maxChars: 200 }),
          customerEmail: wrapUntrustedField("customer.email", o.customer?.email || o.email, { maxChars: 200 }),
          note: wrapUntrustedField("note", o.note, { maxChars: 500 }),
          lineItems: (o.lineItems?.nodes || o.lineItems || []).map((li: any) => ({
            metadata: {
              lineItemId: li.id,
              quantity: li.quantity,
              sku: li.sku ?? li.variant?.sku,
              variantId: li.variant?.id,
            },
            content: {
              title: wrapUntrustedField("lineItem.title", li.title || li.name, { maxChars: 500 }),
            },
          })),
          shippingAddress: o.shippingAddress ? {
            name: wrapUntrustedField("shippingAddress.name", o.shippingAddress.name, { maxChars: 200 }),
            address1: wrapUntrustedField("shippingAddress.address1", o.shippingAddress.address1, { maxChars: 200 }),
            address2: wrapUntrustedField("shippingAddress.address2", o.shippingAddress.address2, { maxChars: 200 }),
            city: wrapUntrustedField("shippingAddress.city", o.shippingAddress.city, { maxChars: 200 }),
            company: wrapUntrustedField("shippingAddress.company", o.shippingAddress.company, { maxChars: 200 }),
            province: o.shippingAddress.province || o.shippingAddress.provinceCode,
            zip: o.shippingAddress.zip,
            country: o.shippingAddress.country,
            countryCode: o.shippingAddress.countryCodeV2 || o.shippingAddress.countryCode,
            phone: o.shippingAddress.phone,
          } : null,
          billingAddress: o.billingAddress ? {
            name: wrapUntrustedField("billingAddress.name", o.billingAddress.name, { maxChars: 200 }),
            address1: wrapUntrustedField("billingAddress.address1", o.billingAddress.address1, { maxChars: 200 }),
            address2: wrapUntrustedField("billingAddress.address2", o.billingAddress.address2, { maxChars: 200 }),
            city: wrapUntrustedField("billingAddress.city", o.billingAddress.city, { maxChars: 200 }),
            company: wrapUntrustedField("billingAddress.company", o.billingAddress.company, { maxChars: 200 }),
            province: o.billingAddress.province || o.billingAddress.provinceCode,
            zip: o.billingAddress.zip,
            country: o.billingAddress.country,
            countryCode: o.billingAddress.countryCodeV2 || o.billingAddress.countryCode,
            phone: o.billingAddress.phone,
          } : null,
        }
      );
    },
    "Get an order by ID",
    { sideEffect: "read" }
  ),

  "update-order": createCommand(
    z.object({
      id: z.string().min(1).describe("Order ID (GraphQL GID format)"),
      tags: z.string().optional().describe("Tags (comma-separated)"),
      email: z.string().email().optional().describe("Customer email"),
      note: z.string().optional().describe("Order note"),
      shippingAddress: z.object({
        address1: z.string().optional(),
        address2: z.string().optional(),
        city: z.string().optional(),
        company: z.string().optional(),
        countryCode: z.string().optional().describe("ISO 3166-1 alpha-2 country code (e.g., GB)"),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        phone: z.string().optional(),
        provinceCode: z.string().optional(),
        zip: z.string().optional(),
      }).optional().describe("Shipping address to set on the order"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { id, tags, email, note, shippingAddress } = args as {
        id: string;
        tags?: string;
        email?: string;
        note?: string;
        shippingAddress?: Record<string, string>;
      };
      return client.updateOrder(id, { tags, email, note, shippingAddress });
    },
    "Update an order",
    { sideEffect: "write" }
  ),

  "update-fulfillment-tracking": createCommand(
    z.object({
      fulfillmentId: z.string().min(1).describe("Fulfillment GID (gid://shopify/Fulfillment/...)"),
      trackingNumber: z.string().min(1).optional().describe("New tracking number (mutually exclusive with --clear)"),
      trackingCompany: z.string().optional().describe("Carrier name (e.g., UPS, Royal Mail)"),
      trackingUrl: z.string().optional().describe("Tracking URL"),
      notifyCustomer: cliTypes.bool().optional().describe("Send email to customer"),
      clear: cliTypes.bool().optional().describe("Remove all tracking (number, carrier, URL) from the fulfillment (mutually exclusive with --tracking-number)"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { fulfillmentId, trackingNumber, trackingCompany, trackingUrl, notifyCustomer, clear } = args as {
        fulfillmentId: string;
        trackingNumber?: string;
        trackingCompany?: string;
        trackingUrl?: string;
        notifyCustomer?: boolean;
        clear?: boolean;
      };
      if (clear && trackingNumber) {
        throw new Error("Pass either --tracking-number or --clear, not both");
      }
      if (!clear && !trackingNumber) {
        throw new Error("Provide --tracking-number, or --clear to remove tracking");
      }
      return client.updateFulfillmentTracking(fulfillmentId, {
        trackingNumber,
        trackingCompany,
        trackingUrl,
        notifyCustomer,
        clear,
      });
    },
    "Update or clear tracking on a fulfillment",
    { sideEffect: "write" }
  ),

  "close-return": createCommand(
    z.object({
      id: z.string().min(1).describe("Return GID (gid://shopify/Return/...) to close"),
      confirm: z.string().optional().describe(
        "To actually close the return, pass --confirm with the SAME GID as --id. " +
        "Without it (or with a mismatched value) the command only dry-runs."
      ),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { id, confirm } = args as { id: string; confirm?: string };
      if (confirm !== undefined && confirm !== id) {
        throw new Error(
          `close-return: --confirm must repeat the return GID exactly. ` +
          `Got --confirm '${confirm}' for --id '${id}'.`
        );
      }
      const confirmed = confirm === id;
      return client.closeReturn(id,   !confirmed);
    },
    "Close an OPEN return — dry-runs unless --confirm repeats the return GID",
    { sideEffect: "destructive", requiresConfirmation: false }
  ),

  "create-fulfillment": createCommand(
    z.object({
      orderNumber: z.string().min(1).describe("Order number (e.g., 1234)"),
      trackingNumber: z.string().min(1).optional().describe("Tracking number (omit for an untracked service)"),
      trackingCompany: z.string().optional().describe("Carrier name (default: UPS)"),
      trackingUrl: z.string().optional().describe("Tracking URL"),
      notifyCustomer: cliTypes.bool().optional().describe("Send email to customer (default: false)"),
      lineItems: z.string().optional().describe("Items to fulfill as JSON: [{\"lineItemId\":\"gid://shopify/LineItem/...\",\"quantity\":1}] or [{\"sku\":\"X\",\"quantity\":1}]. lineItemId is preferred — it's unambiguous and works for items with empty SKUs."),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { orderNumber, trackingNumber, trackingCompany, trackingUrl, notifyCustomer, lineItems } = args as {
        orderNumber: string;
        trackingNumber?: string;
        trackingCompany?: string;
        trackingUrl?: string;
        notifyCustomer?: boolean;
        lineItems?: string;
      };
      return client.createFulfillment(orderNumber, trackingNumber, {
        trackingCompany,
        trackingUrl,
        notifyCustomer,
        lineItems: lineItems ? JSON.parse(lineItems) : undefined,
      });
    },
    "Create fulfillment for an order, with optional tracking",
    { sideEffect: "write" }
  ),

  "get-fulfillment-orders": createCommand(
    z.object({
      id: z.string().min(1).describe("Shopify order id (e.g. 1234) or full Order GID"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { id } = args as { id: string };
      const result = await client.getFulfillmentOrders(id);
      const rawFulfillmentOrders = Array.isArray(result?.fulfillmentOrders)
        ? (result.fulfillmentOrders as FulfillmentOrderPayload[])
        : null;
      const holds = rawFulfillmentOrders?.flatMap((fo) =>
        Array.isArray(fo.fulfillmentHolds) ? (fo.fulfillmentHolds as FulfillmentHoldPayload[]) : []
      ) ?? [];
      const holdSummary = holds.map((h) => ({
        reason: h.reason,
        hasReasonNotes: Boolean(h.reasonNotes),
      }));
      const holdDetails = holds.map((h) => ({
        reason: h.reason,
        reasonNotes: h.reasonNotes
          ? wrapUntrustedField("fulfillmentHold.reasonNotes", h.reasonNotes, { maxChars: 1000 })
          : null,
      }));
      const fulfillmentOrders = rawFulfillmentOrders
        ? rawFulfillmentOrders.map((fo) => ({
            ...fo,
            fulfillmentHolds: Array.isArray(fo.fulfillmentHolds)
              ? (fo.fulfillmentHolds as FulfillmentHoldPayload[]).map((h) => {
                  const { reasonNotes, ...rest } = h;
                  void reasonNotes;
                  return rest;
                })
              : fo.fulfillmentHolds,
          }))
        : result?.fulfillmentOrders;
      const safeResult = { ...result, fulfillmentOrders };
      return buildSafeOutput(
        {
          orderId: id,
          fulfillmentOrderCount: rawFulfillmentOrders ? rawFulfillmentOrders.length : 0,
          holdSummary,
        },
        { ...safeResult, holdDetails }
      );
    },
    "List fulfillment orders for a Shopify order (includes hold state and assigned location)",
    { sideEffect: "read" }
  ),
  "release-fulfillment-hold": createCommand(
    z.object({
      fulfillmentOrderId: z
        .string()
        .regex(
          /^gid:\/\/shopify\/FulfillmentOrder\/\d+$/,
          "fulfillmentOrderId must be a FulfillmentOrder GID (gid://shopify/FulfillmentOrder/<id>)"
        )
        .describe("Full FulfillmentOrder GID to release"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { fulfillmentOrderId } = args as { fulfillmentOrderId: string };
      return client.releaseFulfillmentHold(fulfillmentOrderId);
    },
    "Release a hold on a fulfillment order (e.g. an app-set INCORRECT_ADDRESS auto-hold)",
    { sideEffect: "write" }
  ),

  "create-return": createCommand(
    z.object({
      orderNumber: z.string().min(1).describe("Order number"),
      lineItems: z.string().optional().describe("Items to return as JSON: [{\"sku\":\"X\",\"quantity\":1}]"),
      returnReason: z.enum([
        "DEFECTIVE", "WRONG_ITEM", "STYLE", "SIZE_TOO_SMALL",
        "SIZE_TOO_LARGE", "UNWANTED", "OTHER", "UNKNOWN", "COLOR",
      ]).optional().describe("Return reason (default: OTHER)"),
      notify: cliTypes.bool().optional().describe("Send email to customer (default: false)"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { orderNumber, lineItems, returnReason, notify } = args as {
        orderNumber: string;
        lineItems?: string;
        returnReason?: string;
        notify?: boolean;
      };
      return client.createReturn(orderNumber, {
        lineItems: lineItems ? JSON.parse(lineItems) : undefined,
        returnReason,
        notifyCustomer: notify,
      });
    },
    "Create a return for a fulfilled order",
    { sideEffect: "write" }
  ),

  "create-reverse-delivery": createCommand(
    z.object({
      returnId: z.string().min(1).describe("Return GID (gid://shopify/Return/...)"),
      trackingNumber: z.string().min(1).describe("Tracking number for the return shipment"),
      trackingCompany: z.string().optional().describe("Carrier name (default: UPS)"),
      trackingUrl: z.string().optional().describe("Tracking URL"),
      labelUrl: z.string().optional().describe("URL of the return label image (PNG/PDF)"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { returnId, trackingNumber, trackingCompany, trackingUrl, labelUrl } = args as {
        returnId: string;
        trackingNumber: string;
        trackingCompany?: string;
        trackingUrl?: string;
        labelUrl?: string;
      };
      return client.createReverseDelivery(returnId, trackingNumber, {
        trackingCompany,
        trackingUrl,
        labelUrl,
      });
    },
    "Attach return shipping/tracking to a return",
    { sideEffect: "write" }
  ),

  "update-reverse-delivery-shipping": createCommand(
    z.object({
      reverseDeliveryId: z.string().min(1).describe("Reverse delivery GID (gid://shopify/ReverseDelivery/...)"),
      trackingNumber: z.string().min(1).describe("New tracking number for the return shipment"),
      trackingCompany: z.string().optional().describe("Carrier name (default: UPS)"),
      trackingUrl: z.string().optional().describe("Tracking URL"),
      labelUrl: z.string().optional().describe("URL of the return label image (PNG/PDF)"),
      notifyCustomer: cliTypes.bool().optional().describe("Send notification email (default: false)"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { reverseDeliveryId, trackingNumber, trackingCompany, trackingUrl, labelUrl, notifyCustomer } = args as {
        reverseDeliveryId: string;
        trackingNumber: string;
        trackingCompany?: string;
        trackingUrl?: string;
        labelUrl?: string;
        notifyCustomer?: boolean;
      };
      return client.updateReverseDeliveryShipping(reverseDeliveryId, trackingNumber, {
        trackingCompany,
        trackingUrl,
        labelUrl,
        notifyCustomer,
      });
    },
    "Update tracking/label on an existing return reverse delivery",
    { sideEffect: "write" }
  ),

  "reverse-fulfillment-order-dispose": createCommand(
    z.object({
      dispositionInputs: z.string().min(1).describe(
        "JSON array of {reverseFulfillmentOrderLineItemId,quantity,dispositionType,locationId?}"
      ),
      confirmation: z.string().optional().describe(
        `To execute, repeat the exact phrase ${REVERSE_DISPOSAL_CONFIRMATION}; otherwise the command dry-runs`
      ),
    }),
    async (args, client: ShopifyMCPClient, globals) => {
      const { dispositionInputs, confirmation } = args as {
        dispositionInputs: string;
        confirmation?: string;
      };
      if (confirmation !== undefined && confirmation !== REVERSE_DISPOSAL_CONFIRMATION) {
        throw new Error(
          "reverse-fulfillment-order-dispose: --confirmation must exactly equal " +
          REVERSE_DISPOSAL_CONFIRMATION
        );
      }
      const inputs = parseJsonArg<ReverseFulfillmentDispositionInput[]>(
        "reverse-fulfillment-order-dispose",
        "disposition-inputs",
        dispositionInputs,
        ReverseDispositionInputsSchema
      );
      for (const input of inputs) {
        if (input.dispositionType === "RESTOCKED" && !input.locationId) {
          throw new Error(
            "reverse-fulfillment-order-dispose: RESTOCKED dispositions require locationId"
          );
        }
      }

      const confirmed = confirmation === REVERSE_DISPOSAL_CONFIRMATION && !globals.dryRun;
      return client.disposeReverseFulfillmentOrder(inputs, {
        dryRun: !confirmed,
        confirmation: confirmed ? REVERSE_DISPOSAL_CONFIRMATION : undefined,
      });
    },
    "Dispose reverse-fulfillment items; dry-runs unless the exact confirmation phrase is supplied",
    {
      sideEffect: "destructive",
      requiresConfirmation: false,
      dryRunSupported: true,
    }
  ),

  "list-blogs": createCommand(
    z.object({
      limit: cliTypes.limit(50, 250),
      pageInfo: z.string().optional().describe("Cursor for the next page (from a previous response)"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { limit, pageInfo } = args as { limit: number; pageInfo?: string };
      const { blogs, nextPageInfo } = await client.listBlogs({ limit, pageInfo });
      const shopDomain = client.getStoreDomain();
      const wrappedBlogs = blogs.map((b: any) => ({
        metadata: {
          id: b.id,
          handle: b.handle,
          createdAt: b.created_at,
          updatedAt: b.updated_at,
          commentable: b.commentable,
        },
        content: {
          title: wrapUntrustedField("title", b.title, { maxChars: 500 }),
          tags: wrapUntrustedField("tags", b.tags, { maxChars: 1000 }),
        },
      }));

      return buildSafeOutput(
        { command: "list-blogs", count: wrappedBlogs.length, nextPageInfo, shopDomain },
        { blogs: wrappedBlogs }
      );
    },
    "List Shopify blogs (REST). Cursor via --page-info.",
    { sideEffect: "read" }
  ),

  "list-articles": createCommand(
    z.object({
      blogId: z.string().min(1).describe("Numeric blog id (from list-blogs)"),
      limit: cliTypes.limit(50, 250),
      since: z.string().optional().describe("ISO timestamp — restrict to articles with updated_at >= since"),
      pageInfo: z.string().optional().describe("Cursor for the next page (from a previous response)"),
      inlineBody: cliTypes.bool().optional().describe("Include body_html on each article (wrapped at BODY length). Eliminates the per-article get-article round-trip the blog connector does by default."),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { blogId, limit, since, pageInfo, inlineBody } = args as {
        blogId: string; limit: number; since?: string; pageInfo?: string; inlineBody?: boolean;
      };
      const { articles, nextPageInfo } = await client.listArticles(blogId, { limit, since, pageInfo });
      const wrappedArticles = articles.map((a: any) => ({
        metadata: {
          id: a.id,
          blogId: a.blog_id,
          handle: a.handle,
          published: a.published_at != null,
          publishedAt: a.published_at,
          createdAt: a.created_at,
          updatedAt: a.updated_at,
          imageSrc: a.image?.src,
        },
        content: {
          title: wrapUntrustedField("title", a.title, { maxChars: 500 }),
          author: wrapUntrustedField("author", a.author, { maxChars: 200 }),
          summaryHtml: wrapUntrustedField("summary_html", a.summary_html, { maxChars: 4000, convertHtml: true }),
          tags: wrapUntrustedField("tags", a.tags, { maxChars: 1000 }),
          ...(inlineBody
            ? {
                bodyHtml: wrapUntrustedField("body_html", a.body_html, { maxChars: 8000, convertHtml: true }),
              }
            : {}),
        },
      }));

      return buildSafeOutput(
        { command: "list-articles", blogId, count: wrappedArticles.length, nextPageInfo, inlineBody: !!inlineBody },
        { articles: wrappedArticles }
      );
    },
    "List articles in a Shopify blog (REST). Use --since for incremental sync, --page-info for pagination, --inline-body to fold body_html into each entry.",
    { sideEffect: "read" }
  ),

  "get-article": createCommand(
    z.object({
      id: z.string().min(1).describe("Numeric article id"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { id } = args as { id: string };
      const article = await client.getArticleById(id);
      const a = article ?? {};

      return buildSafeOutput(
        {
          command: "get-article",
          id: a.id,
          blogId: a.blog_id,
          handle: a.handle,
          publishedAt: a.published_at,
          createdAt: a.created_at,
          updatedAt: a.updated_at,
          imageSrc: a.image?.src,
          imageAlt: a.image?.alt,
          templateSuffix: a.template_suffix,
          userId: a.user_id,
        },
        {
          title: wrapUntrustedField("title", a.title, { maxChars: 500 }),
          author: wrapUntrustedField("author", a.author, { maxChars: 200 }),
          bodyHtml: wrapUntrustedField("body_html", a.body_html, { maxChars: 32000, convertHtml: true }),
          summaryHtml: wrapUntrustedField("summary_html", a.summary_html, { maxChars: 4000, convertHtml: true }),
          tags: wrapUntrustedField("tags", a.tags, { maxChars: 1000 }),
        }
      );
    },
    "Fetch a single Shopify article by id (REST). Returns the full body_html.",
    { sideEffect: "read" }
  ),

  "get-article-raw": createCommand(
    z.object({
      id: z.string().min(1).describe("Numeric article id"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { id } = args as { id: string };
      const article = await client.getArticleRawById(id);
      const a = article ?? {};
      return buildSafeOutput(
        {
          command: "get-article-raw",
          id: a.id,
          blogId: a.blog_id,
          handle: a.handle,
          updatedAt: a.updated_at,
        },
        {
          title: wrapUntrustedField("title", a.title, { maxChars: 500 }),
          bodyHtmlRaw: wrapUntrustedField("body_html", a.body_html, { maxChars: 200000 }),
        }
      );
    },
    "Fetch a single article's VERBATIM body_html (REST, uncached) for exact-string edits.",
    { sideEffect: "read" }
  ),

  "update-article": createCommand(
    z.object({
      id: z.string().min(1).describe("Numeric article id"),
      bodyHtml: z.string().optional().describe("New verbatim body_html (raw HTML — replaces the whole body)"),
      title: z.string().optional().describe("New article title (handle/slug is unaffected)"),
      summaryHtml: z.string().optional().describe("New summary_html"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { id, bodyHtml, title, summaryHtml } = args as {
        id: string; bodyHtml?: string; title?: string; summaryHtml?: string;
      };
      if (bodyHtml === undefined && title === undefined && summaryHtml === undefined) {
        throw new Error("update-article: provide at least one of --body-html, --title, --summary-html");
      }
      const updated = await client.updateArticle(id, { bodyHtml, title, summaryHtml });
      const u = updated ?? {};
      return buildSafeOutput(
        {
          command: "update-article",
          id: u.id,
          handle: u.handle,
          updatedAt: u.updated_at,
        },
        {
          title: wrapUntrustedField("title", u.title, { maxChars: 500 }),
          bodyHtmlRaw: wrapUntrustedField("body_html", u.body_html, { maxChars: 200000 }),
        }
      );
    },
    "Update an article's body_html / title / summary_html (REST PUT).",
    { sideEffect: "write" }
  ),

  "get-collection": createCommand(
    z.object({
      id: z.string().min(1).describe("Numeric collection id (custom or smart)"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { id } = args as { id: string };
      const collection = await client.getCollectionRawById(id);
      const c = collection ?? {};
      return buildSafeOutput(
        {
          command: "get-collection",
          id: c.id,
          handle: c.handle,
          updatedAt: c.updated_at,
          publishedScope: c.published_scope,
          sortOrder: c.sort_order,
        },
        {
          title: wrapUntrustedField("title", c.title, { maxChars: 500 }),
          bodyHtmlRaw: wrapUntrustedField("body_html", c.body_html, { maxChars: 200000 }),
        }
      );
    },
    "Fetch a single collection's VERBATIM body_html (REST, uncached).",
    { sideEffect: "read" }
  ),

  "update-collection": createCommand(
    z.object({
      id: z.string().min(1).describe("Numeric collection id"),
      kind: z.enum(["custom", "smart"]).describe("Collection type — determines the REST endpoint (custom_collections vs smart_collections)"),
      bodyHtml: z.string().describe("New verbatim body_html (collection description)"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { id, kind, bodyHtml } = args as {
        id: string; kind: "custom" | "smart"; bodyHtml: string;
      };
      const updated = await client.updateCollectionDescription(id, kind, bodyHtml);
      const u = updated ?? {};
      return buildSafeOutput(
        {
          command: "update-collection",
          id: u.id,
          handle: u.handle,
          updatedAt: u.updated_at,
        },
        {
          title: wrapUntrustedField("title", u.title, { maxChars: 500 }),
          bodyHtmlRaw: wrapUntrustedField("body_html", u.body_html, { maxChars: 200000 }),
        }
      );
    },
    "Update a collection's description body_html (REST PUT).",
    { sideEffect: "write" }
  ),

  ...cacheCommands<ShopifyMCPClient>(),
};

let isCliEntry = false;
try {
  isCliEntry =
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
} catch {
  isCliEntry = false;
}

if (isCliEntry) {
  runCli(commands, ShopifyMCPClient, {
    programName: "shopify-cli",
    description: "Shopify store management via MCP",
  });
}
