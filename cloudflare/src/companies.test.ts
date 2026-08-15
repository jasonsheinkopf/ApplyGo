import assert from "node:assert/strict";
import test from "node:test";

import { MAX_COMPANY_DISCOVERY_COUNT, normalizeCompanyDiscoveryCount } from "./companies.ts";

test("company discovery accepts batches through 100", () => {
  assert.equal(MAX_COMPANY_DISCOVERY_COUNT, 100);
  assert.equal(normalizeCompanyDiscoveryCount(50), 50);
  assert.equal(normalizeCompanyDiscoveryCount(100), 100);
});

test("company discovery clamps invalid and out-of-range counts", () => {
  assert.equal(normalizeCompanyDiscoveryCount(101), 100);
  assert.equal(normalizeCompanyDiscoveryCount(-5), 1);
  assert.equal(normalizeCompanyDiscoveryCount("not-a-number"), 10);
});
