/**
 * Test support: a second provider in the same host, so a host check can prove
 * that pausing the CPA provider does not gate another provider's requests.
 *
 * Loaded only by `scripts/host-pause.mjs`. It reads its address from
 * `OC2CPA_OTHER_BASE` and registers one plain model.
 */

import { Plugin, Provider } from "@opencode/plugin"
import { toModelInfos } from "../../../src/catalog"
import { RESPONSES_PACKAGE } from "../../../src/connection"

const providerID = Provider.ID.make("other-cpa")

export default Plugin.define({
  id: "oc2cpa-test-other-provider",
  async setup(ctx) {
    const base = process.env.OC2CPA_OTHER_BASE
    if (!base) {
      console.error("[oc2cpa-test-other-provider] OC2CPA_OTHER_BASE is not set; not registering")
      return
    }
    await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          ...Provider.Info.empty(providerID),
          name: "Other CPA",
          activation: "enabled",
          package: RESPONSES_PACKAGE,
          settings: { baseURL: `${base}/v1`, apiKey: process.env.OC2CPA_OTHER_KEY ?? "sk-fake-other-0123456789" },
        },
        models: toModelInfos(providerID, [{ id: "other-model", name: "Other Model" }]),
      })
    })
  },
})
