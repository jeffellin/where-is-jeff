/**
 * test-parser.js — Verify parsing against real calendar data
 * Run: node test-parser.js
 *
 * Tests the parsing and merging logic directly without requiring googleapis.
 */

// ── Inline the functions we need to test directly ──

const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN",
  "IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV",
  "NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN",
  "TX","UT","VT","VA","WA","WV","WI","WY","DC",
]);

function extractCityFromAmtrakAddress(address) {
  if (!address) return null;
  const parts = address.split(",").map(p => p.trim());
  const cityStateZip = parts[parts.length - 1];
  if (!cityStateZip) return null;
  const match = cityStateZip.match(/^(.+?)\s+([A-Z]{2})\s+\d{5}(-\d{4})?$/);
  if (match) return match[1].trim();
  const noZip = cityStateZip.match(/^(.+?)\s+([A-Z]{2})$/);
  if (noZip && US_STATES.has(noZip[2])) return noZip[1].trim();
  return cityStateZip.replace(/\s+\d{5}(-\d{4})?$/, "").trim() || null;
}

function extractDestCityFromFlightyDesc(description) {
  if (!description) return null;
  const match = description.match(/^(.+?)\s+to\s+(.+)$/m);
  if (match) return match[2].trim();
  return null;
}

function extractOriginCityFromFlightyDesc(description) {
  if (!description) return null;
  const match = description.match(/^(.+?)\s+to\s+(.+)$/m);
  if (match) return match[1].trim();
  return null;
}

function buildHomeCityVariants(homeCity) {
  const base = homeCity.toLowerCase().trim();
  const variants = new Set([base]);
  const aliases = {
    arlington: ["washington", "washington dc", "washington d.c."],
    washington: ["washington dc", "washington d.c.", "arlington"],
    "washington dc": ["washington", "washington d.c.", "arlington"],
  };
  if (aliases[base]) aliases[base].forEach(a => variants.add(a));
  return variants;
}

// ── Tests ──
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

// === 1. Amtrak address parsing ===
console.log("\n=== Amtrak Address Parsing ===");

assert(
  extractCityFromAmtrakAddress("50 Massachusetts Avenue NE , Washington DC 20002-4214") === "Washington",
  "DC Union Station → Washington"
);
assert(
  extractCityFromAmtrakAddress("351 West 31st Street , New York NY 10001") === "New York",
  "Moynihan Train Hall → New York"
);
assert(
  extractCityFromAmtrakAddress("30th Street Station , Philadelphia PA 19104") === "Philadelphia",
  "30th St Station → Philadelphia"
);

// === 2. Flighty description parsing ===
console.log("\n=== Flighty Description Parsing ===");

const flightyDesc1 = `Booking Code: EQSGPJ

American Airlines 177
New York to San Francisco
↗ 8:44 PM EDT
↘ 12:29 AM PDT
Flight time 6 hr, 45 min`;

assert(
  extractDestCityFromFlightyDesc(flightyDesc1) === "San Francisco",
  "JFK→SFO description → destination: San Francisco"
);
assert(
  extractOriginCityFromFlightyDesc(flightyDesc1) === "New York",
  "JFK→SFO description → origin: New York"
);

const flightyDesc2 = `Booking Code: ABCDEF

American Airlines 500
Washington to Los Angeles
↗ 10:00 AM EDT
↘ 1:00 PM PDT
Flight time 5 hr, 0 min`;

assert(
  extractDestCityFromFlightyDesc(flightyDesc2) === "Los Angeles",
  "DCA→LAX description → destination: Los Angeles"
);
assert(
  extractOriginCityFromFlightyDesc(flightyDesc2) === "Washington",
  "DCA→LAX description → origin: Washington"
);

// === 3. Home city aliasing ===
console.log("\n=== Home City Aliasing ===");

const homeVariants = buildHomeCityVariants("Arlington");
assert(homeVariants.has("arlington"), "Arlington is home");
assert(homeVariants.has("washington"), "Washington matches Arlington");
assert(homeVariants.has("washington dc"), "Washington DC matches Arlington");
assert(!homeVariants.has("new york"), "New York is NOT home");
assert(!homeVariants.has("los angeles"), "Los Angeles is NOT home");

// === 4. Scenario: Simple LA round trip (Apr 13-16) ===
console.log("\n=== Scenario: DCA→LAX round trip ===");

// Flighty creates two events: outbound and return
const laTrip = [
  {
    summary: "✈ DCA→LAX · AA 100",
    location: "Ronald Reagan Washington National",
    description: "Booking Code: XYZ\n\nAmerican Airlines 100\nWashington to Los Angeles\n↗ 10:00 AM\n↘ 1:00 PM\nFlight time 5 hr",
    start: { dateTime: "2026-04-13T10:00:00-04:00" },
    end: { dateTime: "2026-04-13T13:00:00-07:00" },
    id: "la1",
  },
  {
    summary: "✈ LAX→DCA · AA 200",
    location: "Los Angeles Intl.",
    description: "Booking Code: XYZ\n\nAmerican Airlines 200\nLos Angeles to Washington\n↗ 3:00 PM\n↘ 11:00 PM\nFlight time 5 hr",
    start: { dateTime: "2026-04-16T15:00:00-07:00" },
    end: { dateTime: "2026-04-16T23:00:00-04:00" },
    id: "la2",
  },
];

// Parse these as the handler would
const parseEvent = (event) => {
  const title = event.summary || "";
  const location = event.location || "";
  const description = event.description || "";
  const start = event.start?.date || event.start?.dateTime?.split("T")[0];
  const end = event.end?.date || event.end?.dateTime?.split("T")[0];
  if (!start || !end) return null;

  const AIRPORT_CITIES = {
    DCA: "Washington DC", LAX: "Los Angeles", JFK: "New York",
    SFO: "San Francisco",
  };

  const flightyMatch = title.match(/([A-Z]{3})\s*→\s*([A-Z]{3})/);
  const hasFlightyDesc = description.includes("Flight time") || description.includes("Booking Code");

  if (flightyMatch && hasFlightyDesc) {
    let city = extractDestCityFromFlightyDesc(description);
    let originCity = extractOriginCityFromFlightyDesc(description);
    if (!city) city = AIRPORT_CITIES[flightyMatch[2]] || flightyMatch[2];
    if (!originCity) originCity = AIRPORT_CITIES[flightyMatch[1]] || flightyMatch[1];
    return { id: event.id, city, originCity, start, end, mode: "flight", _legType: "flighty" };
  }

  const isAmtrak = /^amtrak:\s*\d+/i.test(title);
  if (isAmtrak) {
    const city = extractCityFromAmtrakAddress(location);
    return city ? { id: event.id, city, originCity: null, start, end, mode: "train", _legType: "amtrak" } : null;
  }

  return null;
};

const isHomeCity = (city, variants) => city ? variants.has(city.toLowerCase().trim()) : false;

function mergeLegsIntoTrips(legs, homeCity) {
  const hv = buildHomeCityVariants(homeCity);
  const result = [];
  const sorted = [...legs].sort((a, b) => a.start.localeCompare(b.start));
  let i = 0;

  while (i < sorted.length) {
    const tripLegs = [sorted[i]];
    let j = i + 1;
    let returnedHome = (sorted[i]._legType === "flighty" && isHomeCity(sorted[i].city, hv));

    while (j < sorted.length && !returnedHome) {
      const prevEnd = new Date(tripLegs[tripLegs.length - 1].end + "T00:00:00");
      const nextStart = new Date(sorted[j].start + "T00:00:00");
      const daysBetween = (nextStart - prevEnd) / (1000 * 60 * 60 * 24);
      if (daysBetween > 7) break;
      tripLegs.push(sorted[j]);
      const nextReturnsHome = (sorted[j]._legType === "flighty" && isHomeCity(sorted[j].city, hv)) ||
        (sorted[j]._legType === "amtrak" && isHomeCity(sorted[j].city, hv));
      if (nextReturnsHome) returnedHome = true;
      j++;
    }

    const segments = [];
    let currentDest = null;
    let pendingDepartureDate = null;

    for (const tl of tripLegs) {
      let tlDest = null;
      if (tl._legType === "flighty") {
        tlDest = isHomeCity(tl.city, hv) ? null : tl.city;
      } else if (tl._legType === "amtrak") {
        tlDest = isHomeCity(tl.city, hv) ? null : tl.city;
      } else {
        tlDest = tl.city;
      }

      if (!tlDest && !currentDest) {
        pendingDepartureDate = tl.start;
      } else if (tlDest && tlDest !== currentDest) {
        if (currentDest && segments.length > 0) {
          segments[segments.length - 1].end = tl.start;
        }
        const segStart = pendingDepartureDate || tl.start;
        currentDest = tlDest;
        pendingDepartureDate = null;
        segments.push({ city: tlDest, start: segStart, end: tl.end, mode: tl.mode });
      } else if (!tlDest && currentDest) {
        segments[segments.length - 1].end = tl.start;
        currentDest = null;
        pendingDepartureDate = null;
      }
    }

    if (segments.length > 0) {
      const lastLeg = tripLegs[tripLegs.length - 1];
      const lastSeg = segments[segments.length - 1];
      if (new Date(lastLeg.end) > new Date(lastSeg.end)) lastSeg.end = lastLeg.end;
    }

    for (const seg of segments) result.push(seg);
    i = j;
  }

  return result;
}

const laLegs = laTrip.map(parseEvent).filter(Boolean);
const laResult = mergeLegsIntoTrips(laLegs, "Arlington");

assert(laResult.length === 1, `LA trip: 1 merged trip (got ${laResult.length})`);
if (laResult.length >= 1) {
  assert(laResult[0].city === "Los Angeles", `LA trip destination: Los Angeles (got "${laResult[0].city}")`);
  assert(laResult[0].start === "2026-04-13", `LA trip starts Apr 13 (got ${laResult[0].start})`);
  assert(laResult[0].end === "2026-04-16", `LA trip ends Apr 16 (got ${laResult[0].end})`);
}

// === 5. Scenario: Train DC→NYC then Fly NYC→SFO then Fly SFO→DCA ===
console.log("\n=== Scenario: Mixed mode DC→NYC→SFO→DCA ===");

const mixedTrip = [
  {
    summary: "Amtrak: 123 Northeast Regional",
    location: "50 Massachusetts Avenue NE , Washington DC 20002-4214",
    description: "",
    start: { dateTime: "2026-05-08T08:00:00-04:00" },
    end: { dateTime: "2026-05-08T11:30:00-04:00" },
    id: "mix1",
  },
  {
    summary: "Amtrak: 456 Acela",
    location: "351 West 31st Street , New York NY 10001",
    description: "",
    start: { dateTime: "2026-05-10T20:00:00-04:00" },
    end: { dateTime: "2026-05-10T23:30:00-04:00" },
    id: "mix2",
  },
  {
    summary: "✈ JFK→SFO · AA 177",
    location: "John F Kennedy Intl.",
    description: "Booking Code: EQSGPJ\n\nAmerican Airlines 177\nNew York to San Francisco\n↗ 8:44 PM EDT\n↘ 12:29 AM PDT\nFlight time 6 hr, 45 min",
    start: { dateTime: "2026-05-10T20:44:00-04:00" },
    end: { dateTime: "2026-05-11T03:29:00-04:00" },
    id: "mix3",
  },
  {
    summary: "✈ SFO→DCA · AA 300",
    location: "San Francisco Intl.",
    description: "Booking Code: ZZZZZ\n\nAmerican Airlines 300\nSan Francisco to Washington\n↗ 2:00 PM PDT\n↘ 10:00 PM EDT\nFlight time 5 hr",
    start: { dateTime: "2026-05-14T14:00:00-07:00" },
    end: { dateTime: "2026-05-14T22:00:00-04:00" },
    id: "mix4",
  },
];

const mixedLegs = mixedTrip.map(parseEvent).filter(Boolean);
const mixedResult = mergeLegsIntoTrips(mixedLegs, "Arlington");

console.log("  Mixed trip results:", JSON.stringify(mixedResult, null, 2));

assert(mixedResult.length === 2, `Mixed trip: 2 segments (got ${mixedResult.length})`);
if (mixedResult.length >= 1) {
  assert(mixedResult[0].city === "New York", `Segment 1: New York (got "${mixedResult[0].city}")`);
  assert(mixedResult[0].start === "2026-05-08", `NYC starts May 8 (got ${mixedResult[0].start})`);
}
if (mixedResult.length >= 2) {
  assert(mixedResult[1].city === "San Francisco", `Segment 2: San Francisco (got "${mixedResult[1].city}")`);
  assert(mixedResult[1].end === "2026-05-14", `SFO ends May 14 (got ${mixedResult[1].end})`);
}

// === Summary ===
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
