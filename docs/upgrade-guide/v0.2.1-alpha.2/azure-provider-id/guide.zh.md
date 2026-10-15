---
kind: upgrade-guide
description: "内置 Azure 提供方路由从 azure-openai-responses 改为 azure。"
---

# Azure 提供方路由标识符

[English](guide.md) | 中文

## 变更

使用 pi-ai 1.2.0 时，内置 Azure 提供方路由为 `azure`，不再是 `azure-openai-responses`。使用旧标识符选择内置目录的配置必须更新。通信协议标识符仍为 `azure-openai-responses`；显式配置并使用该协议的自定义路由无需改名。

## 迁移

1. 在 `cordis.yml` 或其覆盖配置中的 `@deepseek-ai/dsh-llm-pi-ai` 配置里，将内置路由键 `config.providers.azure-openai-responses` 改为 `config.providers.azure`，保留其凭据引用、端点和模型选项。不要修改 `api: azure-openai-responses` 的值。
2. 在设置 → 模型中确认 Azure 提供方显示为 `azure`，然后在该提供方下重新选择受影响的已保存模型或默认模型。
3. 如果凭据通过设置页保存，请在新的 `azure` 路由下重新输入：保存的登录记录以路由标识符寻址。通过 `apiKeyEnv` 引用的凭据不受影响。确认模型发现不再报告未知提供方标识符，且 Azure 模型请求能成功执行。
