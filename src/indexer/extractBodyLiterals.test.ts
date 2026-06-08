import assert from "node:assert/strict";
import { test } from "bun:test";

import { bodyLiteralsSearchText, extractBodyLiterals } from "./extractBodyLiterals";

const texts = (kind: "code" | "message", body: string): string[] =>
  extractBodyLiterals(body)
    .filter((literal) => literal.kind === kind)
    .map((literal) => literal.text);

test("extracts a qualified diagnostic code from a symbol body", () => {
  const body = `
    def _check_ordering(cls):
        errors.append(checks.Error("'ordering' refers to the nonexistent field", id='models.E015'))
  `;
  const codes = texts("code", body);
  assert.ok(codes.includes("models.E015"), `expected models.E015, got ${codes}`);
  assert.ok(codes.includes("E015"), "the bare code segment is also captured");
});

test("extracts varied diagnostic code shapes, framework-agnostic", () => {
  assert.ok(texts("code", "raise TSError(2345)  # TS2345").includes("TS2345"));
  assert.ok(texts("code", "throw new Error('E1234: bad')").includes("E1234"));
  assert.ok(
    texts("code", "code: ERR_INVALID_ARG_TYPE").includes("ERR_INVALID_ARG_TYPE"),
    "SCREAMING_SNAKE codes are captured",
  );
});

test("generic words and common lowercase tokens never become codes", () => {
  const body = `
    if error or multiple or failed:
        return self.handle_error(error)  # utf8, sha1, md5 are not codes
  `;
  const codes = texts("code", body).map((c) => c.toLowerCase());
  for (const generic of ["error", "multiple", "failed", "utf8", "sha1", "md5", "error"]) {
    assert.ok(!codes.includes(generic), `'${generic}' must not be a code`);
  }
  assert.deepEqual(codes, [], "no codes in a body of only generic words");
});

test("a single all-caps word is not a code, but a snake-cased one is", () => {
  assert.deepEqual(texts("code", "raise ERROR"), [], "bare ERROR is not distinctive");
  assert.ok(texts("code", "raise DJANGO_SETTINGS_MODULE_ERROR").includes("DJANGO_SETTINGS_MODULE_ERROR"));
});

test("extracts a distinctive quoted message but ignores short/format strings", () => {
  const body = `
    raise FieldError("Cannot resolve keyword %r into field")
    label = "ok"
    fmt = "%s/%d"
  `;
  const messages = texts("message", body);
  assert.ok(
    messages.some((m) => m.startsWith("Cannot resolve keyword")),
    `expected the message, got ${JSON.stringify(messages)}`,
  );
  assert.ok(!messages.includes("ok"), "short strings are not messages");
  assert.ok(!messages.some((m) => m.includes("%s/%d")), "format-only strings are not messages");
});

test("search text lowercases and joins literals for the FTS column", () => {
  const literals = extractBodyLiterals("id='models.E015'  raise FieldError('Field is invalid here')");
  const text = bodyLiteralsSearchText(literals);
  assert.ok(text.includes("models.e015"));
  assert.ok(text.includes("e015"));
  assert.equal(text, text.toLowerCase(), "search text is lowercased");
});

test("empty input yields no literals", () => {
  assert.deepEqual(extractBodyLiterals(""), []);
});
