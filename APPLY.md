# v2.15.0 apply notes

## 1. Overwrite these four files

```
src/index.ts
src/tools/debugEvent.ts
test/v2_15_0.test.ts      (NEW)
package.json
```

## 2. DELETE one file. A zip cannot express a deletion, so do this by hand.

```
src/tools/debugInjuries.ts
```

Nothing imports it. `src/index.ts` never referenced it, so there is nothing
dangling to clean up. `test/v2_15_0.test.ts` ASSERTS it is gone, so the suite
fails if it is still present (mutation-verified: restoring the file fails the
suite).

One loose end left deliberately alone: `bdlClient.getRawInjuries()` was that
tool's only caller in `src/`. It is now unused except by a stub in
`test/toolWiring.test.ts`. Removing it would mean editing two more files for no
behavioural gain, so it stays. Flagging it rather than hiding it.

## 3. Unchanged on purpose

- `src/tools/futures.ts` kept, still unregistered. Blocked on the `type` value
  this release makes readable.
- `src/tools/teamRecord.ts` kept, still unregistered, per your call.

## 4. Verify after deploy

```
npm test          # expect 851 pass / 0 fail
```

Then confirm the deploy took and read the field this release exists for:

```
tkb_get_api_usage                 -> header should report 2.15.0
tkb_debug_raw_event(sport: "nfl", eventID: "ygBw5sEmEBR0sBPv7C4g")   # 15 Aug preseason
tkb_debug_raw_event(sport: "nfl", eventID: "J5HTln3CEGxm5DE8iDDD")   # 13 Sep reg opener
```

Read `SCALARS_FIRST.type` in both. If the two differ, that is the preseason
discriminator and the NFL/NHL filter can be built on it. If both say "match",
SGO does not distinguish and the fallback is a per-sport season-start date
table. Do not build the table until those two calls are made.
