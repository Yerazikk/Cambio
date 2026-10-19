# Cambio

A real-time, server-authoritative implementation of Cambio — the card game where
the lowest hand wins, you don't know your own cards, and snapping a match is a
race decided in milliseconds.

## The game

Four cards each, dealt face down and laid out two by two. You may study your
bottom two before the first turn, and after that remembering them is your
problem — the server shows a peeked card once and never again.

On your turn, draw from the deck or take the discard top. A card drawn from the
deck can be swapped into your hand or discarded, and discarding a power card
triggers it:

| Card | Power |
| --- | --- |
| 7, 8 | Look at one of your own cards |
| 9, 10 | Look at one of another player's cards |
| J, Q | Swap any two cards on the table — two of yours, two of theirs, or one of each |
| K | Look at any card, then swap any two cards - or pass |

A card taken from the discard pile grants no power — it must go into your hand.
Powers are optional; you may decline one.

**Decks.** The host picks one, two, or three packs before the round starts. More
packs means more of every rank on the table, so snaps come up far more often.

**Cards.** The host also picks the back the table plays with. It is purely
cosmetic - every card wears the same one, so it gives nothing away - and it can
be changed at any point, mid-round included. The artwork lives in
`client/public/backs`; a new back is an SVG dropped in there plus a line in
`CARD_BACKS` in `shared/src/rules.ts`.

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

## The table

You are looking down at one table from above. Everyone has a seat on its rim,
spaced evenly round it - four players make a square, five a pentagon, six a
hexagon - and the seats keep the order the players are listed in, so the person
who plays after you is on your left and play runs clockwise. You are always at
the bottom, facing your own hand, which means every player learns the same
layout and the same place to look for their own cards.

Your hand sits above the card you have temporarily drawn, and everyone else's
drawn card sits beside theirs, out towards the middle of the felt. That is both
where you would put a card down at a real table and the one direction a seat
can grow without crowding its neighbour.

### What everyone can see

Cambio is played face down, which could make it opaque - someone across the
table does something, and all you get is a new discard. So every move is
broadcast in public terms and animates on every screen at the same moment:

| You see | Because at a real table |
| --- | --- |
| A card lift and tip as someone looks at it | You watch them pick it up |
| Both ends of a swap flip and settle | You watch the two cards cross |
| A drawn card appear at a player's seat | You watch it leave the pile |
| The face of a card taken off the discard | It was face up on the way out |
| The snapped card shake, red | Someone slapped the table |

What is never sent is the face of a card the viewer has not earned. The server
announces the gesture and the slots it landed on - `{ kind, byId, slots }` - and
nothing else, so you can see exactly which of someone's cards they just looked
at and still have no idea what it was. Remembering it is their problem, and
remembering that they looked is yours. A running log in the corner of the felt
names the last few moves in words, for the half-second after one lands.

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
  components/        Card, Seat, Piles, SnapBar, TableLog, Toasts, TurnClock
  seating.ts         where each player sits, as one formula
  state/useGame.ts   view, transient peeks, move animations, snap arming
  net/socket.ts      typed client with auto-reconnect
```

Three decisions shape the rest:

**The rules engine is pure.** `reduce(state, actor, action, { now, rng })` reads
no clock and no randomness of its own, so every rule — every power, every
illegal move, scoring, deck exhaustion — is tested as a plain function call with
no server and no timing flake.

**Views are redacted per player, keyed on card instance.** Knowledge is tracked
as `knownBy: Map<CardId, Set<PlayerId>>`, attached to the card rather than the
slot it occupies. That is what makes a sight-unseen J/Q swap come out right: knowledge
travels with the card into its new hand. Every byte of table state a client
receives goes through `viewFor`, and an integration test asserts over a whole
round that no player is ever sent a card they hadn't earned.

**Seating is geometry, not cases.** `seatRing` rotates the player list so the
viewer is first, then walks it round an ellipse at `360 / n` degrees a step from
the bottom. Every table size falls out of that one formula, and each seat
arrives as a left/top percentage of the felt - so the ring reshapes itself with
the window instead of needing a layout per player count.

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
npm test         # 234 unit + integration tests (vitest)
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
- **E2E** — 40 tests in real browsers, one context per player: lobby and kick, a
  reload mid-game, a round played entirely by clicking, playing again,
  two browsers racing a snap with one of them throttled, asserting the whole
  table agrees on the winner, and the shared view of the table - that each
  player sits in their own bottom seat with the others round them in order, and
  that a move animates on the other player's screen without its face going with
  it.

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
