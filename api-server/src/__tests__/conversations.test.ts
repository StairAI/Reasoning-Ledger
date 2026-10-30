import { call } from "@orpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildConversations, sessionKey } from "#/lib/conversations";
import type { LinkRow } from "#/lib/conversations";
import { prisma } from "#/lib/prisma";
import { ownedLinks } from "#/lib/repository";
import type { SessionSummary } from "#/lib/repository";
import { registerAgent } from "#/routes/agents";
import { ctx, makeTestOwner } from "./helpers";
import type { TestOwner } from "./helpers";

function session(agentId: string, sessionId: string, ts: number): SessionSummary {
  return {
    agent_id: agentId,
    agent_name: `agent ${agentId}`,
    behaviors: ["Observing", "Acting"],
    first_ts: ts,
    last_ts: ts + 1000,
    llm_calls: 1,
    owner_id: "owner",
    record_count: 3,
    session_id: sessionId,
    tokens: 100,
  };
}

function link(
  agentId: string,
  sessionId: string,
  behavior: string,
  tags: string[],
  kind: string | null = null,
): LinkRow {
  return { agent_id: agentId, behavior, kind, session_id: sessionId, tags };
}

describe("Conversations — session ids", () => {
  it("reads the conversation, sub-agent lane and turn from a chat harness's session id", () => {
    expect(sessionKey("abc:t007")).toStrictEqual({ conversation: "abc", lane: null, turn: 7 });
    expect(sessionKey("abc:sub:a0bd672d:t002")).toStrictEqual({
      conversation: "abc",
      lane: "a0bd672d",
      turn: 2,
    });
    expect(sessionKey("a:b:c:t010")).toStrictEqual({ conversation: "a:b:c", lane: null, turn: 10 });
  });

  it("treats any other session id as a conversation of its own", () => {
    expect(sessionKey("legacy-session")).toStrictEqual({
      conversation: "legacy-session",
      lane: null,
      turn: null,
    });
    expect(sessionKey("run:tail")).toStrictEqual({
      conversation: "run:tail",
      lane: null,
      turn: null,
    });
  });
});

describe("Conversations — grouping and nesting", () => {
  const sessions = [
    session("A", "parent:t001", 1000),
    session("A", "parent:t002", 5000),
    session("A", "parent:sub:a0bd672d:t001", 2000),
    session("A", "child:t001", 3000),
    session("A", "child:t002", 4000),
    session("A", "fork:t003", 6000),
    session("B", "elsewhere:t001", 7000),
    session("A", "plain-session", 500),
  ];
  const links = [
    link("A", "parent:t001", "Delegating", ["conv:parent", "link:aaaa"], "spawn"),
    link("A", "parent:t001", "Delegating", ["conv:parent", "link:bbbb"], "message"),
    link("A", "child:t001", "Observing", ["conv:child", "link:aaaa"]),
    link("A", "child:t002", "Observing", ["conv:child", "link:bbbb"]),
    link("A", "fork:t003", "Observing", ["conv:fork", "fork_of:parent"]),
    link("B", "elsewhere:t001", "Observing", ["conv:elsewhere", "fork_of:parent"]),
  ];
  const roots = buildConversations(sessions, links);
  const parent = roots.find((c) => c.conversation === "parent");

  it("groups a conversation's turns in order and keeps sub-agent turns apart", () => {
    expect(parent?.turns.map((s) => s.session_id)).toStrictEqual(["parent:t001", "parent:t002"]);
    expect(parent?.lanes).toStrictEqual([{ lane: "a0bd672d", sessions: [sessions[2]] }]);
    expect(parent?.record_count).toBe(9);
  });

  it("nests what a conversation started or forked, linked by tags, across agents of the owner", () => {
    expect(roots.map((c) => c.conversation)).toStrictEqual(["parent", "plain-session"]);
    expect(parent?.children.map((c) => [c.conversation, c.parent?.relation])).toStrictEqual([
      ["child", "spawn"],
      ["fork", "fork"],
      ["elsewhere", "fork"],
    ]);
    const child = parent?.children[0];
    expect(child?.messages_in).toBe(1);
    expect(child?.parent).toStrictEqual({ conversation: "parent", relation: "spawn" });
  });

  it("orders roots by their latest activity, nested conversations included", () => {
    const again = buildConversations(
      [session("A", "old:t001", 100), session("A", "new:t001", 200), session("A", "kid:t001", 900)],
      [
        link("A", "old:t001", "Delegating", ["link:cccc"], "spawn"),
        link("A", "kid:t001", "Observing", ["link:cccc"]),
      ],
    );
    expect(again.map((c) => c.conversation)).toStrictEqual(["old", "new"]);
  });

  it("names the parent even when it is not listed, and never nests a conversation under itself", () => {
    const lone = buildConversations(
      [session("A", "x:t001", 1), session("A", "y:t001", 2)],
      [
        link("A", "x:t001", "Observing", ["fork_of:gone"]),
        link("A", "x:t001", "Delegating", ["link:dddd"], "spawn"),
        link("A", "y:t001", "Observing", ["link:dddd"]),
        link("A", "x:t001", "Observing", ["link:eeee"]),
        link("A", "y:t001", "Delegating", ["link:eeee"], "spawn"),
      ],
    );
    const x = lone.find((c) => c.conversation === "x");
    expect(x?.parent).toStrictEqual({ conversation: "gone", relation: "fork" });
    expect(lone.map((c) => c.conversation)).toStrictEqual(["x"]);
    expect(x?.children.map((c) => c.conversation)).toStrictEqual(["y"]);
  });
});

describe("Conversations — linking records in the database", () => {
  let owner: TestOwner;
  let other: TestOwner;
  let agentId: string;
  let otherAgent: string;

  async function insert(
    agent: string,
    sessionId: string,
    behavior: "Delegating" | "Observing",
    tags: string[],
    payload: object,
  ) {
    await prisma.traceRecord.create({
      data: {
        agent_id: agent,
        behavior,
        client_ts_utc: BigInt(Date.now()),
        executor: "ai",
        payload,
        record_id: crypto.randomUUID(),
        record_phase: "post_execution",
        schema_version: "0.5",
        server_ts_utc: BigInt(Date.now()),
        session_id: sessionId,
        tags,
      },
    });
  }

  beforeAll(async () => {
    [owner, other] = await Promise.all([makeTestOwner(), makeTestOwner()]);
    const mine = await call(
      registerAgent,
      { name: `conv-${crypto.randomUUID()}` },
      ctx(owner.apiKey),
    );
    agentId = mine.agent_id;
    const theirs = await call(
      registerAgent,
      { name: `conv-${crypto.randomUUID()}` },
      ctx(other.apiKey),
    );
    otherAgent = theirs.agent_id;
    await insert(agentId, "p:t001", "Delegating", ["conv:p", "link:1111"], { kind: "spawn" });
    await insert(agentId, "c:t001", "Observing", ["conv:c", "link:1111"], {
      trigger_type: "agent_trigger",
    });
    await insert(agentId, "f:t002", "Observing", ["conv:f", "fork_of:p"], {
      trigger_type: "human_trigger",
    });
    await insert(agentId, "p:t002", "Observing", ["conv:p"], { trigger_type: "human_trigger" });
    await insert(otherAgent, "q:t001", "Delegating", ["conv:q", "link:1111"], { kind: "spawn" });
  });

  afterAll(async () => {
    await Promise.all([owner.cleanup(), other.cleanup()]);
  });

  it("returns the owner's records that carry a link, with the delegation's kind, and nothing else", async () => {
    const rows = await ownedLinks(owner.ownerId);
    expect(rows.map((r) => [r.session_id, r.behavior, r.kind])).toStrictEqual([
      ["p:t001", "Delegating", "spawn"],
      ["c:t001", "Observing", null],
      ["f:t002", "Observing", null],
    ]);
    expect(rows.every((r) => r.agent_id === agentId)).toBeTruthy();
  });
});
