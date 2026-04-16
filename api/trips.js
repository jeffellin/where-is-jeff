/**
 * /api/trips.js — Serverless function (Vercel-compatible)
 *
 * Reads a Google Calendar, parses travel events (Flighty + Amtrak + manual),
 * and merges individual legs into unified trips.
 *
 * Data sources:
 *
 *   FLIGHTY calendar events:
 *     Title:    "✈ JFK→SFO · AA 177"
 *     Location: "John F Kennedy Intl." (departure airport — NOT useful for destination)
 *     Description: "Booking Code: EQSGPJ\n\nAmerican Airlines 177\nNew York to San Francisco\n..."
 *     → We extract destination city from the description ("New York to San Francisco")
 *     → Fallback: extract destination airport code from title and map to city
 *
 *   AMTRAK app calendar events:
 *     Title:    "Amtrak: 152 Northeast Regional"
 *     Location: "50 Massachusetts Avenue NE , Washington DC 20002-4214"
 *     → City extracted from address; paired legs merged (non-home city = destination)
 *
 *   MANUAL entries:
 *     "Flight to Tokyo", "Train to Portland", "Tokyo Trip", etc.
 *
 * After parsing, all legs are merged into unified trips:
 *   - Consecutive travel legs within 1 day of each other get stitched together
 *   - Home-city legs (departures/returns) are absorbed into the trip
 *   - Mixed mode (train DC→NYC, then fly NYC→SFO) works correctly
 */

const { google } = require("googleapis");

// ── Amtrak station name → city mapping (for Apple Wallet train events) ──
const AMTRAK_STATION_CITIES = {
  "moynihan":           "New York",
  "penn sta":           "New York",
  "penn station":       "New York",
  "grand central":      "New York",
  "union station":      "Washington DC",   // NE corridor; also Chicago — acceptable for home context
  "south station":      "Boston",
  "back bay":           "Boston",
  "north station":      "Boston",
  "30th street":        "Philadelphia",
  "william h gray":     "Philadelphia",
  "trenton":            "Trenton",
  "princeton junction": "Princeton",
  "newark penn":        "Newark",
  "new brunswick":      "New Brunswick",
  "metropark":          "Iselin",
  "stamford":           "Stamford",
  "bridgeport":         "Bridgeport",
  "new haven":          "New Haven",
  "old saybrook":       "Old Saybrook",
  "new london":         "New London",
  "mystic":             "Mystic",
  "providence":         "Providence",
  "route 128":          "Boston",
  "wilmington":         "Wilmington",
  "baltimore":          "Baltimore",
  "new carrollton":     "Washington DC",
  "richmond":           "Richmond",
  "norfolk":            "Norfolk",
  "newport news":       "Newport News",
  "raleigh":            "Raleigh",
  "charlotte":          "Charlotte",
  "savannah":           "Savannah",
  "jacksonville":       "Jacksonville",
  "miami":              "Miami",
  "orlando":            "Orlando",
  "tampa":              "Tampa",
  "chicago":            "Chicago",
  "los angeles":        "Los Angeles",
  "new orleans":        "New Orleans",
  "seattle":            "Seattle",
  "portland":           "Portland",
};

function extractCityFromStationName(stationName) {
  if (!stationName) return null;
  const lower = stationName.toLowerCase();
  for (const [key, city] of Object.entries(AMTRAK_STATION_CITIES)) {
    if (lower.includes(key)) return city;
  }
  return null;
}

// ── Airport code → city mapping ──
const AIRPORT_CITIES = {
  // US Major
  LAX: "Los Angeles", SFO: "San Francisco", OAK: "Oakland",
  JFK: "New York", EWR: "Newark", LGA: "New York",
  ORD: "Chicago", MDW: "Chicago",
  ATL: "Atlanta", DFW: "Dallas", DAL: "Dallas",
  DEN: "Denver", SEA: "Seattle", PDX: "Portland",
  BOS: "Boston", MIA: "Miami", FLL: "Fort Lauderdale",
  IAH: "Houston", HOU: "Houston",
  PHX: "Phoenix", SAN: "San Diego",
  AUS: "Austin", MSP: "Minneapolis",
  DTW: "Detroit", TPA: "Tampa", MCO: "Orlando",
  SLC: "Salt Lake City",
  DCA: "Washington DC", IAD: "Washington DC", BWI: "Baltimore",
  RDU: "Raleigh", CLT: "Charlotte", PHL: "Philadelphia", CHS: "Charleston",
  PIT: "Pittsburgh", CLE: "Cleveland", CVG: "Cincinnati",
  MCI: "Kansas City", STL: "St. Louis", IND: "Indianapolis",
  BNA: "Nashville", MEM: "Memphis", MSY: "New Orleans",
  JAX: "Jacksonville", RSW: "Fort Myers", PBI: "West Palm Beach",
  SJC: "San Jose", SMF: "Sacramento", BUR: "Burbank",
  HNL: "Honolulu", OGG: "Maui", LAS: "Las Vegas",
  MSP: "Minneapolis",
  // International
  NRT: "Tokyo", HND: "Tokyo", KIX: "Osaka",
  LHR: "London", LGW: "London", STN: "London",
  CDG: "Paris", ORY: "Paris",
  FCO: "Rome", MXP: "Milan",
  BCN: "Barcelona", MAD: "Madrid",
  AMS: "Amsterdam", FRA: "Frankfurt", MUC: "Munich",
  ZRH: "Zurich", VIE: "Vienna", CPH: "Copenhagen",
  DUB: "Dublin", LIS: "Lisbon", ATH: "Athens",
  ICN: "Seoul", HKG: "Hong Kong", SIN: "Singapore",
  BKK: "Bangkok", SYD: "Sydney", MEL: "Melbourne", AKL: "Auckland",
  MEX: "Mexico City", CUN: "Cancún", GRU: "São Paulo",
  BOG: "Bogotá", LIM: "Lima", SCL: "Santiago",
  YYZ: "Toronto", YVR: "Vancouver", YUL: "Montreal",
  DXB: "Dubai", DOH: "Doha", TLV: "Tel Aviv",
  CAI: "Cairo", JNB: "Johannesburg", CPT: "Cape Town",
};

// ── US state abbreviations ──
const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN",
  "IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV",
  "NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN",
  "TX","UT","VT","VA","WA","WV","WI","WY","DC",
]);

// ── Address parsing (for Amtrak) ──
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

// ── City from "Station Name\nCity, ST" location (Apple Wallet / Amtrak web) ──
function extractCityFromStationLocation(location) {
  if (!location) return null;
  const lines = location.split("\n").map(l => l.trim()).filter(Boolean);
  const cityLine = lines[lines.length - 1]; // last line is "City, ST"
  if (!cityLine) return null;
  const match = cityLine.match(/^(.+?),\s*[A-Z]{2}$/);
  if (match) return match[1].trim();
  return cityLine.split(",")[0].trim() || null;
}

// ── Flighty description parsing ──
/**
 * Extract destination city from Flighty's event description.
 * The description contains a line like "New York to San Francisco".
 * We want the destination (second city).
 */
function extractDestCityFromFlightyDesc(description) {
  if (!description) return null;

  // Look for "CityA to CityB" pattern
  // This line appears after the airline + flight number line
  const match = description.match(/^(.+?)\s+to\s+(.+)$/m);
  if (match) {
    return match[2].trim();
  }
  return null;
}

/**
 * Extract origin city from Flighty's event description.
 */
function extractOriginCityFromFlightyDesc(description) {
  if (!description) return null;
  const match = description.match(/^(.+?)\s+to\s+(.+)$/m);
  if (match) {
    return match[1].trim();
  }
  return null;
}

// ── Format a dateTime string for display ──
// Google Calendar dateTime values carry their UTC offset (e.g. "2024-03-15T14:30:00-05:00").
// In a serverless environment the process timezone is UTC, so calling new Date().toLocaleTimeString()
// without a timeZone option converts to UTC and shows the wrong time.
// Strategy: use the explicit IANA timeZone from the calendar event when present; otherwise read
// the local time digits straight from the ISO string (the offset already encodes local time).
function formatDetailTime(isoString, timeZone) {
  if (!isoString) return null;

  // Best case: Google Calendar gave us a named timezone (e.g. "America/New_York")
  if (timeZone) {
    return new Date(isoString).toLocaleTimeString("en-US", {
      hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone,
    });
  }

  // Good case: ISO string has a numeric offset — read the local time directly
  // e.g. "2024-03-15T14:30:00-05:00" → the "14:30" IS the departure-city local time
  const localMatch = isoString.match(/T(\d{2}):(\d{2})(?::\d{2})?[+-]\d/);
  if (localMatch) {
    const h = parseInt(localMatch[1], 10);
    const m = localMatch[2];
    const ampm = h >= 12 ? "PM" : "AM";
    const hour12 = h % 12 || 12;
    return `${hour12}:${m} ${ampm}`;
  }

  // Fallback (UTC "Z" suffix or no offset — server local time)
  return new Date(isoString).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit",
  });
}

// ── Parse a single calendar event into a travel leg ──
function parseEvent(event) {
  // Strip zero-width characters (U+200B, U+200C, U+200D, U+FEFF) from title
  // Flighty embeds zero-width spaces around the arrow: "DCA​→​LAX"
  const title = (event.summary || "").replace(/[\u200B\u200C\u200D\uFEFF]/g, "");
  const location = event.location || "";
  const description = event.description || "";
  const start = event.start?.date || event.start?.dateTime?.split("T")[0];
  const end = event.end?.date || event.end?.dateTime?.split("T")[0];

  if (!start || !end) return null;

  let city = null;
  let originCity = null;
  let mode = "flight";

  // ── Flighty events ──
  // Title format: "✈ DCA→LAX • AA 3283" (after stripping zero-width chars)
  // Match any 3-letter airport code pair separated by arrow-like characters
  const flightyMatch = title.match(/([A-Z]{3})\s*[\u2192\u2794\u279D\u27A1→➔➝\->]+\s*([A-Z]{3})/);

  // Detect Flighty events by: has airport codes in title + either has description keywords
  // OR location contains "Intl" / "Airport" / "National" (Flighty puts departure airport in location)
  const hasFlightyDesc = description.includes("Flight time") || description.includes("Booking Code");
  const hasAirportLocation = /intl|airport|national|terminal/i.test(location);
  const isFlighty = flightyMatch && (hasFlightyDesc || hasAirportLocation);

  if (isFlighty) {
    const originCode = flightyMatch[1];
    const destCode = flightyMatch[2];

    // Airport code → city is the canonical, reliable source for home-city matching.
    // Description parsing ("Washington, D.C. to Las Vegas") can produce strings that
    // don't match home city aliases (e.g. comma/period variants), so we prefer the
    // code lookup for originCity and use the description city only as a display fallback.
    originCity = AIRPORT_CITIES[originCode] || extractOriginCityFromFlightyDesc(description) || originCode;

    // For the destination, description is fine (we don't need alias matching)
    city = extractDestCityFromFlightyDesc(description) || AIRPORT_CITIES[destCode] || destCode;

    mode = "flight";

    const carrierLineMatch = description.match(/^([A-Za-z][A-Za-z ]+?)\s+(\d+)\s*$/m);
    const depMatch = description.match(/↗\s*(.+)/);
    const arrMatch = description.match(/↘\s*(.+)/);
    const bookingMatch = description.match(/Booking Code:\s*(\S+)/);
    const durationMatch = description.match(/Flight time\s+(.+)/);

    return {
      id: event.id,
      city,
      originCity,
      region: "",
      start,
      end,
      mode,
      _legType: "flighty",
      _detail: {
        type: "flight",
        flightNumber: carrierLineMatch ? `${carrierLineMatch[1].trim()} ${carrierLineMatch[2]}` : null,
        fromCode: originCode,
        toCode: destCode,
        from: originCity,
        to: city,
        departureDate: start,
        arrivalDate: end,
        departure: depMatch ? depMatch[1].trim() : null,
        arrival: arrMatch ? arrMatch[1].trim() : null,
        bookingCode: bookingMatch ? bookingMatch[1] : null,
        duration: durationMatch ? durationMatch[1].trim() : null,
      },
    };
  }

  // ── Amtrak app events ──
  // Title: "Amtrak: 152 Northeast Regional"
  const isAmtrakApp = /^amtrak:\s*\d+/i.test(title);
  if (isAmtrakApp) {
    city = extractCityFromAmtrakAddress(location);
    mode = "train";
    if (city) {
      const trainName = title.replace(/^amtrak:\s*/i, "").trim();
      const reservationMatch = description.match(/reservation num\w*(?:\s*:\s*|\s+is\s+)(\w+)/i);
      return {
        id: event.id,
        city,
        originCity: null,
        region: location,
        start,
        end,
        mode,
        _legType: "amtrak",
        _detail: {
          type: "train",
          carrier: "Amtrak",
          flightNumber: trainName,
          from: city,
          departureDate: start,
          departure: formatDetailTime(event.start?.dateTime, event.start?.timeZone),
          arrival: formatDetailTime(event.end?.dateTime, event.end?.timeZone),
          reservation: reservationMatch ? reservationMatch[1] : null,
        },
      };
    }
  }

  // ── Apple Wallet / Amtrak web events ──
  // Title: "Train: Amtrak from Union Station to Moynihan Train Hall at Penn Sta."
  // Location: "Station Name\nCity, ST"
  const isAppleWalletTrain = /^train:\s*amtrak\s+from\s+/i.test(title);
  if (isAppleWalletTrain) {
    const departureCity = extractCityFromStationLocation(location);
    mode = "train";
    if (departureCity) {
      const reservationMatch = description.match(/Reservation Number:\s*(\S+)/i);
      const seatMatch = description.match(/Seats?:\s*(.+)/i);
      const stationMatch = title.match(/from\s+(.+?)\s+to\s+(.+)/i);
      const fromStation = stationMatch ? stationMatch[1].trim() : null;
      const toStation = stationMatch ? stationMatch[2].trim() : null;

      // Try to resolve the destination city from the station name in the title.
      // If successful, treat this like a directional leg (city=dest, originCity=departure)
      // so the merger can correctly open/close trips without needing a paired return leg.
      const destCity = extractCityFromStationName(toStation);
      city = destCity || departureCity;
      const legOriginCity = destCity ? departureCity : null;

      return {
        id: event.id,
        city,
        originCity: legOriginCity,
        region: location,
        start,
        end,
        mode,
        _legType: "amtrak",
        _detail: {
          type: "train",
          carrier: "Amtrak",
          fromStation,
          toStation,
          from: departureCity,
          to: destCity || null,
          departureDate: start,
          departure: formatDetailTime(event.start?.dateTime, event.start?.timeZone),
          reservation: reservationMatch ? reservationMatch[1] : null,
          seat: seatMatch ? seatMatch[1].trim() : null,
        },
      };
    }
  }

  // ── Car/Drive events ──
  // Title: "Car: DCA-CHS" or "Drive: Washington-Charleston" or "Car: DCA→CHS"
  const carMatch = title.match(/^(?:car|drive|driving|road\s*trip):\s*(.+)/i);
  if (carMatch) {
    const route = carMatch[1].trim();
    const parts = route.split(/\s*(?:->|[–→-])\s*/);
    if (parts.length >= 2) {
      const destRaw = parts[parts.length - 1].trim();
      const originRaw = parts[0].trim();
      city = AIRPORT_CITIES[destRaw.toUpperCase()] || destRaw;
      originCity = AIRPORT_CITIES[originRaw.toUpperCase()] || originRaw;
    } else {
      city = route;
    }
    mode = "drive";
    if (city) {
      return {
        id: event.id,
        city,
        originCity: originCity || null,
        region: location || "",
        start,
        end,
        mode,
        _legType: "manual",
        _detail: {
          type: "drive",
          from: originCity || null,
          to: city,
          departureDate: start,
        },
      };
    }
  }

  // ── Manual patterns ──

  // "Flight to [City]" — also handles airport codes like "Flight to MSP" or "Flight to DCA"
  const flightTo = title.match(/(?:flight|fly|flying)\s+to\s+(.+)/i);
  if (flightTo) {
    city = flightTo[1].replace(/\s*\(.*\)\s*$/, "").trim();
    city = AIRPORT_CITIES[city.toUpperCase()] || city;
    mode = "flight";
  }

  // "Train to [City]"
  if (!city) {
    const trainTo = title.match(/(?:amtrak|train)\s+to\s+(.+)/i);
    if (trainTo) {
      city = trainTo[1].replace(/\s*\(.*\)\s*$/, "").trim();
      city = AIRPORT_CITIES[city.toUpperCase()] || city;
      mode = "train";
    }
  }

  // "ABC → DEF" airport codes (non-Flighty, no description)
  if (!city) {
    const codeMatch = title.match(/([A-Z]{3})\s*[\u2192\u2794\u279D\u27A1→➔➝\-\->–]+\s*([A-Z]{3})/);
    if (codeMatch) {
      city = AIRPORT_CITIES[codeMatch[2]] || codeMatch[2];
      originCity = AIRPORT_CITIES[codeMatch[1]] || codeMatch[1];
      mode = "flight";
    }
  }

  // "[City] Trip" or "Trip to [City]"
  if (!city) {
    const tripMatch = title.match(/(?:trip\s+to\s+(.+)|(.+?)\s+trip)/i);
    if (tripMatch) city = (tripMatch[1] || tripMatch[2]).trim();
  }

  if (mode !== "train" && /amtrak|train/i.test(title)) mode = "train";
  if (/drive|driving|road\s*trip/i.test(title)) mode = "drive";

  if (!city) return null;
  city = city.replace(/[.!?]$/, "").trim();

  // If originCity still unknown, try to infer from the location field.
  // Google Calendar often puts the departure airport name/code there (e.g. "Washington DCA").
  if (!originCity && location) {
    const locCode = location.match(/\b([A-Z]{3})\b/);
    if (locCode && AIRPORT_CITIES[locCode[1]]) {
      originCity = AIRPORT_CITIES[locCode[1]];
    }
  }

  // Extract flight/train number from parentheses e.g. "Flight to Las Vegas (AA 1525)"
  const parenMatch = (event.summary || "").match(/\(([^)]+)\)/);
  const manualNumber = parenMatch ? parenMatch[1].trim() : null;

  return {
    id: event.id,
    city,
    originCity: originCity || null,
    region: location || "",
    start,
    end,
    mode,
    _legType: "manual",
    _detail: {
      type: mode === "train" ? "train" : "flight",
      carrier: null,
      flightNumber: manualNumber,
      from: originCity || location || null,
      to: city,
      departureDate: start,
      departure: formatDetailTime(event.start?.dateTime, event.start?.timeZone),
      arrival: formatDetailTime(event.end?.dateTime, event.end?.timeZone),
    },
  };
}

// ── Home city matching ──
function buildHomeCityVariants(homeCity) {
  const base = homeCity.toLowerCase().trim();
  const variants = new Set([base]);
  const aliases = {
    arlington: ["washington", "washington dc", "washington d.c.", "baltimore"],
    washington: ["washington dc", "washington d.c.", "arlington", "baltimore"],
    "washington dc": ["washington", "washington d.c.", "arlington", "baltimore"],
    "new york": ["new york city", "nyc", "manhattan"],
    "los angeles": ["la"],
    "san francisco": ["sf"],
    philadelphia: ["philly"],
  };
  if (aliases[base]) aliases[base].forEach(a => variants.add(a));
  return variants;
}

function isHomeCity(city, homeVariants) {
  if (!city) return false;
  return homeVariants.has(city.toLowerCase().trim());
}

/**
 * ── Unified trip merger ──
 *
 * State machine approach:
 *   - Walk through legs chronologically
 *   - Track current state: "home" or "away in [city]"
 *   - Each leg transitions the state
 *   - When state changes from one away-city to another, close the old segment
 *   - When state returns to home, close the segment
 *
 * For Flighty: destination is in `city`, origin in `originCity`
 * For Amtrak: `city` is the station address (departure point)
 *   - If city = home → this is a departure FROM home (outbound)
 *   - If city ≠ home → this is a departure FROM destination (return)
 */
function mergeLegsIntoTrips(legs, homeCity) {
  const homeVariants = buildHomeCityVariants(homeCity);
  const result = [];

  const sorted = [...legs].sort((a, b) => a.start.localeCompare(b.start));

  let currentTrip = null; // { city, start, end, mode }

  for (const leg of sorted) {
    let legOrigin = null; // Where this leg departs FROM
    let legDest = null;   // Where this leg arrives AT

    if (leg._legType === "flighty") {
      legOrigin = leg.originCity;
      legDest = leg.city;
    } else if (leg._legType === "amtrak") {
      if (leg.originCity) {
        // Apple Wallet train: we resolved both origin and destination from the title —
        // treat exactly like a Flighty leg (city = dest, originCity = departure).
        legOrigin = leg.originCity;
        legDest = leg.city;
      } else if (isHomeCity(leg.city, homeVariants)) {
        // Amtrak app: city = departure address = home → outbound, destination unknown
        legOrigin = "home";
        legDest = null;
      } else {
        // Amtrak app: city = departure address = non-home → returning home
        legOrigin = leg.city;
        legDest = "home";
      }
    } else {
      // Manual entries: city is the destination; use originCity if provided
      legDest = leg.city;
      if (leg.originCity) {
        legOrigin = leg.originCity;
      } else if (leg._detail?.from) {
        // originCity wasn't parsed — try to salvage from the display "from" field.
        // Extract an airport code if present (e.g. "Washington DCA" → "DCA" → "Washington DC")
        const codeInFrom = leg._detail.from.match(/\b([A-Z]{3})\b/);
        legOrigin = (codeInFrom && AIRPORT_CITIES[codeInFrom[1]])
          ? AIRPORT_CITIES[codeInFrom[1]]
          : leg._detail.from;
      }
    }

    const originIsHome = legOrigin === "home" || isHomeCity(legOrigin, homeVariants);
    const destIsHome = legDest === "home" || isHomeCity(legDest, homeVariants);

    if (originIsHome && !destIsHome && legDest) {
      // ── LEAVING HOME for a known destination ──
      if (currentTrip && currentTrip.city &&
          currentTrip.city.toLowerCase() === legDest.toLowerCase()) {
        // Already tracking a trip to this city (e.g. backup/alternate flight) —
        // absorb the leg into the existing trip rather than closing and reopening
        if (leg.end > currentTrip.end) currentTrip.end = leg.end;
      } else {
        if (currentTrip) {
          // Close any open trip (shouldn't normally happen)
          result.push({ ...currentTrip });
        }
        currentTrip = {
          city: legDest,
          start: leg.start,
          end: leg.end,
          mode: leg.mode,
          _fromHome: true, // real trip, not a connecting layover
        };
      }

    } else if (originIsHome && !legDest) {
      // ── LEAVING HOME, destination unknown (Amtrak outbound) ──
      // Remember the departure date; the destination will come from the next non-home leg.
      // Skip if a more-informative leg for the same departure already opened a trip
      // (e.g. Apple Wallet and Amtrak app both fire for the same train on the same date).
      if (currentTrip && currentTrip.city && currentTrip._fromHome && leg.start === currentTrip.start) {
        // Duplicate outbound — the trip is already open with a known destination; skip.
      } else {
        if (currentTrip) {
          result.push({ ...currentTrip });
        }
        currentTrip = {
          city: null, // Will be filled by next leg
          start: leg.start,
          end: leg.end,
          mode: leg.mode,
          _pendingDeparture: true,
        };
      }

    } else if (!originIsHome && destIsHome) {
      // ── RETURNING HOME ──
      if (currentTrip) {
        // If we had a pending departure with no destination, the return leg's
        // origin city IS the destination (e.g., Amtrak departing from NYC = we were in NYC)
        if (currentTrip._pendingDeparture && !currentTrip.city && legOrigin && legOrigin !== "home") {
          currentTrip.city = legOrigin;
        }
        // Close the trip at this leg's departure (you leave the destination now)
        currentTrip.end = leg.start;
        result.push({ ...currentTrip });
        currentTrip = null;
      } else if (legOrigin && !isHomeCity(legOrigin, homeVariants)) {
        // ── ORPHANED RETURN — no outbound was recorded (e.g. booked outside Flighty) ──
        // We know where they're returning from; use the return date as the trip end
        result.push({
          city: legOrigin,
          start: leg.start,
          end: leg.start,
          mode: leg.mode,
          _orphanReturn: true,
        });
      }

    } else if (!originIsHome && !destIsHome && legDest) {
      // ── CITY-TO-CITY (e.g., NYC → SFO) ──
      if (currentTrip && currentTrip._pendingDeparture && !currentTrip.city && legOrigin) {
        // Resolve the pending departure: we were in the origin city
        currentTrip.city = legOrigin;
        currentTrip.end = leg.start;
        currentTrip.mode = currentTrip.mode; // keep train mode from departure
        result.push({ ...currentTrip });
      } else if (currentTrip && currentTrip.city) {
        // Close the current segment at this leg's departure
        currentTrip.end = leg.start;
        result.push({ ...currentTrip });
      }
      // Open new segment for the new destination
      currentTrip = {
        city: legDest,
        start: leg.start,
        end: leg.end,
        mode: leg.mode,
      };

    } else if (!destIsHome && legDest && currentTrip && currentTrip._pendingDeparture) {
      // ── Amtrak: the previous leg was an outbound from home, now we know the destination ──
      // This case is handled above in city-to-city, but just in case:
      currentTrip.city = legDest;
      currentTrip.end = leg.end;
      currentTrip.mode = leg.mode;

    } else if (leg._legType === "amtrak" && !isHomeCity(leg.city, homeVariants)) {
      // ── Amtrak departing from non-home city (return leg) ──
      // If we have a pending departure with no destination, this leg's city IS the destination
      if (currentTrip && currentTrip._pendingDeparture && !currentTrip.city) {
        currentTrip.city = leg.city;
        currentTrip.end = leg.start; // Trip ends when we board the return
        result.push({ ...currentTrip });
        currentTrip = null;
      } else if (currentTrip) {
        currentTrip.end = leg.start;
        result.push({ ...currentTrip });
        currentTrip = null;
      }
    }
  }

  // Close any remaining open trip
  if (currentTrip) {
    // Only add if we have a destination
    if (currentTrip.city) {
      result.push({ ...currentTrip });
    }
  }

  // Clean up internal-only flags (keep _fromHome so deduplicateTrips can use it)
  return result.map(t => {
    const { _pendingDeparture, _orphanReturn, ...clean } = t;
    return clean;
  });
}

// ── City coordinates ──
const CITY_COORDS = {
  "los angeles": { lat: 34.0522, lng: -118.2437 },
  "new york": { lat: 40.7128, lng: -74.006 },
  "san francisco": { lat: 37.7749, lng: -122.4194 },
  tokyo: { lat: 35.6762, lng: 139.6503 },
  portland: { lat: 45.5152, lng: -122.6784 },
  seattle: { lat: 47.6062, lng: -122.3321 },
  chicago: { lat: 41.8781, lng: -87.6298 },
  london: { lat: 51.5074, lng: -0.1278 },
  paris: { lat: 48.8566, lng: 2.3522 },
  denver: { lat: 39.7392, lng: -104.9903 },
  austin: { lat: 30.2672, lng: -97.7431 },
  boston: { lat: 42.3601, lng: -71.0589 },
  miami: { lat: 25.7617, lng: -80.1918 },
  atlanta: { lat: 33.749, lng: -84.388 },
  dallas: { lat: 32.7767, lng: -96.797 },
  washington: { lat: 38.9072, lng: -77.0369 },
  "washington dc": { lat: 38.9072, lng: -77.0369 },
  arlington: { lat: 38.8816, lng: -77.091 },
  amsterdam: { lat: 52.3676, lng: 4.9041 },
  barcelona: { lat: 41.3851, lng: 2.1734 },
  rome: { lat: 41.9028, lng: 12.4964 },
  madrid: { lat: 40.4168, lng: -3.7038 },
  seoul: { lat: 37.5665, lng: 126.978 },
  singapore: { lat: 1.3521, lng: 103.8198 },
  sydney: { lat: -33.8688, lng: 151.2093 },
  "hong kong": { lat: 22.3193, lng: 114.1694 },
  toronto: { lat: 43.6532, lng: -79.3832 },
  vancouver: { lat: 49.2827, lng: -123.1207 },
  montreal: { lat: 45.5017, lng: -73.5673 },
  "mexico city": { lat: 19.4326, lng: -99.1332 },
  orlando: { lat: 28.5383, lng: -81.3792 },
  "san diego": { lat: 32.7157, lng: -117.1611 },
  phoenix: { lat: 33.4484, lng: -112.074 },
  minneapolis: { lat: 44.9778, lng: -93.265 },
  "salt lake city": { lat: 40.7608, lng: -111.891 },
  cancun: { lat: 21.1619, lng: -86.8515 },
  "cancún": { lat: 21.1619, lng: -86.8515 },
  houston: { lat: 29.7604, lng: -95.3698 },
  tampa: { lat: 27.9506, lng: -82.4572 },
  raleigh: { lat: 35.7796, lng: -78.6382 },
  baltimore: { lat: 39.2904, lng: -76.6122 },
  detroit: { lat: 42.3314, lng: -83.0458 },
  frankfurt: { lat: 50.1109, lng: 8.6821 },
  philadelphia: { lat: 39.9526, lng: -75.1652 },
  "new haven": { lat: 41.3083, lng: -72.9279 },
  providence: { lat: 41.824, lng: -71.4128 },
  richmond: { lat: 37.5407, lng: -77.436 },
  wilmington: { lat: 39.7391, lng: -75.5398 },
  norfolk: { lat: 36.8508, lng: -76.2859 },
  "new orleans": { lat: 29.9511, lng: -90.0715 },
  pittsburgh: { lat: 40.4406, lng: -79.9959 },
  albany: { lat: 42.6526, lng: -73.7562 },
  savannah: { lat: 32.0809, lng: -81.0912 },
  charleston: { lat: 32.7765, lng: -79.9311 },
  jacksonville: { lat: 30.3322, lng: -81.6557 },
  nashville: { lat: 36.1627, lng: -86.7816 },
  charlotte: { lat: 35.2271, lng: -80.8431 },
  "fort lauderdale": { lat: 26.1224, lng: -80.1373 },
  dubai: { lat: 25.2048, lng: 55.2708 },
  dublin: { lat: 53.3498, lng: -6.2603 },
  lisbon: { lat: 38.7223, lng: -9.1393 },
  honolulu: { lat: 21.3069, lng: -157.8583 },
  "las vegas": { lat: 36.1699, lng: -115.1398 },
  bangkok: { lat: 13.7563, lng: 100.5018 },
  osaka: { lat: 34.6937, lng: 135.5023 },
  "tel aviv": { lat: 32.0853, lng: 34.7818 },
  zurich: { lat: 47.3769, lng: 8.5417 },
  copenhagen: { lat: 55.6761, lng: 12.5683 },
  vienna: { lat: 48.2082, lng: 16.3738 },
  munich: { lat: 48.1351, lng: 11.582 },
  milan: { lat: 45.4642, lng: 9.19 },
  athens: { lat: 37.9838, lng: 23.7275 },
  newark: { lat: 40.7357, lng: -74.1724 },
  oakland: { lat: 37.8044, lng: -122.2712 },
  "san jose": { lat: 37.3382, lng: -121.8863 },
  sacramento: { lat: 38.5816, lng: -121.4944 },
  "kansas city": { lat: 39.0997, lng: -94.5786 },
  "st. louis": { lat: 38.627, lng: -90.1994 },
  indianapolis: { lat: 39.7684, lng: -86.1581 },
  cleveland: { lat: 41.4993, lng: -81.6944 },
  cincinnati: { lat: 39.1031, lng: -84.512 },
  memphis: { lat: 35.1495, lng: -90.049 },
};

function getCoords(city) {
  if (!city) return null;
  return CITY_COORDS[city.toLowerCase().trim()] || null;
}

// ── Deduplication ──
function deduplicateTrips(trips) {
  // Remove trips with no resolved destination, and same-day flight layovers (but keep orphaned
  // returns and trips that genuinely departed from home — those aren't layovers).
  const filtered = trips
    .filter(t => t.city && (t.mode !== "flight" || t.start !== t.end || t._orphanReturn || t._fromHome))
    .map(({ _fromHome, ...t }) => t);

  // Merge consecutive trips to the same city with overlapping or adjacent dates
  const sorted = [...filtered].sort((a, b) => a.start.localeCompare(b.start));
  const result = [];

  for (const trip of sorted) {
    const prev = result[result.length - 1];
    const sameCity = prev && prev.city.toLowerCase() === trip.city.toLowerCase();
    const overlapping = prev && trip.start <= prev.end;

    if (sameCity && overlapping) {
      prev.end = trip.end > prev.end ? trip.end : prev.end;
    } else {
      result.push({ ...trip });
    }
  }

  return result;
}

// ── Main handler ──
async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

  try {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      },
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    });

    const calendar = google.calendar({ version: "v3", auth });

    const now = new Date();
    const timeMin = new Date(now); timeMin.setDate(timeMin.getDate() - 30);
    const timeMax = new Date(now); timeMax.setDate(timeMax.getDate() + 365);

    const response = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    const events = response.data.items || [];
    const homeCity = process.env.HOME_CITY || "Arlington";

    // Debug mode: /api/trips?debug=1 shows raw events
    if (req.query && req.query.debug === "1") {
      const raw = events.map(e => ({
        summary: e.summary,
        location: e.location,
        description: e.description ? e.description.substring(0, 200) : null,
        start: e.start,
        end: e.end,
      }));
      return res.status(200).json({ ok: true, debug: true, event_count: events.length, events: raw });
    }

    // Parse all events into legs, then merge into trips
    const legs = events.map(parseEvent).filter(Boolean);

    // Collect display-worthy legs for trip popups, merging duplicates
    const rawDisplayLegs = legs
      .filter(l => l._detail)
      .map(({ start, end, mode, city, originCity, _detail }) => ({
        start, end, mode, city, originCity, ..._detail,
      }));

    // Merge legs with the same date + mode + carrier (+ route for flights).
    // Trains use only date+mode+carrier so Amtrak app and Apple Wallet events for the same
    // ride merge correctly — they use different identifiers (train number vs station names).
    // Flights include the route so same-day connecting legs with the same carrier stay distinct.
    const legGroups = new Map();
    for (const leg of rawDisplayLegs) {
      const route = leg.mode === "train" ? "" : (leg.flightNumber
        ? leg.flightNumber.toLowerCase().replace(/\s+/g, "")
        : `${(leg.fromCode || leg.from || "").toLowerCase()}-${(leg.toCode || leg.to || "").toLowerCase()}`);
      const key = `${leg.start}|${leg.mode}|${(leg.carrier || "").toLowerCase()}|${route}`;
      if (legGroups.has(key)) {
        const existing = legGroups.get(key);
        for (const [k, v] of Object.entries(leg)) {
          if (v != null && existing[k] == null) existing[k] = v;
        }
      } else {
        legGroups.set(key, { ...leg });
      }
    }
    const displayLegs = [...legGroups.values()];

    let trips = deduplicateTrips(mergeLegsIntoTrips(legs, homeCity));

    // Filter out trips with no destination or whose destination is home
    const homeVariants = buildHomeCityVariants(homeCity);
    trips = trips.filter(t => t.city && !isHomeCity(t.city, homeVariants)).map((trip) => {
      const coords = getCoords(trip.city);
      return { ...trip, lat: coords?.lat || null, lng: coords?.lng || null };
    });

    const home = {
      city: homeCity,
      region: process.env.HOME_REGION || "VA",
      lat: parseFloat(process.env.HOME_LAT) || 38.8816,
      lng: parseFloat(process.env.HOME_LNG) || -77.091,
    };

    res.status(200).json({ ok: true, home, trips, legs: displayLegs, fetched_at: new Date().toISOString() });
  } catch (error) {
    console.error("Calendar API error:", error.message);
    res.status(500).json({ ok: false, error: "Failed to fetch calendar data", detail: error.message });
  }
}

module.exports = handler;
