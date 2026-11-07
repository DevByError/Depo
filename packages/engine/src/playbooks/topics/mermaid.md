---
title: Mermaid diagrams that render the first time
summary: C4 views with flowcharts, ERD syntax with keys and cardinality, sequence and state diagrams, user flows, and the syntax traps that break rendering.
agents: diagram, reasoning, devops-docs, coder
triggers: diagram, diagrams, mermaid, erd, er diagram, c4, sequence diagram, flowchart, architecture diagram, user flow, state diagram
---
# Mermaid diagrams that render the first time

## C4 context and containers (use flowchart; Mermaid's C4 syntax is experimental)
```mermaid
%% Title: Containers
flowchart LR
  patient(["Patient<br/>(browser)"])
  admin(["Admin"])
  subgraph system["Clinic Booking"]
    web["Web app<br/>React + Vite"]
    api["API<br/>FastAPI"]
    db[("PostgreSQL 17")]
    worker["Worker<br/>arq jobs"]
  end
  mail["Mail server<br/>(SMTP)"]
  patient -->|HTTPS| web
  admin -->|HTTPS| web
  web -->|"JSON over HTTPS"| api
  api -->|SQL| db
  api -->|enqueue| worker
  worker -->|SMTP| mail
```
Shapes: `[text]` box, `([text])` stadium (people), `[(text)]` cylinder (database), `{text}` decision. Directions: `LR`, `TD`.

## ERD from the real schema
```mermaid
erDiagram
  USERS ||--o{ BOOKINGS : makes
  DOCTORS ||--o{ BOOKINGS : receives
  USERS }o--o{ ROLES : has
  USERS {
    bigint id PK
    text email UK
    text password_hash
    timestamptz created_at
  }
  BOOKINGS {
    bigint id PK
    bigint user_id FK
    bigint doctor_id FK
    timestamptz starts_at
    text status
  }
```
Cardinality: `||` exactly one, `o|` zero or one, `}|` one or more, `}o` zero or more; `--` identifying (solid), `..` non-identifying (dashed). Attribute types must be one word (`timestamptz`, not `timestamp with time zone`); keys `PK`, `FK`, `UK`; an optional comment in double quotes after the key. Use the real table and column names.

## Sequence: login with refresh rotation
```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant W as Web app
  participant A as API
  participant D as Database
  U->>W: Email and password
  W->>A: POST /api/v1/auth/login
  A->>D: Find user by email
  alt valid password
    A->>D: Store hashed refresh token
    A-->>W: 200 access token + HttpOnly refresh cookie
    W-->>U: Dashboard
  else invalid
    A-->>W: 401 "Email or password is incorrect."
    W-->>U: Error message
  end
```
Arrows: `->>` call, `-->>` reply, `-x` failure. Blocks: `alt/else/end`, `opt/end`, `loop/end`, `par/and/end`. `Note over A,D: text` for notes.

## State diagram
```mermaid
stateDiagram-v2
  [*] --> Pending
  Pending --> Confirmed: staff confirms
  Pending --> Cancelled: patient cancels
  Confirmed --> Cancelled: cancel before 24h
  Confirmed --> Completed: visit done
  Completed --> [*]
  Cancelled --> [*]
```

## User flow
```mermaid
flowchart TD
  start([Open app]) --> signedIn{Signed in?}
  signedIn -- No --> login[Sign in] --> home
  signedIn -- Yes --> home[Home]
  home --> pick[Pick doctor and time] --> free{Slot free?}
  free -- Yes --> confirm[Confirm booking] --> done([Booking confirmed])
  free -- No --> msg["Show 'This time is taken'"] --> pick
```

## Traps that break rendering
- Special characters in labels (parentheses, brackets, colons, slashes, quotes, `#`, `;`): wrap the label in double quotes: `A["POST /auth/login (JSON)"]`. Inside quoted labels use `#quot;` for a double quote.
- `end` as a node id or bare label in flowcharts breaks parsing: use `End` or `done`.
- Node ids: letters, digits and underscores only; labels go in brackets.
- Edge labels: `A -->|text| B` or `A -- text --> B`; quote them if they contain special characters.
- `subgraph id["Title"]` ... `end` on its own line.
- erDiagram entity names without spaces or hyphens (`ORDER_ITEMS`); relationship labels need text after the colon (use `""` for none).
- Comments with `%%` on their own line; no trailing semicolons needed.
- Keep under 40 nodes; split large systems into one diagram per container or flow.
Validate every file with render_diagram and fix the reported line before moving on.
