<!-- AUTO-GENERATED README — DO NOT EDIT. Changes will be overwritten on next publish. -->
# claude-code-plugin-shopify

Dedicated agent for Shopify e-commerce operations with isolated MCP access

![Version](https://img.shields.io/badge/version-1.11.0-blue) ![License: MIT](https://img.shields.io/badge/License-MIT-green) ![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

## Features

- Order
- **get-orders** — List/search orders (single page)
- **get-all-orders** — List/search orders across all pages (auto-paginated)
- **get-order** — Get order by ID
- **update-order** — Update order details
- **create-fulfillment** — Fulfill an order with optional tracking
- **update-fulfillment-tracking** — Update or clear fulfillment tracking
- Customer
- **get-customers** — Search customers
- **update-customer** — Update customer
- **get-customer-orders** — Get customer's orders
- Product
- **get-products** — Search products
- **get-product** — Get product by ID
- **export-product-catalogue** — Stream every Shopify product page to an atomic local JSON artifact and return completeness metadata
- **create-product** — Create a product and set its required default-variant price
- Shopify Inventory
- **get-inventory-items** — Read inventory-item IDs and tracked/item metadata for up to 100 variants of one Shopify product; inspect `metadata.completeness` and treat a 100-row result as incomplete
- **get-inventory-levels** — Read Shopify quantities and location IDs at up to 50 locations for one inventory item; inspect `metadata.completeness` and treat a 50-row result as incomplete
- **inventory-set-quantities** — Preview or set absolute Shopify `available` or `on_hand` quantities using idempotency and compare-and-set; mutation requires the approved preview token and global `--confirm`

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- MCP server binary for the target service (configured via `config.json`)

## Quick Start

```bash
git clone https://github.com/bigl34/claude-code-plugin-shopify.git
cd claude-code-plugin-shopify
cp config.template.json config.json  # fill in your credentials
npm --prefix scripts install
```

```bash
npm --prefix scripts run cli -- get-orders
```

## Installation

1. Clone this repository
2. Copy `config.template.json` to `config.json` and fill in your credentials
3. Install dependencies:
   ```bash
   cd scripts && npm install
   ```
4. Ensure the MCP server binary is available on your system (see the service's documentation)

## Available Commands

### Order Commands

| Command                       | Description                                          | Options                                                                                                     |
| ----------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `get-orders`                  | List/search orders (single page)                     | `--status`, `--limit`, `--query`, `--sort-key`, `--reverse`, `--after`                                      |
| `get-all-orders`              | List/search orders across all pages (auto-paginated) | `--status`, `--query`, `--sort-key`, `--reverse`, `--max-pages`                                             |
| `get-order`                   | Get order by ID                                      | `--id` (required)                                                                                           |
| `update-order`                | Update order details                                 | `--id`, `--tags`, `--email`, `--note`                                                                       |
| `create-fulfillment`          | Fulfill an order with optional tracking              | `--order-number` (required), `--tracking-number`, `--tracking-company`, `--notify-customer`, `--line-items` |
| `update-fulfillment-tracking` | Update or clear fulfillment tracking                 | `--fulfillmentId`, `--trackingNumber`, `--trackingCompany`, `--trackingUrl`, `--notifyCustomer`, `--clear`  |

### Customer Commands

| Command               | Description           | Options                                          |
| --------------------- | --------------------- | ------------------------------------------------ |
| `get-customers`       | Search customers      | `--search`, `--limit`                            |
| `update-customer`     | Update customer       | `--id`, `--email`, `--phone`, `--note`, `--tags` |
| `get-customer-orders` | Get customer's orders | `--id` (required), `--limit`                     |

### Product Commands

| Command                    | Description                                                                                         | Options                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `get-products`             | Search products                                                                                     | `--search`, `--limit`                                                                          |
| `get-product`              | Get product by ID                                                                                   | `--id` (required)                                                                              |
| `export-product-catalogue` | Stream every Shopify product page to an atomic local JSON artifact and return completeness metadata | `--output-file` (required), `--page-size`, `--max-pages`, `--max-page-attempts`, `--overwrite` |
| `create-product`           | Create a product and set its required default-variant price                                         | `--title`, `--price` (required), `--description`, `--vendor`, `--type`, `--tags`, `--status`   |

### Shopify Inventory Commands

| Command                    | Description                                                                                                                                                                    | Options                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get-inventory-items`      | Read inventory-item IDs and tracked/item metadata for up to 100 variants of one Shopify product; inspect `metadata.completeness` and treat a 100-row result as incomplete      | `--product-id` (required; numeric or GID)                                                                                                                               |
| `get-inventory-levels`     | Read Shopify quantities and location IDs at up to 50 locations for one inventory item; inspect `metadata.completeness` and treat a 50-row result as incomplete                 | `--inventory-item-id` (required; numeric or GID)                                                                                                                        |
| `inventory-set-quantities` | Preview or set absolute Shopify `available` or `on_hand` quantities using idempotency and compare-and-set; mutation requires the approved preview token and global `--confirm` | `--idempotency-key`, `--reason`, `--name`, `--quantities` (required), `--reference-document-uri`, `--dry-run` (preview only), `--preview-token` (required for mutation) |

### Common Options

| Option                 | Description                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `--id <id>`            | Shopify GraphQL ID (e.g., "gid://shopify/Order/12345")                                                                |
| `--search <query>`     | Search term                                                                                                           |
| `--status <status>`    | Order status filter                                                                                                   |
| `--limit <number>`     | Maximum records to return (get-orders, single page)                                                                   |
| `--query <filter>`     | Shopify search-syntax filter (e.g., `name:YOUR_ORDER_NUMBER`, `created_at:>2025-06-01`)                               |
| `--sort-key <key>`     | Sort key (e.g., `CREATED_AT`)                                                                                         |
| `--reverse`            | Reverse the sort order                                                                                                |
| `--after <cursor>`     | Pagination cursor from a previous page (get-orders)                                                                   |
| `--max-pages <n>`      | Max pages to fetch (get-all-orders, default 10)                                                                       |
| `--output-file <path>` | Catalogue export destination; a new target needs no confirmation, but overwrite requires `--overwrite true --confirm` |
| `--tags <tags>`        | Comma-separated tags                                                                                                  |

## Usage Examples

```bash
# List recent orders
npm --prefix "scripts" run cli -- get-orders --limit 10

# Find an order by its order number (e.g. #YOUR_ORDER_NUMBER)
npm --prefix "scripts" run cli -- get-orders --query "name:YOUR_ORDER_NUMBER"

# Get a specific order by ID
npm --prefix "scripts" run cli -- get-order --id "gid://shopify/Order/12345"

# Search for customers
npm --prefix "scripts" run cli -- get-customers --search "john@example.com"

# Get customer's order history
npm --prefix "scripts" run cli -- get-customer-orders --id "gid://shopify/Customer/12345"

# Search products
npm --prefix "scripts" run cli -- get-products --search "ProductName Product"

# Inspect the Shopify-side inventory item IDs for one product
npm --prefix "scripts" run cli -- get-inventory-items \
  --product-id "gid://shopify/Product/12345"

# Read Shopify-side quantities at up to 50 locations for one inventory item;
# a 50-row response is explicitly incomplete because the fork has no pageInfo
npm --prefix "scripts" run cli -- get-inventory-levels \
  --inventory-item-id "gid://shopify/InventoryItem/23456"

# Export the complete Shopify product-list catalogue to a new restricted file
npm --prefix "scripts" run cli -- export-product-catalogue \
  --output-file "$HOME/biz/var/shopify-product-catalogue.json"

# Create a draft product with the Hide tag and verify its GBP 25.00 default-variant price
# (run after ordinary approval or canonical /create-product workflow authorization)
npm --prefix "scripts" run cli -- create-product \
  --title "Brake Lever" --price "25.00" --tags "Hide" --confirm

# Update order tags
npm --prefix "scripts" run cli -- update-order --id "gid://shopify/Order/12345" --tags "urgent,priority"

# Partially fulfill selected lines by stable Shopify line item ID
npm --prefix "scripts" run cli -- create-fulfillment \
  --order-number "YOUR_ORDER_NUMBER" --tracking-number "1Z999AA10123456784" \
  --tracking-company "UPS" --notify-customer false \
  --line-items '[{"lineItemId":"gid://shopify/LineItem/12345","quantity":1}]'

# Update fulfillment tracking number
npm --prefix "scripts" run cli -- update-fulfillment-tracking --fulfillmentId "gid://shopify/Fulfillment/12345" --trackingNumber "1Z999AA10123456784" --trackingCompany "UPS"

# Clear fulfillment tracking without notifying the customer
npm --prefix "scripts" run cli -- update-fulfillment-tracking --fulfillmentId "gid://shopify/Fulfillment/12345" --clear --notifyCustomer false

# Preview Shopify's coupled available/on_hand effects without mutation
npm --prefix "scripts" run cli -- inventory-set-quantities \
  --idempotency-key "cycle-count-2026-09-04-item-23456-location-34567" \
  --reason "cycle_count_available" --name "available" \
  --quantities '[{"inventoryItemId":"gid://shopify/InventoryItem/23456","locationId":"gid://shopify/Location/34567","quantity":7,"changeFromQuantity":6}]' \
  --dry-run

# Apply exactly that preview only after approval; reuse its idempotency key and
# pass metadata.previewToken from the dry-run response
npm --prefix "scripts" run cli -- inventory-set-quantities \
  --idempotency-key "cycle-count-2026-09-04-item-23456-location-34567" \
  --reason "cycle_count_available" --name "available" \
  --quantities '[{"inventoryItemId":"gid://shopify/InventoryItem/23456","locationId":"gid://shopify/Location/34567","quantity":7,"changeFromQuantity":6}]' \
  --preview-token "sha256:<preview-token-from-dry-run>" \
  --confirm
```

## How It Works

This plugin wraps an MCP (Model Context Protocol) server, providing a CLI interface that communicates with the service's MCP binary. The CLI translates commands into MCP tool calls and returns structured JSON responses.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Authentication errors | Verify credentials in `config.json` |
| `ERR_MODULE_NOT_FOUND` | Run `cd scripts && npm install` |
| MCP connection timeout | Ensure the MCP server binary is installed and accessible |
| Rate limiting | The CLI handles retries automatically; wait and retry if persistent |
| Unexpected JSON output | Check API credentials haven't expired |

## Contributing

Issues and pull requests are welcome.

## License

MIT
