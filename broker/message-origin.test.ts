import test from "node:test";
import assert from "node:assert/strict";
import { isMessage, isMessageOrigin, messageDeliveryFingerprint } from "./protocol.ts";
import type { Message } from "../types.ts";

function messageWith(origin: unknown): unknown {
  return { id: "message-1", timestamp: 1, ...(origin === undefined ? {} : { origin }), content: { text: "hello" } };
}

test("protocol accepts an absent or well-formed origin and rejects a malformed one", () => {
  assert.equal(isMessage(messageWith(undefined)), true);
  for (const harness of ["pi", "opencode", "claude-code", "a", "x".repeat(32), "0day"]) {
    for (const kind of ["human", "agent", "extension"]) {
      assert.equal(isMessage(messageWith({ harness, kind })), true, `${harness}/${kind}`);
    }
  }

  const invalid: unknown[] = [
    null,
    "human",
    [],
    {},
    { harness: "pi" },
    { kind: "human" },
    { harness: "pi", kind: "robot" },
    { harness: "pi", kind: "Human" },
    { harness: "Pi", kind: "human" },
    { harness: "-pi", kind: "human" },
    { harness: "pi_x", kind: "human" },
    { harness: "pi x", kind: "human" },
    { harness: "", kind: "human" },
    { harness: "x".repeat(33), kind: "human" },
    { harness: 1, kind: "human" },
  ];
  for (const origin of invalid) {
    assert.equal(isMessageOrigin(origin), false, JSON.stringify(origin));
    assert.equal(isMessage(messageWith(origin)), false, JSON.stringify(origin));
  }
});

test("broker replay fingerprints distinguish origin", () => {
  const unmarked = messageWith(undefined) as Message;
  const human = messageWith({ harness: "pi", kind: "human" }) as Message;
  const agent = messageWith({ harness: "pi", kind: "agent" }) as Message;
  const otherHarness = messageWith({ harness: "opencode", kind: "human" }) as Message;
  const prints = [unmarked, human, agent, otherHarness].map((message) => messageDeliveryFingerprint(message, "receiver"));
  assert.equal(new Set(prints).size, prints.length);
  assert.equal(messageDeliveryFingerprint({ ...human }, "receiver"), prints[1]);
});
