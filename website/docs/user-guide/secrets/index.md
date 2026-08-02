# Secrets

Hermes can pull API keys from external secret managers at process startup instead of storing every provider key in `~/.hermes/.env`. The secret-manager bootstrap credential remains in `.env`; provider keys can be rotated centrally.

This repository currently includes [Bitwarden Secrets Manager](./bitwarden), backed by the pinned `bws` CLI.
