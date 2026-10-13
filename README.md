# Cambio

A real-time, server-authoritative implementation of Cambio — the card game where
the lowest hand wins, you don't know your own cards, and snapping a match is a
race decided in milliseconds.

## The game

Four cards each, dealt face down. You may study two of them before the first
turn, and after that remembering them is your problem — the server shows a
peeked card once and never again.

On your turn, draw from the deck or take the discard top. A card drawn from the
deck can be swapped into your hand or discarded, and discarding a power card
triggers it:

| Card | Power |
| --- | --- |
| 7, 8 | Look at one of your own cards |
| 9, 10 | Look at one of another player's cards |
| J, Q | Blind swap one of yours for one of theirs |
| K | Look at any card, then swap or pass |

A card taken from the discard pile grants no power — it must go into your hand.
Powers are optional; you may decline one.

**Scoring.** `A` = 1, pips at face value, `J`/`Q` = 10, a black `K` = 13, a red
`K` = **-1**, and jokers = 0. The deck is 54 cards.

**Snapping.** At any time, if a card in any hand matches the rank of the discard
top, you can snap it. Hit your own and it leaves your hand. Hit someone else's
and theirs is discarded, but you owe them one of yours. Get the rank wrong and
you take a penalty card. Empty your hand and the round ends on the spot.

**Calling Cambio.** Instead of drawing, call Cambio. Everyone else takes one
final turn, then all hands are revealed. Lowest total wins, and the caller wins
ties — taking the risk earns the tiebreak. Call without the lowest hand and you
take a 10-point penalty. Hands are revealed and scored, and the host can play
another round with the same table.

## How a snap race is decided

Snapping is the only part of the game where latency could decide the outcome, so
it is not resolved first-packet-wins.

The server probes each client with a nonce and times the echo itself, keeping an
EWMA of the round trip. The client never reports a clock, so there is nothing to
misreport. When the first snap lands, a 200ms window opens; every snap arriving
inside it joins the same race, and the winner is the earliest
`arrival − rtt / 2`:

```
first snap arrives -> open 200ms window

  Ana   arrival 1000ms  rtt 40ms  -> 980
  Bo    arrival 1010ms  rtt 90ms  -> 965   <- WINS
  Cy    arrival 1180ms  rtt 30ms  -> 1165
```

Bo's packet landed later but Bo hit the table first. Ties break on raw arrival
and then on player id, so the result never depends on map iteration order and
every client is told the same winner. Compensation is capped at 150ms so an
extreme round trip cannot buy an arbitrary head start.

The client flashes the snap locally the instant you click, then reconciles to
the authoritative result — including a toast naming the winner and the margin.

## Architecture

```
shared/src/        the protocol both sides compile against
  protocol.ts        ClientMsg | ServerEvent, the view types
  cards.ts           card model, scoring, powers
  rules.ts           every tunable constant

server/src/
  engine/reduce.ts   the entire rule surface, as one pure function
  engine/state.ts    authoritative state + per-player view redaction
  engine/score.ts    hand scoring and round settlement
  snap.ts            the latency-compensated race
  rtt.ts             server-measured round-trip times
  rooms.ts           rooms, seats, session tokens, timers
  gateway.ts         sockets <-> room manager
  server.ts          HTTP + WebSocket + static client

client/src/
  screens/           Home, Lobby, Table, GameOver
  components/        Card, Hand, Piles, SnapBar, Toasts, TurnClock
  state/useGame.ts   view, transient peeks, snap arming, toasts
  net/socket.ts      typed client with auto-reconnect
```

Three decisions shape the rest:

**The rules engine is pure.** `reduce(state, actor, action, { now, rng })` reads
no clock and no randomness of its own, so every rule — every power, every
illegal move, scoring, deck exhaustion — is tested as a plain function call with
no server and no timing flake.

**Views are redacted per player, keyed on card instance.** Knowledge is tracked
as `knownBy: Map<CardId, Set<PlayerId>>`, attached to the card rather than the
slot it occupies. That is what makes a blind J/Q swap come out right: knowledge
travels with the card into its new hand. Every byte of table state a client
receives goes through `viewFor`, and an integration test asserts over a whole
round that no player is ever sent a card they hadn't earned.

**One service, not two.** Express serves the built client on the same port as
the WebSocket, so the page always opens its socket against its own origin. There
is no configurable server URL to get wrong.

## Running it

```bash
npm install
npm run dev     # server on :8080, client on :5173 with /ws proxied
```

Open http://localhost:5173 in two or more tabs. Vite proxies `/ws` through to
the server, so the single-origin assumption holds in development too. The
session token lives in `sessionStorage`, which is per-tab, so each tab is a
separate player — and a refresh puts you back in your seat.

Production is a single process:

```bash
npm run build
npm start       # serves the client and the socket on :8080
```

## Testing

```bash
npm test         # 201 unit + integration tests (vitest)
npm run test:e2e # browser tests (playwright)
npm run test:all # both
npm run typecheck
```

- **Unit** — the deck and scoring, then the reducer against the whole rule
  surface: each power, `knownBy` correctness through swaps, Cambio sequencing
  and ties, deck-exhaustion reshuffles, and every illegal move.
- **Snap arbiter** — the race as pure ordering, plus RTT measurement: the
  headline later-but-lower-ping case, the window boundary to the millisecond,
  deterministic tie-breaks, and the compensation cap.
- **Integration** — a real server and real sockets: join, kick, token
  revocation, host migration, refresh mid-game, grace expiry, a full round to
  scoring, latency-compensated races driven by delayed pongs, and the
  hidden-information leak assertion.
- **E2E** — 33 tests in real browsers, one context per player: lobby and kick, a
  reload mid-game, a round played entirely by clicking, playing again,
  and two browsers racing a snap with one of them throttled, asserting the whole
  table agrees on the winner.

Determinism is built in: the deck takes an injected seeded RNG, the reducer
takes `now`, and the snap arbiter takes a clock and a scheduler, so a failing
race replays exactly instead of flaking.

## Configuration

Every rule and timing is a constant in `shared/src/rules.ts` — hand size,
initial peeks, the snap window, the peek duration, the turn clock, the Cambio
penalty, reconnect grace, and the RTT cap.

One is worth calling out. `SERVER_REMEMBERS_PEEKS` is `false`: a peek is shown
once and then forgotten by the server, so remembering your cards is your job and
refreshing costs you that memory. Set it to `true` and the server keeps sending
every card you have legitimately seen, so a reload restores it exactly. Both are
honest readings of the game; `false` preserves the memory challenge, which is
most of Cambio.

Environment: `PORT` (default 8080).
