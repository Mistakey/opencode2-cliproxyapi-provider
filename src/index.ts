/**
 * OpenCode v2 CLIProxyAPI provider plugin.
 *
 * First slice: explicit address and key (no UI) -> enhanced CPA directory ->
 * OpenCode model registration -> native Responses HTTP/SSE with tool
 * round-trips. Credentials stay in OpenCode's own store; the plugin never keeps
 * a key of its own and never logs one.
 */

import { Plugin, Provider } from "@opencode/plugin"
import { AddressError, DEFAULT_BASE_URL, resolveEndpoints } from "./address"
import { CatalogError, fetchCatalog, toModelInfos } from "./catalog"
import { planConnection, readCredential, readExplicitConfig, redactKey } from "./connection"
import { PLUGIN_ID, describeIssues, inspectHost } from "./host"

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const report = inspectHost({ version: ctx.app?.version, ctx })
    if (!report.ok) {
      console.error(`[${PLUGIN_ID}] refusing to load: ${describeIssues(report.issues)}`)
      return
    }

    const explicit = readExplicitConfig(ctx.options)
    const providerID = Provider.ID.make(explicit.providerID)
    const integrationID = explicit.integrationID

    // The connection concept is native: an integration with an API key method,
    // whose form carries the address that belongs to that key.
    await ctx.integration.transform((editor) => {
      editor.update(integrationID, (integration) => {
        integration.name = explicit.providerName
      })
      editor.method.update({
        integrationID,
        method: {
          type: "key",
          label: `${explicit.providerName} API key`,
          form: [
            {
              type: "string",
              key: "baseURL",
              title: "Address",
              description: "CPA address, including any reverse proxy subpath",
              placeholder: DEFAULT_BASE_URL,
              required: true,
            },
          ],
        },
      })
    })

    const activeConnection = await ctx.integration.connection.active(integrationID)
    const activeCredential = activeConnection
      ? readCredential(activeConnection, await ctx.integration.connection.resolve(activeConnection))
      : undefined

    const planned = planConnection({ explicit, active: activeCredential })
    if (!planned.ok) {
      console.error(`[${PLUGIN_ID}] not registering models: ${planned.reason}`)
      return
    }
    const plan = planned.plan

    // Store an explicitly configured key through the native key method so the
    // host owns it and injects it into requests. An unchanged pair is reused.
    if (plan.store) {
      await ctx.integration.connect.key({
        integrationID,
        key: plan.key,
        answer: { baseURL: plan.address },
      })
    }

    let endpoints
    try {
      endpoints = resolveEndpoints(plan.address)
    } catch (error) {
      const detail = error instanceof AddressError ? error.message : String(error)
      console.error(`[${PLUGIN_ID}] not registering models: ${detail}`)
      return
    }

    let entries
    try {
      entries = await fetchCatalog({
        modelsURL: endpoints.modelsURL,
        apiKey: plan.key,
        timeoutMs: explicit.catalogTimeoutMs,
      })
    } catch (error) {
      const detail = error instanceof CatalogError ? error.message : String(error)
      console.error(`[${PLUGIN_ID}] directory unavailable at ${endpoints.modelsURL} (${detail}); keeping no models`)
      return
    }

    const models = toModelInfos(providerID, entries)
    let sourceConnection = activeConnection
    if (plan.store) {
      sourceConnection = (await ctx.integration.connection.active(integrationID)) ?? activeConnection
    }
    await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          ...Provider.Info.empty(providerID),
          name: explicit.providerName,
          activation: "enabled",
          integrationID,
          package: explicit.package,
          settings: { baseURL: endpoints.baseURL },
        },
        models,
        ...(sourceConnection ? { sourceConnection } : {}),
      })
    })

    if (models.length === 0) {
      console.warn(`[${PLUGIN_ID}] ${endpoints.modelsURL} returned an empty directory; no models are selectable`)
    }
    console.log(
      `[${PLUGIN_ID}] registered ${models.length} models from ${endpoints.modelsURL} ` +
        `(connection ${plan.mode}, key ${redactKey(plan.key)})`,
    )
  },
})
