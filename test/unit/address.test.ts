import { describe, expect, test } from "bun:test"
import { AddressError, resolveEndpoints } from "../../src/address"
import { CLIENT_VERSION } from "../../src/host"

const clientVersionQuery = `client_version=${encodeURIComponent(CLIENT_VERSION)}`

describe("resolveEndpoints", () => {
  test("keeps the origin root and appends /v1", () => {
    const endpoints = resolveEndpoints("http://127.0.0.1:8317")
    expect(endpoints.baseURL).toBe("http://127.0.0.1:8317/v1")
    expect(endpoints.modelsURL).toBe(`http://127.0.0.1:8317/v1/models?${clientVersionQuery}`)
    expect(endpoints.rootPath).toBe("")
  })

  test("accepts an address without a scheme", () => {
    expect(resolveEndpoints("127.0.0.1:8317").baseURL).toBe("http://127.0.0.1:8317/v1")
  })

  test("preserves a reverse proxy subpath", () => {
    const endpoints = resolveEndpoints("https://gateway.example.com/cpa/")
    expect(endpoints.baseURL).toBe("https://gateway.example.com/cpa/v1")
    expect(endpoints.modelsURL).toBe(`https://gateway.example.com/cpa/v1/models?${clientVersionQuery}`)
    expect(endpoints.rootPath).toBe("/cpa")
  })

  test("treats an explicit /v1 suffix as the same deployment", () => {
    const withV1 = resolveEndpoints("https://gateway.example.com/cpa/v1")
    const withoutV1 = resolveEndpoints("https://gateway.example.com/cpa")
    expect(withV1.baseURL).toBe(withoutV1.baseURL)
    expect(withV1.modelsURL).toBe(withoutV1.modelsURL)
  })

  test("normalizes trailing slashes", () => {
    expect(resolveEndpoints("https://gateway.example.com/cpa/v1///").baseURL).toBe("https://gateway.example.com/cpa/v1")
    expect(resolveEndpoints("https://gateway.example.com//").baseURL).toBe("https://gateway.example.com/v1")
  })

  test("identifies itself instead of claiming to be another client", () => {
    expect(CLIENT_VERSION.startsWith("opencode2-cliproxyapi-provider/")).toBe(true)
    expect(resolveEndpoints("http://127.0.0.1:8317").modelsURL).not.toContain("client_version=pi")
  })

  test("rejects empty, non-http and credential-bearing addresses", () => {
    expect(() => resolveEndpoints("   ")).toThrow(AddressError)
    expect(() => resolveEndpoints("ftp://gateway.example.com")).toThrow(AddressError)
    expect(() => resolveEndpoints("http://user:secret@gateway.example.com")).toThrow(AddressError)
  })
})
