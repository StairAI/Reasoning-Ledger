# Stair AI — Project Overview

**Date:** April 22, 2026
**Status:** Pre-revenue, pre-PMF. World Cup Arena campaign in active development.

---

## 1. What Stair AI Is

Stair AI is building **verifiable trust infrastructure for AI agents**. The core thesis: as AI agents begin managing capital and making autonomous decisions, they need a "credit score" — not based on identity (agents can be duplicated and deleted), but based on **how they think**.

The protocol, called **Glass Box** (also referred to as RAID — Reasoning Auditing and Intelligence Decentralization), creates cryptographic records of AI reasoning processes, scores them for quality, and makes the scores available as a public trust signal.

**One-line summary:** We turn AI agent reasoning from a black box into a verifiable performance record.

---

## 2. The Problem Stack

The project identifies five layers of problems between AI agents and institutional capital adoption:

| Layer | Problem | Stair AI's Solution |
|-------|---------|-------------------|
| Cryptographic | Were the reasoning traces tampered with? | Immutable on-chain storage (Walrus DA + SUI blockchain) |
| Structural | Did the agent reason coherently? | Step-level verification via standardized trace schema |
| Statistical | How does this agent's quality distribute over time? | Track record registry (RAID score) |
| Actuarial | What's the expected loss rate? | Cross-operator claims database (future) |
| Commercial | Can capital flow in? | Underwriting products on the actuarial layer (future) |

Stair AI currently owns the first two layers and is building toward the third. Layers four and five are enablement layers for the broader ecosystem.

---

## 3. Core Technical Primitives

### 3.1 The Reasoning Trace

Every agent action is accompanied by a structured JSON log detailing the trigger event, data consumed, reasoning steps, and final action. Traces follow a **Universal Cognitive Schema** with seven canonical behavior types:

1. **Observing** — the triggering event
2. **Retrieving** — fetching external data
3. **Planning** — decomposing goals into steps
4. **Thinking** — analysis, inference, decision
5. **ToolCalling** — invoking external tools/APIs
6. **Acting** — executing the decided action
7. **Reflecting** — post-action analysis of outcome vs. expectation

Proprietary reasoning (the agent's alpha) is encrypted with the creator's key. Only the trigger and final action are public.

### 3.2 The RAID Score

A composite score evaluating trace quality across multiple dimensions. The scoring system has evolved through several iterations:

**Current design (process-only layer, market-independent):**

| Score | What it measures | Single-trace or cumulative |
|-------|-----------------|---------------------------|
| Data Freshness | How recent was the data the agent used? | Single trace |
| Information Breadth | How many independent data sources? | Single trace |
| Risk-Return Coherence | Do risk labels match return expectations? | Single trace |
| Prediction Specificity | How much information content in the prediction? | Single trace |
| Contrarian Justification Depth | When going against trend, how strong is the reasoning? | Single trace |
| Self-Reported Uncertainty vs. Actual | Does confidence language match confidence numbers? | Single trace |
| Confidence Calibration | Do stated confidence levels match historical accuracy? | Cumulative (30+ traces) |
| Regime Awareness | Does the agent adapt to changing market conditions? | Cumulative |
| Temporal Consistency | Are direction changes justified by data changes? | Cumulative |
| Oracle Dependency Ratio | Is the agent just wrapping a moving average in LLM prose? | Cumulative |

**Key design principle:** Process scores do not depend on market performance and can anchor economic penalties (slashing). Outcome scores (prediction accuracy, PnL) are tracked separately for ranking and marketplace pricing but do not trigger penalties — this separates "did you cheat" from "were you right."

### 3.3 On-Chain Infrastructure

| Component | Technology | Role |
|-----------|-----------|------|
| Data Availability | Walrus (SUI ecosystem) | Stores full reasoning trace JSON blobs, content-addressed, erasure-coded |
| Settlement | SUI blockchain (testnet, targeting mainnet) | Stores Merkle roots of traces + Walrus Blob IDs in a Trace Ledger smart contract |
| Agent Identity | BYOI (Bring Your Own Identity) | Any cryptographic identifier — EVM address, Solana keypair, W3C DID |

Tamper detection: if a retrieved trace's hash doesn't match the on-chain Merkle root, tampering is mathematically proven.

---

## 4. Trust Architecture — Three Tiers

The protocol faces a core tension: controlling the agent runtime increases trust but decreases adoption. This is resolved via a three-tier trust model:

| Tier | Mechanism | Trust Level | Adoption Friction | Label |
|------|-----------|-------------|-------------------|-------|
| Framework-native | Agent runs inside Glass Box runtime; protocol controls trace generation | Highest | Highest (must rebuild agent in framework) | `framework_controlled` |
| SDK-instrumented | Agent runs on own infra but integrates `@stairai/ledger-sdk`; SDK intercepts HTTP calls | Medium | Medium (add SDK dependency) | `sdk_instrumented` |
| Self-attested | Agent submits traces voluntarily via API | Lowest | Lowest (API call) | `self_reported` |

Each tier's RAID score carries its attestation label, letting consumers decide their trust threshold.

**Future tiers (Phase 3 roadmap):**

- **zkTLS** — cryptographically proves external API calls (e.g., to LLM providers) actually occurred, with the correct request/response content, at the claimed time. Addresses the "post-hoc trace fabrication" attack.
- **TEE (Trusted Execution Environment)** — hardware-level attestation proving code ran in a tamper-proof enclave. Addresses the "reasoning and execution separation" attack.

---

## 5. Known Attack Surfaces & Mitigations

| Attack | Description | Current Mitigation | Full Solution |
|--------|-------------|-------------------|---------------|
| Post-hoc trace fabrication | Agent computes outcome first, fabricates matching trace | Commit-reveal scheme (hash before outcome) + Blind Sequencer test events | zkTLS + TEE (Phase 3) |
| Selective submission | Only submit traces for winning predictions | Coverage ratio monitoring (traces submitted / triggers received) | Framework-native tier |
| Data provenance fraud | Agent claims false input data | Cross-verify with oracle price at same timestamp | Automated oracle validation |
| Reasoning-execution separation | One agent decides, another generates the trace | Temporal correlation analysis of trace timestamps | TEE attestation |
| Timestamp manipulation | Backdate traces by seconds | Commit-reveal with tight time window | zkTLS session timestamps |

---

## 6. Existing Demo System (DESIGN.md)

A working 3-agent demo pipeline on SUI testnet:

**Agent A (Sentiment):** Consumes CryptoPanic news → produces sentiment signal → stores trace on Walrus DA.

**Agent B (Prediction):** Consumes Agent A's sentiment + CoinGecko BTC price → produces 24h price prediction → stores trace on Walrus DA → validated 24h later against real price.

**Agent C (Portfolio):** Consumes Agent B's prediction + real SUI price → produces portfolio allocation recommendation → stores trace on Walrus DA → RAID score committed to SUI testnet.

All components use free tiers (CoinGecko, SUI testnet, Walrus testnet). Zero cost to operate.

---

## 7. World Cup Agent Arena (Active Development)

The primary near-term initiative. A public leaderboard of 5 AI agents predicting the 2026 FIFA World Cup via Polymarket. Runs June 11 – July 19, 2026 (39 days, 104 matches).

### 7.1 Strategic Purpose

The Arena solves three problems simultaneously: it provides a time-bound event with verifiable outcomes (every match result is objective), it generates organic attention (50B global World Cup audience), and it lets Stair AI control the entire supply side (all agents are internal).

**Core thesis demonstration:** The leaderboard defaults to sorting by Stair AI Score (reasoning quality), NOT by P&L. When users see that the most profitable agent doesn't have the best reasoning score, they experience the product's value proposition firsthand.

### 7.2 Agent Roster

Five agents positioned on a 2×2 matrix (Information Source × Reasoning Depth):

| Agent | Information Source | Reasoning Depth | Expected Score | Personality |
|-------|-------------------|----------------|---------------|-------------|
| **FOMO** | Social signals (Polymarket momentum) | Shallow | 15-25 / 100 | The degen, chases hype |
| **The Scout** | On-pitch data (Sportradar stats) | Shallow | 25-40 / 100 | Stats intern, reads numbers but doesn't understand them |
| **Contrarian** | Mixed (Polymarket + Sportradar) | Medium | 45-55 / 100 | Fades the market when data disagrees |
| **Oddsmaker** | Social signals (Polymarket vs bookmaker spreads) | Deep | 60-75 / 100 | Wall Street quant shorting prediction markets |
| **Deep Field** | On-pitch data (full Sportradar suite + historical) | Deep | 80-95 / 100 | Expert analyst with multi-step reasoning and post-match reflection |

Designed to produce three recurring narrative conflicts: FOMO vs Contrarian ("follow or fade the crowd"), The Scout vs Deep Field ("reading data vs understanding data"), Oddsmaker vs the field ("is the market ever wrong").

### 7.3 Arena Stair AI Score (Football-Specific)

| Dimension | Weight | What it measures |
|-----------|--------|-----------------|
| Reasoning specificity | 25% | Cites specific data points vs. vague claims |
| Internal consistency | 20% | Steps logically follow from each other |
| Uncertainty acknowledgment | 20% | Quantifies confidence, identifies what could go wrong |
| Information breadth | 15% | Multiple signals vs. single-input anchoring |
| Temporal coherence | 10% | Stable reasoning patterns across similar situations |
| Post-decision reflection | 10% | Analyzes own errors and adjusts |

Score does NOT incorporate prediction accuracy or P&L — by design, reasoning quality and outcome quality are measured independently.

### 7.4 Data Sources

| Source | Use | Priority |
|--------|-----|----------|
| Sportradar Soccer v4 Push Events | Real-time match events (goals, cards, shots) | Critical |
| Sportradar Push Statistics | Real-time team/player stats (possession, xG) | Critical |
| Sportradar Live Probabilities | Bookmaker-derived win probabilities | High |
| Polymarket API | Real-time odds, price movements | Critical (FOMO, Contrarian, Oddsmaker) |
| Public football datasets | Historical World Cup data | Medium (Deep Field only) |

**Status:** Sportradar trial application submitted. Sportmonks registered as fallback.

### 7.5 On-Chain Integration

All reasoning traces are anchored on-chain, silently in the backend — users do not need wallets or blockchain knowledge. Pipeline: Agent produces trace → Upload to Walrus DA → Commit Merkle root + Blob ID to SUI Trace Ledger → Store reference in Arena DB.

### 7.6 Content & Distribution Strategy

Arena's success is determined by content, not product quality. Daily content cadence: pre-match prediction threads (morning) → post-match reasoning breakdowns (within 30 min of final whistle) → weekly reasoning highlights. A dedicated content lead is being hired. Champions League Final (May 31) is the public dry run.

### 7.7 Development Timeline

| Phase | Dates | Deliverables |
|-------|-------|-------------|
| Phase 0: Decisions | By April 22 | Content lead, agent specs, Sportradar status, scoring methodology |
| Phase 1: Core Agents | April 22 – May 7 | FOMO + Deep Field built, Walrus/SUI pipeline connected |
| Phase 2: Conflict Pairs | May 7 – May 21 | Contrarian + Oddsmaker, leaderboard frontend, agent profile pages |
| Phase 3: Polish & Dry Run | May 21 – May 31 | The Scout (cut if behind), Champions League dry run |
| Phase 4: Pre-Tournament | June 1 – June 10 | Iteration, content calendar, Polymarket wallets funded |
| Phase 5: Tournament Live | June 11 – July 19 | Daily content, trace publishing, leaderboard updates |
| Phase 6: Post-Tournament | July 20+ | Full dataset published, Arena opens for external agents |

### 7.8 Success Metrics

| Category | Metric | Target |
|----------|--------|--------|
| Content | Peak single thread impressions | 100K+ |
| Content | Arena website unique visitors (tournament) | 50K+ |
| Product | Reasoning traces published on-chain | 500+ |
| Product | Score variance across agents | >40 point spread |
| Strategic | Inbound developer inquiries post-tournament | 10+ |
| Strategic | VC conversations attributed to Arena | 3+ |

---

## 8. Reasoning Ledger SDK (v0.1)

TypeScript client library (`@stairai/ledger-sdk`) for third-party agents to submit reasoning traces. Built alongside the World Cup Arena but designed to be general-purpose.

**v0.1 scope:** Fluent builder API for trace construction, HTTP submission to Stair AI Trace Service. No direct on-chain dependency — chain anchoring handled server-side.

**Deferred:** Direct Walrus/SUI publishing, Python/Go ports, client-side trace signing (BYOI), streaming submission.

---

## 9. Planned Revenue Path

Revenue model evolves through four phases:

| Phase | Timeline | Revenue Source | Mechanism |
|-------|----------|---------------|-----------|
| 1 | Now – 6 months | Manual audit reports | Hand-crafted agent reasoning audits for DAO treasuries / vault managers ($500-$2000/report) |
| 2 | 6-12 months | SaaS dashboard | Automated scoring + monitoring, monthly subscription ($200-$500/org) |
| 3 | 12-18 months | Reputation API | DeFi protocols query RAID scores for risk decisions, per-query or AUM-based pricing |
| 4 | 18+ months | Protocol-level fees | Transaction fees on staking, signal subscriptions, Smart Vaults |

**Current status:** No revenue. No paying customer. World Cup Arena is the primary vehicle for building credibility and finding the first paying users.

---

## 10. Ecosystem Positioning

### 10.1 Marketplace (Future)

Three planned consumer products:

- **Signal Subscriptions:** Pay to stream top agents' verified terminal actions into trading pipelines.
- **Agent Staking:** Stake tokens on agents, creating a prediction market for agent performance.
- **Smart Vaults:** Deposit capital into automated pools that follow only agents above a RAID score threshold.

### 10.2 Where Stair AI Sits in the Stack

Stair AI is middleware between agent computation and on-chain financial execution. It is agent-agnostic (any framework, any LLM provider) and chain-agnostic (BYOI accepts any cryptographic identifier). It does not host agents or execute trades — it records, evaluates, and publishes trust signals.

---

## 11. Team & Open Roles

- **Colin Qian** — CTO. Technical architecture, protocol design, engineering execution.
- **Shae (CEO)** — ENFP communicator. Cultural fit, relationship-building, fundraising narrative.
- **Co-founder** — Open / TBD.
- **Content Lead** — Actively hiring (critical for Arena). Must be fluent in X/Twitter engagement for crypto and AI audiences.
- **Community & Social Media Ops** — Interview process designed for Discord/Telegram/Twitter, Web3 audiences.

---

## 12. Document Index

| Document | Purpose | Last Updated |
|----------|---------|-------------|
| `Stair_AI_Thesis.md` | One-page thesis: the problem stack from cryptographic to commercial | Current |
| `whitepaper.md` | External-facing protocol overview (6 sections) | v1.0 |
| `blockchain_writeup.md` | Blockchain value proposition summary (Walrus + SUI + future zkTLS/TEE) | Current |
| `tech-design.md` | Full engineering architecture spec (14 sections, 1400+ lines) | March 22, 2026 |
| `DESIGN.md` | 3-agent demo system design with real data integration | March 27, 2026 |
| `World_Cup_Agent_Arena_Design_v1.md` | Arena product design: agents, scoring, content, timeline | April 15, 2026 |
| `Arena_Tech_Design_v1.md` | Arena engineering design: data pipeline, agent runtime, scoring engine | April 15, 2026 |
| `Arena_Platform_Engineering_Spec.md` | Arena platform spec: APIs, database schema, frontend, deployment | April 20, 2026 |
| `Reasoning_Ledger_SDK_Design_v0_1.md` | SDK design for third-party trace submission | April 22, 2026 |

---

## 13. Key Strategic Tensions (Unresolved)

1. **Timing risk:** The agent economy may be 1-2 years from generating real demand for trust infrastructure. Stair AI must survive until then.

2. **Adoption vs trust tradeoff:** Higher trust requires more runtime control (framework-native), but higher adoption requires less friction (self-attested). The three-tier model is the current resolution but each tier serves a different market with different GTM motions.

3. **Score stability vs market volatility:** Process scores are designed to be market-independent, but some dimensions (confidence calibration, regime awareness) inherently depend on market conditions over time. Slashing must only attach to truly market-independent metrics.

4. **Supply-side bootstrapping:** No external agents are submitting traces. Current strategy: self-operate agents (World Cup Arena) to generate data, prove scoring methodology, then convert credibility into developer adoption.

5. **Independent company vs feature risk:** If Chainlink, Eigenlayer, or a major DeFi protocol decides to build agent reputation, they have existing infrastructure and distribution. Stair AI's moat is independent third-party credibility — but that only exists once the score has market recognition.
