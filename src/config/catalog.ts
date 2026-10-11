// Catalog of placeable tiles, translated from the Roblox TileDefs.lua. `id` is written into saves:
// never renumber or reuse one. Add new tiles at the end with the next free id.

export type ServiceName = "police" | "health" | "school" | "fire" | "fun";

export interface TileDef {
  id: number;
  key: string; // also the model name in src/assets/models.json
  name: string;
  cost: number;
  w: number; // footprint at rot 0, in cells
  h: number;
  needsRoad: boolean; // inactive while no road connected to the entrance touches it
  needsPower: boolean; // inactive during a brownout
  powerUse: number;
  powerGen: number;
  population: number; // residential capacity
  jobs: number;
  happiness: number; // legacy flat bonus (unused by the mood model, kept for tuning)
  refundRate: number; // fraction of cost returned on demolish
  unlockRebirth: number; // minimum rebirth count required to buy
  service?: ServiceName; // coverage type this building provides
  radius: number; // coverage radius in cells (Chebyshev, from the footprint edge)
  pollution: number; // mood penalty applied to houses within MOOD.POLLUTION_RADIUS
  amenity: boolean; // parks: +1 mood to houses within radius (or MOOD.AMENITY_RADIUS)
  needsServices: boolean; // residential that only grows when all five services cover it
  roadCapacity: number; // >0 makes this a road tile; trips per tick before jamming
  taxMult: number; // residential: tax per resident is multiplied by this
  incomeBonus: number; // landmarks: fraction added to the income multiplier while working
  parking: boolean; // car parks: serve needsParking buildings within radius
  needsParking: boolean; // big venues: only operate with a car park in reach
  onWater: boolean; // must be placed on water cells (everything else must avoid them)
  roadSide?: "front"; // the road must touch the front edge, not any side
  capacity: number; // services/fun: residents one building can serve (0 = unlimited)
  needsWater: boolean; // shore buildings: at least one footprint cell must touch water
  moored: boolean; // floating buildings: must touch land or a bridge (no road needed)
  requires?: ServiceName[]; // homes: services that must be covered to grow
  needsAmenity: boolean; // homes: only grow with a park (or the waterfront) in reach
  retired: boolean; // homes: residents don't look for jobs
  needsBigRoad: boolean; // must take its road access from an avenue or highway
  waterRadius: number; // placement: some water cell within this many cells (0 = no rule)
  needsNearKey?: string; // only works with a working building of this key within needsNearRadius
  needsNearRadius: number;
  cleans: number; // greenery: pollution it cancels for homes within its radius
}

type DefInput = Partial<TileDef> & Pick<TileDef, "id" | "key" | "name" | "cost">;

function def(t: DefInput): TileDef {
  return {
    id: t.id,
    key: t.key,
    name: t.name,
    cost: t.cost,
    w: t.w ?? 1,
    h: t.h ?? 1,
    needsRoad: t.needsRoad !== false, // default true
    needsPower: t.needsPower === true,
    powerUse: t.powerUse ?? 0,
    powerGen: t.powerGen ?? 0,
    population: t.population ?? 0,
    jobs: t.jobs ?? 0,
    happiness: t.happiness ?? 0,
    refundRate: t.refundRate ?? 0.5,
    unlockRebirth: t.unlockRebirth ?? 0,
    service: t.service,
    radius: t.radius ?? 0,
    pollution: t.pollution ?? 0,
    amenity: t.amenity === true,
    needsServices: t.needsServices === true,
    roadCapacity: t.roadCapacity ?? 0,
    taxMult: t.taxMult ?? 1,
    incomeBonus: t.incomeBonus ?? 0,
    parking: t.parking === true,
    needsParking: t.needsParking === true,
    onWater: t.onWater === true,
    roadSide: t.roadSide,
    capacity: t.capacity ?? 0,
    needsWater: t.needsWater === true,
    moored: t.moored === true,
    requires: t.requires,
    needsAmenity: t.needsAmenity === true,
    retired: t.retired === true,
    needsBigRoad: t.needsBigRoad === true,
    waterRadius: t.waterRadius ?? 0,
    needsNearKey: t.needsNearKey,
    needsNearRadius: t.needsNearRadius ?? 0,
    cleans: t.cleans ?? 0,
  };
}

// Ids are persisted in saves: never renumber or reuse one. `population` is capacity.
export const TILE_LIST: readonly TileDef[] = [
  // roads
  def({ id: 1, key: "road", name: "Road", cost: 10, needsRoad: false, roadCapacity: 60 }),
  def({ id: 13, key: "avenue", name: "Avenue", cost: 60, needsRoad: false, roadCapacity: 240 }),
  def({ id: 14, key: "highway", name: "Highway", cost: 300, needsRoad: false, roadCapacity: 800 }),
  def({ id: 35, key: "bridge", name: "Bridge", cost: 200, needsRoad: false, roadCapacity: 240, onWater: true }),
  // not in the Roblox game: a crossing that carries as much as a highway
  def({ id: 71, key: "highway_bridge", name: "Highway Bridge", cost: 1000, needsRoad: false, roadCapacity: 800, onWater: true }),
  def({ id: 33, key: "car_park", name: "Car Park", cost: 400, w: 2, h: 2, parking: true, radius: 8 }),
  def({ id: 34, key: "parking_garage", name: "Parking Garage", cost: 1500, w: 2, h: 2, needsPower: true, jobs: 2, powerUse: 2, parking: true, radius: 14 }),
  // homes
  def({ id: 15, key: "cottage", name: "Cottage", cost: 60, needsPower: true, population: 2, powerUse: 1 }),
  def({ id: 2, key: "house", name: "House", cost: 100, needsPower: true, population: 4, powerUse: 1 }),
  def({ id: 16, key: "townhouse", name: "Townhouse", cost: 240, needsPower: true, population: 8, powerUse: 2 }),
  def({ id: 18, key: "villa", name: "Villa", cost: 1200, w: 2, h: 2, needsPower: true, population: 6, powerUse: 2, taxMult: 3, needsServices: true }),
  def({ id: 12, key: "apartment", name: "Apartment", cost: 900, w: 2, h: 2, needsPower: true, population: 16, powerUse: 3, needsServices: true }),
  def({ id: 17, key: "tower", name: "Tower", cost: 2500, w: 2, h: 2, needsPower: true, population: 40, powerUse: 6, needsServices: true }),
  // work
  def({ id: 3, key: "shop", name: "Shop", cost: 250, needsPower: true, jobs: 3, powerUse: 2 }),
  def({ id: 19, key: "market", name: "Supermarket", cost: 900, w: 2, h: 2, needsPower: true, jobs: 12, powerUse: 4 }),
  def({ id: 20, key: "office", name: "Office", cost: 1500, w: 2, h: 2, needsPower: true, jobs: 20, powerUse: 5 }),
  def({ id: 4, key: "factory", name: "Factory", cost: 600, w: 2, h: 2, needsPower: true, jobs: 8, powerUse: 5, pollution: 2 }),
  def({ id: 22, key: "heavy_industry", name: "Heavy Industry", cost: 2000, w: 2, h: 2, needsPower: true, jobs: 24, powerUse: 10, pollution: 4 }),
  def({ id: 32, key: "airport", name: "Airport", cost: 30000, w: 10, h: 5, needsPower: true, jobs: 40, powerUse: 12, pollution: 2, incomeBonus: 0.15, needsParking: true, roadSide: "front" }),
  // power
  def({ id: 7, key: "generator", name: "Generator", cost: 150, powerGen: 6, pollution: 1 }),
  def({ id: 23, key: "wind_turbine", name: "Wind Turbine", cost: 350, powerGen: 8 }),
  def({ id: 24, key: "solar_farm", name: "Solar Farm", cost: 1200, w: 2, h: 2, powerGen: 25 }),
  def({ id: 5, key: "power_plant", name: "Power Plant", cost: 400, w: 2, h: 2, powerGen: 20, pollution: 2 }),
  def({ id: 25, key: "nuclear_plant", name: "Nuclear Plant", cost: 8000, w: 2, h: 2, powerGen: 120, pollution: 1, jobs: 6, needsPower: false }),
  // services (coverage)
  def({ id: 8, key: "police", name: "Police", cost: 500, w: 2, h: 2, needsPower: true, jobs: 2, powerUse: 2, service: "police", radius: 10, capacity: 150 }),
  def({ id: 9, key: "clinic", name: "Clinic", cost: 600, w: 2, h: 2, needsPower: true, jobs: 2, powerUse: 2, service: "health", radius: 10, capacity: 120 }),
  def({ id: 10, key: "school", name: "School", cost: 700, w: 2, h: 2, needsPower: true, jobs: 2, powerUse: 2, service: "school", radius: 10, capacity: 100 }),
  def({ id: 11, key: "fire_station", name: "Fire Station", cost: 500, w: 2, h: 2, needsPower: true, jobs: 2, powerUse: 2, service: "fire", radius: 10, capacity: 200 }),
  // fun (coverage, service "fun")
  def({ id: 26, key: "playground", name: "Playground", cost: 200, service: "fun", radius: 6, capacity: 60 }),
  def({ id: 27, key: "cinema", name: "Cinema", cost: 1500, w: 2, h: 2, needsPower: true, jobs: 6, powerUse: 3, service: "fun", radius: 10, capacity: 160 }),
  def({ id: 21, key: "mall", name: "Mall", cost: 4000, w: 2, h: 2, needsPower: true, jobs: 30, powerUse: 8, service: "fun", radius: 8, needsParking: true, capacity: 300 }),
  def({ id: 28, key: "stadium", name: "Football Stadium", cost: 8000, w: 5, h: 5, needsPower: true, jobs: 20, powerUse: 10, service: "fun", radius: 18, incomeBonus: 0.05, needsParking: true, capacity: 500 }),
  def({ id: 31, key: "ferris_wheel", name: "Ferris Wheel", cost: 3500, w: 3, h: 3, needsPower: true, jobs: 6, powerUse: 4, service: "fun", radius: 14, capacity: 150 }),
  // shore (must touch water)
  def({ id: 36, key: "pier", name: "Pier", cost: 300, needsRoad: false, amenity: true, radius: 5, needsWater: true }),
  def({ id: 37, key: "beach_club", name: "Beach Club", cost: 2500, w: 2, h: 2, needsPower: true, jobs: 8, powerUse: 3, service: "fun", radius: 10, capacity: 200, needsWater: true }),
  def({ id: 39, key: "fishing_dock", name: "Fishing Dock", cost: 1200, w: 2, h: 2, jobs: 12, needsWater: true }),
  def({ id: 38, key: "marina", name: "Marina", cost: 4000, w: 2, h: 2, needsPower: true, jobs: 15, powerUse: 4, incomeBonus: 0.05, needsWater: true }),
  def({ id: 40, key: "lighthouse", name: "Lighthouse", cost: 1500, needsPower: true, powerUse: 1, amenity: true, radius: 6, needsWater: true }),
  def({ id: 41, key: "water_park", name: "Water Park", cost: 6000, w: 3, h: 3, needsPower: true, jobs: 20, powerUse: 8, service: "fun", radius: 14, capacity: 400, needsWater: true }),
  // on the water (onWater: every footprint cell must be water)
  def({ id: 42, key: "houseboat", name: "Houseboat", cost: 400, needsRoad: false, moored: true, needsPower: true, population: 3, powerUse: 1, taxMult: 2, onWater: true }),
  def({ id: 43, key: "floating_restaurant", name: "Floating Restaurant", cost: 2800, w: 2, h: 2, needsRoad: false, moored: true, needsPower: true, jobs: 10, powerUse: 3, service: "fun", radius: 8, capacity: 120, onWater: true }),
  def({ id: 45, key: "fish_farm", name: "Fish Farm", cost: 1500, w: 2, h: 2, needsRoad: false, jobs: 8, onWater: true }),
  def({ id: 46, key: "ferry_dock", name: "Ferry Dock", cost: 3500, w: 2, h: 2, needsRoad: false, moored: true, needsPower: true, jobs: 6, powerUse: 2, incomeBonus: 0.03, onWater: true }),
  def({ id: 44, key: "offshore_wind", name: "Offshore Turbine", cost: 900, needsRoad: false, powerGen: 14, onWater: true }),
  def({ id: 47, key: "oil_platform", name: "Oil Platform", cost: 12000, w: 2, h: 2, needsRoad: false, powerGen: 40, jobs: 10, pollution: 3, onWater: true }),
  // more homes
  def({ id: 51, key: "duplex", name: "Duplex", cost: 800, w: 2, h: 1, needsPower: true, population: 6, powerUse: 2 }),
  def({ id: 52, key: "bungalow", name: "Bungalow", cost: 500, needsPower: true, population: 3, powerUse: 1, needsAmenity: true }),
  def({ id: 53, key: "mansion", name: "Mansion", cost: 6000, w: 2, h: 2, needsPower: true, population: 4, powerUse: 3, taxMult: 5, needsServices: true, needsAmenity: true }),
  def({ id: 54, key: "condo", name: "Condo", cost: 7000, w: 2, h: 2, needsPower: true, population: 24, powerUse: 7, needsServices: true }),
  def({ id: 55, key: "skyscraper_res", name: "Residential Skyscraper", cost: 25000, w: 3, h: 3, needsPower: true, population: 80, powerUse: 14, needsServices: true, needsBigRoad: true }),
  def({ id: 56, key: "retirement_home", name: "Retirement Home", cost: 3000, w: 2, h: 2, needsPower: true, population: 12, powerUse: 3, retired: true, requires: ["health"] }),
  def({ id: 57, key: "eco_homes", name: "Eco Homes", cost: 4000, w: 2, h: 2, population: 10 }),
  // more work
  def({ id: 58, key: "bakery", name: "Bakery", cost: 700, needsPower: true, jobs: 6, powerUse: 1 }),
  def({ id: 59, key: "diner", name: "Diner", cost: 900, needsPower: true, jobs: 8, powerUse: 2 }),
  def({ id: 60, key: "hotel", name: "Hotel", cost: 8000, w: 2, h: 2, needsPower: true, jobs: 20, powerUse: 5, incomeBonus: 0.03, waterRadius: 3 }),
  def({ id: 61, key: "warehouse", name: "Warehouse", cost: 2500, w: 2, h: 2, needsPower: true, jobs: 14, powerUse: 2, pollution: 1 }),
  def({ id: 62, key: "bank", name: "Bank", cost: 5000, w: 2, h: 2, needsPower: true, jobs: 10, powerUse: 3, incomeBonus: 0.02 }),
  def({ id: 63, key: "farm", name: "Farm", cost: 2000, w: 3, h: 3, jobs: 10, amenity: true, radius: 3, cleans: 1 }),
  // batch 2
  def({ id: 64, key: "hospital", name: "Hospital", cost: 15000, w: 3, h: 3, needsPower: true, jobs: 30, powerUse: 10, service: "health", radius: 14, capacity: 400 }),
  def({ id: 65, key: "university", name: "University", cost: 20000, w: 3, h: 3, needsPower: true, jobs: 30, powerUse: 8, service: "school", radius: 16, capacity: 400 }),
  def({ id: 66, key: "tech_campus", name: "Tech Campus", cost: 30000, w: 3, h: 3, needsPower: true, jobs: 90, powerUse: 12, needsNearKey: "university", needsNearRadius: 12 }),
  def({ id: 67, key: "cargo_port", name: "Cargo Port", cost: 18000, w: 3, h: 2, needsPower: true, jobs: 30, powerUse: 6, pollution: 2, incomeBonus: 0.05, needsWater: true }),
  def({ id: 68, key: "arcade", name: "Arcade", cost: 1500, needsPower: true, jobs: 4, powerUse: 2, service: "fun", radius: 6, capacity: 80 }),
  def({ id: 69, key: "zoo", name: "Zoo", cost: 14000, w: 3, h: 3, needsPower: true, jobs: 25, powerUse: 6, service: "fun", radius: 14, capacity: 500, amenity: true, cleans: 1 }),
  def({ id: 70, key: "tree_line", name: "Tree Line", cost: 150, needsRoad: false, radius: 2, cleans: 1 }),
  // ruins: what a fire leaves behind; clear them for free (not in the build menu)
  def({ id: 48, key: "ruins_1", name: "Ruins", cost: 0, refundRate: 0, needsRoad: false }),
  def({ id: 49, key: "ruins_2", name: "Ruins", cost: 0, refundRate: 0, needsRoad: false, w: 2, h: 2 }),
  def({ id: 50, key: "ruins_3", name: "Ruins", cost: 0, refundRate: 0, needsRoad: false, w: 3, h: 3 }),
  // parks (amenity: +1 mood within radius)
  def({ id: 29, key: "garden", name: "Garden", cost: 80, needsRoad: false, amenity: true, radius: 3, cleans: 1 }),
  def({ id: 6, key: "park", name: "Park", cost: 150, needsRoad: false, amenity: true, radius: 4, cleans: 1 }),
  def({ id: 30, key: "big_park", name: "Big Park", cost: 500, w: 2, h: 2, needsRoad: false, amenity: true, radius: 7, cleans: 2 }),
];

// Build menu groups (from the Roblox BuildMenu). Anything not claimed here and not ruins goes to "Other".
export const CATEGORIES: readonly { name: string; keys: readonly string[] }[] = [
  { name: "Roads", keys: ["road", "avenue", "highway", "bridge", "highway_bridge", "car_park", "parking_garage"] },
  { name: "Homes", keys: ["cottage", "bungalow", "house", "duplex", "townhouse", "villa", "eco_homes", "retirement_home", "mansion", "apartment", "condo", "tower", "skyscraper_res"] },
  { name: "Work", keys: ["bakery", "shop", "diner", "market", "office", "bank", "warehouse", "factory", "farm", "hotel", "heavy_industry", "tech_campus", "airport"] },
  { name: "Power", keys: ["generator", "wind_turbine", "solar_farm", "power_plant", "nuclear_plant"] },
  { name: "Services", keys: ["police", "clinic", "hospital", "school", "university", "fire_station"] },
  { name: "Fun", keys: ["playground", "arcade", "cinema", "ferris_wheel", "mall", "zoo", "stadium"] },
  { name: "Parks", keys: ["tree_line", "garden", "park", "big_park"] },
  { name: "Shore", keys: ["pier", "beach_club", "fishing_dock", "marina", "lighthouse", "water_park", "cargo_port"] },
  { name: "Water", keys: ["houseboat", "floating_restaurant", "fish_farm", "ferry_dock", "offshore_wind", "oil_platform"] },
];