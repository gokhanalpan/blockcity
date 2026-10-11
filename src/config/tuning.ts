// Every tunable number in the game lives here. The simulation, events, goals, save and (later) the
// renderer import from this file and never carry magic numbers of their own.
// Values match the Roblox version (Block City Tycoon) unless a comment says otherwise.

export const GRID = {
  SIZE: 48, // cells per side; must be a multiple of CHUNK
  CHUNK: 8, // cells per side of one purchasable land chunk
  CELL_UNITS: 4, // world units per cell (the models are built in Roblox studs: 4 per cell)
} as const;

export const ECONOMY = {
  STARTING_CASH: 400,
  TICK_SECONDS: 2,
  TAX_PER_CITIZEN: 2, // cash per tick per resident in a powered house
  TAX_PER_WORKER: 3, // extra per employed resident
  UNPOWERED_TAX: 0.5, // fraction an unpowered house still pays
  BASE_INCOME: 2, // paid every tick no matter what, so nobody can get stuck at $0
  MAX_LANDMARK_BONUS: 0.5, // cap on the summed incomeBonus of working landmarks
  LAND_PRICE_BASE: 200, // price of the next chunk = BASE * (owned - 1)^2
} as const;

export const REBIRTH = {
  MIN_POP: 600,
  INCOME_BONUS: 0.1, // per rebirth
  MAX_BONUS: 0.5,
  START_CASH: 2000, // per rebirth, on top of STARTING_CASH
} as const;

export const MOOD = {
  BASE: 5,
  POWER: 2,
  PER_SERVICE: 1,
  PARK: 1,
  WATERFRONT: 1,
  UNEMPLOYED: -1,
  JAMMED: -1,
  MAX_POLLUTION_PENALTY: 3,
  POLLUTION_RADIUS: 3, // cells beyond a polluter's footprint
  AMENITY_RADIUS: 4, // default park reach when a def has no radius
} as const;

export const GROWTH = {
  THRESHOLD: 10, // accumulator points per resident moving in or out
  NO_ROAD_SHRINK: -3, // per tick
  NO_SERVICES_SHRINK: -2, // per tick, homes that need full coverage but lack it
} as const;

export const TRAFFIC = {
  PEOPLE_PER_TRIP: 4, // one car per this many residents or jobs
  JAM_JOBS_FACTOR: 0.5, // a workplace behind a jam offers this fraction of its jobs
  BIG_ROAD_CAPACITY: 240, // needsBigRoad: access road must carry at least this (avenue or highway)
} as const;

export const EVENTS = {
  MAX_ACTIVE: 3,
  COOLDOWN_TICKS: 20, // at least this many ticks between new events
  FIRST_COOLDOWN_TICKS: 15, // a fresh session gets a quiet start
  MIN_POP: 10, // no events below this population
  CHANCE_BASE: 0.015, // chance per tick = min(BASE + pop / CHANCE_POP_DIV, CHANCE_MAX)
  CHANCE_POP_DIV: 12000,
  CHANCE_MAX: 0.06,
  FIRE_TICKS: 14, // ticks before an unattended fire becomes ruins
  FIRE_FIGHT_TICKS: 4, // ticks a reachable fire station needs
  BLACKOUT_TICKS: 30,
  CRASH_TICKS: { road: 15, avenue: 9, highway: 6 }, // by capacity tier
  STORM_TICKS: 25,
  STORM_PASSED_TICKS: 3, // the harmless storm banner
  CRIME_MAX_TICKS: 60,
  CRIME_RADIUS: 4, // workplaces this close to the centre are hit
  FESTIVAL_TICKS: 40,
  FESTIVAL_FUN_MULT: 2,
  FESTIVAL_INCOME_MULT: 1.5,
  RUSH_TICKS: 30,
  RUSH_GROWTH_MULT: 3,
  RUSH_MIN_FREE_CAPACITY: 20, // a housing rush needs this much empty home capacity
  WEIGHTS: { fire: 5, blackout: 3, crash: 4, storm: 2, crime: 3, festival: 2, rush: 2 },
  FIRE_WEIGHT: { polluter: 4, generator: 2, other: 1 },
  CRIME_HALF_JOBS: 0.5,
} as const;

export const GOALS = {
  ACTIVE: 3, // live goals on the board
} as const;

export const FEED = {
  KEEP: 6, // lines kept
  EVERY_TICKS: 4, // a new line at most this often
  COMPLAIN_CHANCE: 0.7, // when both complaints and compliments are available
  WATER_LINE_CHANCE: 0.5,
  PARK_LINE_CHANCE: 0.3,
  PARK_LINE_MIN_MOOD: 9,
  HAPPY_MIN_MOOD: 8,
} as const;

export const SAVE = {
  SLOTS: 3,
  OFFLINE_CAP_SECONDS: 8 * 3600, // pay at most this much time away
  OFFLINE_MIN_SECONDS: 30, // ignore shorter absences (a reload)
  MAX_NAME: 20,
  DEFAULT_NAME: "My City",
  AUTOSAVE_DEBOUNCE_MS: 250, // "after every change", coalesced
} as const;
