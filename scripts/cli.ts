#!/usr/bin/env npx tsx
/**
 * Shopify Order Manager CLI
 *
 * Zod-validated CLI for Shopify store management via MCP.
 */

import { z, createCommand, runCli, cacheCommands, cliTypes } from "@local/cli-utils";
import { ShopifyMCPClient } from "./mcp-client.js";

// Define commands with Zod schemas
const commands = {
  "list-tools": createCommand(
    z.object({}),
    async (_args, client: ShopifyMCPClient) => {
      const tools = await client.listTools();
      return tools.map((t: { name: string; description?: string }) => ({
        name: t.name,
        description: t.description,
      }));
    },
    "List all available MCP tools"
  ),

  // Product commands
  "get-products": createCommand(
    z.object({
      search: z.string().optional().describe("Search products by title"),
      limit: cliTypes.limit(50, 250),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { search, limit } = args as { search?: string; limit: number };
      return client.getProducts({ searchTitle: search, limit });
    },
    "List products with optional search"
  ),

  "get-product": createCommand(
    z.object({
      id: z.string().min(1).describe("Product ID (GraphQL GID format)"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { id } = args as { id: string };
      return client.getProductById(id);
    },
    "Get a product by ID"
  ),

  "create-product": createCommand(
    z.object({
      title: z.string().min(1).describe("Product title"),
      description: z.string().optional().describe("Product description HTML"),
      vendor: z.string().optional().describe("Product vendor"),
      type: z.string().optional().describe("Product type"),
      tags: z.string().optional().describe("Tags (comma-separated)"),
      status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]).optional().describe("Product status"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { title, description, vendor, type, tags, status } = args as {
        title: string;
        description?: string;
        vendor?: string;
        type?: string;
        tags?: string;
        status?: "ACTIVE" | "DRAFT" | "ARCHIVED";
      };
      return client.createProduct({
        title,
        descriptionHtml: description,
        vendor,
        productType: type,
        tags,
        status,
      });
    },
    "Create a new product"
  ),

  // Customer commands
  "get-customers": createCommand(
    z.object({
      search: z.string().optional().describe("Search customers by name/email"),
      limit: cliTypes.limit(50, 250),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { search, limit } = args as { search?: string; limit: number };
      return client.getCustomers({ searchQuery: search, limit });
    },
    "List customers with optional search"
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
    "Update a customer"
  ),

  "get-customer-orders": createCommand(
    z.object({
      id: z.string().min(1).describe("Customer ID (GraphQL GID or numeric)"),
      limit: cliTypes.limit(50, 250),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { id, limit } = args as { id: string; limit: number };
      // Extract numeric ID from GraphQL format if needed
      const gidMatch = id.match(/gid:\/\/shopify\/Customer\/(\d+)/);
      const customerId = gidMatch ? gidMatch[1] : id;
      return client.getCustomerOrders(customerId, limit);
    },
    "Get orders for a customer"
  ),

  // Order commands
  "get-orders": createCommand(
    z.object({
      status: z.string().optional().describe("Order status filter"),
      limit: cliTypes.limit(50, 250),
      sortKey: z.string().optional().describe("Sort key (e.g., CREATED_AT)"),
      reverse: cliTypes.bool().optional().describe("Reverse sort order"),
      after: z.string().optional().describe("Pagination cursor"),
      query: z.string().optional().describe("Query filter (e.g., created_at:>2025-06-01)"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { status, limit, sortKey, reverse, after, query } = args as {
        status?: string;
        limit: number;
        sortKey?: string;
        reverse?: boolean;
        after?: string;
        query?: string;
      };
      return client.getOrders({ status, limit, sortKey, reverse, after, query });
    },
    "List orders with filters"
  ),

  "get-all-orders": createCommand(
    z.object({
      status: z.string().optional().describe("Order status filter"),
      sortKey: z.string().optional().describe("Sort key (e.g., CREATED_AT)"),
      reverse: cliTypes.bool().optional().describe("Reverse sort order"),
      query: z.string().optional().describe("Query filter (e.g., created_at:>2025-06-01)"),
      maxPages: cliTypes.int(1, 50).default(10).describe("Max pages to fetch"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { status, sortKey, reverse, query, maxPages } = args as {
        status?: string;
        sortKey?: string;
        reverse?: boolean;
        query?: string;
        maxPages: number;
      };
      return client.getAllOrders({ status, sortKey, reverse, query, maxPages });
    },
    "Get all orders with automatic pagination"
  ),

  "get-order": createCommand(
    z.object({
      id: z.string().min(1).describe("Order ID (GraphQL GID format)"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { id } = args as { id: string };
      return client.getOrderById(id);
    },
    "Get an order by ID"
  ),

  "update-order": createCommand(
    z.object({
      id: z.string().min(1).describe("Order ID (GraphQL GID format)"),
      tags: z.string().optional().describe("Tags (comma-separated)"),
      email: z.string().email().optional().describe("Customer email"),
      note: z.string().optional().describe("Order note"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { id, tags, email, note } = args as {
        id: string;
        tags?: string;
        email?: string;
        note?: string;
      };
      return client.updateOrder(id, { tags, email, note });
    },
    "Update an order"
  ),

  "update-fulfillment-tracking": createCommand(
    z.object({
      fulfillmentId: z.string().min(1).describe("Fulfillment GID (gid://shopify/Fulfillment/...)"),
      trackingNumber: z.string().min(1).describe("New tracking number"),
      trackingCompany: z.string().optional().describe("Carrier name (e.g., UPS, Royal Mail)"),
      trackingUrl: z.string().optional().describe("Tracking URL"),
      notifyCustomer: cliTypes.bool().optional().describe("Send email to customer"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { fulfillmentId, trackingNumber, trackingCompany, trackingUrl, notifyCustomer } = args as {
        fulfillmentId: string;
        trackingNumber: string;
        trackingCompany?: string;
        trackingUrl?: string;
        notifyCustomer?: boolean;
      };
      return client.updateFulfillmentTracking(fulfillmentId, trackingNumber, {
        trackingCompany,
        trackingUrl,
        notifyCustomer,
      });
    },
    "Update tracking number on a fulfillment"
  ),

  // Pre-built cache commands
  ...cacheCommands<ShopifyMCPClient>(),
};

// Run CLI
runCli(commands, ShopifyMCPClient, {
  programName: "shopify-cli",
  description: "Shopify store management via MCP",
});
