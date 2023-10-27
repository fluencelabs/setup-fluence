# setup-fluence

This actions setups [Fluence CLI](https://github.com/fluencelabs/cli).

## Usage

This action can be run on `ubuntu-latest`, and `macos-latest` GitHub Actions
runners.

```yaml
steps:
- uses: fluencelabs/setup-fluence@v1
  with:
    artifact: fluence-snapshot # artifact name to try to download from CI
    version: 0.11.2 # fcli version or a channel
```

`version` to download can be a release version or a `channel`. Availible channels are:
- `kras` - version compatible with current `kras` env
- `testnet` - version compatible with current `testnet` env
- `stage` - version compatible with current `stage` env
- `latest` - latest stable version (same as `kras`)
- `stable` - latest stable version (same as `kras`)
- `main` - latest build from `main` branch
- `unstable` - latest release of Fluence CLI

