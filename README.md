# Mass Dispute CLI

## Overview

The Mass Dispute CLI is a command-line tool designed to facilitate the efficient dispute of multiple UMA Optimistic Oracle proposals in the Optimistic Oracle V2 on the supported chains.

## Prerequisites

- Node.js (version 16 or higher)
- yarn (version 1.22.19 or higher)

## Installation

1. **Install dependencies:**

```bash
yarn install
```

2. **Build the project:**

```bash
yarn build
```

## Usage

### Starting the CLI

To start the CLI, use the following command:

```bash
yarn dispute
```

### Arguments

The CLI accepts the following arguments:

- `-h` or `--help`: Display help information.
- `-m` or `--multiplier`: Specify the gas fee multiplier (default is 4).
- `-t` or `--sort-remaining-time`: Specify if disputes should be sorted by remaining time to dispute (ascending) (default is false).
- `-b` or `--sort-bond-size`: Specify if disputes should be sorted by bond size (descending) (default is false).
- `-r` or `--sort-random`: Specify if disputes should be sorted randomly (default is false).
- `-p` or `--only-polymarket`: Specify if only Polymarket proposals should be considered (default is false).

> **Note:** Only one sort option can be set.

### Environment Variables

The CLI uses the following environment variables:

- `CHAIN_ID`: The chain ID. Required.
- `MAX_BLOCK_LOOK_BACK`: The maximum block look-back (default is 3499). Optional.
- `NODE_URL_{CHAIN_ID}`: The node URL for the chain ID. Required.
- `PRIVATE_KEY`: The private key for the wallet. Required.

### Example Usage

To dispute proposals on Polygon Mainnet (chain ID 137) with only Polymarket proposals sorted by remaining time to dispute (ascending), you can run:

```bash
CHAIN_ID=137 NODE_URL_137=<YOUR_NODE_URL> PRIVATE_KEY=<YOUR_PRIVATE_KEY> yarn dispute -p -t
```
