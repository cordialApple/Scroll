# Sample implementation (illustrative)

Not a decided design. A concrete-enough picture to reason about the contracts and to give a reviewer
something to attack. Edge labels reference the five contracts in [boundaries.md](boundaries.md).

## Structure

```mermaid
flowchart TB
  subgraph C["Consumers — depend on Scroll, never the reverse"]
    PS["PersonalServer<br/>C# MCP, Claude-only"]
    SF["STARfolio<br/>Electron"]
  end

  subgraph S["Scroll — depends on nothing"]
    SP["Endpoint spawners<br/>doc-es / ide-es"]
    GATE{"programmatic gate<br/>Strategy"}
    subgraph RM["Room — single authority per document"]
      YD[("Y.Doc gc:false")]
      AW["awareness (ephemeral)"]
      NA["Native attention-anchored agent"]
    end
    GR["Grader + sandbox<br/>authoritative oracle"]
    DB[("Persistence<br/>Postgres snapshot + update log")]
  end

  subgraph P["Peer instances — join via peer protocol"]
    HU["Human clients<br/>y-indexeddb"]
    IV["STARfolio interviewer<br/>headless peer, Adapter"]
  end

  PS -->|"contract 2: seed schema · on"| SP
  SF -->|"contract 3: select mode · off"| GATE
  SF -.->|runs| IV
  SP --> RM
  GATE --> RM
  GATE -.->|"on: admit no AI peer"| IV
  HU -->|"contract 1: peer protocol"| YD
  IV -->|"contract 1: peer protocol"| YD
  NA -->|"same protocol (dogfood)"| YD
  YD <--> AW
  RM -->|"contract 5: persist-before-ack"| DB
  SP -->|"ide-es submission"| GR
```

Notice the arrows: every consumer arrow points **into** Scroll, and nothing inside Scroll points back
out at a consumer. That is the dependency-direction rule made visual. The interviewer (`IV`) reaches
`Y.Doc` through the same peer-protocol edge a human (`HU`) and the native agent (`NA`) use, and the
programmatic gate is what admits or refuses it.

## Flow: PersonalServer coding problem (programmatic on)

```mermaid
sequenceDiagram
  actor User
  participant Claude as Claude (conversation)
  participant PS as PersonalServer (MCP)
  participant Scroll
  participant Grader as Scroll grader

  User->>Claude: ask for a coding problem
  Claude->>PS: call seed tool
  PS->>Scroll: create_ide_es(schema, programmatic:on)
  Note over Scroll: contract 2 (Factory) + contract 3 (Strategy: no AI peer)
  Scroll-->>PS: endpoint URL
  PS-->>Claude: URL + staged hints
  Claude-->>User: here is your IDE link
  User->>Scroll: write solution, submit
  Scroll->>Grader: hidden tests + TLE budget
  Note over Grader: contract 4 — authoritative oracle, not consumer-driven
  Grader-->>Scroll: pass / fail
  Scroll-->>User: resolves only on pass within budget
```

The consumer (PersonalServer) touches exactly one seam (`create_ide_es`) and never the grader. Claude
in conversation is the only intelligence on this path; `programmatic:on` is what guarantees no other
AI joins.

## Flow: STARfolio interview (programmatic off)

```mermaid
sequenceDiagram
  actor User
  participant SF as STARfolio (Electron)
  participant Scroll
  participant IV as Interviewer peer

  SF->>Scroll: create endpoint, programmatic:off
  Note over Scroll: contract 3 — off admits an external AI peer
  Scroll-->>SF: endpoint / room
  SF->>IV: start interviewer, wrap AI+voice as a peer (Adapter)
  IV->>Scroll: join room (contract 1: peer protocol, authenticated)
  User->>Scroll: edits document / notepad
  Scroll-->>IV: Y.Doc deltas + awareness
  IV->>Scroll: writes via CRDT ops at Y.RelativePosition, own awareness
  Note over Scroll: same discipline as the native agent, enforced room-side
```

STARfolio owns the interviewer intelligence and voice; Scroll owns the room and the protocol. At the
boundary the interviewer is indistinguishable from a human collaborator.
