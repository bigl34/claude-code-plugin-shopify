<!-- AUTO-GENERATED README — DO NOT EDIT. Changes will be overwritten on next publish. -->
# claude-code-plugin-shopify

Dedicated agent for Shopify e-commerce operations with isolated MCP access

![Version](https://img.shields.io/badge/version-1.1.12-blue) ![License: MIT](https://img.shields.io/badge/License-MIT-green) ![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

## Features

- Order
- **get-orders** — List recent orders
- **get-order** — Get order by ID
- **update-order** — Update order details
- **update-fulfillment-tracking** — Update fulfillment tracking
- Customer
- **get-customers** — Search customers
- **update-customer** — Update customer
- **get-customer-orders** — Get customer's orders
- Product
- **get-products** — Search products
- **get-product** — Get product by ID
- **create-product** — Create new product

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- MCP server binary for the target service (configured via `config.json`)

## Quick Start

```bash
git clone https://github.com/YOUR_GITHUB_USER/claude-code-plugin-shopify.git
cd claude-code-plugin-shopify
cp config.template.json config.json  # fill in your credentials
cd scripts && npm install
```

```bash
node scripts/dist/cli.js get-orders
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

| Command                       | Description                 | Options                                                                                         |
| ----------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------- |
| `get-orders`                  | List recent orders          | `--status`, `--limit`                                                                           |
| `get-order`                   | Get order by ID             | `--id` (required)                                                                               |
| `update-order`                | Update order details        | `--id`, `--tags`, `--email`, `--note`                                                           |
| `update-fulfillment-tracking` | Update fulfillment tracking | `--fulfillmentId`, `--trackingNumber`, `--trackingCompany`, `--trackingUrl`, `--notifyCustomer` |

### Customer Commands

| Command               | Description           | Options                                          |
| --------------------- | --------------------- | ------------------------------------------------ |
| `get-customers`       | Search customers      | `--search`, `--limit`                            |
| `update-customer`     | Update customer       | `--id`, `--email`, `--phone`, `--note`, `--tags` |
| `get-customer-orders` | Get customer's orders | `--id` (required), `--limit`                     |

### Product Commands

| Command          | Description        | Options                                                    |
| ---------------- | ------------------ | ---------------------------------------------------------- |
| `get-products`   | Search products    | `--search`, `--limit`                                      |
| `get-product`    | Get product by ID  | `--id` (required)                                          |
| `create-product` | Create new product | `--title`, `--description`, `--vendor`, `--type`, `--tags` |

### Common Options

| Option              | Description                                            |
| ------------------- | ------------------------------------------------------ |
| `--id <id>`         | Shopify GraphQL ID (e.g., "gid://shopify/Order/12345") |
| `--search <query>`  | Search term                                            |
| `--status <status>` | Order status filter                                    |
| `--limit <number>`  | Maximum records to return                              |
| `--tags <tags>`     | Comma-separated tags                                   |

## Usage Examples

```bash
# List recent orders
node scripts/dist/cli.js get-orders --limit 10

# Get a specific order by ID
node scripts/dist/cli.js get-order --id "gid://shopify/Order/12345"

# Search for customers
node scripts/dist/cli.js get-customers --search "john@example.com"

# Get customer's order history
node scripts/dist/cli.js get-customer-orders --id "gid://shopify/Customer/12345"

# Search products
node scripts/dist/cli.js get-products --search "ProductName Product"

# Update order tags
node scripts/dist/cli.js update-order --id "gid://shopify/Order/12345" --tags "urgent,priority"

# Update fulfillment tracking number
node scripts/dist/cli.js update-fulfillment-tracking --fulfillmentId "gid://shopify/Fulfillment/12345" --trackingNumber "1Z999AA10123456784" --trackingCompany "UPS"
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

## Known Limitations

**Order Number Search**: The `get-orders` command does not support filtering by order number (e.g., "#ORD1234"). The MCP server only supports `--status` and `--limit` filters.

**Workaround**: To find a specific order by number:
1. Use `get-orders` to list recent orders
2. Scan the results for the order number you need
3. Use `get-order --id <graphql-id>` to get full details

Alternatively, search for the customer first (`get-customers --search "email@example.com"`) then get their order history (`get-customer-orders --id <customer-id>`).

## Contributing

Issues and pull requests are welcome.

## License

MIT
