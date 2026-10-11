# Block City

Single-player toy-city builder for the browser. TypeScript, Vite, Three.js. A port of the Roblox game
Block City Tycoon: the simulation, events, goals and building models are the same.

```
npm install
npm run dev        # http://localhost:5173
npm test           # vitest: simulation, events, goals, saves, model factory
npm run build      # dist/ — zip it and upload to itch.io (base is "./")
npm run models     # re-export src/assets/models.json from ../district-tycoon/rbxmx/models
```

Dev URLs: `?gallery` (model gallery), `?demo&slot=2` (a starter city in slot 2), `?slot=1&map=river`
(open or create slot 1 on that map). Keys: 1-9 pick a card, R turn, 0 demolish, Esc inspect, B hide
the dock, Q/E turn the view, arrows pan.

## Layout

```
src/config/tuning.ts     every tunable number (economy, mood, growth, traffic, events, feed, saves)
src/config/catalog.ts    the tile catalog (ids are saved: never renumber) and build-menu categories
src/sim/                 game state and rules; no DOM, no Three.js
  terrains.ts            water shape per map
  district.ts            grid math, land chunks, tiles, city blob serialize/deserialize
  simulation.ts          recompute (roads, power, traffic, coverage, mood, economy) and collect
  events.ts              fires, blackouts, crashes, storms, crime, festivals, housing rushes
  goals.ts               the goal list and the live board
  citizenFeed.ts         what citizens say
  city.ts                the controller: validate/place/remove/buy land/tick; emits changes
src/save/                save envelope (format.ts) and slots over localStorage (storage.ts)
src/render/              Three.js, reads the City and never writes it
  models.ts              models.json -> merged vertex-coloured geometry per key
  terrain.ts             the island, water, sea, main road, land-for-sale overlays
  roads.ts               road tiles decorated from their neighbours (curbs, lane lines, rails)
  world.ts               keeps the scene in step with City.onChange; ghost preview; selection
  camera.ts / input.ts   tilted camera; mouse + touch (pan, wheel/pinch zoom, Q/E turn, tap)
  labels.ts              DOM labels projected over the 3D view
src/ui/                  HUD: dock.ts (build cards, start screen), panels.ts (top bar, goals,
                         inspect, stats, toasts, citizen feed), previews.ts (card thumbnails),
                         sounds.ts (WebAudio, no files)
src/game.ts              boots a session and wires world, input and HUD together
src/gallery.ts           dev page (?gallery): every model on a lawn
src/assets/models.json   exported from the Roblox build (tools/export_models.py)
tests/                   vitest
```

## Rules in one paragraph

A 48x48 grid in 8x8 chunks; you start with the two front-centre chunks and buy edge-adjacent ones at
`200 * (owned-1)^2`. The entrance is the middle three cells of the front edge. Anything can be placed
anywhere you own, but a building only works once a road reachable from the entrance touches it and it
has power (oldest placements keep power in a brownout). Every tick (2 s) buildings send one trip per
four people down the shortest road path to the entrance; a road over capacity jams and everything behind
it is blocked. Services cover a square around them up to a capacity, parks are amenities, polluters cost
mood unless greenery cancels it. A home's mood (0..10) drives an integer growth accumulator: residents
move in while it's happy, out while it isn't. Income = 2 + (residents*2 [half if unpowered] + employed*3)
× (0.6 + happiness/10) × landmark bonuses. Events start on their own after the city has 10 residents;
goals pay cash in order. Full detail is in the comments of `src/sim/*.ts` and the Roblox README.

## Saves

`localStorage` keys `blockcity.slot.1..3`. A save is `{ format: "block-city", version, id, revision,
origin, savedAt, playSeconds, meta, city }` where `city` is the Roblox v2 blob. `id` and `revision` are
the hooks for a cloud store or a market later; nothing uses them yet. Export writes that JSON to a file;
import accepts it, or a bare Roblox blob. On load the city is paid `income × ticks` for the time away,
capped at 8 hours.
