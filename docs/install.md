# Install

Atom-lite needs Node.js >= 22.19.

```bash
npm install -g atom-lite
atom-lite --version
```

## Run without installing

```bash
npx atom-lite "fix the failing test"
```

## Default provider

The first run uses the Kilo AI Gateway at `https://api.kilo.ai/api/gateway` with the free `kilo-auto/free` model. No API key is required; anonymous use is rate-limited to 200 requests per hour per IP.

Override the profile or model for one run:

```bash
atom-lite --provider ollama --model qwen2.5-coder:7b
```

See [Providers](./providers.md) for setup.

## Verify

```bash
atom-lite --version
atom-lite --help
atom-lite "say hello"
```

If the provider is unreachable or the model is unknown, see [Troubleshooting](./troubleshooting.md).
