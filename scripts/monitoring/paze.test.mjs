import test from "node:test";
import assert from "node:assert/strict";
import { cleanName, merchantKey, parsePage, diffMerchants, collectDirectory } from "./paze.mjs";

function page(names, next = null) {
  const cards = names.map((name) => `<a aria-label="Visit ${name} website"></a>`).join("");
  const pager = next === null
    ? ""
    : `<a class="button" href="?page=${next}" title="Load more items" rel="next">Load More</a>`;
  return `${cards}${pager}`;
}

test("normalizes superficial merchant formatting", () => {
  assert.equal(cleanName(" Harry &amp;  David "), "Harry & David");
  assert.equal(merchantKey("The Harry & David"), merchantKey("Harry and David"));
});

test("extracts server-rendered aria-labels and continuation", () => {
  const parsed = parsePage(page(["Acme", "Harry &amp; David"], 1), 0);
  assert.deepEqual(parsed.merchants.map(({ name }) => name), ["Acme", "Harry & David"]);
  assert.equal(parsed.nextHref, "?page=1");
});

test("collects only consecutive paginated results", async () => {
  const responses = [page(["Alpha"], 1), page(["Beta"])];
  const fakeFetch = async (url) => {
    const index = Number(new URL(url).searchParams.get("page"));
    return new Response(responses[index], { status: 200 });
  };
  const result = await collectDirectory(fakeFetch);
  assert.equal(result.merchants.length, 2);
  assert.deepEqual(result.pagination.pageCounts, [1, 1]);
});

test("rejects broken pagination", async () => {
  const fakeFetch = async () => new Response(page(["Alpha"], 2), { status: 200 });
  await assert.rejects(() => collectDirectory(fakeFetch), /pointed to page 2/);
});

test("distinguishes additions, removals, and likely renames", () => {
  const wrap = (names) => names.map((name) => ({ name, key: merchantKey(name) }));
  assert.deepEqual(diffMerchants(wrap(["Alpha", "Old Merchant", "Gone"]), wrap(["Alpha", "New Merchant", "Added"])), {
    added: ["Added"],
    removed: ["Gone"],
    renamed: [{ from: "Old Merchant", to: "New Merchant" }],
  });
});
