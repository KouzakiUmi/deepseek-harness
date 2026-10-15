---
kind: upgrade-guide
description: "The built-in Azure provider route is now azure instead of azure-openai-responses."
---

# Azure provider route identifier

English | [中文](guide.zh.md)

## Change

With pi-ai 1.2.0, the built-in Azure provider route is `azure`, not `azure-openai-responses`. Configurations that use the old identifier to select the built-in catalog must be updated. The wire protocol identifier remains `azure-openai-responses`; explicitly configured custom routes using that protocol do not need to be renamed.

## Migration

1. In the `@deepseek-ai/dsh-llm-pi-ai` configuration in `cordis.yml` or its overlays, rename the built-in route key `config.providers.azure-openai-responses` to `config.providers.azure`, retaining its credential references, endpoint and model options. Do not rename an `api: azure-openai-responses` value.
2. In Settings → Models, confirm that the Azure provider is listed as `azure`, then reselect affected saved or default model selections under that provider.
3. If credentials were saved through Settings, enter them again under the new `azure` route: stored sign-in records are addressed by route identifier. Credentials referenced through `apiKeyEnv` are unaffected. Confirm that model discovery no longer reports an unknown provider identifier and that an Azure model request succeeds.
