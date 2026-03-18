#!/usr/bin/env npx tsx
/**
 * Shopify Order Manager CLI
 *
 * Zod-validated CLI for Shopify store management via MCP.
 */

import { z, createCommand, runCli, cacheCommands, cliTypes, wrapUntrustedField, buildSafeOutput } from "@local/cli-utils";
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
      const result = await client.getProducts({ searchTitle: search, limit });

      const products = (result?.products || result?.data || result || []);
      const wrappedProducts = (Array.isArray(products) ? products : []).map((p: any) => ({
        metadata: {
          id: p.id,
          status: p.status,
          productType: p.productType,
          tags: p.tags,
          variants: p.variants,
        },
        content: {
          title: wrapUntrustedField("title", p.title, { maxChars: 500 }),
          description: wrapUntrustedField("description", p.description || p.descriptionHtml, { maxChars: 8000, convertHtml: !!p.descriptionHtml && !p.description }),
          vendor: wrapUntrustedField("vendor", p.vendor, { maxChars: 200 }),
        },
      }));

      return buildSafeOutput(
        { command: "get-products", count: wrappedProducts.length },
        { products: wrappedProducts }
      );
    },
    "List products with optional search"
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
      const result = await client.getCustomers({ searchQuery: search, limit });

      const customers = (result?.customers || result?.data || result || []);
      const wrappedCustomers = (Array.isArray(customers) ? customers : []).map((c: any) => ({
        metadata: {
          id: c.id,
          ordersCount: c.ordersCount || c.numberOfOrders,
          tags: c.tags,
          createdAt: c.createdAt,
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
          } : null,
        },
      }));

      return buildSafeOutput(
        { command: "get-customers", count: wrappedCustomers.length },
        { customers: wrappedCustomers }
      );
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
      const gidMatch = id.match(/gid:\/\/shopify\/Customer\/(\d+)/);
      const customerId = gidMatch ? gidMatch[1] : id;
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
            metadata: { quantity: li.quantity, sku: li.sku },
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
        status?: string; limit: number; sortKey?: string; reverse?: boolean; after?: string; query?: string;
      };
      const result = await client.getOrders({ status, limit, sortKey, reverse, after, query });

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
          currency: o.totalPriceSet?.shopMoney?.currencyCode || o.currency,
          tags: o.tags,
          fulfillments: o.fulfillments,
          hasNextPage: result?.pageInfo?.hasNextPage,
          endCursor: result?.pageInfo?.endCursor,
        },
        content: {
          customerName: wrapUntrustedField("customer.displayName", o.customer?.displayName, { maxChars: 200 }),
          customerEmail: wrapUntrustedField("customer.email", o.customer?.email || o.email, { maxChars: 200 }),
          note: wrapUntrustedField("note", o.note, { maxChars: 500 }),
          lineItems: (o.lineItems?.nodes || o.lineItems || []).map((li: any) => ({
            metadata: { quantity: li.quantity, sku: li.sku, variantId: li.variant?.id },
            content: {
              title: wrapUntrustedField("lineItem.title", li.title || li.name, { maxChars: 500 }),
            },
          })),
          shippingAddress: o.shippingAddress ? {
            address1: wrapUntrustedField("shippingAddress.address1", o.shippingAddress.address1, { maxChars: 200 }),
            address2: wrapUntrustedField("shippingAddress.address2", o.shippingAddress.address2, { maxChars: 200 }),
            city: wrapUntrustedField("shippingAddress.city", o.shippingAddress.city, { maxChars: 200 }),
            company: wrapUntrustedField("shippingAddress.company", o.shippingAddress.company, { maxChars: 200 }),
          } : null,
        },
      }));

      return buildSafeOutput(
        { command: "get-orders", count: wrappedOrders.length },
        { orders: wrappedOrders }
      );
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
        status?: string; sortKey?: string; reverse?: boolean; query?: string; maxPages: number;
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
          currency: o.totalPriceSet?.shopMoney?.currencyCode || o.currency,
          tags: o.tags,
        },
        content: {
          customerName: wrapUntrustedField("customer.displayName", o.customer?.displayName, { maxChars: 200 }),
          customerEmail: wrapUntrustedField("customer.email", o.customer?.email || o.email, { maxChars: 200 }),
          note: wrapUntrustedField("note", o.note, { maxChars: 500 }),
          lineItems: (o.lineItems?.nodes || o.lineItems || []).map((li: any) => ({
            metadata: { quantity: li.quantity, sku: li.sku },
            content: {
              title: wrapUntrustedField("lineItem.title", li.title || li.name, { maxChars: 500 }),
            },
          })),
        },
      }));

      return buildSafeOutput(
        { command: "get-all-orders", count: wrappedOrders.length, totalFetched: result.totalFetched, hasMore: result.hasMore },
        { orders: wrappedOrders }
      );
    },
    "Get all orders with automatic pagination"
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
          currency: o.totalPriceSet?.shopMoney?.currencyCode || o.currency,
          tags: o.tags,
          fulfillments: o.fulfillments,
          returns: o.returns,
          refunds: o.refunds,
        },
        {
          customerName: wrapUntrustedField("customer.displayName", o.customer?.displayName, { maxChars: 200 }),
          customerEmail: wrapUntrustedField("customer.email", o.customer?.email || o.email, { maxChars: 200 }),
          note: wrapUntrustedField("note", o.note, { maxChars: 500 }),
          lineItems: (o.lineItems?.nodes || o.lineItems || []).map((li: any) => ({
            metadata: { quantity: li.quantity, sku: li.sku, variantId: li.variant?.id },
            content: {
              title: wrapUntrustedField("lineItem.title", li.title || li.name, { maxChars: 500 }),
            },
          })),
          shippingAddress: o.shippingAddress ? {
            address1: wrapUntrustedField("shippingAddress.address1", o.shippingAddress.address1, { maxChars: 200 }),
            address2: wrapUntrustedField("shippingAddress.address2", o.shippingAddress.address2, { maxChars: 200 }),
            city: wrapUntrustedField("shippingAddress.city", o.shippingAddress.city, { maxChars: 200 }),
            company: wrapUntrustedField("shippingAddress.company", o.shippingAddress.company, { maxChars: 200 }),
          } : null,
          billingAddress: o.billingAddress ? {
            address1: wrapUntrustedField("billingAddress.address1", o.billingAddress.address1, { maxChars: 200 }),
            address2: wrapUntrustedField("billingAddress.address2", o.billingAddress.address2, { maxChars: 200 }),
            city: wrapUntrustedField("billingAddress.city", o.billingAddress.city, { maxChars: 200 }),
            company: wrapUntrustedField("billingAddress.company", o.billingAddress.company, { maxChars: 200 }),
          } : null,
        }
      );
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

  "create-fulfillment": createCommand(
    z.object({
      orderNumber: z.string().min(1).describe("Order number (e.g., 1234)"),
      trackingNumber: z.string().min(1).describe("Tracking number"),
      trackingCompany: z.string().optional().describe("Carrier name (default: UPS)"),
      trackingUrl: z.string().optional().describe("Tracking URL"),
      notifyCustomer: cliTypes.bool().optional().describe("Send email to customer (default: false)"),
      lineItems: z.string().optional().describe("Items to fulfill as JSON: [{\"sku\":\"X\",\"quantity\":1}]"),
    }),
    async (args, client: ShopifyMCPClient) => {
      const { orderNumber, trackingNumber, trackingCompany, trackingUrl, notifyCustomer, lineItems } = args as {
        orderNumber: string;
        trackingNumber: string;
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
    "Create fulfillment with tracking for an order"
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
    "Create a return for a fulfilled order"
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
    "Attach return shipping/tracking to a return"
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
    "Update tracking/label on an existing return reverse delivery"
  ),

  // Pre-built cache commands
  ...cacheCommands<ShopifyMCPClient>(),
};

// Run CLI
runCli(commands, ShopifyMCPClient, {
  programName: "shopify-cli",
  description: "Shopify store management via MCP",
});
