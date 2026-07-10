// Auto-derives each team's tournament status (furthest round reached + whether
// eliminated) from ESPN's public FIFA World Cup feed, and writes status.json.
// Run daily by .github/workflows/update-status.yml. No API key required.
//
// Round scale (matches the pages' CONFIG): 0 Groups · 1 R32 · 2 R16 · 3 QF ·
// 4 SF · 5 Final · 6 Champions. "round" = furthest stage reached.
//
// Safety: if the feed looks incomplete (< 48 real teams) we throw without
// writing, so a bad fetch can never clobber the last good status.json.

import { writeFileSync, readFileSync } from "fs";
import https from "https";

const get = (u) => new Promise((resolve, reject) => {
  https.get(u, (r) => {
    let d = "";
    r.on("data", (c) => (d += c));
    r.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
  }).on("error", reject);
});

const SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=";
const STANDINGS = "https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings";
// Two windows keep each response under ESPN's 100-event cap; events de-duped by id.
const WINDOWS = ["20260611-20260627", "20260628-20260719"];
const KO_STAGE = { "round-of-32": 1, "round-of-16": 2, "quarterfinals": 3, "semifinals": 4, "3rd-place-match": 4, "final": 5 };

async function derive() {
  const status = {};
  const real = new Set();

  // 1) Group qualification from standings. This also defines the 48 real teams.
  const st = await get(STANDINGS);
  for (const g of (st.children || [])) {
    for (const e of (g.standings?.entries || [])) {
      const code = e.team?.abbreviation;
      if (!code) continue;
      real.add(code);
      const note = e.note?.description || "";
      if (note === "Eliminated") status[code] = { round: 0, out: true };
      else if (note === "Advance to Round of 32") status[code] = { round: 1, out: false };
      else status[code] = { round: 0, out: false }; // "Best 8 advance" / undecided third place
    }
  }
  if (real.size < 48) throw new Error(`standings returned only ${real.size} teams; refusing to write`);

  // 2) Knockout progress from the scoreboard — real teams only (bracket
  //    placeholders like "A1"/"W73" carry fake abbreviations, so we skip them).
  const seen = new Set();
  let koStarted = false; // true once any completed knockout match is seen
  for (const w of WINDOWS) {
    const data = await get(SCOREBOARD + w);
    for (const ev of (data.events || [])) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      const slug = ev.season?.slug;
      const stage = KO_STAGE[slug];
      if (!stage) continue;
      const c = ev.competitions?.[0];
      const comps = c?.competitors || [];
      if (comps.length !== 2) continue;
      const bothReal = comps.every((x) => real.has(x.team?.abbreviation));
      const done = c.status?.type?.completed === true;
      if (done && bothReal) koStarted = true;
      for (const x of comps) {
        const code = x.team?.abbreviation;
        if (!real.has(code)) continue;
        const t = status[code] || (status[code] = { round: 0, out: false });
        if (bothReal) t.round = Math.max(t.round, stage);                 // reached this stage
        if (done && slug !== "3rd-place-match" && x.winner !== true) t.out = true; // lost a KO = eliminated
        if (done && slug === "final" && x.winner === true) { t.round = 6; t.out = false; } // champion
      }
    }
  }

  // 3) Group stage is settled the moment the knockouts begin — the R32 can't
  //    start until every group game is played. ESPN leaves non-qualifying
  //    third-placed teams tagged "Best 8 advance" (never "Eliminated"), so they
  //    slip through step 1 as round-0/in. Once the KO has started, any real team
  //    that never advanced (still round 0, not out) did not qualify → eliminate.
  if (koStarted) {
    for (const code of real) {
      const t = status[code];
      if (t && t.round === 0 && !t.out) t.out = true;
    }
  }
  return status;
}

function stamp() {
  const now = new Date();
  const date = now.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" });
  const time = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
  return `${date}, ${time} · auto-updated from live results`;
}

const teams = await derive();
const out = { lastUpdated: stamp(), teams };
const path = new URL("../status.json", import.meta.url);
// Preserve key order stability so git diffs stay small.
const sorted = {};
for (const k of Object.keys(teams).sort()) sorted[k] = teams[k];
out.teams = sorted;
writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
console.log(`Wrote status.json — ${Object.keys(teams).length} teams, ${Object.values(teams).filter((t) => t.out).length} eliminated.`);
