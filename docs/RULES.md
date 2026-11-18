# The rules of Cambio

This is the rule book this implementation plays by. Where the README describes
how the thing is built, this describes what the game *is* — it is the reference
the engine, the tests and the in-game help screen all agree with.

## The aim

End the round with the fewest points. You are dealt four cards face down, you
may study two of them before play starts, and after that remembering what you
hold is your problem: the server shows a peeked card once and never again.

## Scoring

| Card | Points |
| --- | --- |
| Ace | 1 |
| 2–10 | Face value |
| Jack, Queen | 10 |
| Black King | 13 |
| Red King | **-1** |
| Joker | 0 |

A pack is 54 cards. The host picks one, two, or three packs before the round
starts; more packs means more of every rank in play, so slaps come up far more
often and the deck runs down more slowly.

## The deal

Four cards each, face down, two by two. Before the first turn everyone may look
at their bottom two — the same two for every player, so the opening is the same
deal for everyone. Hit **Ready** when you have seen them; play begins once the
whole table is ready.

## A turn

On your turn, either:

- **Draw from the deck.** Then swap it into your hand — the card it displaces
  goes face up on the discard pile — or discard it outright. Discarding a card
  drawn from the deck triggers its power.
- **Take the discard top.** It must go into your hand, and it grants no power:
  it was face up, so the whole table already knows what you took.
- **Call Cambio.** See below.

### Powers

A power fires only when the card was drawn from the deck and then discarded.
Powers are optional — you may always decline one.

| Card | Power |
| --- | --- |
| 7, 8 | Look at one of your own cards |
| 9, 10 | Look at one of another player's cards |
| J, Q | Swap any two cards on the table — two of yours, two of theirs, or one of each |
| K | Look at any card, then swap any two cards — or pass |

Everyone sees *which* card you looked at and *which* two you swapped. Nobody
but you sees a face you were not entitled to.

## Slapping

At any time, if a card in any hand matches the **rank** of the discard top, you
can slap it. Suit does not matter; a joker matches only a joker.

- Slap **your own** card and it goes on the discard pile. Your hand shrinks.
- Slap **someone else's** and theirs goes on the pile, but you owe them one of
  yours — you choose which, and play stops until you hand it over.
- Slap the **wrong rank** and you take a penalty card off the deck, face down.
  You do not get to see what you were given.
- Empty your hand and the round ends on the spot. Nothing beats zero cards.

### Slapping at the same moment as someone else

Two people going for the same card is a queue, not a duel. **A faster slap does
not cancel a slower one — it only goes first.**

1. Every slap made in the same instant is put in order, earliest first.
2. The first slap in the queue is played out.
3. **If it was right, the queue stops.** Everyone behind it keeps their card and
   pays nothing: being second costs you nothing at all.
4. **If it was wrong**, the slapper takes their penalty card and the next slap
   in the queue is played out. Then the third, and so on, until one of them is
   right or the queue runs out.

So slapping just after someone else is never punished for being late. It is
only ever a bet that the player ahead of you got it wrong — and if they did,
your slap still stands.

A wrong slap discards nothing, so the discard top does not change and the slap
behind it is judged against exactly the same card. A right slap *does* change
the top, which is the other reason the queue stops there.

One slap per player per queue: a double-tap counts once, so a slip of the
finger costs one card, not two.

### How the order is decided

Slapping is the only part of the game where latency could decide the outcome,
so it is not first-packet-wins. The server probes each client with a nonce and
times the echo itself — the client never reports a clock, so there is nothing
to misreport. When the first slap lands, a 200ms window opens; every slap
arriving inside it joins the same queue, ordered by the earliest
`arrival − rtt / 2`:

```
first slap arrives -> open 200ms window

  Ana   arrival 1000ms  rtt 40ms  -> 980    2nd in the queue
  Bo    arrival 1010ms  rtt 90ms  -> 965    1st in the queue
  Cy    arrival 1180ms  rtt 30ms  -> 1165   3rd in the queue
```

Bo's packet landed later but Bo hit the table first. Ties break on raw arrival
and then on player id, so the order never depends on map iteration order and
every client is told the same thing. Compensation is capped at 150ms, so an
extreme round trip cannot buy an arbitrary head start.

## Calling Cambio

Instead of drawing, call Cambio. Everyone else takes one final turn, then every
hand is revealed and scored.

- Lowest total wins.
- The caller wins ties — taking the risk earns the tiebreak.
- Call without the lowest hand and you take a **10-point penalty**.

Slapping stays live through the final turns.

## The controls

| Key | What it does |
| --- | --- |
| `S` | Arm slapping — then click any card on the table to slap it |
| `1`–`4` | Slap your own card in that slot outright, with no arming click |
| `Esc` | Cancel slapping, or a half-made choice |
| `I` | Open and close this help |

Arming disarms itself after a few seconds, so a stray later click cannot slap
by accident.
