import type { SessionSummary } from "#/lib/repository";

/**
 * Conversations for the trace list.
 *
 * A chat harness records one session per turn, named `<conversation>:t<n>`, and a
 * sub-agent's turns `<conversation>:sub:<agent>:t<n>` (LEDGER_GUIDE section 5). A
 * session whose id does not follow that convention is a conversation of its own.
 *
 * A conversation started from another one is nested under it when the records
 * say so: a Delegating and the Observing that opened the other side share a
 * `link:<digest>` tag (spawn, handoff or message), and the first Observing of a
 * fork carries `fork_of:<conversation>`. These links live in tags, not in
 * upstream_record_id, because the two sides upload on their own schedules and
 * may belong to different agents of the same owner.
 */

const TURN = /^(.+?)(?::sub:([^:]+))?:t(\d+)$/;

export interface SessionKey {
  conversation: string;
  lane: string | null;
  turn: number | null;
}

/** The conversation, sub-agent lane and turn number a session id names. */
export function sessionKey(sessionId: string): SessionKey {
  const match = TURN.exec(sessionId);
  const conversation = match?.[1];
  const turn = match?.[3];
  if (!(conversation && turn)) {
    return { conversation: sessionId, lane: null, turn: null };
  }
  return { conversation, lane: match?.[2] ?? null, turn: Number(turn) };
}

/** A record that carries a link between conversations (see repository.ownedLinks). */
export interface LinkRow {
  agent_id: string;
  behavior: string;
  kind: string | null;
  session_id: string;
  tags: string[];
}

export type Relation = "fork" | "handoff" | "spawn";

export interface Lane {
  lane: string;
  sessions: SessionSummary[];
}

export interface Conversation {
  agent_id: string;
  agent_name: string;
  behaviors: string[];
  children: Conversation[];
  conversation: string;
  first_ts: number;
  key: string;
  lanes: Lane[];
  last_ts: number;
  llm_calls: number;
  /** Messages other sessions sent this one. */
  messages_in: number;
  owner_id: string;
  /** How this conversation began, when another one started or forked it (shown even if that one is not listed). */
  parent: { conversation: string; relation: Relation } | null;
  record_count: number;
  tokens: number;
  turns: SessionSummary[];
}

const keyOf = (agentId: string, conversation: string) => `${agentId}/${conversation}`;

function byTurn(a: SessionSummary, b: SessionSummary): number {
  return (
    (sessionKey(a.session_id).turn ?? 0) - (sessionKey(b.session_id).turn ?? 0) ||
    a.first_ts - b.first_ts
  );
}

function group(sessions: SessionSummary[]): Map<string, Conversation> {
  const byKey = new Map<string, Conversation>();
  for (const session of sessions) {
    const { conversation, lane } = sessionKey(session.session_id);
    const key = keyOf(session.agent_id, conversation);
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        agent_id: session.agent_id,
        agent_name: session.agent_name,
        behaviors: [],
        children: [],
        conversation,
        first_ts: session.first_ts,
        key,
        lanes: [],
        last_ts: session.last_ts,
        llm_calls: 0,
        messages_in: 0,
        owner_id: session.owner_id,
        parent: null,
        record_count: 0,
        tokens: 0,
        turns: [],
      };
      byKey.set(key, entry);
    }
    if (lane) {
      let target = entry.lanes.find((l) => l.lane === lane);
      if (!target) {
        target = { lane, sessions: [] };
        entry.lanes.push(target);
      }
      target.sessions.push(session);
    } else {
      entry.turns.push(session);
    }
    entry.record_count += session.record_count;
    entry.tokens += session.tokens;
    entry.llm_calls += session.llm_calls;
    entry.first_ts = Math.min(entry.first_ts, session.first_ts);
    entry.last_ts = Math.max(entry.last_ts, session.last_ts);
    entry.behaviors = [...new Set([...entry.behaviors, ...session.behaviors])];
  }
  for (const entry of byKey.values()) {
    entry.turns.sort(byTurn);
    for (const lane of entry.lanes) {
      lane.sessions.sort(byTurn);
    }
  }
  return byKey;
}

interface Edge {
  conversation: string;
  key: string;
  relation: Relation;
}

interface Handout {
  conversation: string;
  key: string;
  kind: string;
}

/** Where each link tag was handed out: the Delegating's conversation and kind. */
function handouts(links: LinkRow[]): Map<string, Handout> {
  const out = new Map<string, Handout>();
  for (const row of links) {
    if (row.behavior !== "Delegating") {
      continue;
    }
    const { conversation } = sessionKey(row.session_id);
    for (const tag of row.tags) {
      if (tag.startsWith("link:") && !out.has(tag)) {
        out.set(tag, {
          conversation,
          key: keyOf(row.agent_id, conversation),
          kind: row.kind ?? "spawn",
        });
      }
    }
  }
  return out;
}

/** The other side of a link tag: a spawn or handoff is an edge; a message is counted on the child. */
function linkEdge(
  tag: string,
  child: string,
  handedOut: Map<string, Handout>,
  byKey: Map<string, Conversation>,
): Edge | null {
  const from = handedOut.get(tag);
  if (!from || from.key === child) {
    return null;
  }
  if (from.kind === "message") {
    const entry = byKey.get(child);
    if (entry) {
      entry.messages_in += 1;
    }
    return null;
  }
  return {
    conversation: from.conversation,
    key: from.key,
    relation: from.kind === "handoff" ? "handoff" : "spawn",
  };
}

/** A fork names its parent by conversation id alone: the same agent's first, else any listed one. */
function forkEdge(
  tag: string,
  agentId: string,
  child: string,
  byKey: Map<string, Conversation>,
  anyAgent: Map<string, string>,
): Edge | null {
  const conversation = tag.slice("fork_of:".length);
  const sameAgent = keyOf(agentId, conversation);
  const key = byKey.has(sameAgent) ? sameAgent : (anyAgent.get(conversation) ?? sameAgent);
  return key === child ? null : { conversation, key, relation: "fork" };
}

function edges(byKey: Map<string, Conversation>, links: LinkRow[]): Map<string, Edge> {
  const handedOut = handouts(links);
  const anyAgent = new Map<string, string>();
  for (const entry of byKey.values()) {
    if (!anyAgent.has(entry.conversation)) {
      anyAgent.set(entry.conversation, entry.key);
    }
  }
  const parentOf = new Map<string, Edge>();
  for (const row of links) {
    if (row.behavior !== "Observing") {
      continue;
    }
    const child = keyOf(row.agent_id, sessionKey(row.session_id).conversation);
    for (const tag of row.tags) {
      let edge: Edge | null = null;
      if (tag.startsWith("link:")) {
        edge = linkEdge(tag, child, handedOut, byKey);
      } else if (tag.startsWith("fork_of:")) {
        edge = forkEdge(tag, row.agent_id, child, byKey, anyAgent);
      }
      if (edge && !parentOf.has(child)) {
        parentOf.set(child, edge);
      }
    }
  }
  return parentOf;
}

function isAncestor(candidate: string, of: string, parentOf: Map<string, Edge>): boolean {
  const seen = new Set<string>();
  let current: string | undefined = of;
  while (current && !seen.has(current)) {
    if (current === candidate) {
      return true;
    }
    seen.add(current);
    current = parentOf.get(current)?.key;
  }
  return false;
}

function latest(entry: Conversation): number {
  return Math.max(entry.last_ts, ...entry.children.map(latest));
}

/**
 * Group sessions into conversations and nest each conversation under the one
 * that started or forked it. Roots come most recently active first (counting
 * their nested conversations); nested ones in the order they began.
 */
export function buildConversations(sessions: SessionSummary[], links: LinkRow[]): Conversation[] {
  const byKey = group(sessions);
  const parentOf = edges(byKey, links);
  const roots: Conversation[] = [];
  for (const entry of byKey.values()) {
    const edge = parentOf.get(entry.key);
    if (edge) {
      entry.parent = { conversation: edge.conversation, relation: edge.relation };
    }
    const parent = edge ? byKey.get(edge.key) : undefined;
    if (edge && parent && !isAncestor(entry.key, edge.key, parentOf)) {
      parent.children.push(entry);
    } else {
      roots.push(entry);
    }
  }
  for (const entry of byKey.values()) {
    entry.children.sort((a, b) => a.first_ts - b.first_ts);
  }
  return roots.toSorted((a, b) => latest(b) - latest(a));
}
