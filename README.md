# Where's Kevin?

A minimal, auto-updating public travel status page powered by Google Calendar.

**How it works:** Flighty syncs your flights to Google Calendar. The Amtrak app syncs train trips to your calendar. This app reads that calendar, parses out destinations, and displays your current location on a clean public page.

## Architecture

```
Google Calendar (your "Travel" calendar)
        ↓ (Google Calendar API)
Serverless API function (/api/trips)
        ↓ (JSON)
Static frontend (index.html)
```

## Quick Start

### 1. Google Calendar Setup

Create a dedicated calendar called **"Travel"** in Google Calendar. Flighty and your Amtrak trips will sync here.

**Event naming convention** (the parser handles these patterns):
- `Flight to Tokyo` or `SFO → NRT` — the parser extracts the destination city
- `Amtrak to Portland` or `Train to Portland` — manual entries
- Any event with a location field set (e.g., "Tokyo, Japan") will use that

**Amtrak app calendar sync:** The Amtrak app can add trips directly to your calendar. These events have titles like `Amtrak: 152 Northeast Regional` or `Amtrak: 2259 Acela` — the destination city is NOT in the title. Instead, the event's address field contains the station street address (e.g., `351 West 31st Street , New York NY 10001`). The parser extracts the city from this address automatically.

For round-trips, the Amtrak app creates two separate events: an outbound leg (address = your home station) and a return leg (address = destination station). The parser groups these and identifies the non-home city as your destination. For example, a DC → NYC weekend trip produces one merged trip to "New York."

### 2. Google Cloud Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (e.g., "wheres-kevin")
3. Enable the **Google Calendar API**
4. Create a **Service Account** (APIs & Services → Credentials → Create Credentials → Service Account)
5. Download the JSON key file
6. In Google Calendar, share your "Travel" calendar with the service account email (found in the JSON key, looks like `xxx@xxx.iam.gserviceaccount.com`) — give it **"See all event details"** permission

### 3. Environment Variables

Create a `.env` file in the project root:

```env
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-sa@your-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"
GOOGLE_CALENDAR_ID=your-calendar-id@group.calendar.google.com
HOME_CITY=Arlington
HOME_REGION=VA
HOME_LAT=38.8816
HOME_LNG=-77.0910
```

**Note on `HOME_CITY`:** This is used both for display ("Kevin is in Arlington") and for Amtrak leg pairing. Since Amtrak departures originate from DC-area stations (Union Station, etc.), the parser also treats "Washington" and "Washington DC" as home-city matches via built-in aliases. You can add custom aliases in the `buildHomeCityVariants` function in `api/trips.js` if needed.

The `GOOGLE_CALENDAR_ID` is found in Google Calendar → Settings → your Travel calendar → "Integrate calendar" → Calendar ID.

### 4. Deploy Options

#### Option A: Vercel (recommended)
```bash
npm install
vercel
```
The `/api/trips.js` file is auto-detected as a serverless function.

#### Option B: Netlify
```bash
npm install
# Move api/trips.js to netlify/functions/trips.js and update the fetch URL in index.html
netlify deploy
```

#### Option C: Any Node.js host
```bash
npm install
node server.js
```

### 5. Custom Domain

Point your domain (e.g., `whereskevin.com`) to your hosting provider per their DNS instructions.

## Project Structure

```
wheres-kevin/
├── api/
│   └── trips.js          # Serverless function — reads Google Calendar
├── public/
│   └── index.html         # The public-facing page
├── server.js              # Standalone Node server (for non-serverless hosts)
├── package.json
├── .env.example
└── README.md
```

## Calendar Event Parsing

The API parses calendar events into trip data. It handles these patterns:

| Event Title | Location Field | Extracted City |
|---|---|---|
| `Flight to Tokyo` | (any) | Tokyo |
| `SFO → NRT` | (any) | Tokyo (airport code lookup) |
| `Amtrak to Portland` | (any) | Portland |
| `Amtrak: 152 Northeast Regional` | `50 Mass Ave NE, Washington DC 20002` | Washington (home leg) |
| `Amtrak: 2259 Acela` | `351 West 31st St, New York NY 10001` | New York (destination leg) |
| `Tokyo Trip` | `Tokyo, Japan` | Tokyo |

**Amtrak round-trip pairing:** When two Amtrak app events appear within 7 days of each other, the parser groups them and picks the non-home city as the destination. The merged trip spans from the first leg's departure date to the last leg's arrival date.

## Customization

- **Home base**: Set via environment variables (`HOME_CITY`, `HOME_REGION`, etc.)
- **Colors/theme**: Edit the CSS variables at the top of `index.html`
- **Refresh interval**: The page auto-refreshes trip data every 15 minutes (configurable in `index.html`)
# where-is-jeff
