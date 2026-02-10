/**
 * Shopify MCP Client
 *
 * Wrapper client for Shopify GraphQL Admin API via MCP server.
 * Handles orders, customers, and products.
 * Configuration from config.json with store domain and API credentials.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { PluginCache, TTL, createCacheKey } from "@local/plugin-cache";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface MCPConfig {
  mcpServer: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
  storeDomain: string;
}

// Initialize cache with namespace
const cache = new PluginCache({
  namespace: "shopify-order-manager",
  defaultTTL: TTL.FIVE_MINUTES,
});

export class ShopifyMCPClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private config: MCPConfig;
  private connected: boolean = false;
  private cacheDisabled: boolean = false;

  constructor() {
    // When compiled, __dirname is dist/, so look in parent for config.json
    const configPath = join(__dirname, "..", "config.json");
    this.config = JSON.parse(readFileSync(configPath, "utf-8"));
  }

  // ============================================
  // CONNECTION MANAGEMENT
  // ============================================

  /**
   * Establishes connection to the MCP server.
   * Called automatically by other methods when needed.
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    const env = {
      ...process.env,
      ...this.config.mcpServer.env,
    };

    this.transport = new StdioClientTransport({
      command: this.config.mcpServer.command,
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

  /**
   * Disconnects from the MCP server.
   */
  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }

  // ============================================
  // CACHE CONTROL
  // ============================================

  /**
   * Disables caching for all subsequent requests.
   */
  disableCache(): void {
    this.cacheDisabled = true;
    cache.disable();
  }

  /**
   * Re-enables caching after it was disabled.
   */
  enableCache(): void {
    this.cacheDisabled = false;
    cache.enable();
  }

  /**
   * Returns cache statistics including hit/miss counts.
   */
  getCacheStats() {
    return cache.getStats();
  }

  /**
   * Clears all cached data.
   * @returns Number of cache entries cleared
   */
  clearCache(): number {
    return cache.clear();
  }

  /**
   * Invalidates a specific cache entry by key.
   * @param key - The cache key to invalidate
   */
  invalidateCacheKey(key: string): boolean {
    return cache.invalidate(key);
  }

  // ============================================
  // MCP TOOLS
  // ============================================

  /**
   * Lists available MCP tools.
   * @returns Array of tool definitions
   */
  async listTools(): Promise<any[]> {
    await this.connect();
    const result = await this.client!.listTools();
    return result.tools;
  }

  /**
   * Calls an MCP tool with arguments.
   * @param name - Tool name
   * @param args - Tool arguments
   * @returns Parsed tool response
   * @throws {Error} If tool call fails
   */
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

  // ============================================
  // PRODUCT OPERATIONS
  // ============================================

  /**
   * Lists products with optional search and pagination.
   *
   * @param options - Filter options
   * @param options.searchTitle - Search by title
   * @param options.limit - Maximum products to return
   * @returns Array of product objects
   *
   * @cached TTL: 1 hour
   *
   * @example
   * const products = await client.getProducts({ searchTitle: "Product A" });
   */
  async getProducts(options?: { searchTitle?: string; limit?: number }): Promise<any> {
    const cacheKey = createCacheKey("products", {
      search: options?.searchTitle,
      limit: options?.limit,
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const args: Record<string, any> = {};
        if (options?.searchTitle) args.searchTitle = options.searchTitle;
        if (options?.limit) args.limit = options.limit;
        return this.callTool("get-products", args);
      },
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Retrieves a single product by ID.
   *
   * @param productId - Shopify product ID (numeric or GID)
   * @returns Product object
   *
   * @cached TTL: 1 hour
   */
  async getProductById(productId: string): Promise<any> {
    const cacheKey = createCacheKey("product", { id: productId });

    return cache.getOrFetch(
      cacheKey,
      () => this.callTool("get-product-by-id", { productId }),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Creates a new product.
   *
   * @param product - Product data
   * @param product.title - Product title (required)
   * @param product.descriptionHtml - HTML description
   * @param product.vendor - Vendor name
   * @param product.productType - Product type
   * @param product.tags - Comma-separated tags
   * @param product.status - Status: "ACTIVE", "DRAFT", "ARCHIVED"
   * @returns Created product object
   *
   * @invalidates products/*
   */
  async createProduct(product: {
    title: string;
    descriptionHtml?: string;
    vendor?: string;
    productType?: string;
    tags?: string;
    status?: string;
  }): Promise<any> {
    const result = await this.callTool("createProduct", product);
    // Invalidate product caches after mutation
    cache.invalidatePattern(/^products/);
    return result;
  }

  // ============================================
  // CUSTOMER OPERATIONS
  // ============================================

  /**
   * Lists customers with optional search.
   *
   * @param options - Filter options
   * @param options.searchQuery - Search query (name, email, etc.)
   * @param options.limit - Maximum customers to return
   * @returns Array of customer objects
   *
   * @cached TTL: 15 minutes
   *
   * @example
   * const customers = await client.getCustomers({ searchQuery: "john@example.com" });
   */
  async getCustomers(options?: { searchQuery?: string; limit?: number }): Promise<any> {
    const cacheKey = createCacheKey("customers", {
      search: options?.searchQuery,
      limit: options?.limit,
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const args: Record<string, any> = {};
        if (options?.searchQuery) args.searchQuery = options.searchQuery;
        if (options?.limit) args.limit = options.limit;
        return this.callTool("get-customers", args);
      },
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Updates a customer's details.
   *
   * @param customerId - Shopify customer ID
   * @param updates - Fields to update
   * @returns Updated customer object
   *
   * @invalidates customer/*
   */
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
    // Invalidate customer caches after mutation
    cache.invalidatePattern(/^customer/);
    return result;
  }

  /**
   * Gets orders for a specific customer.
   *
   * @param customerId - Shopify customer ID
   * @param limit - Maximum orders to return
   * @returns Array of order objects
   *
   * @cached TTL: 5 minutes
   */
  async getCustomerOrders(customerId: string, limit?: number): Promise<any> {
    const cacheKey = createCacheKey("customer_orders", { id: customerId, limit });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const args: Record<string, any> = { customerId };
        if (limit) args.limit = limit;
        return this.callTool("get-customer-orders", args);
      },
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  // ============================================
  // ORDER OPERATIONS
  // ============================================

  /**
   * Lists orders with optional filtering and pagination.
   *
   * @param options - Filter and pagination options
   * @param options.status - Filter by status
   * @param options.limit - Maximum orders to return (max 250)
   * @param options.sortKey - Sort field (e.g., "CREATED_AT", "UPDATED_AT")
   * @param options.reverse - Reverse sort order
   * @param options.after - Pagination cursor
   * @param options.query - Query filter (e.g., "created_at:>2025-01-01")
   * @returns Orders with pagination info
   *
   * @cached TTL: 5 minutes
   *
   * @example
   * const { orders, pageInfo } = await client.getOrders({ status: "unfulfilled", limit: 50 });
   */
  async getOrders(options?: {
    status?: string;
    limit?: number;
    sortKey?: string;
    reverse?: boolean;
    after?: string;  // Pagination cursor
    query?: string;  // Query filter (e.g., "created_at:>2025-01-01")
  }): Promise<any> {
    const cacheKey = createCacheKey("orders", {
      status: options?.status,
      limit: options?.limit,
      sortKey: options?.sortKey,
      reverse: options?.reverse,
      after: options?.after,
      query: options?.query,
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const args: Record<string, any> = {};
        if (options?.status) args.status = options.status;
        if (options?.limit) args.first = options.limit;  // API uses 'first' not 'limit'
        if (options?.sortKey) args.sortKey = options.sortKey;
        if (options?.reverse !== undefined) args.reverse = options.reverse;
        if (options?.after) args.after = options.after;
        if (options?.query) args.query = options.query;
        return this.callTool("get-orders", args);
      },
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Gets all orders with automatic pagination.
   *
   * Not cached due to potential size. Use with caution.
   *
   * @param options - Filter options
   * @param options.status - Filter by status
   * @param options.sortKey - Sort field
   * @param options.reverse - Reverse sort order
   * @param options.query - Query filter
   * @param options.maxPages - Safety limit (default: 10, max 2500 orders)
   * @returns Object with orders array, count, and hasMore flag
   */
  async getAllOrders(options?: {
    status?: string;
    sortKey?: string;
    reverse?: boolean;
    query?: string;
    maxPages?: number;  // Safety limit, default 10 (2500 orders max)
  }): Promise<{ orders: any[]; totalFetched: number; hasMore: boolean }> {
    const allOrders: any[] = [];
    let cursor: string | undefined = undefined;
    let hasNextPage = true;
    let pageCount = 0;
    const maxPages = options?.maxPages ?? 10;

    while (hasNextPage && pageCount < maxPages) {
      const result = await this.getOrders({
        status: options?.status,
        limit: 250,  // Max per request
        sortKey: options?.sortKey ?? "CREATED_AT",
        reverse: options?.reverse ?? true,  // Newest first by default
        after: cursor,
        query: options?.query,
      });

      // Handle response - may be array or object with pageInfo
      if (Array.isArray(result)) {
        allOrders.push(...result);
        hasNextPage = false;  // No pagination info, assume done
      } else if (result.orders) {
        allOrders.push(...result.orders);
        hasNextPage = result.pageInfo?.hasNextPage ?? false;
        cursor = result.pageInfo?.endCursor;
      } else {
        // Unknown format, treat as single page
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

  /**
   * Retrieves a single order by ID.
   *
   * @param orderId - Shopify order ID (numeric or GID)
   * @returns Order object with full details
   *
   * @cached TTL: 5 minutes
   */
  async getOrderById(orderId: string): Promise<any> {
    const cacheKey = createCacheKey("order", { id: orderId });

    return cache.getOrFetch(
      cacheKey,
      () => this.callTool("get-order-by-id", { orderId }),
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Updates tracking information on an existing fulfillment.
   *
   * @param fulfillmentId - Fulfillment GID (gid://shopify/Fulfillment/...)
   * @param trackingNumber - New tracking number
   * @param options - Optional tracking details
   * @param options.trackingCompany - Carrier name (e.g., UPS, Royal Mail)
   * @param options.trackingUrl - Tracking URL
   * @param options.notifyCustomer - Send email to customer (default: false)
   * @returns Updated fulfillment object
   *
   * @invalidates order/*
   */
  async updateFulfillmentTracking(
    fulfillmentId: string,
    trackingNumber: string,
    options?: {
      trackingCompany?: string;
      trackingUrl?: string;
      notifyCustomer?: boolean;
    }
  ): Promise<any> {
    const result = await this.callTool("update-fulfillment-tracking", {
      fulfillmentId,
      trackingNumber,
      ...options,
    });
    cache.invalidatePattern(/^order/);
    return result;
  }

  /**
   * Updates an order's details.
   *
   * @param orderId - Shopify order ID
   * @param updates - Fields to update
   * @param updates.tags - Comma-separated tags
   * @param updates.email - Customer email
   * @param updates.note - Order note
   * @param updates.customAttributes - Custom attributes
   * @param updates.metafields - Metafields
   * @param updates.shippingAddress - Shipping address
   * @returns Updated order object
   *
   * @invalidates order/*
   */
  async updateOrder(orderId: string, updates: {
    tags?: string;
    email?: string;
    note?: string;
    customAttributes?: any;
    metafields?: any;
    shippingAddress?: any;
  }): Promise<any> {
    const result = await this.callTool("update-order", { id: orderId, ...updates });
    // Invalidate order caches after mutation
    cache.invalidatePattern(/^order/);
    return result;
  }

  // ============================================
  // UTILITY
  // ============================================

  /**
   * Gets the configured store domain.
   *
   * @returns Store domain (e.g., "mystore.myshopify.com")
   */
  getStoreDomain(): string {
    return this.config.storeDomain;
  }
}

export default ShopifyMCPClient;
