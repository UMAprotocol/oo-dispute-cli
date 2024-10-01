# Polymarket Mass Dispute CLI

## Overview

The Polymarket Mass Dispute CLI is a command-line tool designed to facilitate the efficient dispute of multiple UMA Optimistic Oracle proposals. This tool allows users to dispute multiple proposals quickly and effectively.

## Prerequisites

- Node.js (version 16 or higher)
- yarn (version 1.22.19 or higher)

## Installation

1. **Clone the repository:**

   ```bash
   git clone <repository-url>
   cd mass-dispute-cli
   ```

2. **Install dependencies:**

   ```bash
   yarn install
   ```

3. **Build the project:**
   ```bash
   yarn build
   ```

## Usage

### Starting the CLI

To start the CLI, use the following command:

```bash
yarn start
```

### Arguments

The CLI accepts the following arguments:

- `-v` or `--version`: Display the current version of the CLI.
- `-h` or `--help`: Display help information.
- `-c` or `--chain-id`: Specify the chain ID (default is 137).
- `-b` or `--max-block-look-back`: Specify the maximum block look-back (default is 3499).
- `-p` or `--only-polymarket`: Specify if only Polymarket proposals should be considered (default is true).

### Environment Variables

The CLI uses the following environment variables:

- `CHAIN_ID`: The chain ID (default is 137).
- `MAX_BLOCK_LOOK_BACK`: The maximum block look-back (default is 3499).
- `ONLY_POLYMARKET`: Specify if only Polymarket proposals should be considered (default is true).
- `NODE_URL_137`: The node URL for Polygon Mumbai (default is `https://rpc.ankr.com/polygon_mumbai`).

### Example Usage

To dispute proposals on Polygon Mumbai (chain ID 137) with a maximum block look-back of 3499, you can run:

```bash
CHAIN_ID=137 MAX_BLOCK_LOOK_BACK=3499 ONLY_POLYMARKET=true NODE_URL_137=https://rpc.ankr.com/polygon_mumbai yarn start
```

This command will start the CLI and dispute all proposals on Polygon Mumbai within the specified block range.

## License

This project is licensed under the MIT License.
